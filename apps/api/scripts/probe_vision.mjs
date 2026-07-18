import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { rasterizePages, extractText } from "../src/services/pdf.js";
import { callClaudeJSON, hasApiKey, MODEL } from "../src/services/anthropic.js";
import { createRun } from "../src/services/runs.js";

/**
 * Milestone A vision probe (council edit #1, amended §8) — THROWAWAY numbers
 * script, not pipeline code. Rasterizes a product-dense sample of the hostile
 * 104-pp Bosch handbook, runs one vision extraction pass per page, and
 * extrapolates cost + wall-clock to the full document against T7 (< 1 hr).
 */
if (!hasApiKey()) {
  console.error("ANTHROPIC_API_KEY not set in .env — probe needs it.");
  process.exit(1);
}

const HD = path.resolve(__dirname, "../../../fixtures/HD_BOOKET.pdf");
const PAGES = [20, 21, 22, 23, 24, 25, 26, 27]; // product-dense mid-section sample
const run = createRun("vision-probe");

console.log(`Vision probe on HD_BOOKET.pdf pages ${PAGES.join(",")} with ${MODEL}\n`);
const { pageCount } = await extractText(HD, { only: [1] });
const images = await rasterizePages(HD, PAGES, { scale: 2 });

const SYSTEM = `Extract every distinct product on this catalog page. Return JSON:
{"products":[{"name":"...","partNumber":"...","specs":{"<label>":"<value with unit>"},"confidence":0..1}],"pageHasProducts":true|false}`;

const results = [];
let totalCost = 0;
let totalMs = 0;

for (const { page, png } of images) {
  const started = Date.now();
  let entry;
  try {
    const json = await callClaudeJSON({
      system: SYSTEM,
      maxTokens: 3000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(png).toString("base64") } },
            { type: "text", text: `Catalog page ${page}. Extract all products.` },
          ],
        },
      ],
      log: (e) => {
        run.log(e);
        if (e.kind === "ai_call") {
          totalCost += e.costUsd;
          entry = { page, ms: e.latencyMs, costUsd: e.costUsd, usage: e.usage };
        }
      },
      tag: `probe:p${page}`,
    });
    entry.products = json.products?.length ?? 0;
  } catch (err) {
    entry = { page, error: err.message };
  }
  entry.wallMs = Date.now() - started;
  totalMs += entry.wallMs;
  results.push(entry);
  console.log(`p${page}: ${entry.products ?? "ERR"} products, ${entry.wallMs} ms, $${(entry.costUsd ?? 0).toFixed(4)}`);
}

const perPageMs = totalMs / results.length;
const perPageCost = totalCost / results.length;
const projection = {
  model: MODEL,
  sampledPages: PAGES.length,
  pageCount,
  perPageMs: Math.round(perPageMs),
  perPageCostUsd: +perPageCost.toFixed(4),
  fullDocSerialMinutes: +((perPageMs * pageCount) / 60000).toFixed(1),
  fullDocWith8WorkersMinutes: +((perPageMs * pageCount) / 8 / 60000).toFixed(1),
  fullDocCostUsd: +(perPageCost * pageCount).toFixed(2),
  t7TargetMinutes: 60,
};

fs.writeFileSync(path.join(run.dir, "probe.json"), JSON.stringify({ results, projection }, null, 2));
console.log("\n─── Extrapolation to full 104-pp document (vision-only worst case) ───");
console.table(projection);
console.log(`Report → runs/${run.runId}/probe.json`);
console.log(
  projection.fullDocWith8WorkersMinutes < 60
    ? "✅ Within T7 with parallel workers (and the real pipeline runs text-first, vision only where pairing-QA fails)."
    : "❌ Over T7 even parallelized — raise at Gate G1 before architecture hardens."
);
