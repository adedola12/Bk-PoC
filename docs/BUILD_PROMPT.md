# BuildersKonnect AI Catalog Onboarding PoC ("BK-Ingest")

How to use: Create your project folder (e.g. `bk-ingest/`), copy the project documents and sample files in as described in §2, open Claude Code in that folder, and paste everything below the line as your first prompt. Keep this file in the repo as `docs/BUILD_PROMPT.md` for reference.

---

You are building BK-Ingest, a proof-of-concept AI catalog-onboarding system for BuildersKonnect (BK), a Nigerian construction-materials marketplace. I am Adedolapo Quasim (ADLM Studio) — the engineer of record. Work with me iteratively; I ratify decisions.

## 1. Mission

Build a system where a vendor uploads arbitrary files (PDF / Excel / Word / images), the system determines what each file is (catalogue, single-product datasheet, product image, vendor document, other), extracts and normalizes product data with AI, classifies products against a trade-based taxonomy, expands variants, generates marketplace descriptions, and emits BK's exact bulk-upload Excel template — with per-field confidence scoring so trustworthy rows auto-pass and everything uncertain goes to a human review queue. Nothing wrong may enter the catalog silently; nothing may be dismissed silently.

## 2. Required reading — the knowledge base is law

Before writing any code, read every file in `docs/` and `fixtures/`, in this order:

1. `docs/BK_Catalog_Automation_Knowledge_Base_v1.1.md` — file inventory, BK template schema (30 columns, dropdowns, import rules), golden-example conventions, decisions D1–D7, master taxonomy draft, catalog profiles, anomaly log A1–A10, open questions.
2. `docs/BK_Catalog_Automation_Design_Document_v1.md` — the 11-stage pipeline (Stages 0–10), stage-by-stage justification, demonstration plan, risks, acceptance tests.
3. `docs/BK_Decisions_Addendum_D8-D11.md` — stack decision (this build), category ID register, price ledger, no-silent-dismissal rule. Where the addendum amends the design doc, the addendum wins.
4. `docs/BK_PoC_Acceptance_Tests_and_Evaluation_Strategy.pdf` — ratified tests T1–T8 and the master evaluation checklist. The build is done when this checklist passes.
5. `fixtures/` — the 10 real sample files (listed in KB §2). These are the PoC's entire test universe:
   - `catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx` — the output contract (D6)
   - `01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx` — golden example; emitter regression target
   - `Alca_Drain__AM101_.pdf`, `Toilet_Roll_Holder_Data_sheet.pdf`, `Towel_Rail_Holder_Data_Sheet.pdf` — clean datasheets
   - `HD_BOOKET.pdf` (104 pp), `Revised_Quick_Refrence_Guide.pdf` (2 ultra-wide pp) — hostile Bosch catalogs
   - `Jaguar_Toilet_Roll_Holder_Image.jpg`, `Jaquar_Towel_Rail_Holder_Image.jpg` — product images
   - `SG_BK.docx` — Satkay vendor registration form (MUST route to vendor_document, never product-extract; T8 test case)

If any of these files is missing from the folder, STOP and tell me before proceeding.

## 3. Binding design decisions (D1–D11)

- **D1** Trade-based master taxonomy (10 trades, KB §6); products auto-classified by deterministic rules → lexical/fuzzy → embeddings, in that cost order; method agreement raises confidence.
- **D2** Dynamic brand registry: canonical names, aliases (Jaguar→Jaquar), sub-brand lineage (Artize ⊂ Jaquar), product-code signatures; unknown brands auto-register as candidates with evidence, never blocking, never silently merging.
- **D3** Description (~100–130 words) + 8–9 tags generated per row in the Twyford golden-example house style; generated copy may only assert facts present in extracted data; post-generation fact-check pass, regenerate or flag on failure.
- **D4** Missing price → blank + todo entry; re-upload with price → price-only delta; manual entry supported.
- **D5** One row per purchasable variant; derived variant SKUs (manufacturer finish codes substituted into product code) labelled `derived_unverified`.
- **D6** The BK template xlsx IS the output contract. The emitter reads the template's own headers, required markers, dropdowns and Instructions sheet to shape output. Never hardcode the schema.
- **D7** Document triage is Stage 0 — classification before any extraction.
- **D8** Stack (this build): MERN monorepo — MongoDB, Express, React (JSX, Vite), Node.js ≥ 20. AI via Anthropic JS SDK (`claude-sonnet-4-6` default; vision for hostile PDFs/images). Excel via exceljs. Images via Cloudinary (upload + delivery URLs into template media columns). PDF rasterization for vision: any solid Node option (e.g. `pdf-to-img`/poppler wrapper) — pick one and justify in a comment.
- **D9** ADLM category ID register: issue `cat_` + 21-char nanoid IDs for every taxonomy node (matching BK's observed format, e.g. `cat_NMgutrpDUDaPfIxEbF7-h`); crosswalk collection maps ADLM ↔ BK IDs; every emitted ID carries provenance `adlm_registry` | `bk_confirmed`. Never present ADLM IDs as BK's.
- **D10** Append-only `price_events` collection `{sku, variant, vendor, brand, price, currency, sourceFile, effectiveDate, method}`; enables per-SKU history and cross-brand/supplier comparison. Prices are never overwritten.
- **D11** No silent dismissal: any `vendor_document` / `other` classification surfaces a UI verification prompt (first-page snapshot + extracted summary) requiring human confirm/reclassify before filing. Vendor forms are parsed into structured vendor profiles (company, RC, contacts, warranty, MOQ, delivery, certifications SON/MANCAP/ISO).

## 4. Repository scaffold

```
bk-ingest/
├── docs/                        # the four project documents + this prompt
├── fixtures/                    # the 10 sample files (read-only; never mutate)
├── apps/
│   ├── api/                     # Express + pipeline
│   │   ├── src/
│   │   │   ├── stages/          # stage0_triage … stage10_emit (one module each)
│   │   │   ├── models/          # mongoose: Vendor, IPR, BrandRegistry, TaxonomyNode,
│   │   │   │                    #   IdCrosswalk, UploadLedger, PriceEvent, ReviewItem, TodoItem
│   │   │   ├── services/        # anthropic.js, cloudinary.js, pdf.js, xlsx.js, confidence.js
│   │   │   ├── routes/          # /uploads /triage /review /todo /products /prices /emit /reports
│   │   │   └── eval/            # evaluation harness: ground truth loader, T1–T8 scorers
│   │   └── test/
│   └── web/                     # React (Vite) showcase UI
│       └── src/
│           ├── pages/           # Upload, TriageVerify (D11), ReviewQueue, Todo,
│           │                    #   Products, PriceCompare, RunReport
│           └── components/
├── packages/
│   ├── taxonomy/                # D1 tree as data + D9 ID register + seed script
│   └── emitter/                 # template-driven xlsx writer (exceljs), template reader
├── ground-truth/                # human-verified annotations (I will fill; you scaffold schema)
├── .env.example                 # ANTHROPIC_API_KEY, MONGODB_URI, CLOUDINARY_CLOUD_NAME,
│                                #   CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
└── README.md
```

npm workspaces monorepo. Plain JavaScript (ESM) with JSDoc types — no TypeScript for the PoC unless I say otherwise. ESLint + Prettier. Vitest for tests.

## 5. Core data structure — the IPR

Every extracted product is an Intermediate Product Record. Every field, without exception, is stored as:

```js
{ value, unit, raw, sourceRef: { file, page, region }, confidence: 0..1, method: "text"|"vision"|"derived"|"rule" }
```

Raw source strings are always retained beside normalized values. Derived values (variant SKUs, drawing-read dimensions) are `method: "derived"` and flagged in the UI. The IPR decouples messy inputs from the template contract — Stage 7 maps IPR → template columns per category via mapping profiles, and the emitter (D6) shapes output from the template file itself.

## 6. Non-negotiable integrity rules

1. Flag, never silently fix. The known anomalies (KB §8, A1–A10) are the test set: the QRG's "2700 V", the scrambled "8600 W", part number 0601513000 on three products — the pipeline must CATCH these (route to review), not correct or propagate them. This is acceptance test T4: zero silent leaks.
2. Preserve manufacturer terminology verbatim in stored raw values and descriptions.
3. Never guess taxonomy IDs, brand identities, or missing specs. Unknown → flagged, low-confidence → review queue.
4. Generated descriptions: facts-only from the IPR; run the fact-check pass; log every regeneration.
5. Confidence gate dispositions: PASS (auto-emit) / REVIEW / TODO — thresholds configurable in one place (`services/confidence.js`), defaults: required-field pass ≥ 0.85, review below.
6. `fixtures/` is read-only. All pipeline artifacts go to `runs/<timestamp>/`.

## 7. Acceptance tests (ratified) — build the harness alongside the pipeline

Implement `apps/api/src/eval/` scorers as you build, not after:

- **T1** triage: 10/10 files correctly routed. **T8**: every non-product file surfaces the D11 prompt (SG_BK.docx is the named case).
- **T2** field accuracy vs `ground-truth/`: ≥95% clean sources (Alca, Jaquar, Artize, Twyford round-trip), ≥85% hostile (Bosch QRG; HD sampled).
- **T3** zero-touch ≥70% overall, reported per catalog. **T7** wall-clock per catalog recorded by the pipeline (104-pp handbook target < 1 hr).
- **T4** seeded-anomaly recall = 100% (A1–A3 plus 5 synthetic injected errors per hostile catalog — build the injector).
- **T5** pricing: blank + todo on first run; simulated re-upload with prices appends price events only. **T6** variant expansion: Jaquar/Artize → base + 9 finishes each, derived SKUs labelled. The Twyford golden file is the emitter regression test: read golden → IPRs → emit → structural + content diff must be lossless.

## 8. Build order (follow strictly; stop for my review at each gate)

> Amended 2026-07-18 after council review: vision probe added to Milestone A; emitter round-trip and anomaly injector pulled forward into Milestone B. Rationale: validate the highest-variance component (vision cost/latency) and the catastrophic-failure anchor (template round-trip) before the architecture hardens around them.

**Milestone A — Skeleton (Gate G1):** monorepo scaffold; Mongo models; taxonomy package seeded with D1 tree + D9 ID register; upload endpoint + Stage 0 triage (structural signals + Claude classification with confidence); D11 TriageVerify UI page; run T1+T8 against all 10 fixtures. **Plus (council edit #1): a half-day throwaway vision probe** — rasterize 5–10 pages of `HD_BOOKET.pdf`, run one Claude vision extraction pass, record accuracy/latency/cost per page, and extrapolate to the full 104 pp against T7's 1-hour target and the API budget. Not a gate — just numbers, reported at G1. STOP — demo to me.

**Milestone B — Clean extraction + output contract (Gate G2):** Stages 1–3 for xlsx/docx/native-PDF; IPR store; extraction of the three datasheets; SG_BK.docx → vendor profile parse; Twyford template-signature short-circuit; ground-truth schema + scorer; interim T2 on clean sources. **Plus (council edit #2): the emitter's template-reader + Twyford lossless round-trip** (moved up from Milestone E) — pure deterministic exceljs work, becomes the standing regression from here on. **Plus (council edit #3): the anomaly injector** (moved up from Milestone D) — so seeded-error recall exercises extraction and classification as they are built. STOP — accuracy review with me.

**Milestone C — Classification & registries:** Stage 4 (three-method classifier), Stage 5 (brand registry with the seeded aliases/lineages), D9 crosswalk, Stage 6 variant expansion. T6 green. STOP.

**Milestone D — Hostile sources (Gate G3):** vision path for the QRG (page rasterize → panel-segmented Claude vision extraction) triggered by the label-value pairing QA; HD handbook chunked bulk extraction with part-number dedupe; T4 green (injector already exists from Milestone B). STOP.

**Milestone E — Content, emission, pricing (Gate G4):** Stage 8 generation + fact-check; Stage 7 mapping + Cloudinary; full template-driven emission with 500-row sharding (emitter core already regression-tested since Milestone B); Upload Ledger; D4/D10 price flow + PriceCompare UI; ReviewQueue + Todo + RunReport pages; full T1–T8 scorecard. Final demo.

## 9. Working conventions

- Plan before code: at each milestone, present a short plan and the files you'll touch; wait for my OK.
- Small commits, conventional messages (`feat(stage0): …`), every stage gets Vitest coverage with fixture-based tests.
- Anthropic calls: structured JSON outputs, retries with backoff, per-call cost + latency logged to the run record (feeds T7).
- Secrets only via `.env` (gitignored); `.env.example` documents every variable. Never commit fixture-derived data containing my API keys.
- When a design question isn't answered by `docs/`, ASK me — do not invent policy. Log answered questions as new decisions in `docs/DECISIONS.md` (continue numbering from D12). **Two questions are pre-logged for the first gate: (D12 candidate) classifier-disagreement precedence — what wins when the three taxonomy methods conflict; (D13 candidate) cross-file SKU reconciliation — is the same part number appearing in two uploaded documents a confirmation signal or two candidate rows?**
- ReviewItem should record the reviewer's resolution (`resolution`, `correctedValue`, `failedMethod`) so every human correction becomes calibration data.
- UI: clean, functional, demo-ready; BuildersKonnect navy/gold accent; no design-system bikeshedding at PoC stage.

## 10. Definition of done

The evaluation checklist in `BK_PoC_Acceptance_Tests_and_Evaluation_Strategy.pdf` §5 (blocks A–F) fully checked; `npm run eval` reproduces the T1–T8 scorecard from a clean clone with only `.env` provided; README documents setup, pipeline, and how to run the demo end-to-end.

Begin with Milestone A. First output I expect: your plan for the scaffold + Stage 0, and any questions about the docs after reading them.
