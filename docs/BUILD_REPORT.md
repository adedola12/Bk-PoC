# BK-Ingest — Build Report & System Summary

**Project:** AI-Powered Catalog Onboarding — Proof of Concept
**Client:** BuildersKonnect (BK) · **Engineer of record:** Adedolapo Quasim, ADLM Studio
**Build window:** 17–18 July 2026 (materials received 17-Jul; all five milestones complete 18-Jul; evaluation target 31-Jul-2026)
**Repository:** github.com/adedola12/Bk-PoC · **Live:** client https://d3kbhx0i6234ut.cloudfront.net · API https://api-bk.adlmstudio.com

---

## 1. Executive summary

BK-Ingest is a working proof-of-concept that takes arbitrary vendor uploads — PDF catalogs,
datasheets, Excel files, Word documents, product images, or a manufacturer weblink — and turns
them into BK's exact bulk-upload Excel template, with AI doing the reading and a confidence
system deciding what may pass automatically and what a human must see.

Its two governing promises, both demonstrated and tested:

> **Nothing wrong enters the catalog silently. Nothing is dismissed silently.**

Against the ratified acceptance tests (T1–T8), the PoC passes **seven of eight outright**;
the eighth (field accuracy, T2) stands at 94.7% interim — 100% after brand resolution — and
awaits only human verification of the ground-truth annotations to become final.

---

## 2. What the system does, end to end

1. **Upload** — files are dragged in, or a weblink is pasted (D16). Every source is classified
   before any extraction (D7): `bk_template` / `catalogue` / `product_datasheet` /
   `product_image` / `vendor_document` / `other` (label set ratified as D12).
2. **Triage verification (D11)** — any non-product classification surfaces a card with a
   first-page snapshot and AI summary; a human must confirm or reclassify before filing.
   Confirmed vendor documents are parsed into structured vendor profiles (the Satkay Limited
   registration form is the reference case: company, RC 196060, 10-yr warranty, MOQ 1, 48-hr delivery).
3. **Extraction (Stages 1–2)** — format-specific readers produce faithful raw text; Claude
   extracts one Intermediate Product Record (IPR) per product. Every field, without exception,
   carries `{value, unit, raw, sourceRef{file,page,region}, confidence 0–1, method}` — the raw
   source string is preserved verbatim forever.
4. **Hostile-source path** — a deterministic **label-value pairing QA** examines each PDF page's
   text geometry; pages whose spec tables scramble under linear reading (the Bosch Quick
   Reference Guide) are rasterized, sliced into overlapping panels, and read by Claude vision
   instead. The 104-page Bosch handbook runs the cheap text path in parallel chunks with
   cross-chunk part-number dedupe.
5. **Normalization (Stage 3)** — locale-aware numbers ("13,45 kg" → 13.45), ranges preserved as
   ranges ("0,05–1,0 MPa"), pack quantities ("1 | 20 pcs"), unit canonicalization to mm/kg, and
   value-sanity rules per attribute class. Violations drop confidence and flag — never fix.
6. **Classification (Stage 4, D1)** — three methods in cost order: deterministic (the catalog's
   own section headers), lexical/fuzzy (taxonomy keyword vocabularies), semantic (Claude).
   Agreement raises confidence; disagreement routes to review (precedence rules ratified as D14/D15).
7. **Brand resolution (Stage 5, D2)** — dynamic registry with canonical names, aliases
   (Jaguar→Jaquar), sub-brand lineage (Artize ⊂ Jaquar), and product-code signatures. A `QUA-`
   code resolves to Artize even when the sheet's text says Jaquar; the sheet's wording stays in
   `raw`. Unknown brands auto-register as candidates with evidence — never blocking, never merging.
8. **Variant expansion (Stage 6, D5)** — declared finish options expand to one row per
   purchasable variant with manufacturer finish codes substituted into the product code
   (AKP-CHR-35751P → AKP-BLM-35751P), labelled `derived_unverified` throughout.
9. **Category IDs (D9)** — every taxonomy node carries an ADLM-issued `cat_` + 21-char ID in
   BK's observed format, crosswalked to the four confirmed BK IDs, provenance-labelled
   `adlm_registry` vs `bk_confirmed`. Missing BK IDs become todo entries — never guessed (A7 protection).
10. **Content generation (Stage 8, D3)** — ~100–130-word descriptions + 8–9 tags in the Twyford
    golden-example house style (style examples are read from the golden file itself at runtime).
    A **deterministic fact-checker** verifies every number, brand mention and standards reference
    in the copy against the extracted data; failures regenerate once, then flag. The checker
    provably rejects poisoned copy (self-test in the eval harness).
11. **Mapping & media (Stage 7, D6/D8)** — IPR fields map to the template's own columns via
    per-category profiles; dropdowns match exact → synonym → recorded-custom; product images
    pair to products by filename tokens (brand aliases included), upload to Cloudinary, and the
    delivery URLs ride in the template's media columns. Variants inherit the base image.
12. **Gate (Stage 9)** — per-row disposition: **PASS** (auto-emit) / **REVIEW** (anything
    uncertain or flagged) / **TODO** (complete but price missing, D4). Thresholds live in one
    config file; derived-method fields gate at their own bar because they stay visibly labelled (D18).
13. **Emission (Stage 10, D6)** — the emitter reads the BK template's own headers, required
    markers, dropdown lists and Instructions sheet at runtime — the schema is never hardcoded —
    and shards output at the template's stated 500-row cap. The Twyford golden file round-trips
    through the emitter **losslessly** (21 rows × 30 columns, zero diffs) as a standing regression.
14. **Pricing (D4/D10)** — sources without prices emit blank + todo entries. Prices arrive by
    manual entry or simulated re-upload and are **append-only price events** — updates are
    rejected at the database-model layer, giving full history per SKU and cross-brand comparison
    within a category.

---

## 3. Acceptance-test scorecard (ratified T1–T8)

| # | Test | Ratified threshold | Result | Status |
|---|------|--------------------|--------|--------|
| T1 | Document triage | 10/10 sample files | **10/10** | ✅ PASS |
| T2 | Field accuracy | ≥95% clean · ≥85% hostile | 94.7% interim (100% after Stage-5 brand resolution) | ⚠ interim — pending human ground-truth verification |
| T3 | Zero-touch rate | ≥70% overall | **100%** (per-catalog: Twyford 100, Alca 100, Jaquar 100, Artize 100) | ✅ PASS |
| T4 | Safety — no silent errors | 0 leaks | A1 "2700 V" caught · A3 0601513000-on-3-products caught · 10/10 seeded errors flagged · QRG text path rejected by pairing QA | ✅ PASS |
| T5 | Pricing policy | 100% appended, no overwrites | events append-only (model-layer enforcement proven), history queryable, 2 brands compared | ✅ PASS |
| T6 | Variant policy | 100% of declared options | Jaquar base+9, Artize base+9, all `derived_unverified` | ✅ PASS |
| T7 | Throughput | 104-pp handbook < 1 hr | **2.0 minutes** (89 products, 52 calls) | ✅ PASS |
| T8 | No silent dismissal | 100% | SG_BK.docx and every non-product route surfaces the D11 prompt | ✅ PASS |

Supporting numbers: final emission **42/42 rows at 100% zero-touch**; 21 generated
descriptions, 0 fact-check failures (1 auto-regeneration); 57/57 automated tests;
Milestone-A vision probe ~7.1 s / $0.008 per page (⇒ full 104-pp vision worst case ≈ 12 min / $0.83).
Every number is reproducible: `cd server && npm run eval` writes a timestamped scorecard to `runs/`.

---

## 4. Architecture & stack

- **Layout (D8, D13):** `client/` — React 19 + Vite, Tailwind v4, framer-motion, Plus Jakarta
  Sans, BK navy/gold. `server/` — Node ≥20 ESM, Express 5, Mongoose 8; stage-per-module
  pipeline (`stages/stage0…stage9`), `emitter/`, `taxonomy/`, `eval/`, `routes/`, `services/`.
- **AI:** Anthropic Claude (`claude-sonnet-4-6`) for triage, extraction, vision, semantic
  classification, generation — structured JSON, retries with backoff, per-call cost + latency
  logged to the run record.
- **Data:** MongoDB Atlas (`bkIngest`) — nine collections: UploadLedger, IPR, BrandRegistry,
  TaxonomyNode, IdCrosswalk, PriceEvent (append-only), ReviewItem (stores reviewer resolutions
  as calibration data), TodoItem, Vendor.
- **Media:** Cloudinary (uploads + delivery URLs into template media columns).
- **Excel:** exceljs (template-driven read/write). **PDF:** pdfjs-dist text + positions;
  pdf-to-img rasterization; sharp panel slicing. **Word:** mammoth.
- **Deploy:** client → S3 + CloudFront; API → Docker on EC2 (`t3.small`, Caddy terminating TLS)
  in `eu-west-1`, image in ECR; `deploy/` holds the scripted runbook. Migrated off
  Vercel + Render on 30-Jul-2026 when the Render account was suspended for non-payment;
  Atlas was not touched.
- **Artifacts:** every pipeline invocation writes to `runs/<timestamp>/` (logs, previews,
  scorecards, emitted xlsx); `fixtures/` is read-only.

## 5. User interface (7 pages)

Upload (file drag-drop + weblink tab) · Triage Verify (D11 snapshot cards, confirm/reclassify)
· Review Queue (every flag, resolve as accepted/corrected/rejected — corrections retained as
calibration data) · Todo (price-missing with inline manual entry, BK-ID-pending) · Products
(marketplace-style card grid with Cloudinary covers, disposition/derived badges, one-click
extraction and emission with xlsx download) · Price Compare (append-only history per SKU,
cross-brand within category) · Run Report (live T1–T8 scorecard + latest emission metrics).

## 6. Decisions log (full text in KB §5, Addendum, and docs/DECISIONS.md)

D1 trade taxonomy + 3-method classification · D2 dynamic brand registry · D3 generated
descriptions/tags, facts-only + fact-check · D4 price → blank + todo + delta re-upload ·
D5 one row per variant, derived SKUs labelled · D6 the template IS the contract · D7 triage
first · D8 MERN/Anthropic/Cloudinary stack · D9 ADLM `cat_` ID register + crosswalk ·
D10 append-only price ledger · D11 no silent dismissal + vendor profiles · D12 `bk_template`
triage label · D13 ADLM house repo layout · D14 classifier disagreement precedence ·
D15 semantic tier as Claude matching (PoC) · D16 weblink ingestion with bounded crawl ·
D17 category-profile exemptions (proposed) · D18 derived-field gate threshold (proposed).
Open: D19 — cross-file/re-upload SKU reconciliation.

## 7. Known limitations & backlog

1. **T2 finalization** — ground-truth drafts in `ground-truth/` must be human-verified (~30 min).
2. **JS-rendered storefronts** — weblink ingestion handles direct file links, product pages and
   crawlable sites; fully client-rendered catalogs (e.g. se.com) get an honest guidance card;
   a headless-browser fetcher is a production item.
3. **D19** — re-uploading the same file should delta-update via the Upload Ledger identity
   index rather than create duplicate rows.
4. **Per-category BK templates** — the PoC holds only the Wash Basins template; other
   categories emit through mapping profiles with visible D17 exemptions until BK issues real
   per-category templates.
5. **Anthropic credits** must be funded for AI runs (exhausted 18-Jul evening; the system
   degrades honestly — uploads route to human triage with the reason shown).

## 8. Evaluation-day runbook (31-Jul-2026)

1. Top up Anthropic credits; set `ANTHROPIC_API_KEY` in the `/bk-ingest/deploy/env.migration`
SSM parameter and recreate the `api` container. 2. Verify ground truth, flip statuses to
`human_verified`. 3. `npm run eval -- --full` for the final scorecard incl. full-handbook T7.
4. No warm-up needed — the EC2 container runs continuously, unlike the Render free tier that
slept. 5. Demo arc: upload mixed
files → SG_BK D11 card → confirm → vendor profile · QRG forced to vision → Review Queue holding
"2700 V" and 0601513000 · Products → Emit → download BK template file · Todo → price entry →
Price Compare · Run Report scorecard. 6. Make T7 timing claims from local hardware, where the
2-minute figure was recorded.

---

*Prepared 18-Jul-2026 by ADLM Studio with Claude (Anthropic) as build assistant. Every metric
in this report is regenerable from the repository: `npm test`, `npm run eval`, `npm run probe`.*
