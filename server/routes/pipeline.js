import express from "express";
import path from "node:path";
import { UploadLedger } from "../models/UploadLedger.js";
import { IPR } from "../models/IPR.js";
import { ReviewItem } from "../models/ReviewItem.js";
import { ingestFile } from "../stages/stage1_ingest.js";
import { extractIprs } from "../stages/stage2_extract.js";
import { normalizeIpr } from "../stages/stage3_normalize.js";
import { createRun } from "../services/runs.js";

const router = express.Router();

const EXTRACTABLE = new Set(["product_datasheet", "bk_template"]);

/* ─── POST /:uploadId/extract — Stages 1–3 on a triaged upload ─── */
router.post("/:uploadId/extract", async (req, res, next) => {
  try {
    const upload = await UploadLedger.findById(req.params.uploadId);
    if (!upload) return res.status(404).json({ error: "Upload not found" });

    const label = upload.triage?.verifiedLabel || upload.triage?.label;
    if (!EXTRACTABLE.has(label)) {
      return res.status(400).json({
        error: `label "${label}" is not extractable yet — catalogues land in Milestone D, non-product routes never extract (D11)`,
      });
    }

    const run = createRun("extract");
    const started = Date.now();

    const ingested = await ingestFile(upload.storedPath);
    const rawIprs = await extractIprs(ingested, upload.originalName, { log: run.log });
    const iprs = rawIprs.map((ipr) => (ipr.templateRow ? ipr : normalizeIpr(ipr)));

    const saved = [];
    for (const ipr of iprs) {
      const doc = await IPR.create({
        runId: run.runId,
        upload: upload._id,
        identity: ipr.identity,
        attributes: ipr.attributes || {},
        logistics: ipr.logistics || {},
        compliance: ipr.compliance || {},
        mediaRefs: ipr.mediaRefs || [],
        templateRow: ipr.templateRow || null,
      });
      // §6.1 — every flag becomes a review item, never silently dropped
      for (const f of ipr.flags || []) {
        await ReviewItem.create({
          runId: run.runId,
          ipr: doc._id,
          upload: upload._id,
          fieldKey: f.field,
          reason: f.reason,
          detail: f.detail,
          failedMethod: "text",
        });
      }
      saved.push(doc);
    }

    run.log({ kind: "extract_complete", file: upload.originalName, iprs: saved.length, ms: Date.now() - started });
    res.status(201).json({ runId: run.runId, count: saved.length, iprs: saved });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /iprs — inspect extracted records ─── */
router.get("/iprs", async (req, res, next) => {
  try {
    const iprs = await IPR.find({}).sort({ createdAt: -1 }).limit(200).populate("upload", "originalName").lean();
    res.json(iprs);
  } catch (err) {
    next(err);
  }
});

export default router;
