// Client for the central ADLM AI Service (adlm-ai-service repo).
// Phase 6 wiring: BK-Ingest can route catalogue extraction + taxonomy mapping
// through POST /api/ai/catalogue/extract instead of calling Anthropic
// directly, so every call is metered, cached, quota'd and credit-guarded
// centrally.
//
// Env:
//   ADLM_AI_URL    e.g. https://xxxx.execute-api.us-east-1.amazonaws.com
//   ADLM_AI_TOKEN  licence JWT / access token for an account with the ai add-on
//
// Usage (from a stage or route):
//   import { aiCatalogueExtract, adlmAiEnabled } from "../services/adlmAi.js";
//   if (adlmAiEnabled()) {
//     const out = await aiCatalogueExtract({ pages, taxonomy, templateColumns });
//     // out.result.products → rows with taxonomyPath/templateRow/disposition
//   }
//
// Note: this is the integration seam, not a full pipeline replacement — the
// BK pipeline's IPR/gating stages still apply to the returned products.

const BASE = () => (process.env.ADLM_AI_URL || "").replace(/\/$/, "");

export function adlmAiEnabled() {
  return Boolean(process.env.ADLM_AI_URL && process.env.ADLM_AI_TOKEN);
}

export async function aiCatalogueExtract({ pages, taxonomy = [], templateColumns = [] }, { log } = {}) {
  if (!adlmAiEnabled()) throw new Error("ADLM_AI_URL / ADLM_AI_TOKEN not configured");
  const started = Date.now();
  const res = await fetch(`${BASE()}/api/ai/catalogue/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ADLM_AI_TOKEN}`,
      "x-adlm-product": "bk",
    },
    body: JSON.stringify({ pages, taxonomy, templateColumns }),
  });
  const body = await res.json().catch(() => ({}));
  log?.({
    kind: "adlm_ai_call",
    feature: "catalogueExtract",
    status: res.status,
    cached: body.cached ?? null,
    latencyMs: Date.now() - started,
  });
  if (res.status === 403) throw new Error("ADLM AI: add-on not active for this account");
  if (res.status === 503) throw new Error("ADLM AI: feature throttled by credit guard");
  if (!res.ok || body.ok === false) {
    throw new Error(`ADLM AI: ${body.code || res.status} ${body.message || ""}`.trim());
  }
  return body; // { ok, cached, result: { products, ... }, audit, disclaimer }
}
