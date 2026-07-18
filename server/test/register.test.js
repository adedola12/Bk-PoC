import { describe, it, expect } from "vitest";
import { buildRegister, buildCrosswalk, issueId, TAXONOMY_TREE } from "../taxonomy/index.js";

describe("D9 ID register", () => {
  it("issues cat_ + 21-char ids in BK's observed format", () => {
    const id = issueId();
    expect(id).toMatch(/^cat_[0-9A-Za-z_-]{21}$/);
  });

  it("flattens all 10 trades with unique paths and ids", () => {
    const rows = buildRegister();
    expect(rows.filter((r) => r.depth === 0)).toHaveLength(10);
    const paths = new Set(rows.map((r) => r.path));
    const ids = new Set(rows.map((r) => r.adlmId));
    expect(paths.size).toBe(rows.length);
    expect(ids.size).toBe(rows.length);
  });

  it("crosswalks all four confirmed BK ids onto existing nodes (A7-safe)", () => {
    const rows = buildRegister(TAXONOMY_TREE);
    const xwalk = buildCrosswalk(rows);
    expect(xwalk).toHaveLength(4);
    expect(xwalk.every((x) => x.provenance === "bk_confirmed")).toBe(true);
    const productType = xwalk.find((x) => x.level === "product_type");
    expect(productType.nodePath.endsWith("> Countertop")).toBe(true);
  });
});
