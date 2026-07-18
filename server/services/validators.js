/**
 * Cross-record validators (early slice of Stage 9, needed by the anomaly
 * injector harness from Milestone B onward). Flag, never fix (§6.1).
 */

/**
 * A3-class duplicate detection: same product code on different products.
 * @param {Array<{productCode:string|null, name?:string}>} records
 * @returns {Array<{code:string, indexes:number[]}>}
 */
export function findDuplicateCodes(records) {
  const byCode = new Map();
  records.forEach((r, i) => {
    const code = (r.productCode || "").trim();
    if (!code) return;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(i);
  });
  return [...byCode.entries()]
    .filter(([, idxs]) => idxs.length > 1)
    .map(([code, indexes]) => ({ code, indexes }));
}

/**
 * Unit-field mismatch (A1-class): a power spec expressed in volts, etc.
 * @param {{label:string, unit:string|null}} field
 */
export function unitMatchesLabel(label, unit) {
  if (!unit) return true;
  const l = (label || "").toLowerCase();
  const u = unit.toLowerCase();
  if (/power|wattage/.test(l)) return ["w", "kw", "watt", "watts"].includes(u);
  if (/voltage/.test(l)) return ["v", "volt", "volts"].includes(u);
  if (/weight/.test(l)) return ["kg", "g", "t"].includes(u);
  if (/dimension|length|width|height|depth/.test(l)) return ["mm", "cm", "m", "in"].includes(u);
  return true;
}
