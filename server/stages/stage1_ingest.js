import path from "node:path";
import { extractText, rasterizePages } from "../services/pdf.js";
import { extractDocxText } from "../services/docx.js";
import { detectBkTemplateSignature } from "../services/xlsx.js";
import { readDataRows } from "../emitter/index.js";

/**
 * Stage 1 — Ingestion (Design Doc §3): format-specific readers produce a
 * faithful raw representation. Vision fallback triggers (pairing QA / no
 * text layer) belong to the hostile path — Milestone D.
 *
 * @returns {Promise<
 *   | {kind:"template", filled:boolean, schema:object, rows:Array}
 *   | {kind:"pdf_text", pageCount:number, pages:Array<{page,text}>, raster:(pages:number[])=>Promise<Array>}
 *   | {kind:"docx_text", text:string}
 * >}
 */
export async function ingestFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".xlsx" || ext === ".xlsm") {
    const sig = await detectBkTemplateSignature(filePath);
    if (sig.isTemplate) {
      const { schema, rows } = await readDataRows(filePath);
      return { kind: "template", filled: rows.length > 0, schema, rows };
    }
    throw new Error("non-template spreadsheets are a Milestone D concern (catalogue-in-sheet)");
  }

  if (ext === ".pdf") {
    const { pageCount, pages } = await extractText(filePath);
    return {
      kind: "pdf_text",
      pageCount,
      pages,
      raster: (nums, opts) => rasterizePages(filePath, nums, opts),
    };
  }

  if (ext === ".docx") {
    return { kind: "docx_text", text: await extractDocxText(filePath) };
  }

  if (ext === ".html" || ext === ".htm") {
    // D16 — web page source: the page text is the document
    const fs = await import("node:fs");
    const { htmlToText } = await import("../services/weburl.js");
    return { kind: "html_text", text: htmlToText(fs.readFileSync(filePath, "utf8")) };
  }

  throw new Error(`no ingestion reader for ${ext}`);
}
