import mongoose from "mongoose";

/**
 * Review queue item — one per flagged field/row. Stores the reviewer's
 * resolution so every human correction becomes calibration data (§9).
 */
const reviewItemSchema = new mongoose.Schema(
  {
    runId: { type: String, index: true },
    ipr: { type: mongoose.Schema.Types.ObjectId, ref: "IPR", default: null },
    upload: { type: mongoose.Schema.Types.ObjectId, ref: "UploadLedger", default: null },
    fieldKey: { type: String, default: null }, // null = whole-row review
    reason: {
      type: String,
      enum: [
        "low_confidence",
        "anomaly_rule",
        "duplicate_code",
        "unit_implausible",
        "unmapped_taxonomy",
        "unconfirmed_brand",
        "triage_uncertain",
        "fact_check_failed",
        "unpaired_media",
      ],
      required: true,
    },
    detail: { type: String, default: "" },
    sourceSnapshot: { type: String, default: null }, // path to source-region image
    status: { type: String, enum: ["open", "resolved", "dismissed"], default: "open" },
    // calibration data (§9)
    resolution: { type: String, enum: ["accepted", "corrected", "rejected", null], default: null },
    correctedValue: { type: mongoose.Schema.Types.Mixed, default: null },
    failedMethod: { type: String, enum: ["text", "vision", "derived", "rule", null], default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("ReviewItem", reviewItemSchema);
