import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import cloudinary, { hasCloudinary, uploadBufferToCloudinary } from "../services/cloudinary.js";

/**
 * Media round-trip check (D8 / Stage 7) — proves the deployment can actually
 * reach Cloudinary, not just that credentials are present. Uploads one fixture
 * through the same uploadBufferToCloudinary() the pipeline uses, reads the
 * delivery URL back, then destroys the throwaway asset.
 *
 *   npm run verify:media                 # default fixture, cleans up after
 *   npm run verify:media -- --keep       # leave the asset in place
 *   npm run verify:media -- <image path> # use a different image
 *
 * Exits non-zero on failure so it can gate a deploy.
 */
const KEEP = process.argv.includes("--keep");
const PUBLIC_ID = "_verify_media_delete_me"; // never collides with a real SKU
const DEFAULT_FIXTURE = path.resolve(__dirname, "../../fixtures/Jaguar_Toilet_Roll_Holder_Image.jpg");
const fixture = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DEFAULT_FIXTURE;

if (!hasCloudinary()) {
  console.error("❌ Cloudinary env incomplete — need CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.");
  process.exit(1);
}
if (!fs.existsSync(fixture)) {
  console.error(`❌ Fixture not found: ${fixture}`);
  process.exit(1);
}

// Same derivation as the uploader, so the cleanup targets what we created.
const folder = process.env.CLOUDINARY_FOLDER?.replace(/\/previews$/, "/products") || "bk/products";

console.log(`Cloudinary media check — cloud ${process.env.CLOUDINARY_CLOUD_NAME}, folder ${folder}`);
console.log(`Fixture: ${path.basename(fixture)}`);

/**
 * A failed upload is either "credentials rejected" or "the request never left
 * the network" — worth telling apart, since only the first is a code/config
 * problem. An egress proxy answers CONNECT with 403/407 before Cloudinary sees
 * anything, which surfaces here as the same http_code Cloudinary itself uses.
 */
function diagnose(err) {
  if (err.http_code === 401) return "credentials rejected by Cloudinary — check API key/secret.";
  if ((err.http_code === 403 || err.http_code === 407) && process.env.HTTPS_PROXY)
    return `possible egress-policy denial rather than a Cloudinary error — check ${process.env.HTTPS_PROXY}/__agentproxy/status and allow api.cloudinary.com + res.cloudinary.com.`;
  if (err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") return "network unreachable — api.cloudinary.com is blocked or DNS is failing.";
  return "see the error above.";
}

const buffer = fs.readFileSync(fixture);
let url;
const started = Date.now();
try {
  url = await uploadBufferToCloudinary(buffer, PUBLIC_ID);
} catch (err) {
  console.error(`❌ upload failed (${err.http_code ?? err.code ?? err.name}): ${err.message}`);
  console.error(`   ${diagnose(err)}`);
  process.exit(1);
}
console.log(`✅ upload: ${buffer.length} bytes in ${Date.now() - started} ms`);
console.log(`   ${url}`);

// Read it back — an upload that returns a URL nothing can fetch is still broken.
let ok = false;
try {
  const res = await fetch(url);
  ok = res.ok && Boolean(res.headers.get("content-type")?.startsWith("image/"));
  console.log(`${ok ? "✅" : "❌"} delivery: ${res.status} ${res.headers.get("content-type")} ${res.headers.get("content-length") ?? "?"} bytes`);
} catch (err) {
  console.error(`❌ delivery fetch failed: ${err.message}`);
  console.error("   res.cloudinary.com may be blocked even when api.cloudinary.com is reachable.");
}

if (KEEP) {
  console.log(`↩ --keep: leaving ${folder}/${PUBLIC_ID} in place.`);
} else {
  try {
    const { result } = await cloudinary.uploader.destroy(`${folder}/${PUBLIC_ID}`);
    console.log(`🧹 cleanup: ${result}`);
  } catch (err) {
    console.error(`⚠ cleanup failed — remove ${folder}/${PUBLIC_ID} by hand: ${err.message}`);
  }
}

console.log(ok ? "\n✅ Stage 7 media path is live end to end." : "\n❌ Media path is NOT usable — Stage 7 will fall back to local:// URLs.");
process.exit(ok ? 0 : 1);
