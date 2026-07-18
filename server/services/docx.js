import mammoth from "mammoth";

/** Raw text from a .docx (Stage 0 sampling; Milestone B vendor-form parse). */
export async function extractDocxText(filePath) {
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value || "";
}
