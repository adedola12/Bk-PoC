import mongoose from "mongoose";

/**
 * D2 dynamic brand registry — canonical names, aliases, sub-brand lineage,
 * product-code signatures. Unknown brands auto-register as candidates with
 * evidence; never blocking, never silently merging.
 */
const brandRegistrySchema = new mongoose.Schema(
  {
    canonicalName: { type: String, required: true, unique: true },
    aliases: [{ type: String }], // e.g. Jaguar → Jaquar
    parentBrand: { type: String, default: null }, // e.g. Artize ⊂ Jaquar
    codeSignatures: [{ type: String }], // regex sources, e.g. "^AKP-", "^06011"
    status: { type: String, enum: ["confirmed", "candidate"], default: "candidate" },
    evidence: [
      {
        sourceFile: String,
        note: String,
        addedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model("BrandRegistry", brandRegistrySchema);
