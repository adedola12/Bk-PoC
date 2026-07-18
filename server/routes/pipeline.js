import express from "express";
import path from "node:path";
import { UploadLedger } from "../models/UploadLedger.js";
import { IPR } from "../models/IPR.js";
import { ReviewItem } from "../models/ReviewItem.js";
import { ingestFile } from "../stages/stage1_ingest.js";
import { extractIprs } from "../stages/stage2_extract.js";
import { normalizeIpr } from "../stages/stage3_normalize.js";
import { classifyIpr } from "../stages/stage4_classify.js";
import { resolveIprBrand } from "../stages/stage5_brand.js";
import { expandVariants } from "../stages/stage6_variants.js";
import { resolveTaxonomyIds } from "../services/ids.js";
import { TodoItem } from "../models/TodoItem.js";
import { createRun } from "../services/runs.js";
import { bulkExtract } from "../stages/bulk_extract.js";
import { detectAnomalies } from "../eval/injector.js";

const router = express.Router();

const EXTRACTABLE = new Set(["product_datasheet", "bk_template", "catalogue"]);
const ANOMALY_REASON = { duplicate_code: "duplicate_code", wrong_unit: "unit_implausible", sanity: "anomaly_rule" };

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

    let rawIprs;
    let bulkStats = null;
    if (label === "catalogue") {
      // hostile path: pairing QA routes pages to text chunks or vision panels
      const bulk = await bulkExtract(upload.storedPath, upload.originalName, { log: run.log });
      rawIprs = bulk.iprs;
      bulkStats = { ...bulk.stats, qa: bulk.qa.pages };
    } else {
      const ingested = await ingestFile(upload.storedPath);
      rawIprs = await extractIprs(ingested, upload.originalName, { log: run.log });
    }
    const normalized = rawIprs.map((ipr) => (ipr.templateRow ? ipr : normalizeIpr(ipr)));

    // Stages 4–6 (skip filled-template rows — already contract-shaped)
    const iprs = [];
    for (const ipr of normalized) {
      if (ipr.templateRow) {
        iprs.push(ipr);
        continue;
      }
      // bulk catalogues skip the semantic tier (cost order, D1) — the
      // deterministic source-section + lexical tiers carry them
      await classifyIpr(ipr, {
        sourceSection: ipr.sourceSection ?? null,
        useSemantic: label !== "catalogue",
        log: run.log,
      });
      await resolveIprBrand(ipr, { sourceFile: upload.originalName });
      ipr.taxonomyIds = await resolveTaxonomyIds(ipr.taxonomyPath);
      if (ipr.taxonomyIds.pending && ipr.taxonomyPath) {
        await TodoItem.create({
          runId: run.runId,
          type: "bk_id_pending",
          detail: `BK category ID needed for "${ipr.taxonomyPath}"`,
          sourceFile: upload.originalName,
        });
      }
      iprs.push(...expandVariants(ipr));
    }

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
        taxonomyPath: ipr.taxonomyPath ?? null,
        taxonomyConfidence: ipr.taxonomyConfidence ?? null,
        taxonomyIds: ipr.taxonomyIds ?? {},
        variantLabel: ipr.variantLabel ?? null,
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

    // §6.1 — cross-record anomaly detection (A1/A2/A3 classes): every catch
    // becomes a ReviewItem; nothing wrong may pass silently
    const anomalies = detectAnomalies(iprs.filter((i) => !i.templateRow));
    for (const a of anomalies) {
      const idx = a.index ?? a.indexes?.[0];
      await ReviewItem.create({
        runId: run.runId,
        ipr: saved[idx]?._id ?? null,
        upload: upload._id,
        fieldKey: a.field ?? "productCode",
        reason: ANOMALY_REASON[a.type] ?? "anomaly_rule",
        detail: a.detail,
      });
    }

    const wallMs = Date.now() - started;
    run.log({ kind: "extract_complete", file: upload.originalName, iprs: saved.length, anomalies: anomalies.length, ms: wallMs });
    res.status(201).json({
      runId: run.runId,
      count: saved.length,
      anomaliesFlagged: anomalies.length,
      wallMs, // feeds T7 — recorded by the pipeline itself
      bulkStats,
      iprs: label === "catalogue" ? undefined : saved, // catalogues return counts, not 200 rows
    });
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
