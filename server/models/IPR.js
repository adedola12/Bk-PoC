import mongoose from "mongoose";

/**
 * Intermediate Product Record (Design Doc Â§3 Stage 2). Every field, without
 * exception, is stored as an IPR field object:
 * { value, unit, raw, sourceRef: { file, page, region }, confidence, method }
 */
const sourceRefSchema = new mongoose.Schema(
  {
    file: { type: String, required: true },
    page: { type: Number, default: null },
    region: { type: String, default: null },
  },
  { _id: false }
);

const iprFieldSchema = new mongoose.Schema(
  {
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    unit: { type: String, default: null },
    raw: { type: String, default: null }, // source string always retained verbatim
    sourceRef: { type: sourceRefSchema, required: true },
    confidence: { type: Number, min: 0, max: 1, required: true },
    method: { type: String, enum: ["text", "vision", "derived", "rule"], required: true },
  },
  { _id: false }
);

const iprSchema = new mongoose.Schema(
  {
    runId: { type: String, index: true },
    upload: { type: mongoose.Schema.Types.ObjectId, ref: "UploadLedger" },
    // identity block
    identity: {
      brand: iprFieldSchema,
      subBrand: iprFieldSchema,
      productCode: iprFieldSchema,
      name: iprFieldSchema,
      collection: iprFieldSchema,
    },
    // free-form typed attributes: key â†’ IPR field
    attributes: { type: Map, of: iprFieldSchema, default: {} },
    logistics: { type: Map, of: iprFieldSchema, default: {} },
    compliance: { type: Map, of: iprFieldSchema, default: {} },
    mediaRefs: [{ type: String }],
    // Twyford short-circuit: full template column map (lossless round-trip payload)
    templateRow: { type: Object, default: null },
    // classification (Stage 4) and variant lineage (Stage 6) â€” filled later
    taxonomyPath: { type: String, default: null },
    taxonomyConfidence: { type: Number, default: null },
    variantOf: { type: mongoose.Schema.Types.ObjectId, ref: "IPR", default: null },
    variantLabel: { type: String, default: null }, // e.g. "derived_unverified"
    disposition: { type: String, enum: ["PASS", "REVIEW", "TODO", null], default: null },
  },
  { timestamps: true }
);

export const IPR = mongoose.model("IPR", iprSchema);
