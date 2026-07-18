import fs from "node:fs";

/**
 * PDF services. Rasterization uses `pdf-to-img` (pdfjs-based, pure JS):
 * chosen over poppler wrappers because it needs no native binaries on
 * Windows/PoC hardware, and pdfjs rendering fidelity is sufficient for
 * Claude-vision input at 2–3× scale (D8 allows any solid Node option).
 * Text extraction uses pdfjs-dist directly so both paths share one engine.
 */

/**
 * @param {string} filePath
 * @param {{maxPages?: number, only?: number[]}} [opts] - `only` extracts just
 *   the listed 1-based pages (cheap for sampling one middle page of a 104-pp doc)
 * @returns {Promise<{pageCount:number, pages:Array<{page:number,text:string,items:number}>}>}
 */
export async function extractText(filePath, { maxPages = Infinity, only = null } = {}) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  const targets = only
    ? only.filter((n) => n >= 1 && n <= doc.numPages)
    : Array.from({ length: Math.min(doc.numPages, maxPages) }, (_, i) => i + 1);
  for (const i of targets) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    pages.push({ page: i, text, items: content.items.length });
    page.cleanup();
  }
  const result = { pageCount: doc.numPages, pages };
  await doc.destroy();
  return result;
}

/**
 * Rasterize selected pages to PNG buffers for vision extraction / D11 snapshots.
 * @param {string} filePath
 * @param {number[]} pageNumbers 1-based
 * @returns {Promise<Array<{page:number, png:Buffer}>>}
 */
export async function rasterizePages(filePath, pageNumbers, { scale = 2 } = {}) {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(filePath, { scale });
  const wanted = new Set(pageNumbers);
  const out = [];
  let n = 0;
  for await (const image of doc) {
    n++;
    if (wanted.has(n)) out.push({ page: n, png: image });
    if (out.length === wanted.size) break;
  }
  return out;
}
