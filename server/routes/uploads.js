import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { UploadLedger } from "../models/UploadLedger.js";
import { triageFile } from "../stages/stage0_triage.js";
import { createRun } from "../services/runs.js";
import { fetchUrl } from "../services/weburl.js";

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

/* ─── POST /api/uploads/url — D16: ingest from a manufacturer weblink ─── */
router.post("/url", async (req, res, next) => {
  try {
    const { url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url required" });

    const fetched = await fetchUrl(url); // SSRF-guarded, 25 MB cap
    const run = createRun("url-intake");
    const intakeDir = path.join(run.dir, "intake");
    fs.mkdirSync(intakeDir, { recursive: true });

    const urlName = path.basename(new URL(fetched.finalUrl).pathname) || "page";
    const fileName = urlName.toLowerCase().endsWith(fetched.ext) ? urlName : `${urlName}${fetched.ext}`;
    const storedPath = path.join(intakeDir, fileName);
    fs.writeFileSync(storedPath, fetched.buffer);
    const sha256 = crypto.createHash("sha256").update(fetched.buffer).digest("hex");

    const started = Date.now();
    const triage = await triageFile(storedPath, {
      log: run.log,
      previewsDir: path.join(run.dir, "previews"),
    });
    run.log({ kind: "triage", file: fileName, url: fetched.finalUrl, ms: Date.now() - started, label: triage.label });

    const doc = await UploadLedger.create({
      originalName: fileName,
      storedPath,
      previewPath: triage.previewPath,
      mimeType: fetched.contentType,
      size: fetched.buffer.length,
      sha256,
      sourceUrl: fetched.finalUrl,
      runId: run.runId,
      triage,
    });
    res.status(201).json({ runId: run.runId, items: [doc] });
  } catch (err) {
    next(err);
  }
});

export default router;
