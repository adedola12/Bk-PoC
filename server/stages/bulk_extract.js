import { extractText } from "../services/pdf.js";
import { callClaudeJSON } from "../services/anthropic.js";
import { pairingQa } from "./pairing_qa.js";
import { visionExtractPage, normCode } from "./vision_extract.js";

/**
 * Catalogue bulk extraction (Design Doc §3 Stage 2, hostile path):
 * - pairing QA decides per page: trusted text (cheap) vs vision (QRG case)
 * - trusted pages extract in multi-page text chunks, in parallel batches
 * - products dedupe on part number ACROSS chunks; same code on genuinely
 *   different products is KEPT + left for validators to flag (A3 — never
 *   silently merged, never silently dropped)
 * - the catalog's own section headers ride along as sourceSection — the
 *   deterministic tier of Stage 4 (D1 method 1)
 */

const CHUNK_PAGES = 2; // keeps per-call JSON under the output budget
// 5 parallel chunks tripped Bedrock's per-minute limit on a 46-page hostile
// catalogue — 4.5 minutes of vision work lost to a 429. 3 keeps the wall
// time close while staying under the limit; the client also backs off on
// throttles now, so a burst degrades into a wait rather than a failure.
const CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 3);

const TEXT_CATALOG_SYSTEM = `You extract products from pages of a POWER-TOOL trade catalog (text layer).
Return every distinct product with its part number and specification pairs.
Copy printed values VERBATIM, even if implausible. Never correct, never omit.
Return JSON:
{"products":[{
  "name": "model name as printed",
  "partNumber": "as printed",
  "specs": {"<label as printed>": {"value": "<as printed>", "unit": "<unit if printed>", "raw": "<label: value verbatim>"}},
  "page": <page number the product appears on>,
  "confidence": 0..1
}]}
Ignore accessories tables unless they carry their own part numbers and specs.`;

/** Bosch section headers → D1 taxonomy node names (KB §6). */
const SECTION_MAP = [
  { re: /grinding[,\s]+drilling\s*&?\s*demolition/i, node: "Grinding, Drilling & Demolition" },
  { re: /impact\s*(\/|&|and)?\s*diamond\s*drilling|diamond\s*drilling|impact\s*drilling/i, node: "Impact & Diamond Drilling" },
  { re: /\bcordless\b/i, node: "Cordless" },
  { re: /measuring|level+ing/i, node: "Measuring & Leveling" },
  { re: /woodworking/i, node: "Woodworking" },
  { re: /\bgrinding\b/i, node: "Grinding" },
];

export function detectSection(pageText) {
  for (const { re, node } of SECTION_MAP) {
    if (re.test(pageText.slice(0, 2500))) return node;
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {string} sourceFile
 * @param {{log?:Function, pages?:number[]|null}} opts - pages limits the run (eval sampling)
 */
export async function bulkExtract(filePath, sourceFile, { log, pages = null } = {}) {
  const started = Date.now();
  const qa = await pairingQa(filePath, { only: pages });
  const textPages = qa.pages.filter((p) => p.trustText).map((p) => p.page);
  const visionPages = qa.pages.filter((p) => !p.trustText).map((p) => p.page);

  const stats = { pages: qa.pages.length, textPages: textPages.length, visionPages: visionPages.length, calls: 0 };
  const rawProducts = [];

  // ── section tracking across the whole doc (cheap text scan) ──
  const { pages: allText } = await extractText(filePath, { only: qa.pages.map((p) => p.page) });
  const sectionByPage = {};
  let current = null;
  for (const pt of allText) {
    const found = detectSection(pt.text);
    if (found) current = found;
    sectionByPage[pt.page] = current;
  }

  // ── trusted pages → parallel text chunks ──
  const chunks = [];
  for (let i = 0; i < textPages.length; i += CHUNK_PAGES) chunks.push(textPages.slice(i, i + CHUNK_PAGES));
  const textByPage = new Map(allText.map((p) => [p.page, p.text]));

  const runChunk = async (chunk) => {
    const body = chunk.map((n) => `[page ${n}]\n${textByPage.get(n) ?? ""}`).join("\n\n").slice(0, 45000);
    stats.calls++;
    const json = await callClaudeJSON({
      system: TEXT_CATALOG_SYSTEM,
      maxTokens: 16000,
      messages: [{ role: "user", content: `Catalog: ${sourceFile}\n\n${body}` }],
      log,
      tag: `bulk:p${chunk[0]}-${chunk.at(-1)}`,
    });
    return (json.products || []).map((p) => ({ ...p, page: p.page ?? chunk[0], method: "text" }));
  };

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(runChunk));
    for (const r of results) {
      if (r.status === "fulfilled") rawProducts.push(...r.value);
      else log?.({ kind: "bulk_chunk_failed", message: r.reason?.message });
    }
  }

  // ── untrusted pages → panel-segmented vision ──
  for (const pageNum of visionPages) {
    const { products, calls } = await visionExtractPage(filePath, pageNum, { log });
    stats.calls += calls;
    rawProducts.push(...products.map((p) => ({ ...p, page: pageNum, method: "vision" })));
  }

  // ── cross-chunk dedupe (same code + same-ish name = same product) ──
  const byKey = new Map();
  let merged = 0;
  for (const prod of rawProducts) {
    const key = normCode(prod.partNumber) || `name:${(prod.name || "").toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing && samey(existing.name, prod.name)) {
      merged++;
      if (Object.keys(prod.specs || {}).length > Object.keys(existing.specs || {}).length) byKey.set(key, prod);
    } else if (existing) {
      byKey.set(`${key}#${byKey.size}`, prod); // A3 candidate — validators flag it
    } else {
      byKey.set(key, prod);
    }
  }
  stats.merged = merged;

  const iprs = [...byKey.values()].map((p) => productToIpr(p, sourceFile, sectionByPage[p.page] ?? null));
  stats.ms = Date.now() - started;
  log?.({ kind: "bulk_complete", file: sourceFile, products: iprs.length, ...stats });
  return { iprs, qa, stats, sectionByPage };
}

const samey = (a, b) => {
  const tok = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const ta = tok(a);
  const tb = tok(b);
  if (!ta.size || !tb.size) return true;
  return [...ta].filter((t) => tb.has(t)).length / Math.min(ta.size, tb.size) >= 0.5;
};

function productToIpr(p, sourceFile, sourceSection) {
  const mk = (value, raw, unit = null, confidence = p.confidence ?? 0.7) => ({
    value: value ?? null,
    unit,
    raw: raw ?? (value != null ? String(value) : null),
    sourceRef: { file: sourceFile, page: p.page ?? null, region: sourceSection },
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    method: p.method === "vision" ? "vision" : "text",
  });

  const attributes = {};
  for (const [label, spec] of Object.entries(p.specs || {})) {
    if (!spec) continue;
    attributes[label] = mk(spec.value ?? null, spec.raw ?? null, spec.unit ?? null);
  }

  return {
    identity: {
      name: mk(p.name, p.name),
      productCode: mk(p.partNumber, p.partNumber),
    },
    attributes,
    logistics: {},
    compliance: {},
    mediaRefs: [],
    sourceSection,
  };
}
