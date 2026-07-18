import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { UploadLedger } from "../models/UploadLedger.js";
import { triageFile } from "../stages/stage0_triage.js";
import { createRun } from "../services/runs.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ─── POST / — intake + Stage 0 triage ─── */
router.post("/", upload.array("files", 20), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: "No files uploaded" });

    const run = createRun("intake");
    const intakeDir = path.join(run.dir, "intake");
    fs.mkdirSync(intakeDir, { recursive: true });

    const results = [];
    for (const f of req.files) {
      const storedPath = path.join(intakeDir, f.originalname);
      fs.writeFileSync(storedPath, f.buffer);
      const sha256 = crypto.createHash("sha256").update(f.buffer).digest("hex");

      const started = Date.now();
      const triage = await triageFile(storedPath, {
        log: run.log,
        previewsDir: path.join(run.dir, "previews"),
      });
      run.log({ kind: "triage", file: f.originalname, ms: Date.now() - started, label: triage.label });

      const doc = await UploadLedger.create({
        originalName: f.originalname,
        storedPath,
        previewPath: triage.previewPath,
        mimeType: f.mimetype,
        size: f.size,
        sha256,
        runId: run.runId,
        triage,
      });
      results.push(doc);
    }
    res.status(201).json({ runId: run.runId, items: results });
  } catch (err) {
    next(err);
  }
});

export default router;
