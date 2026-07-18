import mongoose from "mongoose";

/** D1 tree node + D9 issued ID (seeded by packages/taxonomy/seed.js). */
const taxonomyNodeSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    depth: { type: Number, required: true },
    parentPath: { type: String, default: null },
    adlmId: { type: String, required: true, unique: true },
    keywords: [{ type: String }],
    provenance: { type: String, enum: ["adlm_registry"], default: "adlm_registry" },
  },
  { timestamps: true }
);

export default mongoose.model("TaxonomyNode", taxonomyNodeSchema);
