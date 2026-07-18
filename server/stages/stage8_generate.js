import { callClaudeJSON } from "../services/anthropic.js";

/**
 * Stage 8 — Content generation (D3): ~100–130-word description + 8–9 tags in
 * the Twyford golden-example house style. HARD RULE (§6.4): generated copy
 * may only assert facts present in the IPR. A deterministic post-generation
 * fact-check verifies every number and load-bearing claim; failure →
 * regenerate once → still failing → REVIEW flag. Every regeneration is logged.
 */

const SYSTEM = (styleExamples) => `You write marketplace product descriptions for a construction-materials marketplace.
House style (learn from these golden examples):
---
${styleExamples.join("\n---\n")}
---
Style rules: ~100–130 words; varied technical opening (never reuse an opening); benefit framing; restate exact specs; reference standards/certifications ONLY if provided; close with brand heritage/warranty ONLY if provided.
ABSOLUTE RULE: assert ONLY facts present in the provided product data. No invented specs, standards, warranties, materials or capabilities. Preserve manufacturer terminology verbatim.
Also produce 8–9 lowercase tags: comma-free keyword phrases mixing brand, collection, dimension, attribute and category terms.
Return JSON: {"description": "...", "tags": ["...", ...]}`;

/** IPR → the fact sheet the generator is allowed to use. */
export function factSheet(ipr) {
  const facts = {};
  const push = (k, f) => {
    if (f?.value != null) facts[k] = { value: f.value, unit: f.unit ?? null, raw: f.raw ?? null };
  };
  for (const [k, f] of Object.entries(ipr.identity || {})) push(k, f);
  for (const group of ["attributes", "logistics", "compliance"]) {
    const entries = ipr[group] instanceof Map ? [...ipr[group].entries()] : Object.entries(ipr[group] || {});
    for (const [k, f] of entries) push(k, f);
  }
  return facts;
}

/**
 * Deterministic fact-check: every number in the copy must trace to an IPR
 * value/raw (mm/kg units normalized); brand mentions must match the canonical
 * brand or recorded lineage; EN/WRAS-style standard references must exist in
 * the IPR compliance fields.
 * @returns {{ok: boolean, violations: string[]}}
 */
export function factCheck(description, ipr) {
  const facts = factSheet(ipr);
  const violations = [];

  const factNumbers = new Set();
  const addNums = (s) => {
    for (const m of String(s).matchAll(/\d[\d.,]*/g)) {
      const n = m[0].replace(/,/g, "");
      factNumbers.add(n);
      factNumbers.add(String(Number(n))); // "550.0" ↔ "550"
      if (Number(n) > 0) {
        factNumbers.add(String(Number(n) / 10)); // cm ↔ mm drift
        factNumbers.add(String(Number(n) * 10));
      }
    }
  };
  for (const f of Object.values(facts)) {
    addNums(f.value);
    if (f.raw) addNums(f.raw);
    if (Array.isArray(f.value)) f.value.forEach(addNums);
  }

  for (const m of String(description).matchAll(/\d[\d.,]*/g)) {
    const n = m[0].replace(/,/g, "");
    if (!factNumbers.has(n) && !factNumbers.has(String(Number(n)))) {
      violations.push(`number "${m[0]}" not present in extracted data`);
    }
  }

  const brand = facts.brand?.value;
  if (brand) {
    const brandRe = /\b(Twyford|Jaquar|Jaguar|Artize|Bosch|Alcadrain|Geberit)\b/gi;
    for (const m of String(description).matchAll(brandRe)) {
      const mentioned = m[0].toLowerCase();
      const allowed = [brand, facts.subBrand?.value, "jaquar"].filter(Boolean).map((b) => String(b).toLowerCase());
      if (!allowed.includes(mentioned)) violations.push(`brand "${m[0]}" is not this product's brand`);
    }
  }

  const complianceText = ["norms", "certifications", "warranty"]
    .map((k) => JSON.stringify(facts[k] ?? ""))
    .join(" ")
    .toLowerCase();
  for (const m of String(description).matchAll(/\b(EN\s?\d{3,5}|BS\s?EN\s?\d{3,5}|WRAS|ISO\s?\d{3,5})\b/gi)) {
    const norm = m[0].replace(/\s+/g, " ").toLowerCase();
    if (!complianceText.includes(norm.replace(/\s/g, " ")) && !complianceText.includes(norm.replace(/\s/g, ""))) {
      violations.push(`standard "${m[0]}" not present in extracted compliance data`);
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Generate description + tags for one IPR with the fact-check/regenerate loop.
 * @returns {Promise<{description:string, tags:string[], factChecked:boolean,
 *   regenerated:boolean, violations:string[]}>}
 */
export async function generateContent(ipr, styleExamples, { log } = {}) {
  const facts = factSheet(ipr);
  const ask = (note = "") =>
    callClaudeJSON({
      system: SYSTEM(styleExamples),
      messages: [
        {
          role: "user",
          content: `Product data (the ONLY permissible facts):\n${JSON.stringify(facts, null, 1)}\n${note}`,
        },
      ],
      maxTokens: 900,
      log,
      tag: `generate:${ipr.identity?.productCode?.value ?? "?"}`,
    });

  let out = await ask();
  let check = factCheck(out.description || "", ipr);
  let regenerated = false;

  if (!check.ok) {
    regenerated = true;
    log?.({ kind: "regeneration", sku: ipr.identity?.productCode?.value, violations: check.violations });
    out = await ask(
      `\nYour previous draft failed fact-checking: ${check.violations.join("; ")}. Rewrite using ONLY the facts above.`
    );
    check = factCheck(out.description || "", ipr);
  }

  const tags = (out.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 9);
  return {
    description: out.description || "",
    tags,
    factChecked: check.ok,
    regenerated,
    violations: check.violations,
  };
}
