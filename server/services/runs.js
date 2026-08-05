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

/**
 * Artifact paths are persisted RELATIVE to the runs root, never absolute.
 *
 * Absolute paths do not survive the machine that wrote them. Records written on
 * Render carry `/opt/render/project/src/runs/...` and records written on a
 * Windows dev box carry `C:\Users\...\runs\...`; after the move to EC2 both name
 * files that cannot exist here, and every read of them fails with a raw ENOENT
 * that leaks the old layout into the UI.
 *
 * Storing the run-relative tail instead makes a record mean the same thing on
 * whatever machine reads it, because the root is resolved at read time.
 */
export function toRunRelative(abs) {
  if (!abs) return abs ?? null;
  const rel = path.relative(RUNS_ROOT, abs);
  // Outside the runs root (path.relative escapes with "..") — keep it verbatim
  // rather than inventing a relative path that would resolve somewhere wrong.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join("/");
}

/**
 * Resolve a stored artifact path to an absolute path on THIS machine.
 *
 * Handles three shapes, because the database predates the relative convention:
 *   - run-relative ("2026-07-31T05-11Z_intake/intake/x.pdf") — the new form
 *   - absolute and still valid — returned as-is
 *   - absolute from another machine (Render POSIX or Windows) — re-rooted by
 *     taking the tail after the last "runs" segment
 *
 * @returns {string|null} absolute path that exists, or null when the artifact is
 *   genuinely not on this deployment. Callers must treat null as "the source
 *   file is gone", not as an error to throw a stack trace over.
 */
export function resolveRunPath(stored) {
  if (!stored) return null;

  // Contained under the runs root: a stored value is data, and "../../etc/passwd"
  // would otherwise resolve to a real file and be served.
  const within = (abs) =>
    (abs === RUNS_ROOT || abs.startsWith(RUNS_ROOT + path.sep)) && fs.existsSync(abs) ? abs : null;

  if (!path.isAbsolute(stored) && !/^[a-zA-Z]:[\\/]/.test(stored)) {
    return within(path.resolve(RUNS_ROOT, stored.split("/").join(path.sep)));
  }

  // Absolute and still valid (rows written on this machine before the relative
  // convention). Contained too — an absolute path is no more trustworthy than a
  // relative one just because it resolves.
  if (within(stored)) return stored;

  // Foreign absolute path: recover the tail after the last "runs" segment and
  // re-root it here. Split on both separators — a Windows path read on Linux
  // has backslashes that path.sep will not match.
  const parts = stored.split(/[\\/]+/);
  const idx = parts.lastIndexOf("runs");
  if (idx === -1 || idx === parts.length - 1) return null;
  return within(path.join(RUNS_ROOT, ...parts.slice(idx + 1)));
}
