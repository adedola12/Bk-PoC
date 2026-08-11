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
 * Positional text extraction — items with page coordinates, for the
 * label-value pairing QA (Design Doc §3 Stage 1). pdfjs y-origin is
 * bottom-left; we keep raw transform values (x=tx[4], y=tx[5]).
 * @returns {Promise<{pageCount:number, pages:Array<{page:number, width:number, height:number,
 *   items:Array<{str:string, x:number, y:number}>}>}>}
 */
export async function extractTextPositions(filePath, { only = null, maxPages = Infinity } = {}) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const targets = only
    ? only.filter((n) => n >= 1 && n <= doc.numPages)
    : Array.from({ length: Math.min(doc.numPages, maxPages) }, (_, i) => i + 1);
  const pages = [];
  for (const i of targets) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      page: i,
      width: viewport.width,
      height: viewport.height,
      items: content.items
        .filter((it) => it.str.trim())
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] })),
    });
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

/**
 * Pull the images embedded in a PDF's pages (D8 media).
 *
 * Product datasheets carry the product photo inside the PDF, but the only
 * source of a `Cover Image` used to be a separately uploaded product_image
 * file paired by SKU — so a datasheet that plainly shows the product still
 * emitted with the media column empty.
 *
 * `minArea` exists to skip logos, rules and icons: a real product photo on a
 * datasheet is a few hundred pixels square, while brand marks come in around
 * 232x77. Judged on area rather than either dimension so a wide product shot
 * is not thrown away with the letterheads.
 *
 * Returns PNG buffers, largest first, so a caller wanting "the product" can
 * take the head of the list.
 */
export async function extractEmbeddedImages(filePath, { pages = null, minArea = 30000 } = {}) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const sharp = (await import("sharp")).default;

  const toPng = async (img) => {
    // pdfjs hands back raw pixel data: 1 = grayscale 1bpp (skip, it is almost
    // always a mask), 2 = RGB 24bpp, 3 = RGBA 32bpp.
    const channels = img.kind === 3 ? 4 : img.kind === 2 ? 3 : null;
    if (!channels || !img.data) return null;
    const expected = img.width * img.height * channels;
    const buf = Buffer.from(img.data.buffer ?? img.data, img.data.byteOffset ?? 0, img.data.length ?? expected);
    if (buf.length < expected) return null; // truncated/unsupported encoding
    return sharp(buf.subarray(0, expected), { raw: { width: img.width, height: img.height, channels } })
      .png()
      .toBuffer();
  };

  const doc = await getDocument({ url: filePath, disableFontFace: true }).promise;
  const wanted = pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const out = [];

  for (const p of wanted) {
    if (p < 1 || p > doc.numPages) continue;
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    const seen = new Set();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== OPS.paintImageXObject && ops.fnArray[i] !== OPS.paintJpegXObject) continue;
      const name = ops.argsArray[i][0];
      if (typeof name !== "string" || seen.has(name)) continue;
      seen.add(name);
      let img;
      try {
        img = await new Promise((resolve) => page.objs.get(name, resolve));
      } catch {
        continue; // object not resolvable — skip rather than fail the document
      }
      if (!img?.width || !img?.height) continue;
      if (img.width * img.height < minArea) continue;
      let png = null;
      try {
        png = await toPng(img);
      } catch {
        png = null;
      }
      if (png) out.push({ page: p, name, width: img.width, height: img.height, buffer: png });
    }
  }

  return out.sort((a, b) => b.width * b.height - a.width * a.height);
}

/**
 * Choose the product photo from a page's embedded images.
 *
 * "Largest wins" is wrong: the Alca datasheet's biggest image is a dimensioned
 * line drawing, with the actual product photo second. Brightness does not
 * separate them either — a chrome fitting on white reads as 74% white, more
 * than the drawing's 65%.
 *
 * Mid-tone coverage does, but only WITHIN a document: a drawing is bimodal
 * (white paper, black lines) while a photo carries shading, so Alca scores
 * 46% for the photo against 24% for the drawing. Across documents the scale
 * shifts — the chrome Jaquar photo sits at 17% — so this ranks candidates
 * against each other and never against a fixed threshold.
 *
 * The area gate first drops wordmarks and banner strips, which can otherwise
 * score well on mid-tone while being nobody's product.
 */
export async function pickProductImage(images, { minShareOfLargest = 0.25 } = {}) {
  if (!images?.length) return null;
  if (images.length === 1) return images[0];

  const sharp = (await import("sharp")).default;
  const largest = images[0].width * images[0].height;
  const candidates = images.filter((i) => (i.width * i.height) / largest >= minShareOfLargest);
  if (candidates.length === 1) return candidates[0];

  const midTone = async (buf) => {
    const { data } = await sharp(buf)
      .removeAlpha().greyscale().resize(140, 140, { fit: "inside" })
      .raw().toBuffer({ resolveWithObject: true });
    let mid = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > 45 && data[i] < 225) mid++;
    return mid / data.length;
  };

  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    try {
      score = await midTone(c.buffer);
    } catch {
      score = 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
