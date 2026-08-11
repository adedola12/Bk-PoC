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
  // One placement per drawing; callers wanting "the images" want them once.
  const placed = await extractPlacedImages(filePath, { pages, minArea, minPlacedArea: 0 });
  const byName = new Map();
  for (const p of placed) {
    const key = `${p.page}:${p.name}`;
    if (!byName.has(key)) byName.set(key, { page: p.page, name: p.name, width: p.width, height: p.height, buffer: p.buffer });
  }
  return [...byName.values()].sort((a, b) => b.width * b.height - a.width * a.height);
}

/**
 * The same images, but each PLACEMENT located on its page.
 *
 * Knowing an image exists is not enough to say which product it belongs to.
 * The Bosch quick-reference guide puts ~99 products on two pages, so mapping
 * products to images by page number alone gave every product on the page the
 * same photo — one image for ninety-nine products, which is what the client
 * saw. Position is the missing signal: with it, a product can be matched to
 * the image nearest its own code (see stages/media_from_pdf.js).
 *
 * Coordinates are PDF user space with a bottom-left origin — the same frame
 * extractTextPositions reports — so image rects and text anchors are directly
 * comparable without either caller converting.
 *
 * Getting there means tracking the CTM through the operator list by hand:
 * pdfjs reports WHAT is drawn, never WHERE. save/restore/transform maintain
 * it, and form XObjects push their own matrix — handling those moved Bosch
 * from 58 correctly-located placements on page one to 150 across the file.
 * Anything still landing outside the MediaBox is a construct this walk does
 * not model (tiling patterns, soft-mask groups) and is dropped rather than
 * trusted, since a wrong position would pull the wrong photo onto a product.
 *
 * `minPlacedArea` is in square points and filters by how large the image is
 * ON THE PAGE, which `minArea` (source pixels) cannot see: a 600x500 source
 * bitmap placed as a 12pt bullet is decoration, not a product shot.
 *
 * @returns {Promise<Array<{page:number, name:string, width:number, height:number,
 *   buffer:Buffer, x:number, y:number, w:number, h:number}>>}
 */
export async function extractPlacedImages(
  filePath,
  { pages = null, minArea = 30000, minPlacedArea = 2000 } = {}
) {
  const { getDocument, OPS, Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
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
    const [vx0, vy0, vx1, vy1] = page.view; // MediaBox, user space
    const ops = await page.getOperatorList();

    // Walk the operator list keeping the current transform, collecting a rect
    // per paint. Decoding is deferred so a repeated image decodes once.
    const identity = [1, 0, 0, 1, 0, 0];
    let ctm = identity.slice();
    const stack = [];
    const hits = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() ?? identity.slice();
      else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice());
        ctm = Util.transform(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? identity.slice();
      else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
        const name = args[0];
        if (typeof name !== "string") continue;
        // an image occupies the unit square mapped through the CTM
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((pt) => Util.applyTransform(pt, ctm));
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const w = Math.max(...xs) - x;
        const h = Math.max(...ys) - y;
        const pad = 5; // rounding slack at the page edge
        const inBounds = x >= vx0 - pad && y >= vy0 - pad && x + w <= vx1 + pad && y + h <= vy1 + pad;
        // A rect outside the MediaBox means this walk did not model something
        // (tiling pattern, soft-mask group) and the POSITION is not to be
        // trusted. The image still is: it is returned unplaced so callers can
        // fall back to ranking it, rather than losing it outright — dropping
        // them took Bosch from 47 usable images to 10.
        if (inBounds && w * h < minPlacedArea) continue;
        hits.push(inBounds ? { name, x, y, w, h, inBounds: true } : { name, inBounds: false });
      }
    }

    const decoded = new Map(); // name -> {width,height,buffer} | null
    for (const hit of hits) {
      if (!decoded.has(hit.name)) {
        let entry = null;
        try {
          const img = await new Promise((resolve) => page.objs.get(hit.name, resolve));
          if (img?.width && img?.height && img.width * img.height >= minArea) {
            const png = await toPng(img);
            if (png) entry = { width: img.width, height: img.height, buffer: png };
          }
        } catch {
          entry = null; // object not resolvable — skip rather than fail the document
        }
        decoded.set(hit.name, entry);
      }
      const d = decoded.get(hit.name);
      if (d) {
        out.push(
          hit.inBounds
            ? { page: p, name: hit.name, ...d, x: hit.x, y: hit.y, w: hit.w, h: hit.h, inBounds: true }
            : { page: p, name: hit.name, ...d, inBounds: false }
        );
      }
    }
  }

  return out;
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
