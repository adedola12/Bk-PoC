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

export default router;
