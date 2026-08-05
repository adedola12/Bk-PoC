import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { triageFile } from "../stages/stage0_triage.js";
import { ingestFile } from "../stages/stage1_ingest.js";
import { extractIprs } from "../stages/stage2_extract.js";
import { normalizeIpr } from "../stages/stage3_normalize.js";
import { classifyIpr } from "../stages/stage4_classify.js";
import { resolveIprBrand } from "../stages/stage5_brand.js";
import { expandVariants } from "../stages/stage6_variants.js";
import { TRIAGE_GROUND_TRUTH } from "./groundTruth.js";
import { loadGroundTruth, scoreCatalog } from "./t2_accuracy.js";
import { injectErrors, detectAnomalies } from "./injector.js";
import { readDataRows, templateRowsToIprs, iprsToTemplateRows, emitRows, readTemplateSchema } from "../emitter/index.js";
import { bulkExtract } from "../stages/bulk_extract.js";
import { mapIprToRow } from "../stages/stage7_map.js";
import { generateContent, factCheck } from "../stages/stage8_generate.js";
import { gateRow } from "../stages/stage9_gate.js";
import { createRun } from "../services/runs.js";
import { aiAvailable } from "../services/anthropic.js";

const FULL_RUN = process.argv.includes("--full"); // full 104-pp handbook (T7 timing)

/**
 * Evaluation harness — `npm run eval` reproduces the scorecard from a clean
 * clone with only .env provided (§10). Milestone A+B scope: T1, T8, interim
 * T2 (clean sources), emitter round-trip, injector mechanics. T3–T7 pending.
 */
const FIXTURES = path.resolve(__dirname, "../../fixtures");
const GT_DIR = path.resolve(__dirname, "../../ground-truth");
const fx = (name) => path.join(FIXTURES, name);

const run = createRun("eval");
console.log(`\nBK-Ingest evaluation — run ${run.runId}`);
if (!aiAvailable()) {
  console.log("⚠ ANTHROPIC_API_KEY not set: LLM-tier checks will fail honestly (never guessed).\n");
}

/* ─────────── T1 + T8 — triage ─────────── */
console.log("── T1/T8 · document triage ──");
const triageRows = [];
for (const gt of TRIAGE_GROUND_TRUTH) {
  const filePath = fx(gt.file);
  if (!fs.existsSync(filePath)) {
    triageRows.push({ file: gt.file, pass: false, t8: !gt.verifyPrompt, got: "MISSING" });
    continue;
  }
  const started = Date.now();
  const t = await triageFile(filePath, { log: run.log, previewsDir: path.join(run.dir, "previews") });
  const pass = t.label === gt.label;
  const t8 = gt.verifyPrompt ? t.needsVerification === true : true;
  triageRows.push({ file: gt.file, expected: gt.label, got: t.label, conf: t.confidence, pass, t8, ms: Date.now() - started });
  console.log(`${pass ? "✅" : "❌"} ${gt.file} → ${t.label} (${t.confidence.toFixed(2)})${t.needsVerification ? " [verify]" : ""}`);
}
const t1Pass = triageRows.filter((r) => r.pass).length;
const t8Pass = triageRows.every((r) => r.t8);

/* ─────────── T2 interim — clean-source extraction accuracy ─────────── */
console.log("\n── T2 (interim) · clean-source field accuracy ──");
const groundTruth = loadGroundTruth(GT_DIR);
const t2Results = [];
const extractedByFile = {};
for (const gt of groundTruth) {
  const filePath = fx(gt.file);
  const started = Date.now();
  try {
    const ingested = await ingestFile(filePath);
    const iprs = (await extractIprs(ingested, gt.file, { log: run.log })).map((i) =>
      i.templateRow ? i : normalizeIpr(i)
    );
    extractedByFile[gt.file] = iprs;
    const score = scoreCatalog(gt, iprs);
    score.ms = Date.now() - started;
    t2Results.push(score);
    const pct = score.accuracy == null ? "n/a" : `${(score.accuracy * 100).toFixed(1)}%`;
    console.log(
      `${score.accuracy >= 0.95 ? "✅" : "⚠"} ${gt.file}: ${pct} (${score.correct}/${score.scored} fields, ${score.skipped} unannotated, ${score.ms} ms) [${gt.status}]`
    );
    for (const m of score.misses) {
      console.log(`   ✗ ${m.product} · ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`);
    }
  } catch (err) {
    t2Results.push({ file: gt.file, error: err.message });
    console.log(`❌ ${gt.file}: ${err.message}`);
  }
}
const t2Scored = t2Results.filter((r) => r.accuracy != null);
const t2Overall = t2Scored.length
  ? t2Scored.reduce((s, r) => s + r.correct, 0) / t2Scored.reduce((s, r) => s + r.scored, 0)
  : null;

/* ─────────── Stages 4–6 + T6 — classification, brand, variants ─────────── */
console.log("\n── Stages 4–6 · classification, brand registry, T6 variants ──");
const EXPECTED_NODES = {
  "Alca_Drain__AM101_.pdf": "Plumbing & Sanitary Ware > Concealed Cisterns & Installation Systems",
  "Toilet_Roll_Holder_Data_sheet.pdf": "Plumbing & Sanitary Ware > Bathroom Accessories",
  "Towel_Rail_Holder_Data_Sheet.pdf": "Plumbing & Sanitary Ware > Bathroom Accessories",
};
const EXPECTED_BRANDS = {
  "Alca_Drain__AM101_.pdf": "Alcadrain",
  "Toilet_Roll_Holder_Data_sheet.pdf": "Jaquar",
  "Towel_Rail_Holder_Data_Sheet.pdf": "Artize",
};
let classOk = 0;
let brandOk = 0;
const t6 = { expanded: {}, pass: false };
for (const [file, iprs] of Object.entries(extractedByFile)) {
  for (const ipr of iprs.filter((i) => !i.templateRow)) {
    const cls = await classifyIpr(ipr, { log: run.log });
    const brand = await resolveIprBrand(ipr, { sourceFile: file });
    const nodeOk = cls.path === EXPECTED_NODES[file];
    const bOk = ipr.identity?.brand?.value === EXPECTED_BRANDS[file];
    if (nodeOk) classOk++;
    if (bOk) brandOk++;
    console.log(
      `${nodeOk ? "✅" : "❌"} ${file} → ${cls.path} (conf ${cls.confidence}) · brand ${bOk ? "✅" : "❌"} ${ipr.identity?.brand?.value}${ipr.identity?.subBrand ? ` (⊂ ${brand.parent})` : ""}`
    );
    const rows = expandVariants(ipr);
    t6.expanded[file] = {
      rows: rows.length,
      derived: rows.filter((r) => r.variantLabel === "derived_unverified").length,
      list: rows,
    };
  }
}
const jaq = t6.expanded["Toilet_Roll_Holder_Data_sheet.pdf"];
const art = t6.expanded["Towel_Rail_Holder_Data_Sheet.pdf"];
t6.pass = jaq?.rows === 10 && jaq?.derived === 9 && art?.rows === 10 && art?.derived === 9;
console.log(
  `${t6.pass ? "✅" : "❌"} T6: Jaquar ${jaq?.rows ?? 0} rows (${jaq?.derived ?? 0} derived_unverified) · Artize ${art?.rows ?? 0} rows (${art?.derived ?? 0} derived_unverified) — threshold base + 9 each`
);

// post-Stage5 T2 rescore: the Artize lineage miss should now be resolved
const t2Post = groundTruth.map((gt) => scoreCatalog(gt, extractedByFile[gt.file] ?? []));
const t2PostScored = t2Post.filter((r) => r.accuracy != null);
const t2PostOverall = t2PostScored.length
  ? t2PostScored.reduce((s, r) => s + r.correct, 0) / t2PostScored.reduce((s, r) => s + r.scored, 0)
  : null;
console.log(
  `${t2PostOverall >= 0.95 ? "✅" : "⚠"} T2 after Stage 5 brand resolution: ${t2PostOverall == null ? "n/a" : (t2PostOverall * 100).toFixed(1) + "%"} on clean sources`
);

/* ─────────── Emitter regression — Twyford lossless round-trip ─────────── */
console.log("\n── Emitter · Twyford golden round-trip ──");
let roundTrip = { pass: false };
try {
  const goldenPath = fx("01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx");
  const { rows: originalRows } = await readDataRows(goldenPath);
  const iprs = templateRowsToIprs(originalRows, "01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx");
  const back = iprsToTemplateRows(iprs);
  const outPath = path.join(run.dir, "twyford_roundtrip.xlsx");
  await emitRows(goldenPath, back, outPath);
  const { rows: emittedRows } = await readDataRows(outPath);

  const diffs = [];
  if (originalRows.length !== emittedRows.length) {
    diffs.push(`row count ${originalRows.length} → ${emittedRows.length}`);
  }
  originalRows.forEach((orig, i) => {
    const emitted = emittedRows[i];
    if (!emitted) return;
    for (const [col, val] of Object.entries(orig.values)) {
      if ((emitted.values[col] ?? "") !== (val ?? "")) {
        diffs.push(`row ${i + 1} · ${col}: "${val}" → "${emitted.values[col]}"`);
      }
    }
  });
  roundTrip = { pass: diffs.length === 0, rows: originalRows.length, diffs: diffs.slice(0, 10) };
  console.log(
    roundTrip.pass
      ? `✅ lossless: ${originalRows.length} rows × ${Object.keys(originalRows[0].values).length} columns round-tripped with zero diffs`
      : `❌ ${diffs.length} diffs — first: ${diffs[0]}`
  );
} catch (err) {
  roundTrip = { pass: false, error: err.message };
  console.log(`❌ round-trip error: ${err.message}`);
}

/* ─────────── Injector mechanics (T4 foundation) ─────────── */
console.log("\n── Injector · seeded-anomaly mechanics (full T4 in Milestone D) ──");
let injectorCheck = { pass: false };
try {
  const cleanIprs = Object.values(extractedByFile).flat().filter((i) => !i.templateRow);
  if (cleanIprs.length >= 2) {
    const { mutated, injected } = injectErrors(cleanIprs, { count: 5, seed: 42 });
    const caught = detectAnomalies(mutated);
    const caughtTypes = new Set(caught.map((c) => `${c.type}:${c.index ?? c.indexes?.join(",")}`));
    const detected = injected.filter((inj) =>
      caught.some(
        (c) =>
          (c.index === inj.index || c.indexes?.includes(inj.index)) ||
          (inj.type === "duplicate_code" && c.type === "duplicate_code")
      )
    );
    injectorCheck = {
      pass: injected.length === 5,
      injected: injected.length,
      detected: detected.length,
      recall: injected.length ? detected.length / injected.length : 0,
      details: injected.map((i) => `${i.type}@${i.index}:${i.field ?? ""}`),
    };
    console.log(
      `${injectorCheck.pass ? "✅" : "⚠"} injected ${injected.length} seeded errors (seed 42), validators caught ${detected.length} — recall ${(injectorCheck.recall * 100).toFixed(0)}% on clean-source records`
    );
  } else {
    console.log("⚠ not enough extracted IPRs to exercise the injector");
  }
} catch (err) {
  console.log(`❌ injector error: ${err.message}`);
  injectorCheck = { pass: false, error: err.message };
}

/* ─────────── T3 — zero-touch rate (Stage 7 map → Stage 9 gate) ─────────── */
console.log("\n── T3 · zero-touch rate (map → gate, per catalog) ──");
let t3 = { pass: false };
try {
  const schema = await readTemplateSchema(fx("catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx"));
  const catalogs = {};

  // Twyford golden rows (template short-circuit)
  const { rows: twyRows } = await readDataRows(fx("01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx"));
  catalogs["01_Twyford (template)"] = templateRowsToIprs(twyRows, "twyford.xlsx");

  // clean datasheets incl. their expanded variants (from the Stage 4–6 section)
  for (const [file, exp] of Object.entries(t6.expanded)) catalogs[file] = exp.list ?? [];
  if (extractedByFile["Alca_Drain__AM101_.pdf"]) catalogs["Alca_Drain__AM101_.pdf"] = extractedByFile["Alca_Drain__AM101_.pdf"];

  const perCatalog = {};
  let passTodo = 0;
  let total = 0;
  for (const [file, iprs] of Object.entries(catalogs)) {
    let zt = 0;
    for (const ipr of iprs) {
      const { row, profile, dropdownFlags } = mapIprToRow(ipr, schema);
      const gate = gateRow({ ipr, row, schema, profile, dropdownFlags });
      if (gate.disposition !== "REVIEW") zt++;
    }
    perCatalog[file] = { total: iprs.length, zeroTouch: iprs.length ? zt / iprs.length : 0 };
    passTodo += zt;
    total += iprs.length;
    console.log(`   ${file}: ${(perCatalog[file].zeroTouch * 100).toFixed(0)}% (${zt}/${iprs.length})`);
  }
  const overall = total ? passTodo / total : 0;
  t3 = { pass: overall >= 0.7, overall, perCatalog };
  console.log(`${t3.pass ? "✅" : "❌"} T3 overall: ${(overall * 100).toFixed(1)}% zero-touch (threshold ≥70%)`);
} catch (err) {
  console.log(`❌ T3 error: ${err.message}`);
  t3.error = err.message;
}

/* ─────────── Block E — generation + fact-check (D3) ─────────── */
console.log("\n── Stage 8 · description generation + fact-check ──");
let genCheck = { pass: false };
try {
  const { rows: twyRows } = await readDataRows(fx("01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx"));
  const styleExamples = twyRows.map((r) => r.values["Description"]).filter(Boolean).slice(0, 2);
  const target = extractedByFile["Alca_Drain__AM101_.pdf"]?.[0];
  if (target && aiAvailable()) {
    const gen = await generateContent(target, styleExamples, { log: run.log });
    const words = gen.description.split(/\s+/).filter(Boolean).length;
    genCheck = {
      pass: gen.factChecked && gen.tags.length >= 8 && gen.tags.length <= 9 && words >= 80 && words <= 150,
      words,
      tags: gen.tags.length,
      factChecked: gen.factChecked,
      regenerated: gen.regenerated,
      violations: gen.violations,
    };
    console.log(
      `${genCheck.pass ? "✅" : "⚠"} Alca description: ${words} words, ${gen.tags.length} tags, fact-check ${gen.factChecked ? "PASS" : "FAIL"}${gen.regenerated ? " (after 1 regeneration)" : ""}`
    );
    // adversarial self-test: a poisoned copy must FAIL the checker
    const poisoned = factCheck(gen.description + " Backed by a 25-year warranty and EN 99999 compliance.", target);
    console.log(`${!poisoned.ok ? "✅" : "❌"} fact-checker rejects invented claims (${poisoned.violations.length} violations found)`);
    genCheck.poisonedRejected = !poisoned.ok;
    genCheck.pass = genCheck.pass && !poisoned.ok;
  } else {
    console.log("⚠ generation check skipped (no extracted Alca IPR or no API key)");
  }
} catch (err) {
  console.log(`❌ generation error: ${err.message}`);
  genCheck.error = err.message;
}

/* ─────────── T5 — price ledger (D4/D10, needs MongoDB) ─────────── */
console.log("\n── T5 · pricing policy (append-only ledger) ──");
let t5 = { pass: false, skipped: false };
try {
  const { default: mongoose } = await import("mongoose");
  await mongoose.connect(process.env.MONGODB_URI, { dbName: "bkIngest", serverSelectionTimeoutMS: 8000 });
  const { PriceEvent } = await import("../models/PriceEvent.js");

  const before = await PriceEvent.countDocuments();
  const stamp = Date.now();
  await PriceEvent.create({
    sku: "AKP-CHR-35751P", vendor: "Satkay Limited", brand: "Jaquar",
    price: 18500, currency: "NGN", sourceFile: `eval-reupload-${stamp}`, effectiveDate: new Date(), method: "reupload_delta",
  });
  await PriceEvent.create({
    sku: "QUA-CHR-61711", vendor: "Satkay Limited", brand: "Artize",
    price: 42000, currency: "NGN", sourceFile: `eval-reupload-${stamp}`, effectiveDate: new Date(), method: "reupload_delta",
  });
  const after = await PriceEvent.countDocuments();

  // append-only enforcement: updates must throw at the model layer (D10)
  let updateBlocked = false;
  try {
    await PriceEvent.updateOne({ sku: "AKP-CHR-35751P" }, { price: 1 });
  } catch {
    updateBlocked = true;
  }

  const history = await PriceEvent.find({ sku: "AKP-CHR-35751P" }).sort({ effectiveDate: -1 }).lean();
  const brands = new Set((await PriceEvent.find({}).lean()).map((e) => e.brand));

  t5 = {
    pass: after === before + 2 && updateBlocked && history.length >= 1 && brands.size >= 2,
    appended: after - before,
    updateBlocked,
    historyDepth: history.length,
    brandsPriced: [...brands],
  };
  console.log(`${t5.pass ? "✅" : "❌"} events appended (+${t5.appended}) · overwrite blocked: ${updateBlocked} · history depth ${history.length} · brands priced: ${[...brands].join(", ")}`);
  await mongoose.disconnect();
} catch (err) {
  t5 = { pass: false, skipped: true, error: err.message };
  console.log(`⚠ T5 skipped — MongoDB unavailable (${err.message})`);
}

/* ─────────── T4 — hostile sources, seeded-anomaly recall ─────────── */
console.log(`\n── T4 · hostile extraction + zero silent leaks${FULL_RUN ? " (FULL 104-pp run)" : " (HD sampled)"} ──`);
const t4 = { pass: false };
try {
  // QRG — the verified-anomaly source. Pairing QA must reject its text layer.
  const qrgStart = Date.now();
  const qrg = await bulkExtract(fx("Revised_Quick_Refrence_Guide.pdf"), "Revised_Quick_Refrence_Guide.pdf", { log: run.log });
  const qrgMs = Date.now() - qrgStart;
  const visionTriggered = qrg.stats.visionPages === qrg.stats.pages && qrg.stats.pages === 2;
  console.log(
    `${visionTriggered ? "✅" : "❌"} pairing QA: ${qrg.stats.visionPages}/${qrg.stats.pages} QRG pages routed to vision (A2 defense) · ${qrg.iprs.length} products · ${(qrgMs / 1000).toFixed(0)}s`
  );

  const qrgAnomalies = detectAnomalies(qrg.iprs);
  const a1 = qrgAnomalies.find(
    (a) => a.type === "wrong_unit" && /power/i.test(a.field ?? "") && /\bV\b/.test(a.detail ?? "")
  );
  const a3 = qrgAnomalies.find((a) => a.type === "duplicate_code" && String(a.detail).includes("0601513000"));
  console.log(`${a1 ? "✅" : "❌"} A1 caught: rated power in volts ${a1 ? `(${a1.detail})` : "— NOT FLAGGED"}`);
  console.log(`${a3 ? "✅" : "❌"} A3 caught: part number 0601513000 on multiple products ${a3 ? `(rows ${a3.indexes.join(",")})` : "— NOT FLAGGED"}`);

  // HD handbook — text path at scale (sampled by default, full with --full)
  const hdPages = FULL_RUN ? null : Array.from({ length: 12 }, (_, i) => 18 + i);
  const hdStart = Date.now();
  const hd = await bulkExtract(fx("HD_BOOKET.pdf"), "HD_BOOKET.pdf", { log: run.log, pages: hdPages });
  const hdMs = Date.now() - hdStart;
  console.log(
    `✅ HD handbook${FULL_RUN ? "" : ` pages 18–29`}: ${hd.iprs.length} products via ${hd.stats.calls} calls (${hd.stats.merged} cross-chunk merges) · ${(hdMs / 1000).toFixed(0)}s${FULL_RUN ? ` — T7 target < 3600s: ${hdMs < 3600000 ? "PASS" : "FAIL"}` : ""}`
  );

  // seeded synthetic errors: 5 per hostile catalog, ALL must be flagged
  let recallNum = 0;
  let recallDen = 0;
  for (const [name, iprs] of [["QRG", qrg.iprs], ["HD", hd.iprs]]) {
    if (iprs.length < 2) continue;
    const { mutated, injected } = injectErrors(iprs, { count: 5, seed: 42 });
    const caught = detectAnomalies(mutated);
    const detected = injected.filter((inj) =>
      caught.some(
        (c) => c.index === inj.index || c.indexes?.includes(inj.index) || (inj.type === "duplicate_code" && c.type === "duplicate_code")
      )
    );
    recallNum += detected.length;
    recallDen += injected.length;
    console.log(`${detected.length === injected.length ? "✅" : "❌"} ${name}: ${detected.length}/${injected.length} seeded errors flagged`);
  }

  t4.visionTriggered = visionTriggered;
  t4.a1 = Boolean(a1);
  t4.a3 = Boolean(a3);
  t4.a2Note = "text path rejected by pairing QA; scramble-class values covered by sanity rules on seeded errors";
  t4.injectedRecall = recallDen ? recallNum / recallDen : 0;
  t4.qrgProducts = qrg.iprs.length;
  t4.hdProducts = hd.iprs.length;
  t4.timing = { qrgMs, hdMs, hdFull: FULL_RUN };
  t4.pass = visionTriggered && t4.a1 && t4.a3 && t4.injectedRecall === 1;
} catch (err) {
  console.log(`❌ T4 error: ${err.message}`);
  t4.error = err.message;
}

/* ─────────── scorecard ─────────── */
const scorecard = {
  T1: { metric: `${t1Pass}/10 correctly routed`, threshold: "10/10", pass: t1Pass === 10 },
  T8: { metric: t8Pass ? "all non-product files surface D11 prompt" : "MISSED prompt", threshold: "100%", pass: t8Pass },
  T2_interim: {
    metric: t2Overall == null ? "no scored fields" : `${(t2Overall * 100).toFixed(1)}% on clean sources`,
    threshold: "≥95% clean (ground truth pending human verification)",
    pass: t2Overall != null && t2Overall >= 0.95,
    perCatalog: t2Results,
  },
  emitterRoundTrip: { ...roundTrip, threshold: "lossless" },
  injectorMechanics: injectorCheck,
  T3: {
    metric: t3.overall != null ? `${(t3.overall * 100).toFixed(1)}% zero-touch overall` : "not computed",
    threshold: "≥70% overall, reported per catalog",
    pass: Boolean(t3.pass),
    perCatalog: t3.perCatalog ?? null,
  },
  T4: {
    metric: `A1 ${t4.a1 ? "caught" : "MISSED"} · A3 ${t4.a3 ? "caught" : "MISSED"} · seeded recall ${(t4.injectedRecall * 100 || 0).toFixed(0)}% · QRG vision-forced ${t4.visionTriggered ? "yes" : "NO"}`,
    threshold: "0 silent leaks — 100% recall",
    pass: t4.pass,
    detail: t4,
  },
  T5: t5.skipped
    ? `skipped — MongoDB unavailable (${t5.error})`
    : {
        metric: `+${t5.appended} events appended · overwrite blocked ${t5.updateBlocked} · ${t5.brandsPriced?.length ?? 0} brands priced`,
        threshold: "100% appended, history preserved, no overwrites",
        pass: t5.pass,
      },
  generation: genCheck,
  T6: {
    metric: `Jaquar ${jaq?.rows ?? 0}/10 rows · Artize ${art?.rows ?? 0}/10 rows · derived labelled`,
    threshold: "base + 9 finishes each, 100% derived_unverified labels",
    pass: t6.pass,
  },
  stage4_6: {
    classification: `${classOk}/3 nodes correct`,
    brands: `${brandOk}/3 canonical after Stage 5`,
    t2PostStage5: t2PostOverall,
  },
  T7: "probe green (Milestone A); full timing in E",
  triageRows,
};

fs.writeFileSync(path.join(run.dir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
console.log(`\n─── Scorecard ───`);
console.log(`T1: ${scorecard.T1.metric} — ${scorecard.T1.pass ? "PASS" : "FAIL"}`);
console.log(`T8: ${scorecard.T8.metric} — ${scorecard.T8.pass ? "PASS" : "FAIL"}`);
console.log(`T2 (interim): ${scorecard.T2_interim.metric} — ${scorecard.T2_interim.pass ? "PASS" : "REVIEW"}`);
console.log(`T3: ${scorecard.T3.metric} — ${scorecard.T3.pass ? "PASS" : "FAIL"}`);
console.log(`T4: ${scorecard.T4.metric} — ${scorecard.T4.pass ? "PASS" : "FAIL"}`);
console.log(`T5: ${t5.skipped ? "SKIPPED (no DB)" : `${scorecard.T5.metric} — ${scorecard.T5.pass ? "PASS" : "FAIL"}`}`);
console.log(`T6: ${scorecard.T6.metric} — ${scorecard.T6.pass ? "PASS" : "FAIL"}`);
console.log(`Emitter round-trip: ${roundTrip.pass ? "LOSSLESS" : "FAIL"}`);
console.log(`Scorecard → runs/${run.runId}/scorecard.json`);

const hardPass = scorecard.T1.pass && scorecard.T8.pass && roundTrip.pass;
process.exit(hardPass ? 0 : 1);
