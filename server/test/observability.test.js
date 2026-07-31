import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { requestLog } from "../middleware/requestLog.js";
import reportRoutes from "../routes/reports.js";
import { runsRoot } from "../services/runs.js";

/** Boot an app on an ephemeral port and hand back a fetch bound to it. */
async function serve(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p) => fetch(base + p),
    close: () => new Promise((r) => server.close(r)),
  };
}

describe("request log middleware", () => {
  const lines = [];
  let api;

  beforeAll(async () => {
    const app = express();
    app.use(requestLog({ write: (m) => lines.push(m), slowMs: 20 }));
    app.get("/healthz", (req, res) => res.json({ ok: true }));
    app.get("/healthz-broken", (req, res) => res.status(503).json({ ok: false }));
    app.get("/pipeline/extract", (req, res) => res.json({ ok: true }));
    app.get("/slow", async (req, res) => {
      await new Promise((r) => setTimeout(r, 60));
      res.json({ ok: true });
    });
    app.get("/boom", (req, res) => res.status(500).json({ error: "x" }));
    app.use((req, res) => res.status(404).json({ error: "Not found" }));
    api = await serve(app);
  });
  afterAll(() => api.close());

  it("logs one line per request with method, path, status and duration", async () => {
    lines.length = 0;
    await api.get("/pipeline/extract");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/GET \/pipeline\/extract 200 \d+ms$/);
  });

  it("strips the query string — filters and ids stay out of a shared log", async () => {
    lines.length = 0;
    await api.get("/pipeline/extract?uploadId=secret-123");
    expect(lines[0]).not.toContain("secret-123");
    expect(lines[0]).toContain("/pipeline/extract");
  });

  it("skips successful health checks so Render's probe can't drown the log", async () => {
    lines.length = 0;
    await api.get("/healthz");
    expect(lines).toHaveLength(0);
  });

  it("still logs a failing health check", async () => {
    lines.length = 0;
    await api.get("/healthz-broken");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("503");
  });

  it("marks 5xx, 4xx, slow and ordinary requests distinguishably", async () => {
    lines.length = 0;
    await api.get("/boom");
    await api.get("/nope");
    await api.get("/slow"); // 60ms against slowMs: 20
    await api.get("/pipeline/extract");
    expect(lines[0].startsWith("✖")).toBe(true);
    expect(lines[1].startsWith("▲")).toBe(true);
    expect(lines[2].startsWith("…")).toBe(true);
    expect(lines[3].startsWith("·")).toBe(true);
  });
});

describe("GET /reports/:runId/log", () => {
  const RUN_ID = "2026-01-01T00-00-00-000Z_test";
  const EMPTY_RUN = "2026-01-01T00-00-00-001Z_test";
  let api;

  beforeAll(async () => {
    const dir = path.join(runsRoot(), RUN_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(runsRoot(), EMPTY_RUN), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "log.jsonl"),
      [
        JSON.stringify({ kind: "triage", file: "a.pdf" }),
        JSON.stringify({ kind: "ai_call", costUsd: 0.01 }),
        JSON.stringify({ kind: "ai_call", costUsd: 0.02 }),
        JSON.stringify({ kind: "cloudinary_failed", file: "b.jpg" }),
        '{"kind":"truncated"', // a run still writing — must not fail the read
      ].join("\n") + "\n"
    );
    const app = express();
    app.use("/reports", reportRoutes);
    api = await serve(app);
  });

  afterAll(async () => {
    await api.close();
    fs.rmSync(path.join(runsRoot(), RUN_ID), { recursive: true, force: true });
    fs.rmSync(path.join(runsRoot(), EMPTY_RUN), { recursive: true, force: true });
  });

  it("returns the run's entries and survives a truncated final line", async () => {
    const body = await (await api.get(`/reports/${RUN_ID}/log`)).json();
    expect(body.total).toBe(4);
    expect(body.malformed).toBe(1);
    expect(body.entries[0].kind).toBe("triage");
  });

  it("filters by kind, including comma-separated kinds", async () => {
    const one = await (await api.get(`/reports/${RUN_ID}/log?kind=ai_call`)).json();
    expect(one.total).toBe(2);
    const two = await (await api.get(`/reports/${RUN_ID}/log?kind=ai_call,cloudinary_failed`)).json();
    expect(two.total).toBe(3);
  });

  it("limit returns the tail, not the head", async () => {
    const body = await (await api.get(`/reports/${RUN_ID}/log?limit=2`)).json();
    expect(body.entries).toHaveLength(2);
    expect(body.returned).toBe(2);
    expect(body.entries.at(-1).kind).toBe("cloudinary_failed");
  });

  it("reports an empty log for a run that has not written one yet", async () => {
    const body = await (await api.get(`/reports/${EMPTY_RUN}/log`)).json();
    expect(body).toMatchObject({ total: 0, returned: 0, entries: [] });
  });

  it("404s an unknown run and 400s anything that isn't a run id", async () => {
    expect((await api.get("/reports/2026-01-01T00-00-00-999Z_test/log")).status).toBe(404);
    expect((await api.get("/reports/%2e%2e%2fetc/log")).status).toBe(400);
    expect((await api.get("/reports/etc%2Fpasswd/log")).status).toBe(400);
  });
});
