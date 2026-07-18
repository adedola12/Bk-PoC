import { describe, it, expect } from "vitest";
import { injectErrors, detectAnomalies } from "../eval/injector.js";

const mkIpr = (code, dims = [550, 440, 825], weightKg = 12) => ({
  identity: { productCode: { value: code, raw: code, confidence: 1, method: "text" } },
  attributes: {
    dimensions1: { value: dims[0], unit: "mm", raw: String(dims[0]), confidence: 0.9, method: "text" },
    dimensions2: { value: dims[1], unit: "mm", raw: String(dims[1]), confidence: 0.9, method: "text" },
    dimensions3: { value: dims[2], unit: "mm", raw: String(dims[2]), confidence: 0.9, method: "text" },
  },
  logistics: { weightKg: { value: weightKg, unit: "kg", raw: `${weightKg} kg`, confidence: 0.9, method: "text" } },
  compliance: {},
});

describe("T4 anomaly injector (Milestone B build, D wiring)", () => {
  const fleet = [mkIpr("AAA-1"), mkIpr("BBB-2"), mkIpr("CCC-3"), mkIpr("DDD-4")];

  it("is seeded-deterministic", () => {
    const a = injectErrors(fleet, { count: 5, seed: 42 });
    const b = injectErrors(fleet, { count: 5, seed: 42 });
    expect(a.injected).toEqual(b.injected);
    expect(a.injected).toHaveLength(5);
  });

  it("never mutates the input records", () => {
    const before = JSON.stringify(fleet);
    injectErrors(fleet, { count: 5, seed: 7 });
    expect(JSON.stringify(fleet)).toBe(before);
  });

  it("different seeds give different error sets", () => {
    const a = injectErrors(fleet, { count: 5, seed: 1 });
    const b = injectErrors(fleet, { count: 5, seed: 2 });
    expect(JSON.stringify(a.injected)).not.toBe(JSON.stringify(b.injected));
  });

  it("detectAnomalies catches injected duplicate codes and wrong units", () => {
    const { mutated, injected } = injectErrors(fleet, { count: 8, seed: 42 });
    const caught = detectAnomalies(mutated);
    const dupInjected = injected.some((i) => i.type === "duplicate_code");
    const unitInjected = injected.some((i) => i.type === "wrong_unit");
    if (dupInjected) expect(caught.some((c) => c.type === "duplicate_code")).toBe(true);
    if (unitInjected) expect(caught.some((c) => c.type === "wrong_unit")).toBe(true);
  });
});
