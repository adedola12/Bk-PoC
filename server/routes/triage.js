import express from "express";
import fs from "node:fs";
import { UploadLedger } from "../models/UploadLedger.js";
import { TRIAGE_LABELS } from "../stages/stage0_triage.js";
import { parseVendorDocument } from "../stages/vendor_parse.js";

const router = express.Router();

/* ─── GET / — ledger, verification queue first ─── */
router.get("/", async (req, res, next) => {
  try {
    const items = await UploadLedger.find({})
      .sort({ "triage.needsVerification": -1, createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:id/preview — D11 snapshot image ─── */
router.get("/:id/preview", async (req, res, next) => {
  try {
    const item = await UploadLedger.findById(req.params.id).lean();
    if (!item?.previewPath || !fs.existsSync(item.previewPath)) {
      return res.status(404).json({ error: "No preview available" });
    }
    res.sendFile(item.previewPath);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /verify-all — D11 bulk confirm (labels kept as classified) ─── */
router.post("/verify-all", async (req, res, next) => {
  try {
    const items = await UploadLedger.find({ "triage.needsVerification": true });
    let verified = 0;
    for (const item of items) {
      item.triage.verified = true;
      item.triage.verifiedLabel = item.triage.label;
      item.triage.verifiedAt = new Date();
      item.triage.needsVerification = false;
      await item.save();
      verified++;
      if (item.triage.verifiedLabel === "vendor_document") {
        try {
          await parseVendorDocument(item);
        } catch (err) {
          console.error(`vendor parse failed for ${item.originalName}: ${err.message}`);
        }
      }
    }
    res.json({ verified });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /:id/verify — D11 confirm / reclassify ─── */
router.post("/:id/verify", async (req, res, next) => {
  try {
    const { confirm, label } = req.body; // confirm: true keeps triage label; label overrides
    if (!confirm && !TRIAGE_LABELS.includes(label)) {
      return res.status(400).json({ error: `label must be one of ${TRIAGE_LABELS.join(", ")}` });
    }
    const item = await UploadLedger.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Upload not found" });

    item.triage.verified = true;
    item.triage.verifiedLabel = confirm ? item.triage.label : label;
    item.triage.verifiedAt = new Date();
    item.triage.needsVerification = false;
    await item.save();

    // D11: once a human confirms a vendor_document, parse it into a
    // structured vendor profile (never before — no silent filing).
    let vendor = null;
    if (item.triage.verifiedLabel === "vendor_document") {
      try {
        vendor = await parseVendorDocument(item);
      } catch (err) {
        console.error(`vendor parse failed for ${item.originalName}: ${err.message}`);
      }
    }
    res.json({ ...item.toObject(), vendor });
  } catch (err) {
    next(err);
  }
});

export default router;
