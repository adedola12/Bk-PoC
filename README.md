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
npm install                 # workspaces: apps/api, apps/web, packages/*
cp .env.example .env        # fill ANTHROPIC_API_KEY, MONGODB_URI, Cloudinary
npm run seed                # D1 taxonomy + D9 ID register into MongoDB
```

## Run

```bash
npm run dev                 # API on :5000
npm run dev:web             # React showcase on :5173 (proxies /api)
```

## Evaluate

```bash
npm test                    # Vitest — structural/rule-tier fixture tests
npm run eval                # T1–T8 scorecard → runs/<timestamp>/scorecard.json
npm run probe               # Milestone A vision cost/latency probe (HD_BOOKET sample)
```

`fixtures/` is read-only — all pipeline artifacts are written to `runs/<timestamp>/`.

## Repo layout

- `apps/api` — Express 5 pipeline: `src/stages/` (Stage 0–10), `src/models/`,
  `src/services/`, `src/routes/`, `src/eval/` (T1–T8 scorers)
- `apps/web` — React (Vite) showcase: Upload, TriageVerify (D11), ReviewQueue…
- `packages/taxonomy` — D1 tree + D9 `cat_` ID register + seed
- `packages/emitter` — template-driven xlsx emitter (D6)
- `ground-truth/` — human-verified annotations (schema in Milestone B)

## Milestone status

- **A — Skeleton + Stage 0 triage**: in progress (this gate: T1 + T8 + vision probe)
- B — Clean extraction + emitter round-trip + anomaly injector: pending
- C — Classification & registries: pending
- D — Hostile sources (vision path): pending
- E — Content, emission, pricing: pending
