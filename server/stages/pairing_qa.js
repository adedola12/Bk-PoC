import { extractTextPositions } from "../services/pdf.js";

/**
 * Label-value pairing QA (Design Doc §3 Stage 1) — the cheap self-check that
 * decides PER PAGE whether linear text extraction is trustworthy or vision
 * extraction is required. Verified failure case: the Bosch QRG's ultra-wide
 * multi-panel pages scramble label-value adjacency in linear reading order
 * (anomalies A1–A3 all stem from this).
 *
 * Signals, all deterministic and LLM-free:
 * 1. Geometry: pages much wider than tall (multi-panel layouts) are suspect.
 * 2. Pairing distance: for sampled "<number> <unit>" value tokens, measure the
 *    spatial distance to the text item that PRECEDES them in linear order.
 *    In a sane single-column page those are near-neighbours; when linear
 *    order interleaves panels, consecutive items sit far apart on the page.
 * 3. Scramble score: fraction of consecutive item pairs with large backwards
 *    jumps in reading order.
 */

/** number (optionally range) with an optional unit, e.g. "2700 W", "6,500 – 6,500 rpm", "3.2 J" */
const VALUE_TOKEN = /^[~≤≥]?\d[\d.,\s]*(?:[-–—]\s*[\d.,]+)?\s*(w|v|kg|g|mm|cm|m|j|nm|min-1|rpm|bpm|l|ah|hz|db)?\.?$/i;
/** label-ish: mostly letters ("Rated input power", "Impact energy") */
const LABEL_TOKEN = /^[a-z][a-z\s/()&-]{3,}$/i;

/**
 * Verified failure signature (QRG, anomalies A1–A3): spec tables emit as a
 * RUN of label items followed by a RUN of value items — linear adjacency then
 * pairs "Disc diameter" with "2700 V". Healthy key-value sheets interleave
 * label, value, label, value → value runs of length 1–2.
 */
export function scorePagePairing(page) {
  const { items, width, height } = page;
  const ultraWide = width > height * 1.4 || width > 1200;

  const kinds = items.map(({ str }) => {
    const s = str.trim();
    if (VALUE_TOKEN.test(s)) return "value";
    if (LABEL_TOKEN.test(s)) return "label";
    return "other";
  });

  let valueCount = 0;
  let inLongRun = 0;
  const runs = [];
  let run = 0;
  for (const kind of kinds) {
    if (kind === "value") {
      run++;
      valueCount++;
    } else if (kind === "other") {
      continue; // page furniture doesn't break a spec run
    } else {
      if (run > 0) runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  for (const r of runs) if (r >= 3) inLongRun += r;

  const meanValueRun = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 0;
  const longRunShare = valueCount ? inLongRun / valueCount : 0;

  const trustText = !(ultraWide && (meanValueRun > 2.2 || longRunShare > 0.35));
  return {
    page: page.page,
    width: Math.round(width),
    height: Math.round(height),
    ultraWide,
    valueCount,
    meanValueRun: +meanValueRun.toFixed(2),
    longRunShare: +longRunShare.toFixed(2),
    trustText,
  };
}

/** @returns {Promise<{pages: Array, anyVisionNeeded: boolean}>} */
export async function pairingQa(filePath, { only = null } = {}) {
  const { pages } = await extractTextPositions(filePath, { only });
  const scored = pages.map(scorePagePairing);
  return { pages: scored, anyVisionNeeded: scored.some((p) => !p.trustText) };
}
