import { extractEmbeddedImages, pickProductImage } from "../services/pdf.js";
import { uploadBufferToCloudinary, hasCloudinary } from "../services/cloudinary.js";

/**
 * Attach the product photo carried inside a source PDF (D8 media).
 *
 * A `Cover Image` could previously only come from a SEPARATELY UPLOADED
 * product_image paired by SKU, so a datasheet that plainly shows the product
 * still emitted with the media column empty and the UI showed "IMAGE PENDING".
 *
 * Two judgements this makes, both learned from real files:
 *
 *   page furniture  A graphic repeated at identical dimensions across 2+ pages
 *                   is a background, not a product. The ENESS catalogue repeats
 *                   a 1655x1153 full-bleed across two pages, which outsized the
 *                   real product shot and would otherwise have been chosen.
 *   which image     Within one page, "largest" is wrong — the Alca datasheet's
 *                   biggest image is a dimensioned line drawing with the photo
 *                   second. pickProductImage ranks by mid-tone coverage, which
 *                   separates shaded photographs from bimodal line art.
 *
 * Products are matched to the image on THEIR OWN page via the sourceRef.page
 * that every IPR field already carries, so a multi-product catalogue gets one
 * image each rather than all sharing page one.
 *
 * Never throws: imaging is an enhancement, and losing it must not cost an
 * extraction run that has already paid for the model work.
 *
 * @returns {Promise<number>} how many IPRs were given an image
 */
export async function attachEmbeddedImages(iprs, filePath, sourceFile, { log } = {}) {
  if (!iprs?.length || !filePath || !/\.pdf$/i.test(filePath)) return 0;
  if (!hasCloudinary()) {
    log?.({ kind: "media_skipped", reason: "cloudinary_not_configured", file: sourceFile });
    return 0;
  }

  let images = [];
  try {
    images = await extractEmbeddedImages(filePath);
  } catch (err) {
    log?.({ kind: "media_error", stage: "extract", file: sourceFile, message: err.message });
    return 0;
  }
  if (!images.length) return 0;

  const pagesByDim = new Map();
  for (const i of images) {
    const k = `${i.width}x${i.height}`;
    if (!pagesByDim.has(k)) pagesByDim.set(k, new Set());
    pagesByDim.get(k).add(i.page);
  }
  const background = new Set([...pagesByDim.entries()].filter(([, p]) => p.size >= 2).map(([k]) => k));
  const usable = images.filter((i) => !background.has(`${i.width}x${i.height}`));
  if (!usable.length) return 0;

  const byPage = new Map();
  for (const i of usable) {
    if (!byPage.has(i.page)) byPage.set(i.page, []);
    byPage.get(i.page).push(i);
  }

  const pageOf = (ipr) => {
    const get = (group, key) => (ipr[group] instanceof Map ? ipr[group].get(key) : ipr[group]?.[key]);
    const attrs = ipr.attributes instanceof Map ? [...ipr.attributes.values()] : Object.values(ipr.attributes || {});
    for (const f of [get("identity", "productCode"), get("identity", "name"), ...attrs]) {
      if (f?.sourceRef?.page) return f.sourceRef.page;
    }
    return null;
  };
  const slug = (s) =>
    String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "product";

  // One upload per distinct image, not per product: ten colour variants of one
  // toilet-roll holder share a single photo, and re-uploading it ten times
  // would be ten round trips for one asset.
  const urlByImage = new Map();
  let attached = 0;

  for (const ipr of iprs) {
    if (ipr.mediaRefs?.length) continue; // a real product_image already won
    const page = pageOf(ipr);
    const pool = page && byPage.has(page) ? byPage.get(page) : byPage.size === 1 ? [...byPage.values()][0] : [];
    if (!pool.length) continue;

    let best;
    try {
      best = await pickProductImage([...pool].sort((a, b) => b.width * b.height - a.width * a.height));
    } catch {
      best = null;
    }
    if (!best) continue;

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

  if (attached) log?.({ kind: "media_attached", file: sourceFile, count: attached, unique: urlByImage.size });
  return attached;
}
