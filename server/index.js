import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env lives at the repo root locally; on Render, env vars come from the dashboard
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { connectDB } from "./db.js";
import { requestLog } from "./middleware/requestLog.js";
import { ensureBrandsSeeded } from "./stages/stage5_brand.js";
import uploadRoutes from "./routes/uploads.js";
import triageRoutes from "./routes/triage.js";
import pipelineRoutes from "./routes/pipeline.js";
import emitRoutes from "./routes/emit.js";
import priceRoutes from "./routes/prices.js";
import reviewRoutes from "./routes/review.js";
import todoRoutes from "./routes/todos.js";
import reportRoutes from "./routes/reports.js";

await connectDB();
await ensureBrandsSeeded().catch((err) => console.error("brand seed failed:", err.message));

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(requestLog()); // one line per request — Render's only view into a live deploy
app.use(express.json({ limit: "2mb" }));

/* CORS — env-extendable allowlist merged with local dev origins (ADLM pattern).
   Origins normalize (lowercase, no trailing slash) so a pasted value with a
   trailing slash still matches; Vercel preview deployments of this project
   (bk-po-c-*.vercel.app) are allowed automatically. */
const normOrigin = (s) => String(s || "").trim().toLowerCase().replace(/\/+$/, "");
const PROD_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(normOrigin).filter(Boolean);
const allowlist = new Set([...PROD_ORIGINS, "http://localhost:5173", "http://localhost:4173"]);
const isAllowedOrigin = (origin) => {
  const o = normOrigin(origin);
  if (allowlist.has(o)) return true;
  return /^https:\/\/bk-po-c[a-z0-9-]*\.vercel\.app$/.test(o); // project preview URLs
};
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || isAllowedOrigin(origin)) return cb(null, true);
      cb(new Error(`Not allowed by CORS: ${origin} — add it to CORS_ORIGINS`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.get(["/health", "/healthz"], (req, res) =>
  res.json({ ok: true, db: mongoose.connection.readyState === 1 })
);

// mounted at both bare and /api paths (ADLM compatibility pattern)
app.use(["/uploads", "/api/uploads"], uploadRoutes);
app.use(["/triage", "/api/triage"], triageRoutes);
app.use(["/pipeline", "/api/pipeline"], pipelineRoutes);
app.use(["/emit", "/api/emit"], emitRoutes);
app.use(["/prices", "/api/prices"], priceRoutes);
app.use(["/review", "/api/review"], reviewRoutes);
app.use(["/todos", "/api/todos"], todoRoutes);
app.use(["/reports", "/api/reports"], reportRoutes);

/* ─── error tail ─── */
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (/Not allowed by CORS/.test(err.message || "")) {
    console.warn(err.message); // one-line warning, not a stack dump
    return res.status(403).json({ error: err.message });
  }
  const status = res.statusCode !== 200 ? res.statusCode : err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`BK-Ingest API running on port ${PORT}`));
