# BuildersKonnect — AI Catalog Onboarding PoC
## Decisions Addendum: D8–D11 & Design Amendments
**Date:** 17 July 2026 · **Amends:** Knowledge Base v1.1 (§5, §9) and Design Document v1.0 (§2, §3, §4)
**Status:** Adopted. To be merged into KB v1.2 / Design Doc v1.1 at next consolidation.

---

## New Design Decisions

| ID | Decision | Implication |
|----|----------|-------------|
| D8 | **Build platform & stack:** PoC developed in Claude Code as a MERN application — MongoDB, Express, React (JSX), Node.js — with product images hosted on **Cloudinary**. | Single-stack: extraction pipeline runs in Node (Anthropic SDK for JS; exceljs for template emission), replacing the Python/SQLite proposal in Design Doc §4. MongoDB holds registries, Upload Ledger, review/todo queues, price ledger. Cloudinary integrates at Stage 7: images upload there; returned URLs populate Cover Image / Other Images template columns. React front end delivers the showcase UI: upload, triage verification, review queue, todo, price views. |
| D9 | **ADLM-built category ID register** (closes Q2 with our own solution — BK has no available registry). IDs issued for every taxonomy node in BK's format style (`cat_` + nanoid, matching observed `cat_NMgutrpDUDaPfIxEbF7-h`). | Crosswalk table maps ADLM IDs ↔ BK IDs; when BK's real IDs surface, mapping is a lookup update, not a data migration. The register is itself a deliverable BK can adopt. Anomaly A7 (Countertop/Pedestal ID conflict) is resolved inside the register with correct product-type nodes. |
| D10 | **Backend price ledger:** prices are append-only history events — `{sku, variant, vendor, brand, price, currency, source, effective_date}` — never overwritten. | Extends D4: re-upload with prices appends a new price event (full audit trail) rather than replacing a value. Enables per-SKU price-change tracking, cross-supplier comparison for the same product, and cross-brand comparison within a category. Blank-price todo behavior (D4) unchanged. |
| D11 | **No silent dismissal + vendor document parsing.** Any file classified `vendor_document` or `other/unsupported` triggers a **UI verification prompt** — document snapshot preview plus the system's extracted summary — before final filing or dismissal. Vendor forms are parsed into structured **vendor profiles** (company, RC, contacts, addresses, social handles, years in business, categories, certifications SON/MANCAP/ISO/international, warranty period & coverage, supply states, MOQ, delivery timeline), not merely archived. | Strengthens Stage 0: "filed silently" is no longer permitted for non-product routes. SG_BK.docx becomes the reference case: routed to vendor_document, snapshot shown for human confirmation, then parsed into Satkay Limited's vendor profile whose fields (e.g., 10-year warranty, MOQ 1, 48hr delivery) become vendor-level data available to the pipeline. |

## Record correction / clarification (SG_BK.docx)

Design Doc v1.0 §7 already routed SG_BK.docx to `vendor_document` (never product-extracted, never discarded); the earlier note that its embedded images are "logos/signature only" referred to the images (BK letterhead with contact block, BK logo, signatory signature), not the document's text content, which was fully read and drives the Satkay vendor scenario in KB §1. D11 nonetheless hardens this path: non-product classifications now require human verification with a visual snapshot, eliminating the silent-filing failure mode entirely.

## Design Document deltas (to land in v1.1)

1. §2/§3 Stage 0: add verification-prompt sub-step for non-product routes; add vendor-form parsing sub-pipeline → vendor profile store.
2. §3 Stage 7: Cloudinary upload step; template media columns carry Cloudinary URLs.
3. §4 Technology table: Node.js/Express pipeline, MongoDB storage, exceljs emission, React review UI (replaces "generated HTML review sheet"), Cloudinary media, Claude via Anthropic JS SDK.
4. §3 Stage 10 / D10: Upload Ledger gains `price_events` collection; D4 delta path appends events.
5. §9 acceptance tests: T5 restated against the price ledger (missing price → todo; re-upload → new price event, other fields untouched); add T8: non-product files must surface the D11 verification prompt (SG_BK.docx as the test case) — 100%.
6. Open Questions: Q2 **closed by D9**. Remaining open: Q4 (where pricing lives in BK's import — interim: our backend ledger per D10), Q5 (media sourcing for the 104-pp Bosch book).

## Immediate next steps

1. Ratify acceptance tests T1–T8 (thresholds still pending your/BK sign-off).
2. Scaffold the Claude Code repo: monorepo — `apps/api` (Express pipeline + queues), `apps/web` (React showcase), `packages/taxonomy` (D1 tree + D9 ID register), `packages/emitter` (template-driven xlsx). Seed with the 10 sample files as fixtures and the golden Twyford file as the emitter regression test.
3. Week-1 build per Design Doc §10: Stages 0–4 incl. the D11 verification flow, demonstrated on the three datasheets + SG_BK.docx.

*End of Addendum*
