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
import { TRIAGE_GROUND_TRUTH } from "./groundTruth.js";
import { loadGroundTruth, scoreCatalog } from "./t2_accuracy.js";
import { injectErrors, detectAnomalies } from "./injector.js";
import { readDataRows, templateRowsToIprs, iprsToTemplateRows, emitRows } from "../emitter/index.js";
import { createRun } from "../services/runs.js";
import { hasApiKey } from "../services/anthropic.js";

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
if (!hasApiKey()) {
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
  T3: "pending (Milestone E)",
  T4: "injector ready — full seeded-recall run in Milestone D",
  T5: "pending (Milestone E)",
  T6: "pending (Milestone C)",
  T7: "probe green (Milestone A); full timing in E",
  triageRows,
};

fs.writeFileSync(path.join(run.dir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
console.log(`\n─── Scorecard ───`);
console.log(`T1: ${scorecard.T1.metric} — ${scorecard.T1.pass ? "PASS" : "FAIL"}`);
console.log(`T8: ${scorecard.T8.metric} — ${scorecard.T8.pass ? "PASS" : "FAIL"}`);
console.log(`T2 (interim): ${scorecard.T2_interim.metric} — ${scorecard.T2_interim.pass ? "PASS" : "REVIEW"}`);
console.log(`Emitter round-trip: ${roundTrip.pass ? "LOSSLESS" : "FAIL"}`);
console.log(`Scorecard → runs/${run.runId}/scorecard.json`);

const hardPass = scorecard.T1.pass && scorecard.T8.pass && roundTrip.pass;
process.exit(hardPass ? 0 : 1);
