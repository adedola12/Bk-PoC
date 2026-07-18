import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { triageFile } from "../stages/stage0_triage.js";
import { TRIAGE_GROUND_TRUTH } from "./groundTruth.js";
import { createRun } from "../services/runs.js";
import { hasApiKey } from "../services/anthropic.js";

/**
 * Evaluation harness — `npm run eval` reproduces the scorecard from a clean
 * clone with only .env provided (§10). Milestone A scope: T1 + T8.
 * Later milestones append T2–T7 scorers here.
 */
const FIXTURES = path.resolve(__dirname, "../../../../fixtures");

const run = createRun("eval");
console.log(`\nBK-Ingest evaluation — run ${run.runId}`);
if (!hasApiKey()) {
  console.log("⚠ ANTHROPIC_API_KEY not set: LLM-tier files will route to human triage (never guessed) and T1 will fail.\n");
}

const rows = [];
for (const gt of TRIAGE_GROUND_TRUTH) {
  const filePath = path.join(FIXTURES, gt.file);
  if (!fs.existsSync(filePath)) {
    rows.push({ file: gt.file, expected: gt.label, got: "MISSING FILE", pass: false, t8: !gt.verifyPrompt });
    continue;
  }
  const started = Date.now();
  const t = await triageFile(filePath, { log: run.log, previewsDir: path.join(run.dir, "previews") });
  const pass = t.label === gt.label;
  const t8 = gt.verifyPrompt ? t.needsVerification === true : true;
  rows.push({
    file: gt.file,
    expected: gt.label,
    got: t.label,
    conf: t.confidence.toFixed(2),
    method: t.method,
    verify: t.needsVerification,
    ms: Date.now() - started,
    pass,
    t8,
  });
  console.log(`${pass ? "✅" : "❌"} ${gt.file} → ${t.label} (${t.confidence.toFixed(2)}, ${t.method})${t.needsVerification ? " [verify]" : ""}`);
}

const t1Pass = rows.filter((r) => r.pass).length;
const t8Pass = rows.every((r) => r.t8);
const scorecard = {
  T1: { metric: `${t1Pass}/10 correctly routed`, threshold: "10/10", pass: t1Pass === 10 },
  T8: { metric: t8Pass ? "all non-product files surface D11 prompt" : "MISSED prompt", threshold: "100%", pass: t8Pass },
  T2: "pending (Milestone B)",
  T3: "pending (Milestone E)",
  T4: "pending (Milestone B injector / D verification)",
  T5: "pending (Milestone E)",
  T6: "pending (Milestone C)",
  T7: "pending (probe numbers in Milestone A; full in E)",
  rows,
};

fs.writeFileSync(path.join(run.dir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
console.log(`\nT1: ${scorecard.T1.metric} — ${scorecard.T1.pass ? "PASS" : "FAIL"}`);
console.log(`T8: ${scorecard.T8.metric} — ${scorecard.T8.pass ? "PASS" : "FAIL"}`);
console.log(`Scorecard → runs/${run.runId}/scorecard.json`);
process.exit(scorecard.T1.pass && scorecard.T8.pass ? 0 : 1);
