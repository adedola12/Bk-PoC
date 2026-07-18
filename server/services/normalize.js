/**
 * Stage 3 normalization primitives (Design Doc §3). Locale-aware, range-
 * preserving, never destructive — the raw string is ALWAYS kept beside the
 * canonical value (integrity rule §6.2).
 */

/** "13,45" → 13.45 · "1.234,5" → 1234.5 · "1,234.5" → 1234.5 · "550" → 550 */
export function parseLocaleNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s/g, "");
  if (!s) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // rightmost separator is the decimal mark
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (hasComma) {
    // EU decimal comma ("13,45") vs thousands ("1,234") — 3-digit tail + len>4 = thousands
    const parts = s.split(",");
    s = parts.length === 2 && parts[1].length !== 3 ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Preserve ranges as ranges (§3): "0,05-1,0 MPa" → {min:0.05, max:1}.
 * Returns {kind:"range",min,max} | {kind:"number",value} | null.
 */
export function parseNumberOrRange(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const m = s.match(/^([\d.,]+)\s*[-–—]\s*([\d.,]+)/);
  if (m) {
    const min = parseLocaleNumber(m[1]);
    const max = parseLocaleNumber(m[2]);
    if (min != null && max != null) return { kind: "range", min, max };
  }
  const num = parseLocaleNumber(s.match(/[\d.,]+/)?.[0]);
  return num == null ? null : { kind: "number", value: num };
}

/** "1 | 20 pcs" → { unit: 1, carton: 20 } (Alca pack-quantity convention) */
export function parsePackQty(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+)\s*\|\s*(\d+)/);
  if (m) return { unit: Number(m[1]), carton: Number(m[2]) };
  const single = parseLocaleNumber(raw);
  return single == null ? null : { unit: single, carton: null };
}

/** Canonicalize length units to mm, weight to kg (template units, KB §3). */
export function toMm(value, unit) {
  if (value == null) return null;
  const u = (unit || "mm").toLowerCase();
  if (u === "mm") return value;
  if (u === "cm") return value * 10;
  if (u === "m") return value * 1000;
  if (u === "in" || u === '"') return Math.round(value * 25.4 * 100) / 100;
  return null; // unknown unit — caller keeps raw and flags
}

export function toKg(value, unit) {
  if (value == null) return null;
  const u = (unit || "kg").toLowerCase();
  if (u === "kg") return value;
  if (u === "g") return value / 1000;
  if (u === "t") return value * 1000;
  return null;
}

/**
 * Value-sanity rules per attribute class (§3) — catches A1/A2-class errors.
 * Returns { ok, reason? }; violations DROP confidence and FLAG, never fix.
 */
export const SANITY_RULES = {
  ratedPowerW: { min: 100, max: 4000, note: "corded power tool rated input power (W)" },
  voltageV: { min: 3.6, max: 480, note: "tool/system voltage (V)" },
  dimensionMm: { min: 1, max: 10000, note: "product dimension (mm)" },
  weightKg: { min: 0.01, max: 500, note: "product weight (kg)" },
  impactJ: { min: 0.5, max: 70, note: "impact energy (J)" },
};

export function checkSanity(ruleKey, value) {
  const rule = SANITY_RULES[ruleKey];
  if (!rule || value == null || typeof value !== "number") return { ok: true };
  if (value < rule.min || value > rule.max) {
    return { ok: false, reason: `${value} outside plausible ${rule.note} range ${rule.min}–${rule.max}` };
  }
  return { ok: true };
}
