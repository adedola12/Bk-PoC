import sharp from "sharp";
import { rasterizePages } from "../services/pdf.js";
import { callClaudeJSON } from "../services/anthropic.js";

/**
 * Panel-segmented vision extraction (Design Doc §3, hostile path). Ultra-wide
 * multi-panel pages are rasterized, sliced into overlapping vertical panels
 * (a 2381-pt QRG page downsampled whole would destroy label-value legibility),
 * and each panel goes through Claude vision. Products are merged across the
 * panel overlap by part number.
 *
 * Integrity: extraction preserves printed values VERBATIM — "2700 V" stays
 * "2700 V" (§6.1). Catching it is the validators' job, never the extractor's.
 */

const PANEL_TARGET_WIDTH = 1400; // px — keeps text legible after provider downscale
const PANEL_OVERLAP = 0.12;

const VISION_CATALOG_SYSTEM = `You extract products from a rasterized page of a POWER-TOOL trade catalog.
The page shows product panels: name/model, part number ("Part No: ..."), and a specification list of label-value pairs.
Read label-value pairs FROM THE VISUAL LAYOUT — a value belongs to the label it sits next to in its panel.
Copy printed values VERBATIM, even if they look wrong or implausible. Never correct, never omit a printed spec.
Return JSON:
{"products":[{
  "name": "model name as printed, e.g. GWS 27-230 PR",
  "partNumber": "as printed, keep spacing",
  "specs": {"<label as printed>": {"value": "<as printed>", "unit": "<unit if printed>", "raw": "<label: value verbatim>"}},
  "confidence": 0..1
}]}
Only products visible in THIS image. Partial panels at the image edge: include them only if the part number is visible.`;

/**
 * @param {string} filePath
 * @param {number} pageNum
 * @returns {Promise<{products: Array, panels: number, calls: number}>}
 */
export async function visionExtractPage(filePath, pageNum, { log } = {}) {
  const [pageImage] = await rasterizePages(filePath, [pageNum], { scale: 2 });
  if (!pageImage) throw new Error(`could not rasterize page ${pageNum}`);

  const img = sharp(pageImage.png);
  const { width, height } = await img.metadata();

  const panelCount = Math.max(1, Math.ceil(width / PANEL_TARGET_WIDTH));
  const step = Math.floor(width / panelCount);
  const overlapPx = Math.floor(step * PANEL_OVERLAP);

  const products = new Map(); // normalized part number → product
  let calls = 0;
  for (let p = 0; p < panelCount; p++) {
    const left = Math.max(0, p * step - (p > 0 ? overlapPx : 0));
    const panelWidth = Math.min(width - left, step + overlapPx * 2);
    const panelPng = await sharp(pageImage.png)
      .extract({ left, top: 0, width: panelWidth, height })
      .png()
      .toBuffer();

    calls++;
    const json = await callClaudeJSON({
      system: VISION_CATALOG_SYSTEM,
      maxTokens: 12000, // dense QRG panels carry 10+ products; truncated JSON is unusable
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: panelPng.toString("base64") },
            },
            { type: "text", text: `Catalog page ${pageNum}, panel ${p + 1}/${panelCount}.` },
          ],
        },
      ],
      log,
      tag: `vision:p${pageNum}.${p + 1}`,
    });

    for (const prod of json.products || []) {
      if (!prod.partNumber && !prod.name) continue;
      const key = normCode(prod.partNumber) || `name:${(prod.name || "").toLowerCase()}`;
      const existing = products.get(key);
      // overlap merge: same part number twice across panels = the same product;
      // keep the richer read (A3-style same-code-different-product collisions
      // are detected downstream by the validators, where they are FLAGGED)
      if (!existing || Object.keys(prod.specs || {}).length > Object.keys(existing.specs || {}).length) {
        if (existing && !sameProduct(existing, prod)) {
          // different names sharing a code — keep BOTH so validators can flag A3
          products.set(`${key}#${products.size}`, { ...prod, page: pageNum });
          continue;
        }
        products.set(key, { ...prod, page: pageNum });
      }
    }
  }

  return { products: [...products.values()], panels: panelCount, calls };
}

export const normCode = (code) => String(code || "").replace(/\s+/g, "").trim();

const sameProduct = (a, b) => {
  const tok = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const ta = tok(a.name);
  const tb = tok(b.name);
  if (!ta.size || !tb.size) return true;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.min(ta.size, tb.size) >= 0.5;
};
