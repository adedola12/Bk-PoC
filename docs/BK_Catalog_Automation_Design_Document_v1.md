# BuildersKonnect — AI Catalog Onboarding PoC
## Design Document v1.0
**Prepared by:** ADLM Studio (Adedolapo Quasim)
**Date:** 17 July 2026
**Companion document:** Knowledge Base v1.1 (file inventory, template schema, decisions D1–D7, anomaly log)

---

## 1. Objective

Design and demonstrate a pipeline that takes arbitrary vendor uploads (catalogues, datasheets, images, forms — in PDF, Excel, Word or image formats), determines what each file is, extracts and normalizes product data, classifies it against a master taxonomy, generates marketplace-ready content, and emits BuildersKonnect's bulk upload template — with every field confidence-scored so that only trustworthy data reaches the master catalog automatically and everything else lands in a human review queue.

**BK success criteria (verbatim):** "Build a system where we upload files, check if it's a catalogue or product details, and files it into inventory." Section 9 formalizes this into measurable acceptance tests.

**Design constraints inherited from decisions (KB §5):** template-format-driven output (D6); default trade-based master taxonomy with auto-classification (D1); dynamic brand registry (D2); generated descriptions/tags in golden-example house style (D3); pricing blank→todo→delta-update (D4); one row per purchasable variant (D5); document triage as a first-class stage (D7).

---

## 2. Architecture Overview

```
                        ┌─────────────────────────────────────────────┐
 Vendor upload ───────▶ │ STAGE 0  Intake & Document Triage (D7)      │
 (any file/bundle)      │ file-type detect → content classify →       │
                        │ route: catalogue | datasheet | image |      │
                        │        vendor doc | other                   │
                        └───────┬─────────────────────────┬───────────┘
                                │ product-bearing         │ non-product
                                ▼                         ▼
                        ┌───────────────────┐     Vendor context store
                        │ STAGE 1 Ingestion │     (forms, certs → linked
                        │ format-specific   │      to vendor profile)
                        │ readers + vision  │
                        │ fallback          │
                        └───────┬───────────┘
                                ▼
                        ┌───────────────────────────────────────────┐
                        │ STAGE 2 Extraction → Intermediate Product │
                        │ Record (IPR) — one normalized JSON per    │
                        │ product, every field carries              │
                        │ {value, unit, source_ref, confidence}     │
                        └───────┬───────────────────────────────────┘
                                ▼
        ┌────────────────┬──────┴────────┬──────────────────┬─────────────────┐
        ▼                ▼               ▼                  ▼                 ▼
  STAGE 3          STAGE 4         STAGE 5            STAGE 6           STAGE 7
  Normalization    Taxonomy        Brand              Variant           Attribute
  units, locale,   classification  resolution         expansion         mapping to
  value sanity     (D1)            (D2 registry)      (D5)              template schema
        └────────────────┴──────┬────────┴──────────────────┴─────────────────┘
                                ▼
                        ┌───────────────────────────────┐
                        │ STAGE 8 Content generation    │
                        │ (D3) description + tags,      │
                        │ house style, facts-only       │
                        └───────┬───────────────────────┘
                                ▼
                        ┌───────────────────────────────────────────┐
                        │ STAGE 9 Validation & Confidence Gate      │
                        │ template rules + dropdown/DV checks +     │
                        │ anomaly rules → route per row/field:      │
                        │  PASS → emit   REVIEW → queue   TODO (D4) │
                        └───────┬───────────────────┬───────────────┘
                                ▼                   ▼
                        STAGE 10 Emission      Review Queue + Todo
                        BK template xlsx       (pricing gaps, low-
                        (per category, D6)     confidence fields,
                                               anomalies A1–A10 class)
                                ▼
                        Inventory filing + Upload Ledger
                        (identity index for D4 delta re-uploads)
```

---

## 3. Stage Designs & Justifications

### Stage 0 — Intake & Document Triage (D7)
**What:** Every uploaded file is classified before any extraction: `catalogue` (multi-product), `product_datasheet` (single product), `product_image`, `vendor_document` (registration forms, certifications, price letters), `other/unsupported`.
**How:** Two-step. (a) Cheap structural signals: extension, page count, text density, table density, image-only ratio, filename tokens. (b) LLM classification on a sampled excerpt (first pages + a middle page) with a fixed label set and a confidence threshold; below threshold → human triage queue, never guessed.
**Why:** BK's success criterion makes triage the front door. It also protects data integrity — the Satkay registration form in the sample set must be filed as vendor context, not mined for "products". Images are routed to the media-pairing sub-pipeline (Stage 7) rather than the extractor.
**Bundles:** ZIP uploads are unpacked, each member triaged individually, and sibling relationships kept (e.g., datasheet + matching image arrive together and should pair).

### Stage 1 — Ingestion
**What:** Format-specific readers produce a faithful raw representation.
- **XLSX/CSV:** structured read (openpyxl/pandas); header detection; if the sheet already matches a BK template signature, short-circuit to validation (the Twyford case).
- **PDF, native text:** layout-aware text extraction first; page rasterization for drawings/dimension callouts.
- **PDF, complex layout or scanned:** page → image → vision-model extraction. Trigger rule: extraction QA fails (label-value pairing test, below) or `pdffonts` shows no text layer (OCR case).
- **DOCX:** text + embedded media extraction.
- **Images:** passed to vision for product identification + pairing metadata.
**Label-value pairing QA (why vision fallback is not optional):** on the Bosch Quick Reference Guide, linear text extraction demonstrably scrambles associations — "2700 V" against a grinder's input power, an 1,100 W-class rotary hammer reading "8600 W", one part number (0601513000) attached to three different products (KB Anomaly Log A1–A3). A cheap self-check — re-locate each extracted value in the rendered page region of its label — decides per page whether text extraction is trustworthy or vision extraction is required. This keeps cost low on clean documents (Alca, Jaquar) and accuracy high on hostile ones (QRG).

### Stage 2 — Extraction to Intermediate Product Record (IPR)
**What:** LLM extraction emits one IPR (JSON) per product: identity (brand, sub-brand, product code, name, collection), attributes (typed key-values with units), logistics (weight, dims, pack qty), compliance (norms, certifications, warranty), media references, and provenance.
**Every field carries** `{value, unit, source_ref (file, page, region), confidence, extraction_method}`.
**Why an intermediate structure:** decouples messy inputs from the template contract. New catalog formats only require ingestion work; new categories only require mapping work. This is the same architecture pattern proven in ADLM's RateGen engine for rate-data extraction.
**Segmentation for large catalogues:** the 104-page Bosch handbook is chunked by detected product blocks (SKU-pattern anchors + heading structure), extracted in parallel batches, then de-duplicated on product code.

### Stage 3 — Normalization
Locale-aware numeric parsing (decimal commas: "13,45 kg" → 13.45 kg), unit canonicalization to template units (mm, kg), range preservation as ranges (water pressure "0,05–1,0 MPa" is not a single value), pack-quantity parsing ("1 | 20 pcs" → unit qty 1, carton 20), and **value-sanity rules** per attribute class (a corded power tool's rated input power outside 100–4000 W drops confidence and flags — catches A1/A2-type errors). Normalization never overwrites source values; the raw string is retained alongside the canonical value.

### Stage 4 — Taxonomy Classification (D1)
**What:** Classify each IPR into the master trade-based taxonomy (KB §6): trade → category → product type.
**How (hybrid, in order):**
1. **Deterministic rules** where the source declares its own section (the Bosch catalogs' section headers: Grinding, Cordless, Measuring/Leveling…) — highest precision, near-zero cost.
2. **Lexical/fuzzy match** of product name and description tokens against taxonomy node vocabularies (handles "wash basin", "towel rail", "concealed cistern").
3. **Semantic embeddings** similarity between the IPR text and taxonomy node descriptions — resolves the long tail ("Pre-wall installation system for dry build up" → Concealed Cisterns & Installation Systems, no keyword overlap needed).
Agreement between methods raises confidence; disagreement routes to review. BK `cat_*` IDs are then resolved from the taxonomy-to-BK mapping table; **unmapped nodes are flagged for BK ID assignment, never guessed** (protects against the A7 Countertop/Pedestal ID trap).

### Stage 5 — Brand Resolution (D2)
Canonical brand registry with: canonical name, aliases/misspellings ("Jaguar"→Jaquar), sub-brand lineage (Artize ⊂ Jaquar; Twyford ⊂ Geberit Group), product-code signatures (e.g., `AKP-…` Jaquar accessories, `QUA-…` Artize, `06011…` Bosch part numbers, `TWY…/TW…` Twyford), and evidence links to source documents. Unknown brands are **auto-registered as candidates** from strict parametric evidence (logo/domain on datasheet + code pattern + declared manufacturer) and surfaced for one-click confirmation — they do not block the pipeline and they never silently merge with an existing brand.

### Stage 6 — Variant Expansion (D5)
Where a source declares purchasable options (Jaquar/Artize: base Chrome + 9 finishes), the IPR expands to one row per variant. Variant SKUs are derived by substituting the manufacturer's own finish codes into the product code (AKP-CHR-35751P → AKP-BLM-35751P …), **marked `derived_unverified`** until confirmed against manufacturer data — preserving manufacturer terminology without fabricating certainty. Identical-spec collisions use the golden example's honest suffix convention ("Var. A — …"). Options that are not purchasable distinctions (e.g., adjustable installation depth) remain attributes, not variants.

### Stage 7 — Attribute Mapping & Media Pairing (D6)
The emitter loads the BK template for the resolved category and reads its **own** headers, required-field markers, dropdown validations and Instructions — the template is the contract (D6). IPR fields map to columns via a per-category mapping profile; dropdown fields map through controlled-vocabulary matching (exact → synonym → flagged custom). Media pairing links images to products by filename tokens, product-code OCR, and visual similarity to datasheet drawings; unpaired media goes to review.
**Pricing (D4):** absent price → column blank + todo item `{vendor, sku, "price missing", source}`; the Upload Ledger's identity index (brand + product code + variant code) makes re-uploads update price only.

### Stage 8 — Content Generation (D3)
Descriptions and tags generated in the golden-example house style (KB §4): ~100–130 words, varied technical opening, benefit framing, exact specs restated, standards/warranty close; 8–9 lowercase tag phrases. **Hard rule: generated copy may only assert facts present in the IPR** — specs, standards, certifications and warranty claims must trace to extracted fields (the WRAS cert number and EN norms on the Alca sheet may appear; nothing invented may). A post-generation fact-check pass verifies every number and claim in the copy against the IPR; failures regenerate or route to review.

### Stage 9 — Validation & Confidence Gate
Deterministic validators re-check everything the template itself would enforce (required fields, dropdown membership, unit fields, 500-row cap, comma conventions) plus anomaly rules from the KB log (duplicate product codes, unit implausibility, identical-spec rows). Row disposition:
- **PASS** — all required fields ≥ high-confidence threshold and zero rule violations → auto-emit.
- **REVIEW** — any required field below threshold, any anomaly rule fired, unmapped taxonomy node, or unconfirmed new brand → review queue with side-by-side source region display.
- **TODO** — structurally complete but missing price (D4) → emitted with blank price + todo entry.
Nothing wrong enters the master catalog silently; nothing merely uncertain is discarded.

### Stage 10 — Emission, Filing & Ledger
Output per category: BK template xlsx populated per D6, plus a run report (metrics of §9), the review-queue export, and the todo list. The **Upload Ledger** records every emitted row's identity key, source provenance and field hashes — the backbone for D4 delta updates and for duplicate-detection across future uploads.

---

## 4. Technology Choices (PoC)

| Concern | Choice | Justification |
|---|---|---|
| Orchestration | Python 3.11 pipeline, stage-per-module | Testable stages, parallelizable, matches ADLM stack |
| Structured files | openpyxl / pandas | Direct template read/write incl. validations |
| PDF text & raster | pdftotext-layout + pdf2image/poppler | Proven on sample set; cheap first pass |
| Vision & extraction LLM | Claude (vision + structured JSON output) | Handles QRG-class layouts; single model for triage, extraction, generation reduces integration surface |
| Embeddings (Stage 4) | Sentence embedding model, cosine similarity | Long-tail classification without per-category training data |
| Storage | SQLite (PoC) for registry, ledger, queues | Zero-ops for PoC; schema ports to BK's DB at productionization |
| Review UI (PoC) | Generated HTML review sheet / spreadsheet | Demonstrates the queue without building an app; production UI is a later phase |

---

## 5. Scalability Considerations

1. **Cost tiering:** deterministic → lexical → embedding → LLM, in that order; vision only where the pairing QA demands it. On the sample set, only the QRG (2 pp) and drawing regions need vision; the 104-pp handbook runs mostly on text extraction with LLM structuring.
2. **Parallelism:** catalogues chunk to product blocks processed in parallel; throughput scales linearly with workers.
3. **Template-driven emitter (D6):** onboarding a new category = dropping in BK's generated template + a mapping profile; no code changes.
4. **Registries compound:** every confirmed brand, alias, taxonomy mapping and variant confirmation reduces future review volume — the zero-touch rate improves with use.
5. **500-row cap:** emitter shards output files automatically per the template's limit.
6. **Production path:** SQLite → BK database; xlsx emission → direct import API if/when repository access is granted (explicitly out of PoC scope per client brief).

---

## 6. Data Integrity Principles

Flag, never silently fix (anomalies A1–A10 route to review with evidence); preserve manufacturer terminology and raw source values alongside canonical forms; provenance on every field; derived values (variant SKUs, inferred dimensions from drawings) always labelled derived/unverified; generated content asserts extracted facts only.

---

## 7. PoC Demonstration Plan (on the five catalogs)

| Input | Expected demonstration |
|---|---|
| Satkay form (SG_BK.docx) | Triage → `vendor_document`, filed to vendor profile, zero products extracted |
| Alca AM101 datasheet | Single product, full IPR incl. EU-format normalization, WRAS/EN compliance capture, classified to Concealed Cisterns; template emitted; price → todo |
| Jaquar + Artize datasheets + 2 images | Two products → ~20 variant rows (D5), brand lineage resolved (Artize⊂Jaquar), images paired, drawing-derived dimensions flagged as derived |
| Bosch HD Handbook (104 pp) | Bulk segmentation & extraction at scale; dedupe on part numbers; classified across Tools & Equipment sub-trades |
| Bosch Quick Reference Guide | Vision-mode extraction; anomalies A1–A3 caught by sanity rules and routed to review — the "nothing wrong enters silently" proof |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| QRG-class layouts yield low zero-touch rates | Expected and acceptable: metric is reported per catalog; review queue is the designed outcome for hostile sources |
| Variant SKU derivation wrong for some brands | `derived_unverified` labelling + review sampling; never presented as manufacturer-confirmed |
| Taxonomy↔BK ID map incomplete (Q2 open) | Pipeline runs fully; ID column flagged pending BK registry — no guessing |
| Description generation drifts from facts | Post-generation fact-check pass; regeneration loop |
| Success criteria interpretation gap | §9 acceptance tests submitted for BK sign-off before evaluation |

---

## 9. Evaluation Plan — Proposed Acceptance Tests (for BK sign-off)

Formalizing BK's criterion ("upload files → check if catalogue or product details → file into inventory") into measurable tests. Thresholds are ADLM proposals, adjustable by BK:

| # | Test | Metric | Proposed threshold |
|---|------|--------|--------------------|
| T1 | Document triage | Correct routing on the 10-file sample set | 10/10 |
| T2 | Field-level accuracy | Required template fields correct vs. human-verified ground truth, per catalog | ≥ 95% on clean sources (Alca, Jaquar, Artize, Twyford-check); ≥ 85% on hostile sources (Bosch QRG) |
| T3 | Zero-touch rate | % of product rows emitted with no human intervention | ≥ 70% overall; reported per catalog |
| T4 | Safety | Wrong values entering emitted output undetected (not flagged) | 0 known-anomaly leaks: A1–A3 class errors must be caught |
| T5 | Pricing policy (D4) | Missing prices → todo entries; simulated re-upload with prices → price-only delta update | 100% of price-bearing rows |
| T6 | Variant policy (D5) | Finish options expand to per-variant rows with derived-SKU labelling | 100% of declared options |
| T7 | Throughput | Processing time per catalog, end-to-end | Reported (datasheets: minutes; 104-pp handbook: target < 1 hr on PoC hardware) |

Ground truth is built once by human annotation of the five catalogs; the same set becomes the regression suite for productionization.

---

## 10. Delivery Sequence

1. **Week 1:** Stages 0–4 on the three datasheets + Twyford check; ground-truth annotation; interim accuracy report.
2. **Week 2:** Stages 5–10; Bosch handbook + QRG runs; full metrics report against §9; working demonstration.
Timeline per ADLM's commitment: working demonstration on the five representative catalogs within two weeks of receiving materials (received 17-Jul-2026 → target 31-Jul-2026).

*End of Design Document v1.0*
