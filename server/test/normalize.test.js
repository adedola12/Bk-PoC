import { describe, it, expect } from "vitest";
import {
  parseLocaleNumber,
  parseNumberOrRange,
  parsePackQty,
  toMm,
  toKg,
  checkSanity,
} from "../services/normalize.js";
import { findDuplicateCodes, unitMatchesLabel } from "../services/validators.js";

describe("locale-aware numeric parsing (A5)", () => {
  it("parses EU decimal commas", () => {
    expect(parseLocaleNumber("13,45")).toBe(13.45);
    expect(parseLocaleNumber("1.234,5")).toBe(1234.5);
    expect(parseLocaleNumber("1,234.5")).toBe(1234.5);
    expect(parseLocaleNumber("550")).toBe(550);
  });

  it("preserves ranges as ranges (§3)", () => {
    expect(parseNumberOrRange("0,05-1,0 MPa")).toEqual({ kind: "range", min: 0.05, max: 1 });
    expect(parseNumberOrRange("600")).toEqual({ kind: "number", value: 600 });
  });

  it("parses Alca pack quantities", () => {
    expect(parsePackQty("1 | 20 pcs")).toEqual({ unit: 1, carton: 20 });
  });

  it("canonicalizes units", () => {
    expect(toMm(55, "cm")).toBe(550);
    expect(toKg(13450, "g")).toBe(13.45);
  });
});

describe("sanity rules (A1/A2 classes)", () => {
  it("flags implausible values without fixing them", () => {
    expect(checkSanity("ratedPowerW", 8600).ok).toBe(false); // the scrambled QRG value
    expect(checkSanity("ratedPowerW", 2700).ok).toBe(true); // plausible as W — unit rule catches the V case
    expect(checkSanity("weightKg", 13.45).ok).toBe(true);
  });

  it("catches power specs in volts (A1)", () => {
    expect(unitMatchesLabel("ratedPower", "V")).toBe(false);
    expect(unitMatchesLabel("ratedPower", "W")).toBe(true);
  });
});

describe("duplicate part numbers (A3)", () => {
  it("finds one code on multiple products", () => {
    const dups = findDuplicateCodes([
      { productCode: "0601513000" },
      { productCode: "GWS-14" },
      { productCode: "0601513000" },
    ]);
    expect(dups).toHaveLength(1);
    expect(dups[0].indexes).toEqual([0, 2]);
  });
});
