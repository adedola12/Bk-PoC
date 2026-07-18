import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchDropdown, profileFor, mapIprToRow, identityKey, mediaUrlFor } from "../stages/stage7_map.js";
import { factCheck } from "../stages/stage8_generate.js";
import { gateRow } from "../stages/stage9_gate.js";
import { readTemplateSchema } from "../emitter/index.js";
import { classifyFetched, htmlToText, assertSafeUrl } from "../services/weburl.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const TEMPLATE = path.join(FIXTURES, "catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx");

const mkField = (value, confidence = 0.95, extra = {}) => ({
  value,
  unit: null,
  raw: String(value),
  sourceRef: { file: "t" },
  confidence,
  method: "text",
  ...extra,
});

const accessoryIpr = (conf = 0.95) => ({
  identity: {
    brand: mkField("Jaquar", conf),
    productCode: mkField("AKP-CHR-35751P", conf),
    name: mkField("Toilet Roll Holder", conf),
  },
  attributes: {
    color: mkField("Chrome", conf),
    dimensions1: mkField(180, conf, { unit: "mm" }),
    dimensions2: mkField(65, conf, { unit: "mm" }),
    dimensions3: mkField(95, conf, { unit: "mm" }),
    material: mkField("Brass", conf),
  },
  logistics: {},
  compliance: { warranty: mkField("10 years", conf) },
  taxonomyPath: "Plumbing & Sanitary Ware > Bathroom Accessories",
});

/* ─────────── Stage 7 — mapping + dropdowns ─────────── */
describe("Stage 7 mapping (D6/D17)", () => {
  it("dropdown matching: exact → synonym → flagged custom, never coerced", () => {
    const allowed = ["Ceramic/Vitreous China", "Porcelain", "Glass"];
    expect(matchDropdown("porcelain", allowed).status).toBe("exact");
    expect(matchDropdown("vitreous china", allowed, { "vitreous china": "Ceramic/Vitreous China" }).status).toBe("synonym");
    const custom = matchDropdown("Brass", allowed);
    expect(custom.status).toBe("custom");
    expect(custom.value).toBe("Brass"); // preserved verbatim, flagged
  });

  it("maps an accessory into template columns via its category profile", async () => {
    const schema = await readTemplateSchema(TEMPLATE);
    const { row, profile } = mapIprToRow(accessoryIpr(), schema);
    expect(row["Brand"]).toBe("Jaquar");
    expect(row["Dimensions (1)"]).toBe("180");
    expect(row["Product SKU"]).toBe("AKP-CHR-35751P");
    expect(profile.applicable).toContain("Material");
    expect(profile.applicable).not.toContain("Tap Holes"); // D17 exemption
  });

  it("variant rows inherit the base product's paired image", () => {
    const base = accessoryIpr();
    const variant = { ...accessoryIpr(), identity: { ...accessoryIpr().identity, productCode: mkField("AKP-BLM-35751P") }, variantOfCode: "AKP-CHR-35751P" };
    const paired = new Map([[identityKey(base), "https://res.cloudinary.com/x/AKPCHR35751P.jpg"]]);
    expect(mediaUrlFor(variant, paired)).toBe("https://res.cloudinary.com/x/AKPCHR35751P.jpg");
  });
});

/* ─────────── Stage 8 — deterministic fact-check ─────────── */
describe("Stage 8 fact-check (D3 §6.4)", () => {
  const ipr = accessoryIpr();

  it("passes copy that only asserts extracted facts", () => {
    const ok = factCheck("The Jaquar Toilet Roll Holder measures 180 x 65 x 95mm in polished Chrome, backed by a 10 years warranty.", ipr);
    expect(ok.ok).toBe(true);
  });

  it("rejects invented numbers", () => {
    const bad = factCheck("Rated for 5000 uses with 25mm mounting screws.", ipr);
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.includes("5000"))).toBe(true);
  });

  it("rejects other brands and unextracted standards", () => {
    const bad = factCheck("Bosch quality, certified to EN 14688.", ipr);
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.toLowerCase().includes("bosch"))).toBe(true);
    expect(bad.violations.some((v) => v.includes("EN 14688"))).toBe(true);
  });
});

/* ─────────── Stage 9 — gate dispositions ─────────── */
describe("Stage 9 gate (D17-aware)", () => {
  it("complete accessory → TODO (price missing, D4), basin-only columns exempt", async () => {
    const schema = await readTemplateSchema(TEMPLATE);
    const { row, profile, dropdownFlags } = mapIprToRow(accessoryIpr(), schema);
    const gate = gateRow({ ipr: accessoryIpr(), row, schema, profile, dropdownFlags: [] });
    expect(gate.disposition).toBe("TODO");
    expect(gate.exemptions).toContain("Shape");
  });

  it("low-confidence field → REVIEW", async () => {
    const schema = await readTemplateSchema(TEMPLATE);
    const ipr = accessoryIpr(0.5);
    const { row, profile } = mapIprToRow(ipr, schema);
    const gate = gateRow({ ipr, row, schema, profile, dropdownFlags: [] });
    expect(gate.disposition).toBe("REVIEW");
  });

  it("failed fact-check → REVIEW", async () => {
    const schema = await readTemplateSchema(TEMPLATE);
    const ipr = accessoryIpr();
    const { row, profile } = mapIprToRow(ipr, schema);
    const gate = gateRow({ ipr, row, schema, profile, dropdownFlags: [], factChecked: false });
    expect(gate.disposition).toBe("REVIEW");
  });
});

/* ─────────── D16 — URL ingestion plumbing ─────────── */
describe("D16 URL ingestion", () => {
  it("classifies fetched content by type", () => {
    expect(classifyFetched("application/pdf", "/cat.pdf")).toEqual({ ext: ".pdf", kind: "file" });
    expect(classifyFetched("text/html; charset=utf-8", "/products/basins")).toEqual({ ext: ".html", kind: "page" });
    expect(classifyFetched("image/jpeg", "/img")).toEqual({ ext: ".jpg", kind: "file" });
    expect(classifyFetched("", "/files/list.xlsx").ext).toBe(".xlsx");
  });

  it("strips HTML to readable text", () => {
    const text = htmlToText("<div><h1>Basin X100</h1><script>evil()</script><p>Price: <b>₦25,000</b></p></div>");
    expect(text).toContain("Basin X100");
    expect(text).toContain("₦25,000");
    expect(text).not.toContain("evil");
  });

  it("refuses non-http and private-address URLs", async () => {
    await expect(assertSafeUrl("ftp://x.com/a")).rejects.toThrow(/http/);
    await expect(assertSafeUrl("http://127.0.0.1/admin")).rejects.toThrow(/private/);
    await expect(assertSafeUrl("http://192.168.1.10/x")).rejects.toThrow(/private/);
  });
});
