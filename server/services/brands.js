/**
 * D2 brand registry — seed data + pure resolution logic (persistence-free so
 * tests and offline eval run without Mongo; stage5 wraps this with the
 * BrandRegistry collection).
 *
 * Product-code signatures are the STRONGEST evidence — a QUA- code is Artize
 * even when the sheet's text says "Jaquar" (A9 lineage rule).
 */

export const SEED_BRANDS = [
  {
    canonicalName: "Jaquar",
    aliases: ["Jaguar"], // A9 misspelling
    parentBrand: null,
    codeSignatures: ["^AKP-", "^AQT-", "^ALD-", "^CON-"],
    status: "confirmed",
  },
  {
    canonicalName: "Artize",
    aliases: [],
    parentBrand: "Jaquar", // Artize ⊂ Jaquar premium line
    codeSignatures: ["^QUA-", "^TRN-"],
    status: "confirmed",
  },
  {
    canonicalName: "Twyford",
    aliases: [],
    parentBrand: "Geberit Group",
    codeSignatures: ["^TWY", "^TW\\d"],
    status: "confirmed",
  },
  {
    canonicalName: "Alcadrain",
    aliases: ["Alca", "AlcaPlast", "Alca Plast"],
    parentBrand: null,
    codeSignatures: ["^AM\\d", "^A\\d{2,}"],
    status: "confirmed",
  },
  {
    canonicalName: "Bosch",
    aliases: ["Bosch Professional"],
    parentBrand: null,
    codeSignatures: ["^0\\s?6\\d{2}\\s?\\d{3}\\s?\\d{3}$", "^G[A-Z]{2}\\s"],
    status: "confirmed",
  },
];

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * Resolve a brand from evidence, strongest first:
 * 1. product-code signature  2. exact/alias name match  3. unknown → candidate.
 * Never blocks, never silently merges (D2).
 *
 * @param {Array} registry - brand records (SEED_BRANDS-shaped)
 * @param {{extractedBrand?:string, productCode?:string}} evidence
 * @returns {{match: object|null, method: "code_signature"|"name"|"alias"|null,
 *            candidate: {canonicalName, evidence}|null, conflict: string|null}}
 */
export function resolveBrand(registry, { extractedBrand, productCode }) {
  const code = String(productCode || "").trim();
  const name = norm(extractedBrand);

  let bySignature = null;
  for (const brand of registry) {
    if ((brand.codeSignatures || []).some((sig) => new RegExp(sig, "i").test(code))) {
      bySignature = brand;
      break;
    }
  }

  let byName = null;
  let nameMethod = null;
  if (name) {
    byName = registry.find((b) => norm(b.canonicalName) === name) || null;
    nameMethod = byName ? "name" : null;
    if (!byName) {
      byName = registry.find((b) => (b.aliases || []).some((a) => norm(a) === name)) || null;
      nameMethod = byName ? "alias" : null;
    }
  }

  if (bySignature) {
    // signature wins; a differing text brand is a lineage note, not a merge —
    // unless the text brand IS the signature brand's parent (expected case).
    const conflict =
      byName && byName.canonicalName !== bySignature.canonicalName && byName.canonicalName !== bySignature.parentBrand
        ? `text says "${extractedBrand}" but code matches ${bySignature.canonicalName}`
        : null;
    return { match: bySignature, method: "code_signature", candidate: null, conflict };
  }
  if (byName) return { match: byName, method: nameMethod, candidate: null, conflict: null };

  // unknown → auto-register candidate with evidence, never blocking (D2)
  const candidate = extractedBrand
    ? { canonicalName: extractedBrand.trim(), evidence: { productCode: code || null } }
    : null;
  return { match: null, method: null, candidate, conflict: null };
}
