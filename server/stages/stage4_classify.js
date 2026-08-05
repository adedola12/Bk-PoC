import { TAXONOMY_TREE } from "../taxonomy/index.js";
import { callClaudeJSON, aiAvailable } from "../services/anthropic.js";

/**
 * Stage 4 — Taxonomy classification (D1): three methods in cost order —
 * deterministic source-section rules → lexical/fuzzy → semantic. Method
 * agreement raises confidence; disagreement routes to review; unmapped BK IDs
 * are flagged, never guessed (A7 protection).
 *
 * PoC note (for ratification, see DECISIONS D15 candidate): the "embeddings"
 * method runs as Claude semantic matching — the D8 stack is Anthropic-only
 * and ships no embeddings endpoint; a local sentence-embedding model is the
 * productionization path.
 *
 * Precedence when methods disagree (D14 candidate, applied here):
 * deterministic > lexical > semantic for the label — EXCEPT when the two
 * lower-cost methods agree against the third, their node wins. Confidence:
 * all agree 0.95 · two agree 0.8 · lexical only 0.7 · semantic only 0.6 ·
 * unresolved conflict 0.4 + REVIEW flag.
 */

/** Leaf-ish nodes with their match vocabulary, flattened once. */
function buildVocab(tree = TAXONOMY_TREE) {
  const nodes = [];
  const walk = (list, parentPath) => {
    for (const n of list) {
      const path = parentPath ? `${parentPath} > ${n.name}` : n.name;
      nodes.push({ path, name: n.name, keywords: n.keywords || [], isLeaf: !n.children?.length });
      if (n.children?.length) walk(n.children, path);
    }
  };
  walk(tree, null);
  return nodes;
}
const VOCAB = buildVocab();

/** Method 1 — deterministic: the source declared its own section (Bosch case). */
export function classifyDeterministic(sourceSection) {
  if (!sourceSection) return null;
  const s = sourceSection.trim().toLowerCase();
  const hit = VOCAB.find((n) => n.name.toLowerCase() === s || n.path.toLowerCase().endsWith(`> ${s}`));
  return hit ? { path: hit.path, method: "deterministic" } : null;
}

/** Method 2 — lexical/fuzzy: token overlap between IPR text and node vocabulary. */
export function classifyLexical(iprText) {
  const text = iprText.toLowerCase();
  let best = null;
  for (const node of VOCAB) {
    let score = 0;
    for (const kw of node.keywords) {
      if (text.includes(kw.toLowerCase())) score += kw.split(/\s+/).length * 2; // phrase hits weigh more
    }
    const nameTokens = node.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    score += nameTokens.filter((t) => text.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { path: node.path, score, method: "lexical" };
  }
  return best;
}

/** Method 3 — semantic (Claude): pick from candidate nodes. */
async function classifySemantic(iprText, log) {
  if (!aiAvailable()) return null;
  const leafPaths = VOCAB.filter((n) => n.isLeaf || n.keywords.length).map((n) => n.path);
  const json = await callClaudeJSON({
    system: `You classify construction-materials products into a trade taxonomy.
Pick the SINGLE best node path from the provided list. Never invent a path.
Return JSON: {"path": "<exactly one path from the list>", "confidence": 0..1}`,
    messages: [
      {
        role: "user",
        content: `Product:\n${iprText.slice(0, 1500)}\n\nTaxonomy nodes:\n${leafPaths.join("\n")}`,
      },
    ],
    maxTokens: 300,
    log,
    tag: "classify:semantic",
  });
  return leafPaths.includes(json.path) ? { path: json.path, method: "semantic", modelConfidence: json.confidence } : null;
}

/** IPR → text summary the classifiers read. */
export function iprToText(ipr) {
  const parts = [];
  const push = (f) => f?.value != null && parts.push(Array.isArray(f.value) ? f.value.join(" ") : String(f.value));
  push(ipr.identity?.name);
  push(ipr.identity?.brand);
  push(ipr.identity?.productCode);
  const attrs = ipr.attributes instanceof Map ? Object.fromEntries(ipr.attributes) : ipr.attributes || {};
  push(attrs.features);
  push(attrs.material);
  return parts.join(" · ");
}

/**
 * Classify one IPR. Mutates: taxonomyPath, taxonomyConfidence, flags.
 * @param {object} ipr
 * @param {{sourceSection?:string, useSemantic?:boolean, log?:Function}} opts
 */
export async function classifyIpr(ipr, { sourceSection = null, useSemantic = true, log } = {}) {
  const text = iprToText(ipr);
  const det = classifyDeterministic(sourceSection);
  const lex = classifyLexical(text);
  const sem = useSemantic ? await classifySemantic(text, log) : null;

  const votes = [det, lex, sem].filter(Boolean);
  if (!votes.length) {
    ipr.flags = ipr.flags || [];
    ipr.flags.push({ field: "taxonomy", reason: "unmapped_taxonomy", detail: "no method produced a node" });
    return { path: null, confidence: 0, methods: {} };
  }

  const byPath = new Map();
  for (const v of votes) byPath.set(v.path, (byPath.get(v.path) || 0) + 1);
  const agreeMax = Math.max(...byPath.values());

  let winner;
  let confidence;
  if (agreeMax === votes.length) {
    winner = votes[0].path;
    confidence = votes.length >= 2 ? 0.95 : votes[0].method === "lexical" ? 0.7 : votes[0].method === "semantic" ? 0.6 : 0.9;
  } else if (agreeMax >= 2) {
    winner = [...byPath.entries()].find(([, n]) => n === agreeMax)[0]; // two agree against one
    confidence = 0.8;
    ipr.flags = ipr.flags || [];
    ipr.flags.push({ field: "taxonomy", reason: "anomaly_rule", detail: `method disagreement — majority ${winner}` });
  } else {
    // full conflict: precedence deterministic > lexical > semantic, low confidence + review
    winner = (det || lex || sem).path;
    confidence = 0.4;
    ipr.flags = ipr.flags || [];
    ipr.flags.push({
      field: "taxonomy",
      reason: "unmapped_taxonomy",
      detail: `methods conflict: det=${det?.path ?? "—"} lex=${lex?.path ?? "—"} sem=${sem?.path ?? "—"}`,
    });
  }

  ipr.taxonomyPath = winner;
  ipr.taxonomyConfidence = confidence;
  return { path: winner, confidence, methods: { deterministic: det?.path ?? null, lexical: lex?.path ?? null, semantic: sem?.path ?? null } };
}
