# BK-Ingest — BuildersKonnect AI Catalog Onboarding PoC

AI pipeline that triages arbitrary vendor uploads, extracts and normalizes product
data, classifies against a trade-based taxonomy, and emits BK's exact bulk-upload
Excel template — with per-field confidence gating and human review queues.
**Nothing wrong enters the catalog silently; nothing is dismissed silently.**

Governing documents live in [docs/](docs/) — the Knowledge Base, Design Document,
Decisions Addendum (D8–D11), ratified acceptance tests (T1–T8), and
[BUILD_PROMPT.md](docs/BUILD_PROMPT.md) (build order as amended). New decisions:
[docs/DECISIONS.md](docs/DECISIONS.md) (D12+).

## Setup

```bash
cd server && npm install    # Express 5 pipeline
cd ../client && npm install # React showcase
cp .env.example .env        # at repo root — fill ANTHROPIC_API_KEY, MONGODB_URI, Cloudinary
cd server && npm run seed   # D1 taxonomy + D9 ID register into MongoDB
```

## Run

```bash
cd server && npm run dev    # API on :5000
cd client && npm run dev    # showcase on :5173 (proxies /api)
```

## Evaluate

```bash
cd server
npm test                    # Vitest — structural/rule-tier fixture tests
npm run eval                # T1–T8 scorecard → runs/<timestamp>/scorecard.json
npm run probe               # Milestone A vision cost/latency probe (HD_BOOKET sample)
```

`fixtures/` is read-only — all pipeline artifacts are written to `runs/<timestamp>/`.

## Repo layout (D13 — ADLM house structure)

- `server/` — Express 5 pipeline: `index.js`, `db.js`, `stages/` (Stage 0–10),
  `models/` (PascalCase named exports), `services/`, `routes/`, `eval/` (T1–T8 scorers),
  `taxonomy/` (D1 tree + D9 `cat_` ID register + seed), `emitter/` (D6)
- `client/` — React 19 + Vite + Tailwind v4 + framer-motion showcase:
  Upload, TriageVerify (D11); ReviewQueue/Todo/Products/PriceCompare/RunReport to follow
- `ground-truth/` — human-verified annotations (schema in Milestone B)

## Deploy

- **client → Vercel** (`client/` as project root, `VITE_API_BASE` = Render URL)
- **server → Render** (`server/` as root dir; env vars in dashboard; see `render.yaml`)

## Milestone status

- **A — Skeleton + Stage 0 triage**: ✅ Gate G1 passed 18-Jul-2026 (T1 10/10, T8 100%, vision probe green)
- **B — Clean extraction + emitter round-trip + anomaly injector**: ✅ built 18-Jul-2026 — awaiting Gate G2
  accuracy review (interim T2 94.7%; sole miss is the Artize⊂Jaquar lineage, by design a Stage 5 concern;
  Twyford round-trip lossless; injector seeded+deterministic; SG_BK → Satkay vendor profile parsed via D11)
- **C — Classification & registries**: ✅ built 18-Jul-2026 — T6 PASS (Jaquar+Artize → base + 9 finishes
  each, derived SKUs labelled); 3-method classifier 3/3 nodes; brand registry 3/3 canonical
  (Artize ⊂ Jaquar resolved by QUA- code signature); T2 post-Stage5 = 100% clean sources;
  D14/D15 proposed in docs/DECISIONS.md pending ratification
- D — Hostile sources (vision path): next
- E — Content, emission, pricing: pending
