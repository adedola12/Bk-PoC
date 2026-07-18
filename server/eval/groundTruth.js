/**
 * T1 triage ground truth for the 10 fixtures — ratified label set per D12
 * (docs/DECISIONS.md). `verifyPrompt` marks files that MUST surface the D11
 * verification prompt (T8).
 */
export const TRIAGE_GROUND_TRUTH = [
  { file: "catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx", label: "bk_template", verifyPrompt: false },
  { file: "01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx", label: "bk_template", verifyPrompt: false },
  { file: "Alca_Drain__AM101_.pdf", label: "product_datasheet", verifyPrompt: false },
  { file: "Toilet_Roll_Holder_Data_sheet.pdf", label: "product_datasheet", verifyPrompt: false },
  { file: "Towel_Rail_Holder_Data_Sheet.pdf", label: "product_datasheet", verifyPrompt: false },
  { file: "HD_BOOKET.pdf", label: "catalogue", verifyPrompt: false },
  { file: "Revised_Quick_Refrence_Guide.pdf", label: "catalogue", verifyPrompt: false },
  { file: "Jaguar_Toilet_Roll_Holder_Image.jpg", label: "product_image", verifyPrompt: false },
  { file: "Jaquar_Towel_Rail_Holder_Image.jpg", label: "product_image", verifyPrompt: false },
  { file: "SG_BK.docx", label: "vendor_document", verifyPrompt: true },
];
