import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBkTemplateSignature } from "../services/xlsx.js";
import { extractText } from "../services/pdf.js";
import { triageFile } from "../stages/stage0_triage.js";
import { TRIAGE_GROUND_TRUTH } from "../eval/groundTruth.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const fx = (name) => path.join(FIXTURES, name);

/** Structural (rule-tier) coverage — no API key required. */
describe("D12 bk_template signature", () => {
  it("detects the blank BK template (3-sheet set)", async () => {
    const sig = await detectBkTemplateSignature(fx("catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx"));
    expect(sig.isTemplate).toBe(true);
    expect(sig.kind).toBe("blank");
  });

  it("detects the filled Twyford golden file (Template sheet only)", async () => {
    const sig = await detectBkTemplateSignature(fx("01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx"));
    expect(sig.isTemplate).toBe(true);
    expect(sig.kind).toBe("filled");
  });
});

describe("pdf service", () => {
  it("reads page count and native text from a clean datasheet", async () => {
    const { pageCount, pages } = await extractText(fx("Alca_Drain__AM101_.pdf"), { maxPages: 1 });
    expect(pageCount).toBeGreaterThanOrEqual(1);
    expect(pages[0].text.length).toBeGreaterThan(100);
  });

  it("extracts a single selected page cheaply from the 104-pp handbook", async () => {
    const { pageCount, pages } = await extractText(fx("HD_BOOKET.pdf"), { only: [52] });
    expect(pageCount).toBe(104);
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(52);
  });
});

describe("rule-tier triage (no API key needed)", () => {
  it("routes both xlsx fixtures to bk_template", async () => {
    for (const name of TRIAGE_GROUND_TRUTH.filter((g) => g.label === "bk_template").map((g) => g.file)) {
      const t = await triageFile(fx(name));
      expect(t.label).toBe("bk_template");
      expect(t.method).toBe("rule");
      expect(t.needsVerification).toBe(false);
    }
  });

  it("routes both JPGs to product_image", async () => {
    for (const name of TRIAGE_GROUND_TRUTH.filter((g) => g.label === "product_image").map((g) => g.file)) {
      const t = await triageFile(fx(name));
      expect(t.label).toBe("product_image");
      expect(t.method).toBe("rule");
    }
  });
});
