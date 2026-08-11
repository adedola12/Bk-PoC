import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlacedImages, extractTextPositions } from "../services/pdf.js";
import { planImageAssignments, norm } from "../stages/media_from_pdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (f) => path.resolve(__dirname, "../../fixtures", f);

/**
 * The client's complaint, as a test: "It's one image for all, right?"
 *
 * Every product on a page used to take the same photo, because images were
 * matched to products by PAGE NUMBER. On a datasheet that is invisible — one
 * product, one page — so the whole suite passed while a 99-product catalogue
 * emitted the same picture ninety-nine times. These tests put more than one
 * product on a page, which is the only condition under which the bug exists.
 */
describe("product images are matched by position, not by page", () => {
  it("locates images on the page, in the same frame as the text", async () => {
    const images = await extractPlacedImages(fixture("Alca_Drain__AM101_.pdf"));
    expect(images.length).toBeGreaterThan(0);

    const placed = images.filter((i) => i.inBounds);
    expect(placed.length).toBeGreaterThan(0);

    const { pages } = await extractTextPositions(fixture("Alca_Drain__AM101_.pdf"), { only: [1] });
    const page = pages.find((p) => p.page === 1);
    for (const im of placed) {
      // a located image sits within the page it was drawn on
      expect(im.x).toBeGreaterThanOrEqual(-5);
      expect(im.y).toBeGreaterThanOrEqual(-5);
      expect(im.x + im.w).toBeLessThanOrEqual(page.width + 5);
      expect(im.y + im.h).toBeLessThanOrEqual(page.height + 5);
    }
  }, 60_000);

  it("an image whose position cannot be trusted is kept, not discarded", async () => {
    // Print artwork parks variants and bleed off the page — Bosch draws images
    // at x=3970 on a 2381-wide sheet. Their rects are unusable but the images
    // must still reach the ranking fallback; dropping them cost 37 of 47.
    const images = await extractPlacedImages(fixture("Revised_Quick_Refrence_Guide.pdf"));
    expect(images.length).toBeGreaterThan(20);
    expect(images.some((i) => i.inBounds === false)).toBe(true);
    expect(images.some((i) => i.inBounds === true)).toBe(true);
  }, 120_000);

  it("finds the per-card thumbnails, which the source-pixel gate hides", async () => {
    // The card thumbnails are ~2-5k source pixels, so the 30000 gate that
    // stops a logo winning "biggest image on the page" discarded precisely the
    // images the client asked for. Position, not size, is what identifies them.
    const file = fixture("Revised_Quick_Refrence_Guide.pdf");
    const strict = (await extractPlacedImages(file)).filter((i) => i.inBounds);
    const loose = (await extractPlacedImages(file, { minArea: 2000, minPlacedArea: 400 })).filter((i) => i.inBounds);
    expect(loose.length).toBeGreaterThan(strict.length * 3);
    expect(loose.some((i) => i.width * i.height < 30000)).toBe(true);
  }, 180_000);

  it("gives two products on the SAME page different images", async () => {
    const file = fixture("Revised_Quick_Refrence_Guide.pdf");
    const images = (await extractPlacedImages(file)).filter((i) => i.inBounds);
    const byPage = new Map();
    for (const i of images) {
      if (!byPage.has(i.page)) byPage.set(i.page, []);
      byPage.get(i.page).push(i);
    }
    const { pages } = await extractTextPositions(file, { only: [...byPage.keys()] });
    const anchorsByPage = new Map(
      pages.map((p) => [p.page, p.items.map((it) => ({ norm: norm(it.str), x: it.x, y: it.y })).filter((i) => i.norm)])
    );

    // two real Bosch codes printed far apart on the same sheet
    const codes = ["GSB 16 RE", "GWS 2200"];
    const iprs = codes.map((c) => ({
      identity: { productCode: { value: c, sourceRef: { page: 1 } } },
      attributes: {},
    }));
    const pageOf = (ipr) => ipr.identity.productCode.sourceRef.page;
    const anchorFor = (ipr, page) => {
      const items = anchorsByPage.get(page);
      if (!items?.length) return null;
      const key = norm(ipr.identity.productCode.value);
      let best = null;
      let bestLen = 0;
      for (const it of items) {
        const hit = it.norm.includes(key) ? key.length : key.includes(it.norm) ? it.norm.length : 0;
        if (hit > bestLen) {
          bestLen = hit;
          best = it;
        }
      }
      return bestLen >= 4 ? best : null;
    };

    const plan = await planImageAssignments({ iprs, byPage, anchorsByPage, pageOf, anchorFor });
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.viaAnchor)).toBe(true);
    // the regression: both products on one page taking the same photo
    expect(plan[0].image.name).not.toBe(plan[1].image.name);
  }, 120_000);
});
