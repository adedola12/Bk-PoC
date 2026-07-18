import mongoose from "mongoose";
import { TaxonomyNode } from "../models/TaxonomyNode.js";
import { IdCrosswalk } from "../models/IdCrosswalk.js";

/**
 * D9 — resolve a taxonomy path to IDs with provenance. ADLM IDs are never
 * presented as BK's; missing BK IDs are flagged (bk_id_pending), NEVER guessed
 * (A7 protection).
 */
export async function resolveTaxonomyIds(taxonomyPath) {
  if (!taxonomyPath || mongoose.connection.readyState !== 1) {
    return { adlmId: null, bkId: null, provenance: null, pending: Boolean(taxonomyPath) };
  }
  const node = await TaxonomyNode.findOne({ path: taxonomyPath }).lean();
  if (!node) return { adlmId: null, bkId: null, provenance: null, pending: true };

  const xwalk = await IdCrosswalk.findOne({ nodePath: taxonomyPath }).lean();
  return {
    adlmId: node.adlmId,
    bkId: xwalk?.bkId ?? null,
    provenance: xwalk?.bkId ? "bk_confirmed" : "adlm_registry",
    pending: !xwalk?.bkId,
  };
}
