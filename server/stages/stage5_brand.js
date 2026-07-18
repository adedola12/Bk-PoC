import mongoose from "mongoose";
import { BrandRegistry } from "../models/BrandRegistry.js";
import { SEED_BRANDS, resolveBrand } from "../services/brands.js";

/**
 * Stage 5 — Brand resolution (D2). Applies the registry to an IPR:
 * - canonical brand replaces the extracted VALUE; the extracted string stays
 *   untouched in raw (§6.2)
 * - sub-brand lineage recorded (Artize ⊂ Jaquar)
 * - unknown brands auto-register as candidates with evidence — never block,
 *   never silently merge
 */

export async function ensureBrandsSeeded() {
  if (mongoose.connection.readyState !== 1) return;
  for (const b of SEED_BRANDS) {
    await BrandRegistry.updateOne(
      { canonicalName: b.canonicalName },
      { $setOnInsert: { ...b, evidence: [{ note: "seeded from KB §7/A8-A9", addedAt: new Date() }] } },
      { upsert: true }
    );
  }
}

async function loadRegistry() {
  if (mongoose.connection.readyState === 1) {
    const rows = await BrandRegistry.find({}).lean();
    if (rows.length) return rows;
  }
  return SEED_BRANDS; // offline eval/tests
}

/**
 * @param {object} ipr - normalized IPR (mutated in place)
 * @returns {Promise<{resolved:boolean, canonical?:string, parent?:string|null,
 *           method?:string, conflict?:string|null, candidate?:object|null}>}
 */
export async function resolveIprBrand(ipr, { sourceFile } = {}) {
  const registry = await loadRegistry();
  const extractedBrand = ipr.identity?.brand?.value ?? null;
  const productCode = ipr.identity?.productCode?.value ?? null;

  const result = resolveBrand(registry, { extractedBrand, productCode });

  if (result.match) {
    const b = ipr.identity.brand || {
      value: null, unit: null, raw: null,
      sourceRef: { file: sourceFile || "unknown", page: null, region: null },
      confidence: 0, method: "rule",
    };
    // raw keeps what the document said; value becomes canonical (never the reverse)
    b.raw = b.raw ?? extractedBrand;
    b.value = result.match.canonicalName;
    b.method = "rule";
    b.confidence = Math.max(b.confidence ?? 0, result.method === "code_signature" ? 0.95 : 0.9);
    ipr.identity.brand = b;

    if (result.match.parentBrand) {
      ipr.identity.subBrand = {
        value: result.match.canonicalName,
        unit: null,
        raw: extractedBrand,
        sourceRef: { file: sourceFile || "unknown", page: null, region: "brand registry lineage" },
        confidence: 0.95,
        method: "rule",
      };
    }
    if (result.conflict) {
      ipr.flags = ipr.flags || [];
      ipr.flags.push({ field: "brand", reason: "anomaly_rule", detail: result.conflict });
    }
    return { resolved: true, canonical: result.match.canonicalName, parent: result.match.parentBrand, method: result.method, conflict: result.conflict };
  }

  // unknown brand → candidate registration, never blocking (D2)
  if (result.candidate && mongoose.connection.readyState === 1) {
    await BrandRegistry.updateOne(
      { canonicalName: result.candidate.canonicalName },
      {
        $setOnInsert: { canonicalName: result.candidate.canonicalName, status: "candidate" },
        $push: { evidence: { sourceFile: sourceFile || null, note: `auto-registered; code ${result.candidate.evidence.productCode ?? "n/a"}`, addedAt: new Date() } },
      },
      { upsert: true }
    );
  }
  if (result.candidate) {
    ipr.flags = ipr.flags || [];
    ipr.flags.push({ field: "brand", reason: "unconfirmed_brand", detail: `candidate "${result.candidate.canonicalName}"` });
  }
  return { resolved: false, candidate: result.candidate };
}
