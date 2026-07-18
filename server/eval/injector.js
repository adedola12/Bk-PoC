import { findDuplicateCodes, unitMatchesLabel, sanityRuleFor } from "../services/validators.js";
import { checkSanity, parseLocaleNumber, SANITY_RULES } from "../services/normalize.js";

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

/**
 * Mutations are DETECTABLE-CLASS by construction (Evaluation Strategy §4.3:
 * "wrong units, swapped values, duplicate codes — all of which must be
 * flagged"). A random tweak that lands on a plausible value is not a seeded
 * anomaly — it is noise no validator could honestly catch.
 */
const MUTATIONS = [
  {
    type: "wrong_unit", // A1: "2700 V" where W was meant
    apply(ipr, all, rng) {
      const candidates = numericFields(ipr).filter((f) => sanityRuleFor(f.meta.field));
      const f = pick(candidates, rng);
      if (!f) return null;
      const wrongByRule = { ratedPowerW: "V", voltageV: "W", weightKg: "mm", dimensionMm: "kg", impactJ: "V" };
      const wrong = wrongByRule[sanityRuleFor(f.meta.field)] || "V";
      const original = f.field.unit;
      f.field.unit = wrong;
      return { ...f.meta, detail: `unit ${original} → ${wrong}` };
    },
  },
  {
    type: "magnitude_error", // A2-class: 8600 W-style values — scaled until they BREACH the sanity range
    apply(ipr, all, rng) {
      const candidates = numericFields(ipr).filter((f) => sanityRuleFor(f.meta.field));
      const f = pick(candidates, rng);
      if (!f) return null;
      const rule = SANITY_RULES[sanityRuleFor(f.meta.field)];
      const original = f.field.value;
      let v = original;
      for (let i = 0; i < 6 && v <= rule.max; i++) v *= 10;
      if (v <= rule.max) return null;
      f.field.value = v;
      return { ...f.meta, detail: `${original} → ${v} (breaches ${rule.note})` };
    },
  },
  {
    type: "swapped_values", // A2: label-value pairing scrambled — only pairs where the swap is implausible
    apply(ipr, all, rng) {
      const nums = numericFields(ipr).filter((f) => sanityRuleFor(f.meta.field));
      for (let i = 0; i < nums.length; i++) {
        for (let j = i + 1; j < nums.length; j++) {
          const a = nums[i];
          const b = nums[j];
          const ruleA = SANITY_RULES[sanityRuleFor(a.meta.field)];
          const ruleB = SANITY_RULES[sanityRuleFor(b.meta.field)];
          const aBad = b.field.value < ruleA.min || b.field.value > ruleA.max;
          const bBad = a.field.value < ruleB.min || a.field.value > ruleB.max;
          if (aBad || bBad) {
            [a.field.value, b.field.value] = [b.field.value, a.field.value];
            return { field: `${a.meta.field}⇄${b.meta.field}`, group: a.meta.group, detail: "values swapped (implausible under swapped labels)" };
          }
        }
      }
      return null;
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

function numericFields(ipr) {
  const out = [];
  for (const group of ["attributes", "logistics"]) {
    const entries = ipr[group] instanceof Map ? [...ipr[group].entries()] : Object.entries(ipr[group] || {});
    for (const [field, f] of entries) {
      const num = f && (typeof f.value === "number" ? f.value : parseLocaleNumber(String(f.value ?? "").match(/^[\d.,]+$/)?.[0]));
      if (num != null) {
        f.value = num; // canonicalize so mutations operate numerically
        out.push({ field: f, meta: { field, group } });
      }
    }
  }
  return out;
}

const pick = (arr, rng) => (arr.length ? arr[Math.floor(rng() * arr.length)] : null);

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

  // unit/label mismatch (A1) + sanity ranges (A2/magnitude). Handles both
  // canonical keys (dimensions1, weightKg) and printed spec labels
  // ("Rated input power") whose values may still be strings, and units that
  // ride inside the raw/value text ("2700 V") rather than the unit slot.
  iprs.forEach((ipr, index) => {
    for (const group of ["attributes", "logistics"]) {
      const entries =
        ipr[group] instanceof Map ? [...ipr[group].entries()] : Object.entries(ipr[group] || {});
      for (const [key, f] of entries) {
        if (!f || (f.value == null && !f.raw)) continue;
        const unit = f.unit || String(f.raw ?? f.value ?? "").match(/\b(W|kW|V|kg|g|mm|cm|J|Nm|rpm|bpm)\b\.?$/)?.[1] || null;
        if (!unitMatchesLabel(key, unit)) {
          caught.push({ type: "wrong_unit", index, field: key, detail: `"${key}" in ${unit}` });
        }
        const ruleKey = sanityRuleFor(key);
        if (ruleKey) {
          const num = typeof f.value === "number" ? f.value : parseLocaleNumber(String(f.value ?? f.raw).match(/[\d.,]+/)?.[0]);
          // only sanity-check when the unit is the rule's own dimension —
          // a mismatched unit is already flagged above (A1 vs A2 separation)
          const unitOkForRule =
            (ruleKey === "ratedPowerW" && (!unit || /^k?w$/i.test(unit))) ||
            (ruleKey === "voltageV" && (!unit || /^v$/i.test(unit))) ||
            (ruleKey === "impactJ" && (!unit || /^j$/i.test(unit))) ||
            (ruleKey === "weightKg" && (!unit || /^(kg|g)$/i.test(unit))) ||
            (ruleKey === "dimensionMm" && (!unit || /^(mm|cm|m)$/i.test(unit)));
          if (num != null && unitOkForRule) {
            const sane = checkSanity(ruleKey, num);
            if (!sane.ok) caught.push({ type: "sanity", index, field: key, detail: sane.reason });
          }
        }
      }
    }
  });

  return caught;
}
