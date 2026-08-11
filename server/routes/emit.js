import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { IPR } from "../models/IPR.js";
import { UploadLedger } from "../models/UploadLedger.js";
import { TodoItem } from "../models/TodoItem.js";
import { ReviewItem } from "../models/ReviewItem.js";
import { readTemplateSchema, readDataRows, emitRows } from "../emitter/index.js";
import { mapIprToRow, pairAndUploadMedia, mediaUrlFor, identityKey } from "../stages/stage7_map.js";
import { generateContent } from "../stages/stage8_generate.js";
import { gateRow } from "../stages/stage9_gate.js";
import { createRun, runsRoot, resolveRunPath } from "../services/runs.js";

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, "../../fixtures/catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx");

/**
 * Which template does a source emit into?
 *
 * BK asked to upload the catalogue and its bulk-upload template together, so
 * safes and power tools stop being forced through Wash Basins & Pedestals —
 * required columns like Drain Size do not apply, and every row gated.
 *
 * Two rules:
 *
 *   a template is EMPTY   A bk_template with data rows is a filled sheet and
 *                         a product SOURCE (the Twyford short-circuit). One
 *                         with headers only is an emission TARGET. Same label,
 *                         opposite roles, told apart by content rather than by
 *                         asking the user to declare it.
 *   same upload batch     Files uploaded together share a ledger runId, so the
 *                         empty template in that batch is the one its
 *                         catalogues emit into. No new UI, no pairing step.
 *
 * Falls back to the bundled sanitary template so existing sources keep working.
 */
const templateCache = new Map(); // uploadId -> resolved path (per process)

async function resolveTemplateFor(upload) {
  if (!upload?.runId) return TEMPLATE;
  const key = String(upload._id ?? upload.runId);
  if (templateCache.has(key)) return templateCache.get(key);

  let resolved = TEMPLATE;
  try {
    const siblings = await UploadLedger.find({
      runId: upload.runId,
      $or: [{ "triage.label": "bk_template" }, { "triage.verifiedLabel": "bk_template" }],
    })
      .sort({ createdAt: -1 })
      .lean();

    for (const s of siblings) {
      if (String(s._id) === String(upload._id)) continue; // a sheet cannot be its own target
      const p = resolveRunPath(s.storedPath);
      if (!p) continue;
      const { rows } = await readDataRows(p); // filled = product source, empty = target
      if (rows.length === 0) {
        resolved = p;
        break;
      }
    }
  } catch {
    resolved = TEMPLATE; // an unreadable sibling must not stop the emission
  }

  templateCache.set(key, resolved);
  return resolved;
}

let styleExamplesCache = null;
async function styleExamples() {
  // house style learned from the golden file's own Description column (D3)
  if (!styleExamplesCache) {
    const { rows } = await readDataRows(path.resolve(__dirname, "../../fixtures/01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx"));
    styleExamplesCache = rows.map((r) => r.values["Description"]).filter(Boolean).slice(0, 2);
  }
  return styleExamplesCache;
}

/* Stage 8 generation is the emit hot path — one Claude call per un-described
   row, and serially that dominates wall time (22 calls ≈ 160s of a 185s run).
   Run them through a bounded pool instead; the cap keeps us well inside the
   Anthropic rate limit while cutting the phase to roughly one call's latency
   per batch. */
const GENERATE_CONCURRENCY = 6;

async function mapPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/* ─── POST /api/emit — Stage 7→10 over stored IPRs ─── */
router.post("/", async (req, res, next) => {
  try {
    const { generate = true, regenerate = false, uploadIds = [] } = req.body ?? {};
    const run = createRun("emit");
    const started = Date.now();

    // uploadIds narrows the emission to those source files — a walkthrough
    // emits only what it just processed. Empty emits the whole store.
    const scope = uploadIds.length ? { upload: { $in: uploadIds } } : {};
    // runId is selected because template resolution pairs a catalogue with the
    // template uploaded in the SAME batch — without it every source silently
    // falls back to the bundled sanitary sheet.
    const iprs = await IPR.find(scope).populate("upload", "originalName triage storedPath runId").lean();
    if (!iprs.length) {
      return res.status(400).json({
        error: uploadIds.length
          ? "No extracted rows for the selected files — run extraction first"
          : "No IPRs to emit — run extraction first",
      });
    }

    /* Each source emits into ITS OWN template when one was uploaded alongside
       it, so a safe catalogue is no longer forced through Wash Basins &
       Pedestals. Resolved per IPR, then grouped: one workbook per template. */
    for (const ipr of iprs) {
      ipr.__template = await resolveTemplateFor(ipr.upload);
    }
    const templatePaths = [...new Set(iprs.map((i) => i.__template))];
    const schemaByTemplate = new Map();
    for (const t of templatePaths) schemaByTemplate.set(t, await readTemplateSchema(t));
    if (templatePaths.length > 1) {
      run.log({ kind: "multi_template", count: templatePaths.length, templates: templatePaths.map((t) => path.basename(t)) });
    }
    const schema = schemaByTemplate.get(templatePaths[0]);
    const examples = await styleExamples();

    // media pairing: product_image uploads ↔ base products (Cloudinary URLs)
    const images = await UploadLedger.find({
      $or: [{ "triage.label": "product_image" }, { "triage.verifiedLabel": "product_image" }],
    }).lean();
    // Resolve to absolute paths here, at the boundary, so pairing reads a path
    // that exists on this machine — and silently drops images whose source file
    // did not come across with the record.
    const uniqueImages = [...new Map(images.map((i) => [i.originalName, i])).values()]
      .map((i) => ({ ...i, storedPath: resolveRunPath(i.storedPath) }))
      .filter((i) => i.storedPath);
    const { paired, unpaired } = await pairAndUploadMedia(uniqueImages, iprs, { log: run.log });
    for (const name of unpaired) {
      await ReviewItem.create({ runId: run.runId, reason: "unpaired_media", detail: name });
    }

    const rowsByTemplate = new Map(templatePaths.map((t) => [t, []]));
    const report = {
      total: iprs.length,
      dispositions: { PASS: 0, REVIEW: 0, TODO: 0 },
      perCatalog: {},
      exemptions: {},
      generation: { generated: 0, regenerated: 0, reused: 0, factCheckFailed: 0 },
      media: { paired: paired.size, unpaired: unpaired.length },
      customDropdownValues: 0, // permitted by the template's Instructions; reported, not blocked
    };

    // Map each row once, then fill the missing Descriptions concurrently.
    // Cached Stage 8 output is reused unless the caller asks to regenerate, so
    // a second emit of an unchanged catalog costs no AI calls at all.
    const prepared = iprs.map((ipr) => ({ ipr, ...mapIprToRow(ipr, schemaByTemplate.get(ipr.__template)) }));
    const wantsContent = (p) => generate && !p.ipr.templateRow && !p.row["Description"];
    const pending = prepared.filter(
      (p) => wantsContent(p) && (regenerate || !p.ipr.generated?.description)
    );
    await mapPool(pending, GENERATE_CONCURRENCY, async (p) => {
      p.gen = await generateContent(p.ipr, examples, { log: run.log });
      await IPR.updateOne(
        { _id: p.ipr._id },
        {
          generated: {
            description: p.gen.description,
            tags: p.gen.tags,
            factChecked: p.gen.factChecked,
            violations: p.gen.violations,
            at: new Date(),
          },
        }
      );
    });

    for (const p of prepared) {
      const { ipr, row, profile, dropdownFlags } = p;
      const catalog = ipr.upload?.originalName ?? "unknown";

      let factChecked = true;
      const gen = p.gen ?? (wantsContent(p) ? ipr.generated : null);
      if (gen?.description) {
        if (p.gen) {
          report.generation.generated++;
          if (p.gen.regenerated) report.generation.regenerated++;
        } else {
          report.generation.reused++;
        }
        if (!gen.factChecked) {
          report.generation.factCheckFailed++;
          factChecked = false;
          await ReviewItem.create({
            runId: run.runId,
            ipr: ipr._id,
            reason: "fact_check_failed",
            detail: (gen.violations ?? []).join("; "),
          });
        }
        row["Description"] = gen.description;
        row["Tags"] = (gen.tags ?? []).join(",");
      }

      const cover = mediaUrlFor(ipr, paired);
      if (cover && !row["Cover Image"]) row["Cover Image"] = cover;
      if (cover && !cover.startsWith("local://")) {
        await IPR.updateOne({ _id: ipr._id }, { $addToSet: { mediaRefs: cover } });
      }

      // Gate against the row's OWN template — required columns differ per
      // template, and checking a safes row against Wash Basins would fail it
      // on Drain Size, exactly the problem this feature exists to remove.
      const gate = gateRow({ ipr, row, schema: schemaByTemplate.get(ipr.__template), profile, dropdownFlags, factChecked });
      report.customDropdownValues += gate.customDropdowns.length;
      await IPR.updateOne({ _id: ipr._id }, { disposition: gate.disposition });
      report.dispositions[gate.disposition]++;
      const cat = (report.perCatalog[catalog] ??= { PASS: 0, REVIEW: 0, TODO: 0, total: 0 });
      cat[gate.disposition]++;
      cat.total++;
      for (const ex of gate.exemptions) report.exemptions[ex] = (report.exemptions[ex] || 0) + 1;

      // D4: TODO rows emit with blank price + todo entry. Upsert on the SKU —
      // creating unconditionally meant every re-emit duplicated the whole
      // queue (600 rows had accumulated across runs). A todo already marked
      // done is left alone rather than silently reopened.
      if (gate.disposition === "TODO") {
        const sku = row["Product SKU"] || ipr.identity?.productCode?.value || null;
        await TodoItem.updateOne(
          { type: "price_missing", sku },
          {
            $set: {
              runId: run.runId,
              vendor: "Satkay Limited",
              detail: `price missing for ${row["Unique Product Name"] || "row"}`,
              sourceFile: catalog,
            },
            $setOnInsert: { status: "open" },
          },
          { upsert: true }
        );
      }

      if (gate.disposition !== "REVIEW") {
        rowsByTemplate.get(ipr.__template).push(row);
        if (ipr.upload?._id) {
          await UploadLedger.updateOne({ _id: ipr.upload._id }, { $addToSet: { emittedIdentityKeys: identityKey(ipr) } });
        }
      }
    }

    const emissionDir = path.join(run.dir, "emission");
    fs.mkdirSync(emissionDir, { recursive: true });
    const files = [];
    const perTemplate = [];
    for (const [tpl, rows] of rowsByTemplate) {
      if (!rows.length) continue;
      // One workbook per template, named after it when more than one is in
      // play so two sheets never collide on BK_bulk_upload.xlsx.
      const label = templatePaths.length > 1 ? `BK_bulk_upload__${path.basename(tpl).replace(/\.xlsx$/i, "")}.xlsx` : "BK_bulk_upload.xlsx";
      const written = await emitRows(tpl, rows, path.join(emissionDir, label));
      files.push(...written);
      perTemplate.push({ template: path.basename(tpl), rows: rows.length, files: written.map((f) => path.basename(f)) });
    }
    report.templates = perTemplate;
    const rowsOut = [...rowsByTemplate.values()].flat();

    report.zeroTouch = report.total ? (report.dispositions.PASS + report.dispositions.TODO) / report.total : 0;
    report.emittedRows = rowsOut.length;
    report.files = files.map((f) => path.basename(f));
    report.wallMs = Date.now() - started;
    fs.writeFileSync(path.join(run.dir, "emission_report.json"), JSON.stringify(report, null, 2));
    run.log({ kind: "emit_complete", ...report });

    res.status(201).json({ runId: run.runId, ...report });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /api/emit/download/:runId/:file — the emitted xlsx ─── */
router.get("/download/:runId/:file", (req, res, next) => {
  try {
    const file = path.join(runsRoot(), req.params.runId, "emission", path.basename(req.params.file));
    if (!fs.existsSync(file)) return res.status(404).json({ error: "File not found" });
    res.download(file);
  } catch (err) {
    next(err);
  }
});

export default router;
