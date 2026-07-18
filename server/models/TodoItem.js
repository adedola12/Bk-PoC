import mongoose from "mongoose";

/** D4 todo queue â€” first-class pipeline output (missing prices etc.). */
const todoItemSchema = new mongoose.Schema(
  {
    runId: { type: String, index: true },
    type: { type: String, enum: ["price_missing", "media_missing", "bk_id_pending"], required: true },
    vendor: { type: String, default: null },
    sku: { type: String, default: null },
    detail: { type: String, default: "" },
    sourceFile: { type: String, default: null },
    status: { type: String, enum: ["open", "done"], default: "open" },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const TodoItem = mongoose.model("TodoItem", todoItemSchema);
