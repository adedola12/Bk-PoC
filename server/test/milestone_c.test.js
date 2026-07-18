import { describe, it, expect } from "vitest";
import { resolveBrand, SEED_BRANDS } from "../services/brands.js";
import { classifyLexical, classifyDeterministic, classifyIpr } from "../stages/stage4_classify.js";
import { expandVariants, embeddedFinishCode, toFinishCodes } from "../stages/stage6_variants.js";

/* ─────────── Stage 5 — D2 brand registry ─────────── */
describe("brand resolution (D2)", () => {
  it("code signature beats document text: QUA- is Artize even when the sheet says Jaquar (A9)", () => {
    const r = resolveBrand(SEED_BRANDS, { extractedBrand: "Jaquar", productCode: "QUA-CHR-61711" });
    expect(r.match.canonicalName).toBe("Artize");
    expect(r.method).toBe("code_signature");
    expect(r.match.parentBrand).toBe("Jaquar");
    expect(r.conflict).toBeNull(); // Jaquar is Artize's parent — expected lineage, not a conflict
  });

  it("resolves the Jaguar → Jaquar alias", () => {
    const r = resolveBrand(SEED_BRANDS, { extractedBrand: "Jaguar", productCode: "AKP-CHR-35751P" });
    expect(r.match.canonicalName).toBe("Jaquar");
  });

  it("unknown brands become candidates — never blocking, never merging", () => {
    const r = resolveBrand(SEED_BRANDS, { extractedBrand: "Hindware", productCode: "HW-123" });
    expect(r.match).toBeNull();
    expect(r.candidate.canonicalName).toBe("Hindware");
  });

  it("flags a genuine text-vs-code conflict", () => {
    const r = resolveBrand(SEED_BRANDS, { extractedBrand: "Twyford", productCode: "QUA-CHR-61711" });
    expect(r.match.canonicalName).toBe("Artize");
    expect(r.conflict).toContain("Twyford");
  });
});

/* ─────────── Stage 4 — D1 classifier (rule + lexical tiers, no LLM) ─────────── */
describe("taxonomy classification (D1)", () => {
  it("lexical: concealed cistern → Concealed Cisterns & Installation Systems", () => {
    const hit = classifyLexical("wall hung toilet frame with concealed cistern for dry build up");
    expect(hit.path).toBe("Plumbing & Sanitary Ware > Concealed Cisterns & Installation Systems");
  });

  it("lexical: towel rail → Bathroom Accessories", () => {
    const hit = classifyLexical("artize towel rail 600mm long chrome");
    expect(hit.path).toBe("Plumbing & Sanitary Ware > Bathroom Accessories");
  });

  it("deterministic: Bosch source section header maps straight to its node", () => {
    const hit = classifyDeterministic("Cordless");
    expect(hit.path).toBe("Tools & Equipment > Power Tools > Cordless");
  });

  it("no-method case flags unmapped_taxonomy, never guesses (rule 3)", async () => {
    const ipr = { identity: { name: { value: "zzz qqq" } }, attributes: {} };
    const res = await classifyIpr(ipr, { useSemantic: false });
    expect(res.path).toBeNull();
    expect(ipr.flags.some((f) => f.reason === "unmapped_taxonomy")).toBe(true);
  });
});

/* ─────────── Stage 6 — D5 variant expansion ─────────── */
describe("variant expansion (D5 / T6)", () => {
  const mkAccessory = (code) => ({
    identity: {
      brand: { value: "Jaquar", raw: "Jaquar", confidence: 0.95, method: "text", sourceRef: { file: "t" } },
      productCode: { value: code, raw: code, confidence: 0.97, method: "text", sourceRef: { file: "t" } },
      name: { value: "Toilet Roll Holder", raw: "Toilet Roll Holder", confidence: 0.9, method: "text", sourceRef: { file: "t" } },
    },
    attributes: {
      color: { value: "Chrome", raw: "CHR", confidence: 0.9, method: "text", sourceRef: { file: "t" } },
      finishes: {
        value: ["ABR", "ACR", "BCH", "BLM", "GDS", "GLD", "GRF", "SSF", "WHM"],
        raw: "Available Colour Finishing",
        confidence: 0.9,
        method: "text",
        sourceRef: { file: "t" },
      },
    },
    logistics: {},
    compliance: {},
  });

  it("expands base + 9 finishes into 10 rows with derived SKUs (T6)", () => {
    const rows = expandVariants(mkAccessory("AKP-CHR-35751P"));
    expect(rows).toHaveLength(10);
    const [base, ...variants] = rows;
    expect(base.identity.productCode.value).toBe("AKP-CHR-35751P");
    expect(base.variantLabel).toBeNull();
    expect(variants.every((v) => v.variantLabel === "derived_unverified")).toBe(true);
    const blm = variants.find((v) => v.identity.productCode.value === "AKP-BLM-35751P");
    expect(blm).toBeTruthy();
    expect(blm.identity.productCode.method).toBe("derived");
    expect(blm.attributes.color.value).toBe("Black Matt");
    expect(blm.identity.productCode.raw).toBe("AKP-CHR-35751P"); // manufacturer string preserved
  });

  it("accepts finish names as well as codes", () => {
    expect(toFinishCodes(["Black Matt", "GLD"]).map((f) => f.code)).toEqual(["BLM", "GLD"]);
  });

  it("no declared options → single row, untouched", () => {
    const ipr = mkAccessory("AKP-CHR-35751P");
    delete ipr.attributes.finishes;
    expect(expandVariants(ipr)).toHaveLength(1);
  });

  it("finds embedded finish codes", () => {
    expect(embeddedFinishCode("QUA-CHR-61711")).toBe("CHR");
    expect(embeddedFinishCode("TWYPK2570")).toBeNull();
  });
});
