import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env lives at the monorepo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import express from "express";
import cors from "cors";
import connectDB from "./config/db.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import triageRoutes from "./routes/triageRoutes.js";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";

connectDB();

const app = express();
app.disable("x-powered-by");
app.use(express.json());

const allowlist = ["http://localhost:5173", "http://localhost:4173"];
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/uploads", uploadRoutes);
app.use("/api/triage", triageRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`BK-Ingest API running on port ${PORT}`));
