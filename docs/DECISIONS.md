# BK-Ingest — Decisions Log (continues from D1–D11 in the KB and Addendum)

| ID | Date | Decision | Implication |
|----|------|----------|-------------|
| D12 | 18-Jul-2026 | **Triage label set gains a sixth structural route: `bk_template`.** Files whose workbook matches the BK template signature (sheet set Template/Lookup/Instructions, or a Template sheet whose header row matches the known BK column set) route to `bk_template` — detected by deterministic rule before any LLM call. Filled templates (the Twyford golden file) short-circuit to validation per Design Doc §3 Stage 1. | T1 ground truth: template + Twyford → `bk_template`; 3 datasheets → `product_datasheet`; 2 Bosch → `catalogue`; 2 JPGs → `product_image`; SG_BK.docx → `vendor_document`. D11 verification prompt remains required for `vendor_document`/`other` only. Ratified by ADLM 18-Jul-2026. |

Open (to ratify at their milestone): **D13 candidate** — classifier-disagreement precedence when the three taxonomy methods conflict (Milestone C). **D14 candidate** — cross-file SKU reconciliation: same part number in two uploaded documents = confirmation signal or two candidate rows? (Milestone C/D.)
