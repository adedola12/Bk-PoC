import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairingQa, scorePagePairing } from "../stages/pairing_qa.js";
import { detectSection } from "../stages/bulk_extract.js";
import { findDuplicateCodes, sanityRuleFor } from "../services/validators.js";
import { detectAnomalies } from "../eval/injector.js";
import { normCode } from "../stages/vision_extract.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const fx = (name) => path.join(FIXTURES, name);

/* ─────────── pairing QA — the vision trigger ─────────── */
describe("label-value pairing QA (Design Doc §3 Stage 1)", () => {
  it("rejects both QRG pages (verified scrambled source, A1–A3 origin)", async () => {
    const qa = await pairingQa(fx("Revised_Quick_Refrence_Guide.pdf"));
    expect(qa.pages).toHaveLength(2);
    expect(qa.pages.every((p) => p.trustText === false)).toBe(true);
    expect(qa.anyVisionNeeded).toBe(true);
  }, 60000);

  it("trusts the clean Alca datasheet and sampled HD pages (cheap text path)", async () => {
    const alca = await pairingQa(fx("Alca_Drain__AM101_.pdf"));
    expect(alca.pages[0].trustText).toBe(true);
    const hd = await pairingQa(fx("HD_BOOKET.pdf"), { only: [20, 52, 80] });
    expect(hd.pages.every((p) => p.trustText)).toBe(true);
  }, 120000);

  it("labels-then-values runs are the failure signature", () => {
    const mk = (strs) => ({ page: 1, width: 2400, height: 800, items: strs.map((str, i) => ({ str, x: i, y: 0 })) });
    const scrambled = scorePagePairing(mk(["Disc diameter", "Power output", "Rated speed", "2700 V", "6,500 rpm", "30 mm", "2700 W"]));
    expect(scrambled.trustText).toBe(false);
    const healthy = scorePagePairing(mk(["Power output", "2700 W", "Disc diameter", "230 mm", "Rated speed", "6,500 rpm"]));
    expect(healthy.trustText).toBe(true);
  });
});

/* ─────────── section detection → deterministic classifier tier ─────────── */
describe("Bosch section headers → D1 nodes", () => {
  it("maps the catalog's own section names", () => {
    expect(detectSection("GRINDING, DRILLING & DEMOLITION — heavy duty")).toBe("Grinding, Drilling & Demolition");
    expect(detectSection("Impact / Diamond Drilling section")).toBe("Impact & Diamond Drilling");
    expect(detectSection("CORDLESS FREEDOM")).toBe("Cordless");
    expect(detectSection("Measuring and levelling tools")).toBe("Measuring & Leveling");
    expect(detectSection("no header here")).toBeNull();
  });
});

/* ─────────── A1/A2/A3 detection on hostile-shaped records ─────────── */
describe("anomaly detection over printed spec labels", () => {
  const mkTool = (code, specs) => ({
    identity: { productCode: { value: code, raw: code, confidence: 0.8, method: "vision" } },
    attributes: Object.fromEntries(
      Object.entries(specs).map(([label, [value, unit]]) => [label, { value, unit, raw: `${label}: ${value} ${unit ?? ""}`.trim(), confidence: 0.8, method: "vision" }])
    ),
    logistics: {},
    compliance: {},
  });

  it("A1: rated power printed in volts is flagged wrong_unit", () => {
    const iprs = [mkTool("06018C50K0", { "Rated input power": ["2700", "V"] })];
    const caught = detectAnomalies(iprs);
    expect(caught.some((c) => c.type === "wrong_unit" && /power/i.test(c.field))).toBe(true);
  });

  it("A2-class: 8600 W on a rotary hammer breaches the sanity range", () => {
    const iprs = [mkTool("0611234000", { "Rated input power": ["8600", "W"], "Impact energy": ["3.2", "J"] })];
    const caught = detectAnomalies(iprs);
    expect(caught.some((c) => c.type === "sanity" && /8600/.test(c.detail))).toBe(true);
  });

  it("A3: one part number on three products is flagged once with all rows", () => {
    const iprs = [
      mkTool("0601513000", { "Rated input power": ["600", "W"] }),
      mkTool("0 601 513 000", { "Rated input power": ["3200", "W"] }),
      mkTool("0601513000", { "No-load speed": ["2800", "rpm"] }),
    ];
    const dups = findDuplicateCodes(iprs.map((i) => ({ productCode: i.identity.productCode.value })));
    expect(dups).toHaveLength(1);
    expect(dups[0].indexes).toEqual([0, 1, 2]); // spacing normalized
  });

  it("plausible specs raise no flags", () => {
    const iprs = [mkTool("06018C50K0", { "Rated input power": ["2700", "W"], "Disc diameter": ["230", "mm"] })];
    expect(detectAnomalies(iprs)).toHaveLength(0);
  });

  it("sanityRuleFor maps printed labels", () => {
    expect(sanityRuleFor("Rated input power")).toBe("ratedPowerW");
    expect(sanityRuleFor("Impact energy")).toBe("impactJ");
    expect(sanityRuleFor("Weight")).toBe("weightKg");
  });

  it("normCode strips Bosch spacing", () => {
    expect(normCode("0 601 513 000")).toBe("0601513000");
  });
});
