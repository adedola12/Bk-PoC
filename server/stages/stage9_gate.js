import { THRESHOLDS } from "../services/confidence.js";

/**
 * Stage 9 — Validation & Confidence Gate. Row disposition (§6.5):
 *   PASS   — all APPLICABLE required fields filled and ≥ threshold, zero flags
 *   REVIEW — anything uncertain or flagged
 *   TODO   — structurally complete but price missing (D4)
 * D17: required columns inapplicable to the product's category are exempt and
 * reported, never silently passed.
 *
 * Custom dropdown values do NOT gate to REVIEW: the template's own
 * Instructions state "dropdown + custom fields accept custom values" (D6 —
 * the template is the contract), and A8's brand-list gap is D2's registry's
 * job. They are surfaced in the emission report instead. The risky case —
 * an UNCONFIRMED brand — still gates via the Stage 5 `unconfirmed_brand` flag.
 */

/** Required template columns → the IPR fields that feed them (confidence scope). */
const COLUMN_SOURCE = {
  Brand: ["identity", "brand"],
  Collection: ["identity", "collection"],
  Color: ["attributes", "color"],
  "Dimensions (1)": ["attributes", "dimensions1"],
  "Dimensions (2)": ["attributes", "dimensions2"],
  "Dimensions (3)": ["attributes", "dimensions3"],
  Material: ["attributes", "material"],
  Shape: ["attributes", "shape"],
};

const fieldAt = (ipr, [group, key]) => {
  const g = ipr[group];
  if (!g) return null;
  return g instanceof Map ? g.get(key) : g[key];
};

export function gateRow({ ipr, row, schema, profile, dropdownFlags, factChecked = true }) {
  const reasons = [];
  const applicable = profile.applicable; // null = all required apply
  const requiredCols = schema.columns.filter((c) => c.required && !c.formula);
  const exemptions = [];
  const applicableRequired = [];

  for (const col of requiredCols) {
    const isApplicable = !applicable || applicable.includes(col.name) || applicable.includes(col.raw?.replace(/\s*\*\s*$/, ""));
    if (!isApplicable) {
      exemptions.push(col.name);
      continue;
    }
    applicableRequired.push(col.name);
    if (!row[col.name] || String(row[col.name]).trim() === "") {
      reasons.push(`required "${col.name}" empty`);
    }
  }

  // §6.5 — confidence floor over the fields feeding APPLICABLE REQUIRED
  // columns only; optional extras (features, finishes) never block a row
  if (!ipr.templateRow) {
    for (const colName of applicableRequired) {
      const source = COLUMN_SOURCE[colName];
      if (!source) continue;
      const f = fieldAt(ipr, source);
      if (f?.value == null || typeof f.confidence !== "number") continue;
      // derived fields are labelled in output (D5/D18) → their own threshold
      const bar = f.method === "derived" ? THRESHOLDS.derivedFieldPass : THRESHOLDS.requiredFieldPass;
      if (f.confidence < bar) {
        reasons.push(`"${colName}" confidence ${f.confidence.toFixed(2)} below ${bar}${f.method === "derived" ? " (derived)" : ""}`);
      }
    }
  }

  if (ipr.flags?.length) reasons.push(...ipr.flags.map((f) => `${f.field}: ${f.reason}`));
  if (!factChecked) reasons.push("generated copy failed fact-check");

  if (reasons.length) return { disposition: "REVIEW", reasons, exemptions, customDropdowns: dropdownFlags ?? [] };

  const priceMissing = !row["Selling Price"] && !row["Price"]; // template has no price columns (A6/D4)
  return { disposition: priceMissing ? "TODO" : "PASS", reasons: [], exemptions, customDropdowns: dropdownFlags ?? [] };
}
