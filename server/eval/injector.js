import { findDuplicateCodes } from "../services/validators.js";
import { checkSanity } from "../services/normalize.js";
import { unitMatchesLabel } from "../services/validators.js";

/**
 * T4 anomaly injector (built in Milestone B per amended §8, exercised fully
 * against hostile catalogs in Milestone D). Seeded PRNG → reproducible runs.
 * Error classes mirror the real anomaly log: wrong units (A1), swapped/
 * scrambled values (A2), duplicate part numbers (A3), magnitude errors.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MUTATIONS = [
  {
    type: "wrong_unit", // A1: "2700 V" where W was meant
    apply(ipr) {
      const f = pickNumericField(ipr);
      if (!f) return null;
      const wrong = { W: "V", V: "W", kg: "mm", mm: "kg" }[f.field.unit] || "V";
      const original = { unit: f.field.unit };
      f.field.unit = wrong;
      return { ...f.meta, detail: `unit ${original.unit} → ${wrong}` };
    },
  },
  {
    type: "magnitude_error", // A2-adjacent: scrambled columns produce 8600 W-class values
    apply(ipr) {
      const f = pickNumericField(ipr);
      if (!f) return null;
      const original = f.field.value;
      f.field.value = original * 10;
      return { ...f.meta, detail: `${original} → ${f.field.value}` };
    },
  },
  {
    type: "swapped_values", // A2: label-value pairing scrambled between two fields
    apply(ipr) {
      const nums = allNumericFields(ipr);
      if (nums.length < 2) return null;
      const [a, b] = nums;
      [a.field.value, b.field.value] = [b.field.value, a.field.value];
      return { field: `${a.meta.field}⇄${b.meta.field}`, group: a.meta.group, detail: "values swapped" };
    },
  },
  {
    type: "duplicate_code", // A3: one part number on multiple products
    apply(ipr, all, rng) {
      const donor = all[Math.floor(rng() * all.length)];
      const donorCode = donor?.identity?.productCode?.value;
      if (!donorCode || donorCode === ipr.identity?.productCode?.value) return null;
      const original = ipr.identity.productCode.value;
      ipr.identity.productCode.value = donorCode;
      ipr.identity.productCode.raw = donorCode;
      return { field: "productCode", group: "identity", detail: `${original} → ${donorCode} (dup)` };
    },
  },
];

function allNumericFields(ipr) {
  const out = [];
  for (const group of ["attributes", "logistics"]) {
    for (const [field, f] of Object.entries(ipr[group] || {})) {
      if (f && typeof f.value === "number") out.push({ field: f, meta: { field, group }, group });
    }
  }
  // normalize shape: {field: <fieldObj>, meta}
  return out.map((o) => ({ field: o.field, meta: o.meta }));
}

function pickNumericField(ipr) {
  const nums = allNumericFields(ipr);
  return nums[0] || null;
}

/**
 * Inject `count` seeded errors into a DEEP COPY of the IPR list.
 * @returns {{mutated: Array, injected: Array<{index,type,field,detail}>}}
 */
export function injectErrors(iprs, { count = 5, seed = 42 } = {}) {
  const rng = mulberry32(seed);
  const mutated = structuredClone(iprs);
  const injected = [];
  let guard = 0;
  while (injected.length < count && guard++ < count * 20) {
    const idx = Math.floor(rng() * mutated.length);
    const mutation = MUTATIONS[Math.floor(rng() * MUTATIONS.length)];
    const result = mutation.apply(mutated[idx], mutated, rng);
    if (result) injected.push({ index: idx, type: mutation.type, ...result });
  }
  return { mutated, injected };
}

/**
 * Detection harness (T4 mechanics): run the pipeline's own validators over a
 * record set and report which injected errors are caught. Used by tests now,
 * by the full T4 scorer in Milestone D.
 */
export function detectAnomalies(iprs) {
  const caught = [];

  // duplicate part numbers (A3)
  const codes = iprs.map((i) => ({ productCode: i.identity?.productCode?.value ?? null }));
  for (const dup of findDuplicateCodes(codes)) {
    caught.push({ type: "duplicate_code", detail: dup.code, indexes: dup.indexes });
  }

  // unit/label mismatch (A1) + sanity ranges (A2/magnitude)
  iprs.forEach((ipr, index) => {
    for (const group of ["attributes", "logistics"]) {
      for (const [key, f] of Object.entries(ipr[group] || {})) {
        if (!f || f.value == null) continue;
        if (!unitMatchesLabel(key, f.unit)) {
          caught.push({ type: "wrong_unit", index, field: key, detail: `${key} in ${f.unit}` });
        }
        if (typeof f.value === "number") {
          const ruleKey = key.startsWith("dimensions") ? "dimensionMm" : key === "weightKg" ? "weightKg" : null;
          if (ruleKey) {
            const sane = checkSanity(ruleKey, f.value);
            if (!sane.ok) caught.push({ type: "sanity", index, field: key, detail: sane.reason });
          }
        }
      }
    }
  });

  return caught;
}
