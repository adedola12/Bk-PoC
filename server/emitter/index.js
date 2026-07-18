import ExcelJS from "exceljs";
import path from "node:path";
import { cellText, normalizeHeader } from "../services/xlsx.js";

/**
 * Template-driven emitter (D6). The BK template xlsx IS the output contract:
 * headers, required markers, dropdown lists and the Instructions sheet are
 * read from the workbook at runtime. NOTHING here hardcodes the schema.
 *
 * Known BK layout facts used for parsing (not schema): row 1 is a merged
 * section band, the header row carries `*` required markers, data follows
 * the header row.
 */

const FORMULA_COLUMNS = ["System Product Name"]; // Instructions: auto-fills — never write

/** Find the header row: first row whose cells contain a `*`-marked header, else densest row. */
function findHeaderRow(ws) {
  let best = null;
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => cells.push({ col, text: cellText(cell.value) }));
    const named = cells.filter((c) => c.text.trim());
    if (!named.length) continue;
    const distinct = new Set(named.map((c) => normalizeHeader(c.text).toLowerCase()));
    const hasRequiredMarkers = named.some((c) => /\*\s*$/.test(c.text.trim()));
    const score = distinct.size + (hasRequiredMarkers ? 100 : 0);
    if (!best || score > best.score) best = { row: r, cells: named, score, distinct: distinct.size };
  }
  return best && best.distinct >= 5 ? best : null;
}

/**
 * Read the template's own contract.
 * @returns {Promise<{templatePath, headerRow, columns, dropdowns, instructions, maxRows, sheets}>}
 * columns: [{ col, name, raw, required, formula }]
 */
export async function readTemplateSchema(templatePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const ws = wb.getWorksheet("Template");
  if (!ws) throw new Error(`${path.basename(templatePath)} has no Template sheet`);

  const header = findHeaderRow(ws);
  if (!header) throw new Error(`no header row found in ${path.basename(templatePath)}`);

  const columns = header.cells.map(({ col, text }) => {
    const name = normalizeHeader(text);
    return {
      col,
      name,
      raw: text,
      required: /\*\s*$/.test(text.trim()),
      formula: FORMULA_COLUMNS.includes(name),
    };
  });

  // Dropdowns from the Lookup sheet: header row 1, values below (KB §3)
  const dropdowns = {};
  const lookup = wb.getWorksheet("Lookup");
  if (lookup) {
    lookup.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      const key = normalizeHeader(cell.value);
      if (!key) return;
      const values = [];
      for (let r = 2; r <= lookup.rowCount; r++) {
        const v = cellText(lookup.getRow(r).getCell(col).value).trim();
        if (v) values.push(v);
      }
      if (values.length) dropdowns[key] = values;
    });
  }

  // Instructions sheet: raw lines + the row cap if stated
  const instructions = [];
  const instr = wb.getWorksheet("Instructions");
  if (instr) {
    instr.eachRow((row) => {
      const line = row.values
        .map((v) => cellText(v))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (line) instructions.push(line);
    });
  }
  const capMatch = instructions.join(" ").match(/max(?:imum)?\s+(?:of\s+)?(\d+)\s+products?/i);
  const maxRows = capMatch ? Number(capMatch[1]) : 500;

  return {
    templatePath,
    sheets: wb.worksheets.map((w) => w.name),
    headerRow: header.row,
    columns,
    dropdowns,
    instructions,
    maxRows,
  };
}

/** Read data rows from a (filled) template as objects keyed by canonical column name. */
export async function readDataRows(filePath) {
  const schema = await readTemplateSchema(filePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("Template");
  const rows = [];
  for (let r = schema.headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj = {};
    let hasValue = false;
    for (const c of schema.columns) {
      const text = cellText(row.getCell(c.col).value).trim();
      obj[c.name] = text;
      if (text) hasValue = true;
    }
    if (hasValue) rows.push({ row: r, values: obj });
  }
  return { schema, rows };
}

/**
 * Emit rows into a copy of the template (shape from the template file itself),
 * sharding at the template's own row cap. Formula columns are never written.
 * @param {string} templatePath
 * @param {Array<Object>} rows - objects keyed by canonical column name
 * @param {string} outPathBase - e.g. runs/x/out.xlsx → out.xlsx / out_2.xlsx …
 * @returns {Promise<string[]>} written file paths
 */
export async function emitRows(templatePath, rows, outPathBase) {
  const schema = await readTemplateSchema(templatePath);
  const shards = [];
  for (let i = 0; i < Math.max(1, Math.ceil(rows.length / schema.maxRows)); i++) {
    shards.push(rows.slice(i * schema.maxRows, (i + 1) * schema.maxRows));
  }

  const written = [];
  for (let s = 0; s < shards.length; s++) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath); // fresh copy — keeps styles, lookups, instructions
    const ws = wb.getWorksheet("Template");
    shards[s].forEach((rowObj, i) => {
      const row = ws.getRow(schema.headerRow + 1 + i);
      for (const c of schema.columns) {
        if (c.formula) continue; // Instructions: do not edit
        const v = rowObj[c.name];
        if (v !== undefined && v !== "") row.getCell(c.col).value = v;
      }
      row.commit();
    });
    const out =
      shards.length === 1 ? outPathBase : outPathBase.replace(/\.xlsx$/i, `_${s + 1}.xlsx`);
    await wb.xlsx.writeFile(out);
    written.push(out);
  }
  return written;
}

/**
 * Twyford short-circuit (Design Doc §3 Stage 1): a filled BK template is
 * parsed straight into IPR field maps — deterministic, confidence 1, method
 * "rule". Lossless by construction: every column round-trips via `templateRow`.
 */
export function templateRowsToIprs(rows, sourceFile) {
  return rows.map(({ row, values }) => ({
    identity: {
      brand: iprField(values["Brand"], row, sourceFile),
      productCode: iprField(values["Product SKU"], row, sourceFile),
      name: iprField(values["Unique Product Name"], row, sourceFile),
      collection: iprField(values["Collection"], row, sourceFile),
    },
    templateRow: values, // full column map — the lossless payload
    sourceRow: row,
  }));
}

export function iprsToTemplateRows(iprs) {
  return iprs.map((ipr) => ({ ...ipr.templateRow }));
}

function iprField(value, row, file) {
  const v = (value ?? "").trim();
  return {
    value: v || null,
    unit: null,
    raw: v || null,
    sourceRef: { file, page: null, region: `Template!row ${row}` },
    confidence: v ? 1 : 0,
    method: "rule",
  };
}
