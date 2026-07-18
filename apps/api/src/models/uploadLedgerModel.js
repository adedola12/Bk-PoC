import mongoose from "mongoose";

/**
 * Upload Ledger — one document per uploaded file. Identity backbone for D4
 * delta re-uploads and the store for Stage 0 triage state (incl. D11/D12).
 */
const triageSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      enum: ["bk_template", "catalogue", "product_datasheet", "product_image", "vendor_document", "other"],
    },
    confidence: { type: Number, min: 0, max: 1 },
    method: { type: String, enum: ["rule", "text", "vision"] },
    summary: { type: String, default: "" },
    signals: { type: Object, default: {} },
    // D11 — non-product routes require human confirmation before filing
    needsVerification: { type: Boolean, default: false },
    verified: { type: Boolean, default: false },
    verifiedLabel: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false }
);

const uploadLedgerSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    storedPath: { type: String, required: true },
    previewPath: { type: String, default: null }, // first-page snapshot for the D11 prompt
    mimeType: { type: String },
    size: { type: Number },
    sha256: { type: String, index: true },
    runId: { type: String, index: true },
    triage: { type: triageSchema, default: {} },
    // filled at Stage 10: identity keys of rows emitted from this file
    emittedIdentityKeys: [{ type: String }],
  },
  { timestamps: true }
);

export default mongoose.model("UploadLedger", uploadLedgerSchema);
