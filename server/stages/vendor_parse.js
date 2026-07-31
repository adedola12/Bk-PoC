import { callClaudeJSON } from "../services/anthropic.js";
import { extractDocxText } from "../services/docx.js";
import { resolveRunPath } from "../services/runs.js";
import { Vendor } from "../models/Vendor.js";

/**
 * D11 — vendor documents are parsed into structured vendor profiles, not
 * merely archived. Runs AFTER the human confirms the vendor_document
 * classification in TriageVerify (no silent filing).
 */

const SYSTEM = `You parse vendor registration forms from a construction-materials marketplace into structured profiles.
Extract ONLY what the document states — never invent. Missing → null/[].
Return JSON:
{"companyName": "...", "rcNumber": "...",
 "contacts": [{"name":"","role":"","phone":"","email":""}],
 "addresses": ["..."], "socialHandles": ["..."], "yearsInBusiness": n|null,
 "categories": ["..."], "certifications": ["SON/MANCAP/ISO/international certs as stated"],
 "warranty": {"periodYears": n|null, "coverage": "..."},
 "supplyStates": ["..."], "moq": n|null, "deliveryTimeline": "..."}`;

/**
 * @param {import("mongoose").Document} upload - UploadLedger doc (vendor_document)
 * @param {{log?: Function}} ctx
 */
export async function parseVendorDocument(upload, ctx = {}) {
  const sourcePath = resolveRunPath(upload.storedPath);
  if (!sourcePath) {
    const err = new Error(
      `The source file for "${upload.originalName}" is not on this deployment, so the vendor profile cannot be parsed. Re-upload the file.`
    );
    err.status = 409;
    throw err;
  }
  const text = await extractDocxText(sourcePath);
  const profile = await callClaudeJSON({
    system: SYSTEM,
    messages: [{ role: "user", content: `Vendor document ${upload.originalName}:\n\n${text.slice(0, 20000)}` }],
    maxTokens: 1500,
    log: ctx.log,
    tag: `vendor:${upload.originalName}`,
  });

  if (!profile.companyName) throw new Error("vendor parse produced no companyName");

  const vendor = await Vendor.findOneAndUpdate(
    { companyName: profile.companyName },
    { ...profile, sourceUpload: upload._id },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return vendor;
}
