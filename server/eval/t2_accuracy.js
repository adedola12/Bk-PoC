import fs from "node:fs";
import path from "node:path";

/**
 * T2 — field-level accuracy vs ground-truth annotations (interim on clean
 * sources at Gate G2). Tolerant comparison: numbers ±1% or ±1mm, strings
 * case-insensitive trim, arrays as case-insensitive sets, objects deep.
 */

export function loadGroundTruth(gtDir) {
  return fs
    .readdirSync(gtDir)
    .filter((f) => f.endsWith(".json") && f !== "schema.json")
    .map((f) => JSON.parse(fs.readFileSync(path.join(gtDir, f), "utf8")));
}

/** Extracted IPR → flat comparable field map keyed like the ground truth. */
export function flattenIpr(ipr) {
  const flat = {};
  const id = ipr.identity || {};
  if (id.brand?.value != null) flat.brand = id.brand.value;
  if (id.subBrand?.value != null) flat.subBrand = id.subBrand.value;
  if (id.productCode?.value != null) flat.productCode = id.productCode.value;
  if (id.name?.value != null) flat.productName = id.name.value;
  if (id.collection?.value != null) flat.collection = id.collection.value;
  for (const group of ["attributes", "logistics", "compliance"]) {
    const g = ipr[group];
    if (!g) continue;
    const entries = g instanceof Map ? [...g.entries()] : Object.entries(g);
    for (const [key, f] of entries) {
      if (f && f.value != null) flat[key] = f.value;
    }
  }
  return flat;
}

export function valuesMatch(expected, actual) {
  if (expected == null) return null; // unannotated → skip
  if (actual == null) return false;
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) <= Math.max(1, Math.abs(expected) * 0.01);
  }
  if (Array.isArray(expected)) {
    const act = Array.isArray(actual) ? actual : [actual];
    if (expected.length !== act.length) return false;
    // element match: exact (case-insensitive) OR all expected tokens appear in
    // one actual element — the extractor preserves verbatim source strings
    // ("WRAS (certificate no. 2206330)"), the annotation may be the short form.
    const tokens = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
    return expected.every((e) => {
      const eTok = tokens(e);
      return act.some((a) => {
        const aNorm = String(a).trim().toLowerCase();
        if (aNorm === String(e).trim().toLowerCase()) return true;
        const aTok = new Set(tokens(a));
        return eTok.length > 0 && eTok.every((t) => aTok.has(t));
      });
    });
  }
  if (typeof expected === "object") {
    return Object.entries(expected).every(([k, v]) => valuesMatch(v, actual?.[k]) !== false);
  }
  return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

/**
 * Score one catalog: match products by code (incl. aliases), compare fields.
 * @returns {{file, matchedProducts, totalProducts, correct, scored, skipped, accuracy, misses}}
 */
export function scoreCatalog(gt, iprs) {
  let correct = 0;
  let scored = 0;
  let skipped = 0;
  let matchedProducts = 0;
  const misses = [];

  for (const product of gt.products) {
    const codes = [product.productCode, ...(product.codeAliases || [])].map((c) => c.toLowerCase());
    const ipr = iprs.find((i) => {
      const flat = flattenIpr(i);
      return flat.productCode && codes.includes(String(flat.productCode).trim().toLowerCase());
    });
    if (!ipr) {
      misses.push({ product: product.productCode, field: "(product not found)" });
      scored += Object.values(product.fields).filter((v) => v != null).length;
      continue;
    }
    matchedProducts++;
    const flat = flattenIpr(ipr);
    for (const [field, expected] of Object.entries(product.fields)) {
      const result = valuesMatch(expected, flat[field]);
      if (result === null) {
        skipped++;
        continue;
      }
      scored++;
      if (result) correct++;
      else misses.push({ product: product.productCode, field, expected, actual: flat[field] ?? null });
    }
  }

  return {
    file: gt.file,
    status: gt.status,
    matchedProducts,
    totalProducts: gt.products.length,
    correct,
    scored,
    skipped,
    accuracy: scored ? correct / scored : null,
    misses,
  };
}
