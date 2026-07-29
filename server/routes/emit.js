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
import { createRun, runsRoot } from "../services/runs.js";

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, "../../fixtures/catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx");

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
    const { generate = true, regenerate = false } = req.body ?? {};
    const run = createRun("emit");
    const started = Date.now();

    const iprs = await IPR.find({}).populate("upload", "originalName triage storedPath").lean();
    if (!iprs.length) return res.status(400).json({ error: "No IPRs to emit — run extraction first" });

    const schema = await readTemplateSchema(TEMPLATE);
    const examples = await styleExamples();

    // media pairing: product_image uploads ↔ base products (Cloudinary URLs)
    const images = await UploadLedger.find({
      $or: [{ "triage.label": "product_image" }, { "triage.verifiedLabel": "product_image" }],
    }).lean();
    const uniqueImages = [...new Map(images.map((i) => [i.originalName, i])).values()].filter((i) =>
      fs.existsSync(i.storedPath)
    );
    const { paired, unpaired } = await pairAndUploadMedia(uniqueImages, iprs, { log: run.log });
    for (const name of unpaired) {
      await ReviewItem.create({ runId: run.runId, reason: "unpaired_media", detail: name });
    }

    const rowsOut = [];
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
    const prepared = iprs.map((ipr) => ({ ipr, ...mapIprToRow(ipr, schema) }));
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

      const gate = gateRow({ ipr, row, schema, profile, dropdownFlags, factChecked });
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
        rowsOut.push(row);
        if (ipr.upload?._id) {
          await UploadLedger.updateOne({ _id: ipr.upload._id }, { $addToSet: { emittedIdentityKeys: identityKey(ipr) } });
        }
      }
    }

    const emissionDir = path.join(run.dir, "emission");
    fs.mkdirSync(emissionDir, { recursive: true });
    const files = await emitRows(TEMPLATE, rowsOut, path.join(emissionDir, "BK_bulk_upload.xlsx"));

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
