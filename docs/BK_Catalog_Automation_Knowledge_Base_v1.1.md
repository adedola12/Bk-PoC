# BuildersKonnect — AI Catalog Onboarding PoC
## Knowledge Base v1.1
**Prepared by:** ADLM Studio (Adedolapo Quasim)
**Date:** 17 July 2026
**Status:** Working baseline. v1.1 supersedes v1.0 (adds D5–D7, success criteria, closes Q1/Q3).

---

## 1. Project Context

**Client:** BuildersKonnect (BK) — soft-launched construction materials marketplace (vendor storefronts + contractor procurement), builderskonnect.com.

**Engagement:** Design and, where necessary, build a proof of concept demonstrating that AI can extract, classify, map and transform manufacturer/importer catalog data into BK's bulk upload template with minimal human intervention. Scope is fixed by the client brief: standalone PoC, no codebase integration, evaluated on thought process, engineering approach, scalability, accuracy, and real-world handling. Commercial productionization follows only if the PoC passes.

**Reference vendor scenario:** Satkay Limited (RC 196060, Ikeja, Lagos) — importer/distributor of sanitary ware, bath fittings and accessories under multiple international brands. Top 5 declared products: Alca drain AM101, Jaquar Towel Rail Holder, Jaquar Toilet Roll Holder, Siamp Generation Premium Toilet Seat Cover, Ideal Standard Slimline Basin Mixer. MOQ 1, nationwide supply, 48hr delivery, 10-year warranty (manufacturing defect). This models BK's real-world case: one vendor, many brands, mixed-format source documents.

**Committed evaluation metrics:** field-level accuracy; % of products onboarded with zero human intervention; processing time per catalog.

**Success criteria (BK, 17-Jul-2026):** "Build a system where we upload files, check if it's a catalogue or product details, and files it into inventory." Formalized in the Design Document as: (1) document triage — any uploaded file is classified (catalogue / product datasheet / product image / vendor document / other) and routed correctly; (2) product extraction & transformation into the BK template baseline; (3) filing into inventory with confidence gating. Measurable acceptance tests are proposed in Design Document §9 pending BK sign-off, since the stated criterion is qualitative.

---

## 2. Input File Inventory

| # | File | Type | Role | Extraction difficulty |
|---|------|------|------|----------------------|
| 1 | `catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx` | XLSX, 3 sheets | **BK bulk upload template** (target format) | n/a — specification |
| 2 | `01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx` | XLSX, 21 products | **Golden example** — completed template defining the quality bar | n/a — reference |
| 3 | `Alca_Drain__AM101_.pdf` | PDF, 1 pp, native text | Raw catalog: Alcadrain AM101 concealed cistern/frame datasheet | Low-Medium |
| 4 | `Toilet_Roll_Holder_Data_sheet.pdf` | PDF, 1 pp, native text | Raw catalog: Jaquar AKP-CHR-35751P datasheet | Low-Medium |
| 5 | `Towel_Rail_Holder_Data_Sheet.pdf` | PDF, 1 pp, native text | Raw catalog: Artize QUA-CHR-61711 datasheet | Low-Medium |
| 6 | `HD_BOOKET.pdf` | PDF, 104 pp, native text (noisy) | Raw catalog: Bosch Heavy Duty Handbook — power tools, many SKUs | High |
| 7 | `Revised_Quick_Refrence_Guide.pdf` | PDF, 2 ultra-wide pp | Raw catalog: Bosch Quick Reference Guide — dense multi-panel layout | Very High |
| 8 | `Jaguar_Toilet_Roll_Holder_Image.jpg` | JPG 1000×1000 | Product image (pairs with #4) | n/a |
| 9 | `Jaquar_Towel_Rail_Holder_Image.jpg` | JPG 1000×1000 | Product image (pairs with #5) | n/a |
| 10 | `SG_BK.docx` | DOCX | Satkay vendor registration form (vendor context; embedded images are logos/signature only) | n/a |

**Received vs. brief (7 items):** template ✅ (one category); five catalogs ✅; taxonomy ⚠️ partial (one branch); category structure ⚠️ partial; per-category attributes ⚠️ (wash basins only); import requirements ⚠️ (template Instructions sheet only); success criteria ✅ received 17-Jul-2026 (see §1).

---

## 3. BK Bulk Upload Template — Schema Specification

Source: template file, sheets `Template`, `Lookup`, `Instructions`.

**Category binding (per template Instructions):**
Plumbing & Sanitary Ware > Sanitary Ware > Wash Basins & Pedestals > Countertop
- category_id: `cat_NMgutrpDUDaPfIxEbF7-h`
- subcategory_id: `cat_dW3w7W3KEg1nAX-W5wKD7`
- sub_subcategory_id: `cat_1wIX_oQ4kZiJ3zB-wpfoM`
- product_type_id: `cat_02b2Pq3Q9-Q74OTvotI52`

**30 columns in 7 sections:**

| Section | Columns |
|---|---|
| Product Information (blue) | Brand*, Collection*, Color*, Dimensions (1)*, Dimensions (2)*, Dimensions (3)*, Dimensions Unit* |
| Identity & Naming (indigo) | System Product Name (formula — do not edit), Unique Product Name, Product SKU (auto-gen if blank) |
| Attributes (purple) | Shape*, Overflow*, Drain Size*, Drain Size Unit*, Tap Holes*, Installation Type*, Pedestal Included, Material*, Country of Origin |
| Shipping (yellow) | Shipping Weight Type, Shipping Class, Parcel Length, Parcel Width, Parcel Height |
| Media (pink) | Cover Image, Other Images, Product Specification Doc, Additional Doc |
| Meta (grey) | Description, Tags |

**Dropdown validations (as built):**
- Brand: fixed 22-value list — Bosch, Caterpillar, Philips, Hindware, TATA, Sintex, Makita, JCB, L&T, Bajaj, Havells, RadeBen, Dangote, BUA, Revit, Virony, Goodwill, Benyl, Golden Diamond, Eagle Ace England, Glossy, Rockford
- Color: White, Ivory, Colored, Metallic, Custom
- Dimensions Unit / Drain Size Unit: mm
- Shape: Round, Oval, Square, Rectangular
- Overflow / Pedestal Included: Yes, No
- Tap Holes: 0 hole, 1 hole, 2 holes, 3 holes
- Installation Type: Wall-Mounted, Pedestal, Countertop, Under-Mount, Vessel
- Material: Ceramic/Vitreous China, Porcelain, Stone Resin, Glass, Stainless Steel
- Shipping Weight Type: Light, Standard, Heavy, Oversized
- Shipping Class: Fragile, Hazardous, Liquid, Special Handling

**Import rules (Instructions sheet):** one product per row; * = required, (opt) optional, (cond) conditional; "dropdown + custom" fields accept custom values; multi-select values comma-separated with no space after comma; System Product Name auto-fills — do not edit; locked/formula columns untouched; media via `media/` folder zipped with the xlsx, or direct URLs; variants = duplicate row and change variant-specific fields; tags comma-separated; Discounted Price ≤ Selling Price; SKU auto-generated if blank; max 500 products per file.

**Naming convention (Instructions):** `[Brand] [Collection] Countertop Basin [Color], [Dimensions]`.

---

## 4. Golden Example Conventions (Twyford file)

The completed Twyford file defines the de-facto quality bar and reveals conventions not documented in the Instructions:

1. **Unique Product Name pattern actually used:** `{Brand} {Collection} {Full|Semi}-Pedestal Basin – {Shape}, {L} x {W} x {H}mm, {n}H` (System Product Name left blank; the formula's "Countertop Basin" wording bypassed).
2. **Descriptions are generated marketing copy** (~100–130 words): varied technical opening (vitrification facts), benefit framing, exact specs restated, standards reference (BS EN 14688), brand heritage + warranty close. No two openings identical across 21 rows.
3. **Tags:** 8–9 comma-separated lowercase keyword phrases per product mixing brand, collection, dimension, attribute and category terms.
4. **Variant disambiguation:** identical-spec SKUs distinguished honestly with a suffix — e.g., `(Var. A — handing unconfirmed)` / `(Var. B — handing unconfirmed)` for TWYPK2570 vs TWYPK2580 — never with invented differences. **This convention is adopted as policy.**
5. **Shipping defaults for this category:** Standard / Fragile / parcel 650×500×350.
6. **Images:** one hosted URL per product (Dropbox direct links, `?raw=1`), filename = SKU.
7. Country of Origin: United Kingdom; Material: Ceramic/Vitreous China throughout.

---

## 5. Design Decisions Log

| ID | Date | Decision | Implication |
|----|------|----------|-------------|
| D1 | 17-Jul-2026 | **Default master taxonomy** for all construction materials, organized by **Trade / elemental format**. Products are **auto-classified** into it from name, features and attributes; BK category IDs are then resolved via a mapping layer. | Removes dependency on receiving per-category templates up front. Classification layer owns taxonomy; BK ID mapping maintained as a lookup that grows as BK issues category IDs. |
| D2 | 17-Jul-2026 | **Dynamic brand registry** — brands are auto-recognized/registered from strict parametric product details, not constrained to the current 22-value dropdown. | Extraction must capture brand + sub-brand lineage (e.g., Artize as Jaquar premium line). New brands enter a registry with evidence (source doc, product codes) rather than failing validation. |
| D3 | 17-Jul-2026 | **Description + tags generation is in scope** — products must be well represented once a brand provides catalogs. | Pipeline includes a content-generation stage trained on the golden-example house style (Section 4). Generated copy must only assert facts present in extracted data. |
| D4 | 17-Jul-2026 | **Pricing policy:** if no price exists in the uploaded catalog/files, leave blank and **auto-flag into a todo system**. If the same catalog is re-uploaded with pricing added, **only pricing is updated** (delta update). Manual price input also supported. | Price is a separately versioned field. Requires stable product identity (SKU/product-code matching) across uploads so re-uploads update rather than duplicate. Todo queue is a first-class pipeline output. |
| D5 | 17-Jul-2026 | **One row per purchasable variant.** Each finish/colour/size option becomes its own row with its own SKU, price slot and image slot. | Matches template variant rule (duplicate row) and D4 per-SKU delta pricing. Jaquar/Artize accessories expand ~10× (Chrome base + 9 finishes). Variant SKU derivation: manufacturer finish codes substituted into product code (e.g., AKP-CHR-35751P → AKP-BLM-35751P), flagged as derived-unverified until confirmed against manufacturer data. |
| D6 | 17-Jul-2026 | **The bulk upload template IS the design baseline.** Per-category templates generated in this same 3-sheet format (Template/Lookup/Instructions) are the output contract. | Emitter is template-format-driven: it reads any BK-generated template's headers, validations and Instructions to shape output. No separate output spec expected. |
| D7 | 17-Jul-2026 | **Document triage is a first-class pipeline stage** (from success criteria): every uploaded file is classified — catalogue / single-product datasheet / product image / vendor document / other — before any extraction, and routed accordingly. | Non-product files (e.g., SG_BK.docx registration form) must be recognized and filed as vendor context, never product-extracted. Sample set doubles as the triage test set. |

---

## 6. Master Taxonomy — Working Structure (per D1)

Trade-based top level (aligned to construction trade/elemental conventions familiar to Nigerian QS practice), decomposing to product types. Draft top-level trades:

1. Civil & Structural (cement, aggregates, reinforcement, blocks, formwork)
2. Masonry & Finishes (tiles, paints, screeds, cladding)
3. Carpentry & Joinery (doors, boards, timber, ironmongery)
4. Roofing
5. Plumbing & Sanitary Ware (sanitary ware; taps & mixers; bathroom accessories; concealed cisterns & installation systems; pipes & fittings; drainage)
6. Mechanical/HVAC
7. Electrical (cables, switchgear, lighting, accessories)
8. Tools & Equipment (power tools — drilling, grinding, measuring/leveling, woodworking, cordless; hand tools; safety/PPE)
9. Glazing & Aluminium
10. External Works & Landscaping

Sample-set placement: Twyford basins → 5; Alca AM101 → 5 (Concealed Cisterns & Installation Systems); Jaquar/Artize accessories → 5 (Bathroom Accessories); Bosch products → 8 (by tool family per the source catalogs' own section headers: Grinding; Grinding, Drilling & Demolition; Impact/Diamond Drilling; Cordless; Measuring/Leveling; Woodworking).

Classifier resolves: trade → category → product type, then maps to BK `*_id` values where issued; unmapped nodes are flagged for BK ID assignment, not guessed.

---

## 7. Catalog Profiles & Extraction Strategy Signals

**Alca AM101 (Low-Med):** ~40 spec lines for one product; needs attribute selection, EU number normalization (decimal commas: "13,45 kg"; "0,05-1,0 MPa"), pack-quantity parsing ("1 | 20 pcs"), EAN, warranty "2/15 years", norms EN 14124/EN 14055, WRAS cert no. 2206330. Dimensions 1130×145×520 mm.

**Jaquar AKP-CHR-35751P (Low-Med):** clean key-value table. Finish code CHR embedded in product code = Chrome (base finish) while the "Available Colour Finishing" list names 9 other finishes (ABR, ACR, BCH, BLM, GDS, GLD, GRF, SSF, WHM) — variant handling per D5. Dimensions only in technical drawing callouts.

**Artize QUA-CHR-61711 (Low-Med):** as above; **brand = Artize** (Jaquar premium line) though vendor's form says "Jaquar" — brand lineage rule required (D2). Description "Towel Rail 600mm Long"; drawing gives 600 / 550 / 74 mm.

**Bosch HD Handbook, 104 pp (High):** native text but with duplicated/interleaved text runs; product blocks with SKU part numbers, spec lists, accessory tables; requires page segmentation and product-block detection at scale.

**Bosch Quick Reference Guide, 2 pp (Very High):** 2381-pt-wide multi-panel pages; linear text extraction scrambles label-value pairing (verified — see Anomaly Log). Demands vision-based, panel-segmented extraction. Definitive justification for field-level confidence scoring + human review queue.

**Image pairing:** supplied JPGs matched to products by filename tokens + visual verification against datasheet line drawings (both verified matches for #4 and #5).

---

## 8. Anomaly Log (verified in source; flag, never silently fix)

| ID | Source | Anomaly | Handling |
|----|--------|---------|----------|
| A1 | QRG | "2700 V" for GWS 27-230 PR rated input power (unit should be W) | Extract with low confidence; unit-sanity rule flags |
| A2 | QRG (text order) | Implausible values from scrambled columns, e.g., "8600 W" appearing against a 3.2 J rotary hammer class | Vision extraction; cross-check value ranges per tool class |
| A3 | QRG | Part number `0601513000` listed for three different products (GWS 14-125, GCR 350, GST 150 BCE) | Duplicate-ID detection → review queue |
| A4 | QRG | Source typos/OCR-like defects ("nish" for "finish"; "Rivet Gum") | Normalize with note; never propagate to descriptions |
| A5 | Alca | Decimal commas and EU formats throughout | Locale-aware normalization |
| A6 | Template | Instructions describe "Pricing & Inventory (green)" section + Discounted ≤ Selling rule, but Template sheet has no pricing columns | Handled by D4; confirm with BK where pricing lives |
| A7 | Template | Categorization IDs bound to product type "Countertop", yet filename/golden data are Pedestal basins | Do not reuse IDs verbatim; resolve via D1 mapping; confirm correct product_type_id with BK |
| A8 | Template vs samples | Brand dropdown (22 values) excludes every sample brand except Bosch | Handled by D2 dynamic registry |
| A9 | Vendor form / filenames | "Jaguar" vs "Jaquar" spelling; Artize product attributed to Jaquar | Brand canonicalization table |
| A10 | Twyford golden | Two SKU pairs share identical attribute sets (TWYPK2570/2580; and 550×440×825 1H/2H family overlaps) | Variant-suffix convention (Section 4.4) |

---

## 9. Open Questions Register

| # | Question | Owner | Status |
|---|----------|-------|--------|
| ~~Q1~~ | ~~Success criteria~~ | — | **Closed 17-Jul-2026** — criteria received (see §1); measurable tests proposed in Design Doc §9 for BK sign-off |
| Q2 | BK category-ID registry (or endpoint/export) so the D1 taxonomy can map to real IDs; confirm correct product_type_id for pedestal basins (A7) | BK | Open |
| ~~Q3~~ | ~~Finish/colour variant handling~~ | — | **Closed by D5** — one row per purchasable variant |
| Q4 | Where does pricing live in the import (columns absent, A6) — separate sheet, later template version, or API? Interim policy = D4 | BK | Open |
| Q5 | Media at scale: for the 104-pp Bosch book, are manufacturer images to be scraped/sourced, or is imageless onboarding acceptable at PoC stage? | BK | Open |
| ~~Q6~~ | ~~Per-category templates for cisterns/accessories/tools~~ | — | **Closed by D1** |
| ~~Q7~~ | ~~Brand list extension process~~ | — | **Closed by D2** |
| ~~Q8~~ | ~~Are descriptions/tags in scope?~~ | — | **Closed by D3 (yes)** |

---

## 10. Deliverable Status

**Design Document v1.0 — delivered 17-Jul-2026** (`02_Design/BK_Catalog_Automation_Design_Document_v1.md`): full pipeline architecture (Stages 0–10 incl. document triage per D7), per-stage justification, technology choices, scalability notes, data-integrity principles, PoC demonstration plan, risks, and proposed acceptance tests T1–T7 pending BK sign-off. Next: ground-truth annotation + PoC build (Design Doc §10 delivery sequence).

*End of Knowledge Base v1.1*
