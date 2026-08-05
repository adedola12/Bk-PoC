import path from "node:path";
import fs from "node:fs";
import { detectBkTemplateSignature } from "../services/xlsx.js";
import { extractText, rasterizePages } from "../services/pdf.js";
import { extractDocxText } from "../services/docx.js";
import { callClaudeJSON, aiAvailable } from "../services/anthropic.js";
import { THRESHOLDS } from "../services/confidence.js";

/**
 * Stage 0 — Intake & Document Triage (D7, hardened by D11/D12).
 * Two-step per Design Doc §3: (a) cheap structural signals; (b) Claude
 * classification on a sampled excerpt with a fixed label set. Below the
 * confidence threshold → human triage queue, never guessed.
 *
 * Labels (D12): bk_template | catalogue | product_datasheet | product_image |
 *               vendor_document | other
 */

export const TRIAGE_LABELS = [
  "bk_template",
  "catalogue",
  "product_datasheet",
  "product_image",
  "vendor_document",
  "other",
];

const NON_PRODUCT = new Set(["vendor_document", "other"]); // D11 verification set

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const SYSTEM = `You are the document-triage classifier for a construction-materials marketplace catalog pipeline.
Classify the uploaded document into EXACTLY one of:
- "catalogue": multi-product commercial catalog (many SKUs/part numbers, sections)
- "product_datasheet": technical sheet for ONE product (single code, spec table/drawing)
- "vendor_document": company/vendor paperwork — registration forms, certificates, price letters, company profiles
- "other": none of the above
Rules: judge only from the provided excerpt + signals. If genuinely torn between two labels, pick the likelier one and lower your confidence accordingly.
Return JSON: {"label": "...", "confidence": 0..1, "summary": "<2-3 sentence summary of what the document is>", "productCountEstimate": <int or null>}`;

/**
 * @param {string} filePath absolute path to the stored upload
 * @param {{log?: Function, previewsDir?: string}} ctx
 * @returns {Promise<{label:string, confidence:number, method:string, summary:string,
 *   signals:object, needsVerification:boolean, previewPath:string|null}>}
 */
export async function triageFile(filePath, ctx = {}) {
  const { log, previewsDir } = ctx;
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const size = fs.statSync(filePath).size;
  const signals = { ext, size, filenameTokens: name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) };

  // ── rule tier ──────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    return finalize({
      label: "product_image",
      confidence: 0.95,
      method: "rule",
      summary: "Image file — routed to media pairing.",
      signals,
      previewPath: await snapshot(filePath, ext, previewsDir),
    });
  }

  if (ext === ".xlsx" || ext === ".xlsm") {
    const sig = await detectBkTemplateSignature(filePath);
    signals.templateSignature = sig;
    if (sig.isTemplate) {
      return finalize({
        label: "bk_template",
        confidence: 0.98,
        method: "rule",
        summary: `BK template workbook (${sig.kind}) — ${sig.evidence}. Filled templates short-circuit to validation (D12).`,
        signals,
        previewPath: null,
      });
    }
    // non-template spreadsheet → likely a catalogue in sheet form; let Claude decide from a text sample
  }

  // ── text sampling for the LLM tier ────────────────────────────────
  let excerpt = "";
  let previewPath = null;

  if (ext === ".pdf") {
    const { pageCount, pages } = await extractText(filePath, { maxPages: 3 });
    signals.pageCount = pageCount;
    signals.textDensity = Math.round(pages.reduce((s, p) => s + p.text.length, 0) / pages.length);
    // sample: first pages + one middle page (Design Doc §3 Stage 0)
    const sampled = pages.map((p) => `[page ${p.page}] ${p.text}`);
    if (pageCount > 6) {
      const mid = Math.floor(pageCount / 2);
      const { pages: midPages } = await extractText(filePath, { only: [mid] });
      if (midPages[0]) sampled.push(`[page ${midPages[0].page}] ${midPages[0].text}`);
    }
    excerpt = sampled.join("\n").slice(0, 8000);
    previewPath = await snapshot(filePath, ext, previewsDir);
  } else if (ext === ".docx") {
    excerpt = (await extractDocxText(filePath)).slice(0, 8000);
    signals.textDensity = excerpt.length;
  } else if (ext === ".html" || ext === ".htm") {
    // D16 — URL-ingested web page: classify its text like any document
    const { htmlToText } = await import("../services/weburl.js");
    excerpt = htmlToText(fs.readFileSync(filePath, "utf8")).slice(0, 8000);
    signals.textDensity = excerpt.length;
  } else if (ext === ".xlsx" || ext === ".xlsm") {
    excerpt = JSON.stringify(signals.templateSignature ?? {});
  } else {
    return finalize({
      label: "other",
      confidence: 0.6,
      method: "rule",
      summary: `Unsupported extension ${ext} — routed to verification (D11).`,
      signals,
      previewPath: null,
    });
  }

  // ── LLM tier ───────────────────────────────────────────────────────
  if (!aiAvailable()) {
    // No key: never guess (integrity rule 3) — route to human triage.
    return finalize({
      label: "other",
      confidence: 0,
      method: "rule",
      summary: "ANTHROPIC_API_KEY not set — routed to human triage, never guessed.",
      signals,
      previewPath,
    });
  }

  let result;
  try {
    result = await callClaudeJSON({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Filename: ${name}\nStructural signals: ${JSON.stringify({
            ext,
            pageCount: signals.pageCount ?? null,
            textDensity: signals.textDensity ?? null,
          })}\n\nExcerpt:\n${excerpt}`,
        },
      ],
      log,
      tag: `triage:${name}`,
    });
  } catch (err) {
    // AI tier unavailable (credits, outage) → route to HUMAN triage with the
    // reason visible — never guess (§6.3), never fail the upload with a 500
    log?.({ kind: "triage_ai_unavailable", file: name, message: err.message });
    return finalize({
      label: "other",
      confidence: 0,
      method: "rule",
      summary: `AI classification unavailable (${err.message.slice(0, 120)}) — routed to human triage.`,
      signals,
      previewPath,
    });
  }

  return finalize({
    label: TRIAGE_LABELS.includes(result.label) ? result.label : "other",
    confidence: Number(result.confidence) || 0,
    method: "text",
    summary: result.summary || "",
    signals: { ...signals, productCountEstimate: result.productCountEstimate ?? null },
    previewPath,
  });
}

function finalize(t) {
  const uncertain = t.confidence < THRESHOLDS.triageAuto;
  return {
    ...t,
    // D11: non-product routes ALWAYS require human confirmation before filing;
    // uncertain classifications join the same queue (never guessed).
    needsVerification: NON_PRODUCT.has(t.label) || uncertain,
  };
}

/** First-page snapshot for the D11 prompt (PDF page 1 → PNG; images pass through). */
async function snapshot(filePath, ext, previewsDir) {
  if (!previewsDir) return null;
  try {
    if (IMAGE_EXTS.has(ext)) {
      const dest = path.join(previewsDir, path.basename(filePath));
      fs.copyFileSync(filePath, dest);
      return dest;
    }
    if (ext === ".pdf") {
      const [first] = await rasterizePages(filePath, [1], { scale: 1.5 });
      if (!first) return null;
      const dest = path.join(previewsDir, `${path.basename(filePath, ".pdf")}_p1.png`);
      fs.writeFileSync(dest, first.png);
      return dest;
    }
  } catch {
    return null; // snapshot failure must never block triage
  }
  return null;
}
