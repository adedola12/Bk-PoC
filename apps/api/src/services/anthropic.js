import Anthropic from "@anthropic-ai/sdk";

/**
 * Single Anthropic entry point (§9): structured JSON outputs, retries with
 * backoff, per-call cost + latency logged to the run record (feeds T7).
 */
export const MODEL = "claude-sonnet-4-6"; // D8 default

// USD per MTok for the D8 default model (input / output) — used only for the
// run-record cost estimate shown in reports; update if pricing changes.
const PRICE = { input: 3, output: 15 };

// Lazy: ESM hoists imports above dotenv.config() in entrypoints, so the env
// var may not exist at module-evaluation time. Trim guards stray whitespace
// pasted into .env (an invalid header value otherwise).
let client;
const getClient = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call Claude and parse a single JSON object from the response.
 * @param {object} opts
 * @param {string} opts.system
 * @param {Array} opts.messages - Anthropic messages (may include image blocks)
 * @param {number} [opts.maxTokens]
 * @param {(entry: object) => void} [opts.log] - run-record logger
 * @param {string} [opts.tag] - label for the log entry
 * @returns {Promise<object>} parsed JSON
 */
export async function callClaudeJSON({ system, messages, maxTokens = 1500, log, tag = "call" }) {
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const started = Date.now();
    try {
      const res = await getClient().messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system: `${system}\n\nRespond with a single JSON object only — no prose, no code fences.`,
        messages,
      });
      const latencyMs = Date.now() - started;
      const usage = res.usage || {};
      const costUsd =
        ((usage.input_tokens || 0) * PRICE.input + (usage.output_tokens || 0) * PRICE.output) / 1e6;
      log?.({ kind: "ai_call", tag, model: MODEL, latencyMs, usage, costUsd });

      const text = res.content.find((b) => b.type === "text")?.text ?? "";
      const match = text.match(/\{[\s\S]*\}/); // tolerate stray prose/fences
      if (!match) throw new Error("no JSON object in model response");
      return JSON.parse(match[0]);
    } catch (err) {
      lastErr = err;
      log?.({ kind: "ai_error", tag, attempt: i + 1, message: err.message });
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
