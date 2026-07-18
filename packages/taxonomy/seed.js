import "dotenv/config";
import mongoose from "mongoose";
import { buildRegister, buildCrosswalk } from "./src/index.js";

/**
 * Seed the D1 tree + D9 register into MongoDB (idempotent by node path —
 * re-running keeps existing ADLM IDs stable and only inserts new nodes).
 * Uses raw collections so the seed has no dependency on apps/api schemas.
 */
const uri = process.env.MONGODB_URI;
if (!uri || uri.includes("<db_password>")) {
  console.error("MONGODB_URI missing or still has the <db_password> placeholder — fix .env first");
  process.exit(1);
}

await mongoose.connect(uri, { dbName: "bkIngest", serverSelectionTimeoutMS: 10000 });

const nodesCol = mongoose.connection.collection("taxonomynodes");
const xwalkCol = mongoose.connection.collection("idcrosswalks");

const existing = new Map(
  (await nodesCol.find({}, { projection: { path: 1, adlmId: 1 } }).toArray()).map((d) => [d.path, d])
);

const rows = buildRegister();
let inserted = 0;
for (const row of rows) {
  const prior = existing.get(row.path);
  if (prior) {
    row.adlmId = prior.adlmId; // never re-issue an ID for a known node
    await nodesCol.updateOne({ path: row.path }, { $set: { keywords: row.keywords } });
  } else {
    await nodesCol.insertOne({ ...row, provenance: "adlm_registry", createdAt: new Date() });
    inserted++;
  }
}

const xwalk = buildCrosswalk(rows);
for (const x of xwalk) {
  await xwalkCol.updateOne({ nodePath: x.nodePath }, { $set: x }, { upsert: true });
}

console.log(`Taxonomy seed: ${rows.length} nodes (${inserted} new), ${xwalk.length} BK crosswalk entries`);
await mongoose.disconnect();
