/**
 * Stage 6 — Variant expansion (D5): one row per purchasable variant. Derived
 * variant SKUs substitute the manufacturer's own finish codes into the
 * product code (AKP-CHR-35751P → AKP-BLM-35751P) and are labelled
 * `derived_unverified` until confirmed against manufacturer data — never
 * presented as manufacturer-confirmed (§6 / Design Doc §3).
 */

/** Jaquar/Artize finish codes ↔ names (from the datasheets' own finish lists). */
export const JAQUAR_FINISHES = {
  ABR: "Antique Bronze",
  ACR: "Antique Copper",
  BCH: "Black Chrome",
  BLM: "Black Matt",
  GDS: "Gold Dust",
  GLD: "Full Gold",
  GRF: "Graphite",
  SSF: "Stainless Steel Finish",
  WHM: "White Matt",
  CHR: "Chrome",
};

const NAME_TO_CODE = Object.fromEntries(
  Object.entries(JAQUAR_FINISHES).map(([code, name]) => [name.toLowerCase(), code])
);

/** Normalize a finishes list (codes or names) to codes. Unknown entries pass through flagged. */
export function toFinishCodes(list) {
  return (list || [])
    .map((f) => {
      const s = String(f).trim();
      if (JAQUAR_FINISHES[s.toUpperCase()]) return { code: s.toUpperCase(), known: true };
      const code = NAME_TO_CODE[s.toLowerCase()];
      return code ? { code, known: true } : { code: s, known: false };
    })
    .filter((f, i, arr) => arr.findIndex((x) => x.code === f.code) === i);
}

/** Detect the finish code embedded in a product code, e.g. AKP-CHR-35751P → CHR. */
export function embeddedFinishCode(productCode) {
  const m = String(productCode || "").match(/-([A-Z]{3})-/);
  return m && JAQUAR_FINISHES[m[1]] ? m[1] : null;
}

/**
 * Expand one IPR into base + variant rows. The base row keeps its extracted
 * SKU untouched; variants get derived SKUs + derived_unverified labels.
 * @param {object} ipr - classified/brand-resolved IPR
 * @returns {Array<object>} [base, ...variants] (length 1 if no options)
 */
export function expandVariants(ipr) {
  const attrs = ipr.attributes instanceof Map ? Object.fromEntries(ipr.attributes) : ipr.attributes || {};
  const finishList = attrs.finishes?.value;
  const productCode = ipr.identity?.productCode?.value;
  const baseCode = embeddedFinishCode(productCode);

  if (!Array.isArray(finishList) || !finishList.length || !productCode || !baseCode) {
    return [ipr]; // no purchasable options declared — attributes stay attributes
  }

  const options = toFinishCodes(finishList).filter((f) => f.code !== baseCode);

  const base = { ...ipr, variantOf: null, variantLabel: null };
  base.attributes = { ...attrs };
  if (!base.attributes.color?.value && baseCode) {
    base.attributes.color = mkRuleField(JAQUAR_FINISHES[baseCode], productCode, "finish code in product code");
  }

  const variants = options.map(({ code, known }) => {
    const derivedSku = productCode.replace(`-${baseCode}-`, `-${code}-`);
    const v = structuredClone({ ...ipr, templateRow: undefined });
    v.identity.productCode = {
      ...v.identity.productCode,
      value: derivedSku,
      raw: v.identity.productCode.raw, // manufacturer's original string preserved
      confidence: known ? 0.7 : 0.4,
      method: "derived",
    };
    v.attributes = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes || {};
    v.attributes.color = mkRuleField(JAQUAR_FINISHES[code] ?? code, derivedSku, "substituted finish code");
    delete v.attributes.finishes; // options list lives on the base row only
    v.variantLabel = "derived_unverified";
    v.variantOfCode = productCode;
    if (!known) {
      v.flags = v.flags || [];
      v.flags.push({ field: "color", reason: "anomaly_rule", detail: `unknown finish "${code}" — not derived from manufacturer table` });
    }
    return v;
  });

  return [base, ...variants];
}

function mkRuleField(value, source, region) {
  return {
    value,
    unit: null,
    raw: String(source),
    sourceRef: { file: "derived", page: null, region },
    confidence: 0.85,
    method: "derived",
  };
}
