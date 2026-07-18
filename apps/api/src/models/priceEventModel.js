import mongoose from "mongoose";

/** D10 append-only price ledger. Prices are NEVER overwritten — only appended. */
const priceEventSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, index: true },
    variant: { type: String, default: null },
    vendor: { type: String, required: true },
    brand: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, default: "NGN" },
    sourceFile: { type: String, required: true },
    effectiveDate: { type: Date, required: true },
    method: { type: String, enum: ["extracted", "reupload_delta", "manual"], required: true },
  },
  { timestamps: true }
);

// Append-only: forbid updates at the model layer.
priceEventSchema.pre(["updateOne", "findOneAndUpdate", "updateMany"], function (next) {
  next(new Error("price_events is append-only (D10) — insert a new event instead"));
});

export default mongoose.model("PriceEvent", priceEventSchema);
