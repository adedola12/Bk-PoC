import express from "express";
import fs from "node:fs";
import UploadLedger from "../models/uploadLedgerModel.js";
import { TRIAGE_LABELS } from "../stages/stage0_triage.js";

const router = express.Router();

/* ─── GET /api/triage — ledger, verification queue first ─── */
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

/* ─── GET /api/triage/:id/preview — D11 snapshot image ─── */
router.get("/:id/preview", async (req, res, next) => {
  try {
    const item = await UploadLedger.findById(req.params.id).lean();
    if (!item?.previewPath || !fs.existsSync(item.previewPath)) {
      res.status(404);
      throw new Error("No preview available");
    }
    res.sendFile(item.previewPath);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /api/triage/:id/verify — D11 confirm / reclassify ─── */
router.post("/:id/verify", async (req, res, next) => {
  try {
    const { confirm, label } = req.body; // confirm: true keeps triage label; label overrides
    if (!confirm && !TRIAGE_LABELS.includes(label)) {
      res.status(400);
      throw new Error(`label must be one of ${TRIAGE_LABELS.join(", ")}`);
    }
    const item = await UploadLedger.findById(req.params.id);
    if (!item) {
      res.status(404);
      throw new Error("Upload not found");
    }
    item.triage.verified = true;
    item.triage.verifiedLabel = confirm ? item.triage.label : label;
    item.triage.verifiedAt = new Date();
    item.triage.needsVerification = false;
    await item.save();
    res.json(item);
  } catch (err) {
    next(err);
  }
});

export default router;
