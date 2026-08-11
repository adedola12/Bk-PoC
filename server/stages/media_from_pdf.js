import { extractPlacedImages, pickProductImage, extractTextPositions } from "../services/pdf.js";
import { uploadBufferToCloudinary, hasCloudinary } from "../services/cloudinary.js";

/**
 * Attach the product photo carried inside a source PDF (D8 media).
 *
 * A `Cover Image` could previously only come from a SEPARATELY UPLOADED
 * product_image paired by SKU, so a datasheet that plainly shows the product
 * still emitted with the media column empty and the UI showed "IMAGE PENDING".
 *
 * Products are matched to images BY POSITION, not by page. Page was the
 * original signal and it fails exactly where it matters most: the Bosch quick
 * reference guide carries ~99 products on two pages, so every product on a
 * page took the same photo and the client saw one image repeated ninety-nine
 * times. Each product is now anchored to where its own code is printed, and
 * takes the nearest image to that anchor — which is what a person reading the
 * page does.
 *
 * Two judgements this makes, both learned from real files:
 *
 *   page furniture  A graphic repeated at identical dimensions across 2+ pages
 *                   is a background, not a product. The ENESS catalogue repeats
 *                   a 1655x1153 full-bleed across two pages, which outsized the
 *                   real product shot and would otherwise have been chosen.
 *   which image     Where a product's code cannot be located on the page, there
 *                   is no anchor to measure from, so it falls back to ranking
 *                   the page's images by mid-tone coverage — which separates
 *                   shaded photographs from bimodal line art (the Alca
 *                   datasheet's biggest image is a dimensioned drawing).
 *
 * Never throws: imaging is an enhancement, and losing it must not cost an
 * extraction run that has already paid for the model work.
 *
 * @returns {Promise<number>} how many IPRs were given an image
 */

/** Codes are printed with spaces and dashes that the extractor does not keep. */
export const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Decide which image each product gets, with no I/O.
 *
 * Split out from the upload so the choice can be tested against a real PDF
 * without a Cloudinary account and without spending an extraction run — the
 * page-vs-position bug was invisible in every unit test precisely because
 * nothing exercised the choice on a dense multi-product page.
 *
 * @returns {Promise<Array<{ipr:object, image:object, viaAnchor:boolean}>>}
 */
export async function planImageAssignments({ iprs, byPage, anchorsByPage, pageOf, anchorFor }) {
  const out = [];
  for (const ipr of iprs) {
    if (ipr.mediaRefs?.length) continue; // a real product_image already won
    const page = pageOf(ipr);
    const pool = page && byPage.has(page) ? byPage.get(page) : byPage.size === 1 ? [...byPage.values()][0] : [];
    if (!pool.length) continue;

    let best = null;
    let viaAnchor = false;
    const anchor = page && anchorsByPage ? anchorFor(ipr, page) : null;
    if (anchor) {
      // nearest image to where this product's own code is printed — only
      // images whose rect we actually trust can be measured against it
      let bestD = Infinity;
      for (const im of pool) {
        if (!im.inBounds) continue;
        const d = Math.hypot(im.x + im.w / 2 - anchor.x, im.y + im.h / 2 - anchor.y);
        if (d < bestD) {
          bestD = d;
          best = im;
        }
      }
      viaAnchor = Boolean(best);
    }
    if (!best) {
      // No anchor, so this IS the biggest-image question — apply the strict
      // source-pixel gate here so a thumbnail or icon cannot outrank the
      // product shot the way it never could before.
      const big = pool.filter((i) => i.width * i.height >= 30000);
      const distinct = [...new Map((big.length ? big : pool).map((i) => [i.name, i])).values()];
      try {
        best = await pickProductImage([...distinct].sort((a, b) => b.width * b.height - a.width * a.height));
      } catch {
        best = null;
      }
    }
    if (best) out.push({ ipr, image: best, viaAnchor });
  }
  return out;
}

export async function attachEmbeddedImages(iprs, filePath, sourceFile, { log } = {}) {
  if (!iprs?.length || !filePath || !/\.pdf$/i.test(filePath)) return 0;
  if (!hasCloudinary()) {
    log?.({ kind: "media_skipped", reason: "cloudinary_not_configured", file: sourceFile });
    return 0;
  }

  /* The source-pixel gate exists to stop a logo winning "the biggest image on
     this page". Anchor matching does not ask that question — it asks which
     image sits nearest this product's code — and under the default gate the
     Bosch cards' own thumbnails were the casualties: they are ~2–5k source
     pixels, so 30000 discarded exactly the images the client wanted and left
     only the lifestyle photography. Collect small images too and let position
     decide; the fallback path below still applies the strict gate, because
     that path IS asking the biggest-image question.
     minPlacedArea drops bullets and rules, which no proximity test survives. */
  let images = [];
  try {
    images = await extractPlacedImages(filePath, { minArea: 2000, minPlacedArea: 400 });
  } catch (err) {
    log?.({ kind: "media_error", stage: "extract", file: sourceFile, message: err.message });
    return 0;
  }
  if (!images.length) return 0;

  /* Page furniture repeats at the same size AND THE SAME PLACE on every page;
     a product photo does not. Size alone was the old test, and on a two-page
     poster that condemned any photo appearing on both pages — it left 10 of
     Bosch's 38 usable images standing. Keying on position as well as size
     keeps the ENESS full-bleed out (identical rect on each page) without
     throwing away catalogue photography. */
  const placementKey = (i) =>
    i.inBounds
      ? `${i.width}x${i.height}@${Math.round(i.x)},${Math.round(i.y)},${Math.round(i.w)}x${Math.round(i.h)}`
      : `${i.width}x${i.height}`; // no trustworthy rect — fall back to the old size-only test
  const pagesByPlacement = new Map();
  for (const i of images) {
    const k = placementKey(i);
    if (!pagesByPlacement.has(k)) pagesByPlacement.set(k, new Set());
    pagesByPlacement.get(k).add(i.page);
  }
  const background = new Set([...pagesByPlacement.entries()].filter(([, p]) => p.size >= 2).map(([k]) => k));
  const usable = images.filter((i) => !background.has(placementKey(i)));
  if (!usable.length) return 0;

  const byPage = new Map();
  for (const i of usable) {
    if (!byPage.has(i.page)) byPage.set(i.page, []);
    byPage.get(i.page).push(i);
  }

  /* Text anchors, in the same coordinate frame as the image rects. Only the
     pages that actually carry images are read — a 104-page booklet should not
     pay for text it will never measure against. */
  const anchorsByPage = new Map();
  try {
    const { pages } = await extractTextPositions(filePath, { only: [...byPage.keys()] });
    for (const p of pages) {
      anchorsByPage.set(
        p.page,
        p.items.map((it) => ({ norm: norm(it.str), x: it.x, y: it.y })).filter((it) => it.norm)
      );
    }
  } catch (err) {
    log?.({ kind: "media_error", stage: "anchors", file: sourceFile, message: err.message });
  }

  const pageOf = (ipr) => {
    const get = (group, key) => (ipr[group] instanceof Map ? ipr[group].get(key) : ipr[group]?.[key]);
    const attrs = ipr.attributes instanceof Map ? [...ipr.attributes.values()] : Object.values(ipr.attributes || {});
    for (const f of [get("identity", "productCode"), get("identity", "name"), ...attrs]) {
      if (f?.sourceRef?.page) return f.sourceRef.page;
    }
    return null;
  };

  /* Where is this product printed? Its code is the reliable anchor — names get
     reworded by the extractor, codes do not. A code can be split across text
     items ("GSB" / "20-2 RE"), so a containment test either way counts, with
     the longest match winning to keep a two-character fragment from matching
     half the page. */
  const anchorFor = (ipr, page) => {
    const items = anchorsByPage.get(page);
    if (!items?.length) return null;
    const get = (group, key) => (ipr[group] instanceof Map ? ipr[group].get(key) : ipr[group]?.[key]);
    const keys = [get("identity", "productCode")?.value, get("identity", "name")?.value]
      .map(norm)
      .filter((k) => k.length >= 4);
    let best = null;
    let bestLen = 0;
    for (const key of keys) {
      for (const it of items) {
        const hit = it.norm.includes(key) ? key.length : key.includes(it.norm) ? it.norm.length : 0;
        if (hit > bestLen) {
          bestLen = hit;
          best = it;
        }
      }
      if (best) break; // the code matched; do not let the name override it
    }
    return bestLen >= 4 ? best : null;
  };

  const slug = (s) =>
    String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "product";

  // One upload per distinct image, not per product: ten colour variants of one
  // toilet-roll holder share a single photo, and re-uploading it ten times
  // would be ten round trips for one asset.
  const urlByImage = new Map();
  let attached = 0;

  const plan = await planImageAssignments({ iprs, byPage, anchorsByPage, pageOf, anchorFor });
  const byAnchor = plan.filter((p) => p.viaAnchor).length;

  for (const { ipr, image: best } of plan) {
    const cacheKey = `${best.page}:${best.name}`;
    try {
      if (!urlByImage.has(cacheKey)) {
        const sku = ipr.identity?.productCode?.value || ipr.identity?.name?.value || slug(sourceFile);
        urlByImage.set(cacheKey, await uploadBufferToCloudinary(best.buffer, slug(sku)));
      }
      ipr.mediaRefs = [urlByImage.get(cacheKey)];
      attached++;
    } catch (err) {
      log?.({ kind: "media_error", stage: "upload", file: sourceFile, message: err.message });
      break; // Cloudinary is down or rejecting — stop rather than retry per row
    }
  }

  if (attached) {
    log?.({ kind: "media_attached", file: sourceFile, count: attached, unique: urlByImage.size, byAnchor });
  }
  return attached;
}
