import path from "node:path";
import { callClaudeJSON } from "../services/anthropic.js";
import { templateRowsToIprs } from "../emitter/index.js";

/**
 * Stage 2 — Extraction → Intermediate Product Record (Design Doc §3).
 * Every field carries {value, unit, raw, sourceRef, confidence, method}.
 * Raw source strings are retained VERBATIM (§6.2) — the model is instructed
 * to echo them, and normalization later never overwrites them.
 */

const EXTRACT_SYSTEM = `You extract product data from construction-materials documents into structured records.
For EVERY field return an object: {"value": <normalized-ish value or null>, "unit": <unit string or null>, "raw": "<the EXACT verbatim source text this came from>", "confidence": 0..1}.
Rules:
- raw is sacred: copy the source string exactly, preserving "13,45 kg" style locale formats, typos and all.
- NEVER guess. A field not present in the document is null with confidence 0.
- Preserve manufacturer terminology verbatim in raw values.
- confidence reflects how certain the label-value association is in THIS document.
- color = the colour/finish of THIS specific variant only (finish codes embedded in the product code count, e.g. -CHR- → Chrome). The list of OTHER available finishes goes in "finishes", never in color.
- finishes = available finish OPTION codes/names exactly as listed. EXCLUDE plating/coating thickness specs — those are features.
- range values (e.g. water pressure "0,05 – 1,0 MPa"): raw must contain the FULL range text verbatim, never just one endpoint.

Return JSON:
{"products":[{
  "brand": F, "subBrand": F, "productCode": F, "productName": F, "collection": F,
  "color": F, "material": F, "countryOfOrigin": F,
  "dimensions1": F, "dimensions2": F, "dimensions3": F,
  "weightKg": F, "packQty": F, "ean": F,
  "waterPressure": {"value": {"min": n, "max": n} | n, "unit": "MPa", "raw": "the FULL verbatim range text e.g. 0,05-1,0 MPa", "confidence": n},
  "warranty": F,
  "norms": {"value": [..strings], "raw": "...", "confidence": n},
  "certifications": {"value": [..strings], "raw": "...", "confidence": n},
  "finishes": {"value": [..finish codes], "raw": "...", "confidence": n},
  "features": {"value": [..strings], "raw": "...", "confidence": n}
}]}
where F is the field object shape above. dimensions1/2/3 = length/width(depth)/height as printed.`;

const DRAWING_SYSTEM = `You read technical line drawings on product datasheets.
Extract ONLY the dimension callouts visible in the drawing (numbers with mm implied or stated).
Return JSON: {"dimensionsMm": {"d1": n|null, "d2": n|null, "d3": n|null}, "callouts": ["raw numbers seen"], "confidence": 0..1}
d1/d2/d3 = the three principal dimensions (longest first if orientation unclear). Do not guess hidden dimensions.`;

/**
 * Extract IPR-shaped records from an ingested document.
 * @param {object} ingested - stage1 output
 * @param {string} sourceFile - original filename for provenance
 * @param {{log?:Function, withDrawingPass?:boolean}} ctx
 */
export async function extractIprs(ingested, sourceFile, ctx = {}) {
  const { log, withDrawingPass = true } = ctx;

  // ── Twyford short-circuit: filled BK template is already structured ──
  if (ingested.kind === "template") {
    return templateRowsToIprs(ingested.rows, sourceFile);
  }

  if (ingested.kind === "pdf_text") {
    const text = ingested.pages.map((p) => `[page ${p.page}] ${p.text}`).join("\n").slice(0, 30000);
    const json = await callClaudeJSON({
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: `Document: ${sourceFile}\n\n${text}` }],
      maxTokens: 4000,
      log,
      tag: `extract:${sourceFile}`,
    });

    const iprs = (json.products || []).map((p) => modelProductToIpr(p, sourceFile));

    // ── drawing pass: dimension callouts live in the technical drawing, not
    // the text layer (Jaquar/Artize case). Drawing-read dims are method
    // "derived" and flagged (D5 / §5).
    if (withDrawingPass && iprs.length === 1 && missingDims(iprs[0])) {
      try {
        const [first] = await ingested.raster([1], { scale: 2 });
        if (first) {
          const dj = await callClaudeJSON({
            system: DRAWING_SYSTEM,
            maxTokens: 800,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: Buffer.from(first.png).toString("base64"),
                    },
                  },
                  { type: "text", text: `Datasheet page 1 of ${sourceFile}. Read the drawing dimensions.` },
                ],
              },
            ],
            log,
            tag: `drawing:${sourceFile}`,
          });
          applyDrawingDims(iprs[0], dj, sourceFile);
        }
      } catch (err) {
        log?.({ kind: "drawing_pass_failed", file: sourceFile, message: err.message });
      }
    }
    return iprs;
  }

  throw new Error(`stage2 has no extractor for kind ${ingested.kind}`);
}

/* ─────────── helpers ─────────── */

const FIELD_GROUPS = {
  identity: ["brand", "subBrand", "productCode", "productName", "collection"],
  attributes: ["color", "material", "countryOfOrigin", "dimensions1", "dimensions2", "dimensions3", "waterPressure", "finishes", "features"],
  logistics: ["weightKg", "packQty", "ean"],
  compliance: ["norms", "certifications", "warranty"],
};

function toField(f, sourceFile, page = 1) {
  if (!f || (f.value == null && !f.raw)) return null;
  return {
    value: f.value ?? null,
    unit: f.unit ?? null,
    raw: f.raw ?? null,
    sourceRef: { file: sourceFile, page, region: null },
    confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
    method: "text",
  };
}

function modelProductToIpr(p, sourceFile) {
  const ipr = { identity: {}, attributes: {}, logistics: {}, compliance: {}, mediaRefs: [] };
  for (const [group, keys] of Object.entries(FIELD_GROUPS)) {
    for (const key of keys) {
      const field = toField(p[key], sourceFile);
      if (!field) continue;
      if (group === "identity") {
        const idKey = key === "productName" ? "name" : key;
        ipr.identity[idKey] = field;
      } else {
        ipr[group][key] = field;
      }
    }
  }
  return ipr;
}

const missingDims = (ipr) =>
  !ipr.attributes.dimensions1 || ipr.attributes.dimensions1.value == null;

function applyDrawingDims(ipr, dj, sourceFile) {
  const dims = dj?.dimensionsMm || {};
  const conf = Math.max(0, Math.min(1, Number(dj?.confidence) || 0)) * 0.9; // derived — never fully certain
  const mk = (n) =>
    n == null
      ? null
      : {
          value: n,
          unit: "mm",
          raw: (dj.callouts || []).join(", ") || String(n),
          sourceRef: { file: sourceFile, page: 1, region: "technical drawing" },
          confidence: conf,
          method: "derived", // drawing-read dimensions are derived + UI-flagged (§5)
        };
  for (const [slot, val] of [["dimensions1", dims.d1], ["dimensions2", dims.d2], ["dimensions3", dims.d3]]) {
    const field = mk(val);
    if (field && !ipr.attributes[slot]?.value) ipr.attributes[slot] = field;
  }
}
