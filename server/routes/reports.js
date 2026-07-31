import express from "express";
import fs from "node:fs";
import path from "node:path";
import { runsRoot } from "../services/runs.js";

const router = express.Router();

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/* ─── GET /api/reports — every run with its artifacts ─── */
router.get("/", (req, res, next) => {
  try {
    const root = runsRoot();
    if (!fs.existsSync(root)) return res.json([]);
    const runs = fs
      .readdirSync(root)
      .filter((d) => fs.statSync(path.join(root, d)).isDirectory())
      .sort()
      .reverse()
      .slice(0, 40)
      .map((runId) => {
        const dir = path.join(root, runId);
        const files = fs.readdirSync(dir);
        return {
          runId,
          kind: runId.split("_").at(-1),
          scorecard: files.includes("scorecard.json") ? readJson(path.join(dir, "scorecard.json")) : null,
          emissionReport: files.includes("emission_report.json") ? readJson(path.join(dir, "emission_report.json")) : null,
          probe: files.includes("probe.json") ? readJson(path.join(dir, "probe.json")) : null,
          emissionFiles: fs.existsSync(path.join(dir, "emission"))
            ? fs.readdirSync(path.join(dir, "emission"))
            : [],
        };
      });
    res.json(runs);
  } catch (err) {
    next(err);
  }
});

/* ─── GET /api/reports/latest — newest scorecard + emission report ─── */
router.get("/latest", (req, res, next) => {
  try {
    const root = runsRoot();
    if (!fs.existsSync(root)) return res.json({ scorecard: null, emission: null });
    const dirs = fs
      .readdirSync(root)
      .filter((d) => fs.statSync(path.join(root, d)).isDirectory())
      .sort()
      .reverse();
    let scorecard = null;
    let scorecardRun = null;
    let emission = null;
    let emissionRun = null;
    for (const d of dirs) {
      if (!scorecard) {
        const s = readJson(path.join(root, d, "scorecard.json"));
        if (s) {
          scorecard = s;
          scorecardRun = d;
        }
      }
      if (!emission) {
        const e = readJson(path.join(root, d, "emission_report.json"));
        if (e) {
          emission = e;
          emissionRun = d;
        }
      }
      if (scorecard && emission) break;
    }
    res.json({ scorecard, scorecardRun, emission, emissionRun });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /api/reports/:runId/log — the run's log.jsonl ───
   Reads run detail (per-call AI cost/latency, cloudinary_failed, crawl
   progress) over HTTP, so diagnosing a deploy does not require shell access to
   the box. ?kind= filters by event kind (comma-separated), ?limit= returns
   the last N matching entries (newest-biased; default 500, max 5000). */
const RUN_ID = /^[0-9TZ:.-]+_[a-z-]+$/i; // createRun(): <ISO stamp>_<label>

router.get("/:runId/log", (req, res, next) => {
  try {
    const { runId } = req.params;
    if (!RUN_ID.test(runId)) return res.status(400).json({ error: "Invalid runId" });

    // Belt-and-braces against traversal: the resolved dir must sit under runs/.
    const root = runsRoot();
    const dir = path.resolve(root, runId);
    if (dir !== path.join(root, runId) || !fs.existsSync(dir)) {
      return res.status(404).json({ error: `Unknown run: ${runId}` });
    }

    const logPath = path.join(dir, "log.jsonl");
    if (!fs.existsSync(logPath)) return res.json({ runId, total: 0, returned: 0, entries: [] });

    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const kinds = req.query.kind ? new Set(String(req.query.kind).split(",").map((k) => k.trim())) : null;
    const limit = Math.min(Number(req.query.limit) || 500, 5000);

    // A truncated final line (run still writing) shouldn't fail the whole read.
    const entries = [];
    let malformed = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!kinds || kinds.has(entry.kind)) entries.push(entry);
      } catch {
        malformed++;
      }
    }

    res.json({
      runId,
      total: entries.length,
      returned: Math.min(entries.length, limit),
      ...(malformed ? { malformed } : {}),
      entries: entries.slice(-limit),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
