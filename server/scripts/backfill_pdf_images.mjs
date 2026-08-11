/**
 * Backfill product images from the source PDFs onto existing IPRs.
 *
 *   node scripts/backfill_pdf_images.mjs "<pdf path>" "<ledger name regex>" [--dry]
 *
 * Datasheets and catalogues carry the product photo inside the PDF, but a
 * Cover Image could only ever come from a separately uploaded product_image
 * paired by SKU — so every datasheet-derived product showed "IMAGE PENDING".
 * This pulls the image out, uploads it, and attaches it, without touching the
 * extraction pipeline or needing a redeploy.
 *
 * Page mapping matters for catalogues: each product is matched to the image on
 * ITS OWN page, taken from the field provenance (sourceRef.page) that every
 * IPR field already carries.
 *
 * Backgrounds are excluded by repetition — a page-furniture image appears at
 * identical dimensions on many pages, while a product shot does not.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
// .env lives at the repo root, not in server/ — same as taxonomy/seed.js.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });
import mongoose from "mongoose";
import { IPR } from "../models/IPR.js";
import { UploadLedger } from "../models/UploadLedger.js";
import { extractEmbeddedImages, pickProductImage } from "../services/pdf.js";
import { uploadBufferToCloudinary, hasCloudinary } from "../services/cloudinary.js";

const [pdfPath, namePattern, ...flags] = process.argv.slice(2);
const DRY = flags.includes("--dry");
if (!pdfPath || !namePattern) {
  console.error('usage: node scripts/backfill_pdf_images.mjs "<pdf>" "<ledger name regex>" [--dry]');
  process.exit(1);
}
if (!hasCloudinary() && !DRY) {
  console.error("Cloudinary is not configured — set CLOUDINARY_* or pass --dry");
  process.exit(1);
}

const pageOf = (ipr) => {
  const fields = [ipr.identity?.productCode, ipr.identity?.name, ipr.identity?.brand, ...Object.values(ipr.attributes || {})];
  for (const f of fields) if (f?.sourceRef?.page) return f.sourceRef.page;
  return null;
};
const slug = (s) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "product";

await mongoose.connect(process.env.MONGODB_URI, { dbName: "bkIngest" });

const images = await extractEmbeddedImages(pdfPath);
console.log(`extracted ${images.length} candidate image(s) from ${pdfPath.split(/[\\/]/).pop()}`);

// Page furniture repeats at identical dimensions across pages; products do not.
const dimCount = new Map();
for (const i of images) {
  const k = `${i.width}x${i.height}`;
  dimCount.set(k, (dimCount.get(k) ?? new Set()).add?.(i.page) ? dimCount.get(k) : dimCount.get(k));
}
const pagesByDim = new Map();
for (const i of images) {
  const k = `${i.width}x${i.height}`;
  if (!pagesByDim.has(k)) pagesByDim.set(k, new Set());
  pagesByDim.get(k).add(i.page);
}
// 2 pages is enough: ENESS repeats a 1655x1153 full-bleed graphic across two
// pages, which outsized the real product shot and would have been chosen.
const background = new Set([...pagesByDim.entries()].filter(([, p]) => p.size >= 2).map(([k]) => k));
if (background.size) console.log("treating as page background (repeats on 2+ pages):", [...background].join(", "));

const usable = images.filter((i) => !background.has(`${i.width}x${i.height}`));
const byPage = new Map();
for (const i of usable) {
  if (!byPage.has(i.page)) byPage.set(i.page, []);
  byPage.get(i.page).push(i);
}

const uploads = await UploadLedger.find({ originalName: new RegExp(namePattern, "i") }).lean();
const iprs = await IPR.find({ upload: { $in: uploads.map((u) => u._id) } });
console.log(`matched ${iprs.length} IPR(s) across ${uploads.length} ledger row(s)\n`);

let attached = 0, skipped = 0;
for (const ipr of iprs) {
  const sku = ipr.identity?.productCode?.value || ipr.identity?.name?.value || String(ipr._id);
  const page = pageOf(ipr);
  // Single-product datasheets have one page of images; catalogues map per page.
  const pool = page && byPage.has(page) ? byPage.get(page) : usable.length && byPage.size === 1 ? [...byPage.values()][0] : [];
  if (!pool.length) {
    console.log(`  skip  ${String(sku).padEnd(20)} page=${page ?? "?"}  no image on that page`);
    skipped++;
    continue;
  }
  const best = await pickProductImage([...pool].sort((a, b) => b.width * b.height - a.width * a.height));
  if (!best) { skipped++; continue; }
  if (DRY) {
    console.log(`  would ${String(sku).padEnd(20)} page=${page}  ${best.width}x${best.height}`);
    attached++;
    continue;
  }
  const url = await uploadBufferToCloudinary(best.buffer, slug(sku));
  ipr.mediaRefs = [url, ...(ipr.mediaRefs || []).filter((u) => u !== url)];
  await ipr.save();
  console.log(`  ok    ${String(sku).padEnd(20)} page=${page}  ${best.width}x${best.height}  ${url.split("/").pop()}`);
  attached++;
}

console.log(`\nattached ${attached}, skipped ${skipped}${DRY ? "  (dry run — nothing written)" : ""}`);
await mongoose.disconnect();
