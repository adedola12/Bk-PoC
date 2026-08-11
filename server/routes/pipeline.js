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
import { createRun, resolveRunPath } from "../services/runs.js";
import { bulkExtract } from "../stages/bulk_extract.js";
import { attachEmbeddedImages } from "../stages/media_from_pdf.js";
import { detectAnomalies } from "../eval/injector.js";
import { readDataRows } from "../emitter/index.js";

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

    // The ledger row can outlive its file: rows migrated from Render or from a
    // dev machine name a path that does not exist on this deployment, and the
    // runs volume is deliberately ephemeral. Say so plainly instead of letting
    // an ENOENT surface as a 500 with a foreign absolute path in the message.
    const sourcePath = resolveRunPath(upload.storedPath);
    if (!sourcePath) {
      return res.status(409).json({
        error:
          `The source file for "${upload.originalName}" is not on this deployment, ` +
          `so it cannot be extracted. This row was created on a different machine ` +
          `and only its metadata was migrated. Re-upload the file to extract it.`,
        code: "source_file_missing",
        originalName: upload.originalName,
      });
    }

    /* An EMPTY bk_template is not a source at all — it is the sheet the client
       uploaded alongside their catalogue for the emission to be written into
       (routes/emit.js resolveTemplateFor). Extracting it would "succeed" with
       zero rows, which reads as a failure to anyone watching. Say what it
       actually is instead. A FILLED template still extracts as before. */
    if (label === "bk_template") {
      const { rows } = await readDataRows(sourcePath);
      if (rows.length === 0) {
        return res.status(200).json({
          count: 0,
          role: "emission_target",
          message: `"${upload.originalName}" is an empty BK template — it will be used as the emission target for the files uploaded with it, so there is nothing to extract from it.`,
        });
      }
    }

    const run = createRun("extract");
    const started = Date.now();

    let rawIprs;
    let bulkStats = null;
    const isHtml = /\.html?$/i.test(sourcePath);
    if (label === "catalogue" && !isHtml) {
      // hostile PDF path: pairing QA routes pages to text chunks or vision panels
      const bulk = await bulkExtract(sourcePath, upload.originalName, { log: run.log });
      rawIprs = bulk.iprs;
      bulkStats = { ...bulk.stats, qa: bulk.qa.pages };
    } else {
      const ingested = await ingestFile(sourcePath);
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
        // Upsert on the category, not per extraction — creating unconditionally
        // duplicated the todo on every re-extract of the same taxonomy node
        // (same fix as the price_missing queue in routes/emit.js). The detail
        // string is derived from taxonomyPath, so it is the stable key; a todo
        // already marked done is not silently reopened.
        await TodoItem.updateOne(
          { type: "bk_id_pending", detail: `BK category ID needed for "${ipr.taxonomyPath}"` },
          {
            $set: { runId: run.runId, sourceFile: upload.originalName },
            $setOnInsert: { status: "open" },
          },
          { upsert: true }
        );
      }
      iprs.push(...expandVariants(ipr));
    }

    /* Mongoose Map keys cannot contain "." and cannot start with "$".
       attributes/logistics/compliance are all Maps keyed by whatever the
       extractor names a field, and the Bosch spec tables produced one called
       literally "3.7" — so IPR.create threw "IPR validation failed" and took
       the whole run down with it: 18 products and ~2 minutes of AI work lost
       to one malformed key, surfaced only as a 500 after the request had
       already been running for two minutes.

       Rename the key rather than lose the document. The rename is written to
       the run log — this pipeline does not make silent edits, and the original
       name is the only place the extractor's wording survives. */
    const safeMapKeys = (obj, field) => {
      if (!obj || typeof obj !== "object") return {};
      const out = {};
      for (const [rawKey, value] of Object.entries(obj)) {
        let key = String(rawKey).replace(/\./g, "_");
        if (key.startsWith("$")) key = `_${key.slice(1)}`;
        if (key !== rawKey) run.log({ kind: "map_key_renamed", field, from: rawKey, to: key });
        out[key] = value;
      }
      return out;
    };

    /* Product photos live inside the source PDF, but a Cover Image could only
       ever come from a separately uploaded product_image paired by SKU — so a
       datasheet showing the product still emitted with the media column empty.
       Runs before persisting so mediaRefs is written with the rest of the row,
       and never throws: losing an image must not cost the extraction. */
    try {
      const withImages = await attachEmbeddedImages(iprs, sourcePath, upload.originalName, { log: run.log });
      if (withImages) run.log({ kind: "media", file: upload.originalName, attached: withImages });
    } catch (err) {
      run.log({ kind: "media_error", file: upload.originalName, message: err.message });
    }

    const saved = [];
    for (const ipr of iprs) {
      const doc = await IPR.create({
        runId: run.runId,
        upload: upload._id,
        identity: ipr.identity,
        attributes: safeMapKeys(ipr.attributes, "attributes"),
        logistics: safeMapKeys(ipr.logistics, "logistics"),
        compliance: safeMapKeys(ipr.compliance, "compliance"),
        mediaRefs: ipr.mediaRefs || [],
        templateRow: ipr.templateRow || null,
        taxonomyPath: ipr.taxonomyPath ?? null,
        taxonomyConfidence: ipr.taxonomyConfidence ?? null,
        taxonomyIds: ipr.taxonomyIds ?? {},
        variantLabel: ipr.variantLabel ?? null,
        variantOfCode: ipr.variantOfCode ?? null,
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

/* ─── GET /sources — the extracted documents, with a row count each.
   Feeds the picker on step 3: choose which processed document to emit. Derived
   from the IPRs themselves, not the upload ledger, so a file that was uploaded
   but never extracted does not appear as something you could emit. ─── */
router.get("/sources", async (req, res, next) => {
  try {
    const rows = await IPR.aggregate([
      { $group: { _id: "$upload", count: { $sum: 1 }, lastExtract: { $max: "$createdAt" } } },
      { $lookup: { from: "uploadledgers", localField: "_id", foreignField: "_id", as: "u" } },
      {
        $project: {
          _id: 0,
          uploadId: "$_id",
          count: 1,
          lastExtract: 1,
          originalName: { $ifNull: [{ $arrayElemAt: ["$u.originalName", 0] }, "(source removed)"] },
        },
      },
      { $sort: { lastExtract: -1 } },
    ]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ─── GET /iprs — extracted records + latest ledger price + cover image.
   `?uploads=id,id` narrows to those source files so a walkthrough sees only
   what it just extracted; omitted returns the whole store as before. ─── */
router.get("/iprs", async (req, res, next) => {
  try {
    const { PriceEvent } = await import("../models/PriceEvent.js");
    const { normCode } = await import("../stages/vision_extract.js");
    const ids = String(req.query.uploads || "").split(",").map((s) => s.trim()).filter(Boolean);
    const filter = ids.length ? { upload: { $in: ids } } : {};
    const iprs = await IPR.find(filter).sort({ createdAt: -1 }).limit(200).populate("upload", "originalName").lean();

    const events = await PriceEvent.find({}).sort({ effectiveDate: 1 }).lean();
    const latestBySku = new Map();
    for (const e of events) latestBySku.set(normCode(e.sku), e); // chronological → last wins

    for (const ipr of iprs) {
      const sku = normCode(ipr.identity?.productCode?.value ?? ipr.templateRow?.["Product SKU"] ?? "");
      const price = latestBySku.get(sku);
      ipr.latestPrice = price ? { price: price.price, currency: price.currency, method: price.method } : null;
      ipr.coverUrl =
        (ipr.mediaRefs || []).find((u) => /^https?:\/\//.test(u)) ??
        ipr.templateRow?.["Cover Image"] ??
        null;
    }
    res.json(iprs);
  } catch (err) {
    next(err);
  }
});

export default router;
