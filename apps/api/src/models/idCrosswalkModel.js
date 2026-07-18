import mongoose from "mongoose";

/** D9 crosswalk — ADLM ↔ BK category IDs with provenance. Never guessed. */
const idCrosswalkSchema = new mongoose.Schema(
  {
    nodePath: { type: String, required: true, unique: true },
    adlmId: { type: String, required: true },
    bkId: { type: String, default: null }, // null until BK issues one
    level: { type: String, enum: ["category", "subcategory", "sub_subcategory", "product_type"] },
    provenance: { type: String, enum: ["adlm_registry", "bk_confirmed"], required: true },
  },
  { timestamps: true }
);

export default mongoose.model("IdCrosswalk", idCrosswalkSchema);
