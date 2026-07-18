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
import { ensureBrandsSeeded } from "./stages/stage5_brand.js";
import uploadRoutes from "./routes/uploads.js";
import triageRoutes from "./routes/triage.js";
import pipelineRoutes from "./routes/pipeline.js";

await connectDB();
await ensureBrandsSeeded().catch((err) => console.error("brand seed failed:", err.message));

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

/* CORS — env-extendable allowlist merged with local dev origins (ADLM pattern) */
const PROD_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const allowlist = Array.from(new Set([...PROD_ORIGINS, "http://localhost:5173", "http://localhost:4173"]));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowlist.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
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

/* ─── error tail ─── */
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  const status = res.statusCode !== 200 ? res.statusCode : err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`BK-Ingest API running on port ${PORT}`));
