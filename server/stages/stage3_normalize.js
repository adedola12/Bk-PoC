import {
  parseLocaleNumber,
  parseNumberOrRange,
  parsePackQty,
  toMm,
  toKg,
  checkSanity,
} from "../services/normalize.js";

/**
 * Stage 3 — Normalization (Design Doc §3). Canonicalizes values IN PLACE
 * next to their untouched raw strings; sanity violations drop confidence and
 * append to ipr.flags — flag, never fix (§6.1).
 */

const DIM_KEYS = ["dimensions1", "dimensions2", "dimensions3"];

export function normalizeIpr(ipr) {
  ipr.flags = ipr.flags || [];

  // dimensions → mm
  for (const key of DIM_KEYS) {
    const f = ipr.attributes?.[key];
    if (!f || f.value == null) continue;
    const num = typeof f.value === "number" ? f.value : parseLocaleNumber(f.value);
    const mm = toMm(num, f.unit);
    if (mm == null) {
      flag(ipr, key, `unparseable dimension "${f.raw}"`);
      continue;
    }
    f.value = mm;
    f.unit = "mm";
    const sane = checkSanity("dimensionMm", mm);
    if (!sane.ok) downgrade(ipr, key, f, sane.reason);
  }

  // weight → kg
  const w = ipr.logistics?.weightKg;
  if (w && w.value != null) {
    const num = typeof w.value === "number" ? w.value : parseLocaleNumber(w.value);
    const kg = toKg(num, w.unit || inferWeightUnit(w.raw));
    if (kg == null) flag(ipr, "weightKg", `unparseable weight "${w.raw}"`);
    else {
      w.value = kg;
      w.unit = "kg";
      const sane = checkSanity("weightKg", kg);
      if (!sane.ok) downgrade(ipr, "weightKg", w, sane.reason);
    }
  }

  // pack quantity "1 | 20 pcs"
  const pq = ipr.logistics?.packQty;
  if (pq && pq.value != null && typeof pq.value !== "object") {
    const parsed = parsePackQty(pq.raw ?? pq.value);
    if (parsed) pq.value = parsed;
  }

  // ranges stay ranges (water pressure "0,05 – 1,0 MPa")
  const wp = ipr.attributes?.waterPressure;
  if (wp && wp.value != null && typeof wp.value !== "object") {
    const parsed = parseNumberOrRange(wp.raw ?? String(wp.value));
    if (parsed) wp.value = parsed;
  }

  return ipr;
}

function inferWeightUnit(raw) {
  if (!raw) return "kg";
  const m = String(raw).toLowerCase().match(/\b(kg|g|t)\b/);
  return m ? m[1] : "kg";
}

function flag(ipr, field, detail) {
  ipr.flags.push({ field, reason: "anomaly_rule", detail });
}

function downgrade(ipr, field, f, reason) {
  f.confidence = Math.min(f.confidence, 0.3); // drop, don't fix (§6.1)
  ipr.flags.push({ field, reason: "unit_implausible", detail: reason });
}
