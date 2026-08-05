/**
 * One-off: convert absolute artifact paths in the upload ledger to the
 * run-relative form the code now writes.
 *
 *   node server/scripts/migrate-stored-paths.mjs          # report only
 *   node server/scripts/migrate-stored-paths.mjs --apply  # write changes
 *
 * Rows created before the relative-path convention carry the absolute path of
 * whatever machine wrote them — `/opt/render/project/src/runs/...` from Render,
 * `C:\Users\...\runs\...` from a dev box. Those paths cannot resolve anywhere
 * else, so every read of them failed with ENOENT.
 *
 * Rewriting the path does NOT restore the file. Where the artifact did not come
 * across with the record there is nothing to point at, and the row is reported
 * as unrecoverable — the file has to be re-uploaded. The rewrite still matters:
 * it removes the foreign path, so the API can say "not on this deployment"
 * instead of leaking another machine's layout into the UI.
 */
import mongoose from "mongoose";
import path from "node:path";
import fs from "node:fs";
import { UploadLedger } from "../models/UploadLedger.js";
import { runsRoot, resolveRunPath } from "../services/runs.js";

const APPLY = process.argv.includes("--apply");
const RUNS = runsRoot();

// Same tail-after-"runs" recovery as resolveRunPath, but it does NOT require the
// file to exist: the goal here is to normalise the stored string even when the
// artifact is gone, so nothing keeps a foreign absolute path.
const toRelative = (stored) => {
  if (!stored) return null;
  if (!path.isAbsolute(stored) && !/^[a-zA-Z]:[\\/]/.test(stored)) return stored;
  const parts = stored.split(/[\\/]+/);
  const idx = parts.lastIndexOf("runs");
  if (idx === -1 || idx === parts.length - 1) return null;
  return parts.slice(idx + 1).join("/");
};

await mongoose.connect(process.env.MONGODB_URI, { dbName: "bkIngest", serverSelectionTimeoutMS: 10000 });
console.log(`runs root on this machine: ${RUNS}\nmode: ${APPLY ? "APPLY" : "REPORT ONLY (pass --apply to write)"}\n`);

const docs = await UploadLedger.find({}).lean();
let changed = 0;
const missing = [];

for (const d of docs) {
  const nextStored = toRelative(d.storedPath);
  const nextPreview = toRelative(d.previewPath);
  const storedChanged = nextStored && nextStored !== d.storedPath;
  const previewChanged = nextPreview !== (d.previewPath ?? null) && d.previewPath;

  const present = Boolean(resolveRunPath(nextStored ?? d.storedPath));
  if (!present) missing.push(d.originalName);

  if (storedChanged || previewChanged) {
    changed++;
    console.log(`${present ? "rewrite " : "rewrite*"} ${d.originalName}`);
    console.log(`    ${d.storedPath}\n  → ${nextStored}`);
    if (APPLY) {
      const update = {};
      if (storedChanged) update.storedPath = nextStored;
      if (previewChanged) update.previewPath = nextPreview;
      await UploadLedger.updateOne({ _id: d._id }, { $set: update });
    }
  }
}

const onDisk = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).length : 0;
console.log(`\n${docs.length} ledger rows · ${changed} with a foreign absolute path · ${onDisk} run dirs on disk`);
if (missing.length) {
  console.log(`\n* ${missing.length} row(s) have no file on this deployment — re-upload to use them:`);
  for (const n of missing) console.log(`    ${n}`);
}
if (!APPLY && changed) console.log("\nNothing written. Re-run with --apply.");

await mongoose.disconnect();
