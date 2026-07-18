import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run records — every pipeline invocation writes artifacts to runs/<timestamp>/
 * (integrity rule §6.6: fixtures are read-only; artifacts live here).
 * The run log accumulates per-call AI cost + latency (feeds T7).
 * Resolved from this file's location so it works regardless of cwd.
 */
const RUNS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runs");

export function createRun(label = "run") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${stamp}_${label}`;
  const dir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(path.join(dir, "previews"), { recursive: true });
  const logPath = path.join(dir, "log.jsonl");

  const log = (entry) =>
    fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

  return { runId, dir, log };
}

export function runsRoot() {
  return RUNS_ROOT;
}
