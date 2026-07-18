import ExcelJS from "exceljs";

/**
 * Workbook inspection for Stage 0 (D12 bk_template signature) — read-only.
 * The template's own content is the contract (D6); nothing here hardcodes
 * the schema beyond the minimal signature needed to RECOGNIZE a BK template.
 */

const BK_SHEET_SET = ["Template", "Lookup", "Instructions"];
// Minimal, stable header anchor: columns any BK template carries (KB §3).
const BK_HEADER_ANCHORS = ["Brand", "Unique Product Name", "Collection", "Color", "Tags"];

/** Cell value → plain string (handles richText, formula results, hyperlinks). */
const cellText = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
  }
  return String(v);
};

/** Header cell → canonical column name: trim + strip required/optional markers. */
const normalizeHeader = (s) =>
  cellText(s)
    .replace(/\s*\((opt|cond)\)\s*$/i, "")
    .replace(/\s*\*+\s*$/, "")
    .trim();

export async function readWorkbookMeta(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheets = wb.worksheets.map((ws) => ws.name);
  const meta = { sheets, headerRows: {} };
  for (const ws of wb.worksheets) {
    // Header row = the row (of the first 10) whose normalized cells hit the
    // most BK anchors; falls back to the first row with ≥5 distinct strings
    // (BK templates put a merged section band ABOVE the real header row).
    let best = null;
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const values = ws.getRow(r).values.map(normalizeHeader).filter(Boolean);
      if (!values.length) continue;
      const distinct = new Set(values.map((v) => v.toLowerCase()));
      const anchorHits = BK_HEADER_ANCHORS.filter((a) => distinct.has(a.toLowerCase())).length;
      const candidate = { row: r, values, anchorHits, distinctCount: distinct.size };
      if (!best || candidate.anchorHits > best.anchorHits) best = candidate;
    }
    if (best && (best.anchorHits > 0 || best.distinctCount >= 5)) meta.headerRows[ws.name] = best;
  }
  return meta;
}

/**
 * D12 — deterministic BK-template signature: full 3-sheet set (blank template)
 * OR a Template sheet whose header row contains the anchor columns (filled
 * template like the Twyford golden file, which ships Template-sheet-only).
 * @returns {Promise<{isTemplate: boolean, kind: "blank"|"filled"|null, evidence: string}>}
 */
export async function detectBkTemplateSignature(filePath) {
  const meta = await readWorkbookMeta(filePath);
  const hasSheetSet = BK_SHEET_SET.every((s) => meta.sheets.includes(s));
  const header = meta.headerRows["Template"];
  const headerMatch = (header?.anchorHits ?? 0) >= 3;

  if (hasSheetSet && headerMatch)
    return {
      isTemplate: true,
      kind: "blank",
      evidence: `sheets ${meta.sheets.join("/")} + ${header.anchorHits} header anchors (row ${header.row})`,
    };
  if (headerMatch)
    return {
      isTemplate: true,
      kind: "filled",
      evidence: `Template header row ${header.row} with ${header.anchorHits} anchors`,
    };
  return { isTemplate: false, kind: null, evidence: `sheets ${meta.sheets.join("/")}` };
}
