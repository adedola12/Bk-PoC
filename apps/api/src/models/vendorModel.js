import mongoose from "mongoose";

/**
 * D11 vendor profile — parsed from vendor documents (Milestone B), not merely
 * archived. Field set per Addendum D11 (SG_BK.docx / Satkay reference case).
 */
const vendorSchema = new mongoose.Schema(
  {
    companyName: { type: String, required: true },
    rcNumber: { type: String, default: null },
    contacts: [
      {
        name: String,
        role: String,
        phone: String,
        email: String,
      },
    ],
    addresses: [{ type: String }],
    socialHandles: [{ type: String }],
    yearsInBusiness: { type: Number, default: null },
    categories: [{ type: String }],
    certifications: [{ type: String }], // SON / MANCAP / ISO / international
    warranty: {
      periodYears: { type: Number, default: null },
      coverage: { type: String, default: null },
    },
    supplyStates: [{ type: String }],
    moq: { type: Number, default: null },
    deliveryTimeline: { type: String, default: null },
    sourceUpload: { type: mongoose.Schema.Types.ObjectId, ref: "UploadLedger" },
  },
  { timestamps: true }
);

export default mongoose.model("Vendor", vendorSchema);
