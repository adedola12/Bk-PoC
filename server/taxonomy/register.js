import { customAlphabet } from "nanoid";
import { TAXONOMY_TREE } from "./tree.js";

/**
 * D9 — ADLM category ID register.
 * IDs match BK's observed format: `cat_` + 21-char nanoid using the default
 * nanoid alphabet (observed BK IDs contain `-` and `_`, e.g.
 * cat_NMgutrpDUDaPfIxEbF7-h). Every issued ID carries provenance
 * `adlm_registry`; real BK IDs enter the crosswalk as `bk_confirmed`.
 * ADLM IDs are NEVER presented as BK's (D9).
 */
const nano = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  21
);

export const issueId = () => `cat_${nano()}`;

/**
 * Known BK IDs from the template Instructions sheet (KB §3). Bound to the
 * Countertop product-type chain ONLY — per anomaly A7 these must not be
 * reused for Pedestal basins.
 */
export const BK_CONFIRMED_IDS = [
  { path: "Plumbing & Sanitary Ware", bkId: "cat_NMgutrpDUDaPfIxEbF7-h", level: "category" },
  { path: "Plumbing & Sanitary Ware > Sanitary Ware", bkId: "cat_dW3w7W3KEg1nAX-W5wKD7", level: "subcategory" },
  { path: "Plumbing & Sanitary Ware > Sanitary Ware > Wash Basins & Pedestals", bkId: "cat_1wIX_oQ4kZiJ3zB-wpfoM", level: "sub_subcategory" },
  { path: "Plumbing & Sanitary Ware > Sanitary Ware > Wash Basins & Pedestals > Countertop", bkId: "cat_02b2Pq3Q9-Q74OTvotI52", level: "product_type" },
];

/**
 * Flatten the D1 tree into register rows: one node per row with a stable
 * path key, an issued ADLM ID, depth, parent path and keywords.
 * @returns {Array<{path:string,name:string,depth:number,parentPath:string|null,adlmId:string,keywords:string[]}>}
 */
export function buildRegister(tree = TAXONOMY_TREE) {
  const rows = [];
  const walk = (nodes, parentPath, depth) => {
    for (const node of nodes) {
      const path = parentPath ? `${parentPath} > ${node.name}` : node.name;
      rows.push({
        path,
        name: node.name,
        depth,
        parentPath: parentPath || null,
        adlmId: issueId(),
        keywords: node.keywords || [],
      });
      if (node.children?.length) walk(node.children, path, depth + 1);
    }
  };
  walk(tree, null, 0);
  return rows;
}

/** Crosswalk seed rows mapping ADLM register nodes to confirmed BK IDs. */
export function buildCrosswalk(registerRows) {
  const byPath = new Map(registerRows.map((r) => [r.path, r]));
  return BK_CONFIRMED_IDS.flatMap(({ path, bkId, level }) => {
    const node = byPath.get(path);
    if (!node) return []; // tree/register drift — caller should treat as a seed error
    return [{ nodePath: path, adlmId: node.adlmId, bkId, level, provenance: "bk_confirmed" }];
  });
}
