# Ground truth — human-verified annotations

Per the Evaluation Strategy §4.1: **ground truth first, build second** — annotating
first prevents grading the system against answers derived from its own output.

Each file here annotates one source catalog. Format (`schema.json`):

```json
{
  "file": "<fixture filename>",
  "status": "human_verified | draft_pending_verification",
  "products": [
    {
      "productCode": "<anchor key>",
      "fields": { "<fieldKey>": <expected value or null> }
    }
  ]
}
```

- `null` field = not yet annotated → the T2 scorer skips it (reported as coverage, not accuracy).
- Numbers are canonical units (mm, kg). Arrays compare as sets, case-insensitive.
- Field keys: brand, subBrand, productCode, productName, collection, color, material,
  countryOfOrigin, dimensions1..3, weightKg, packQty {unit, carton}, ean,
  waterPressure {min,max}, warranty, norms[], certifications[], finishes[].

**Status discipline:** the drafts in this folder were seeded from the facts already
recorded in the Knowledge Base (§7 — human-authored) plus datasheet reading. They are
`draft_pending_verification` until Adedolapo verifies each value against the source
document and flips the status to `human_verified`. T2 results are INTERIM until then
(Gate G2 accuracy review).
