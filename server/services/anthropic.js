import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

/**
 * Single Anthropic entry point (§9): structured JSON outputs, retries with
 * backoff, per-call cost + latency logged to the run record (feeds T7).
 *
 * Two providers, one call site:
 *
 *   anthropic — the first-party API, authenticated with ANTHROPIC_API_KEY
 *   bedrock   — Claude on Amazon Bedrock, authenticated with IAM
 *
 * Bedrock is what makes this deployable without a key: the EC2 instance role
 * signs the request, so no secret is staged on the box, none reaches Parameter
 * Store, and nothing can leak through a transcript. The default reflects that —
 * a key selects the first-party API, and its absence selects Bedrock — so the
 * box does the right thing with no configuration and a laptop with a key in
 * .env keeps behaving as it always did. Set AI_PROVIDER to force either one.
 */
const PROVIDER = (
  process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "bedrock")
).toLowerCase();

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-west-1";

/**
 * Bedrock model IDs are not the first-party IDs.
 *
 * Current Claude models are not callable on Bedrock by their bare ID — an
 * on-demand `anthropic.claude-*` call is rejected with "Invocation ... with
 * on-demand throughput isn't supported". They must be addressed through a
 * cross-region INFERENCE PROFILE, which is the same ID behind a region prefix:
 * `eu.` (EU regions) or `global.`. Hence `eu.anthropic.claude-sonnet-4-6`.
 */
const MODEL_BY_PROVIDER = {
  anthropic: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", // D8 default
  bedrock: process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-sonnet-4-6",
};

export const MODEL = MODEL_BY_PROVIDER[PROVIDER] ?? MODEL_BY_PROVIDER.anthropic;

/**
 * USD per MTok (input / output) — used only for the run-record cost estimate
 * shown in reports, never for billing.
 *
 * Keyed by model family and matched against the resolved model ID, because that
 * ID is now configurable: a single hardcoded rate silently under-reports by
 * ~1.7x the moment the model moves from Sonnet to Opus. Bedrock is
 * partner-priced and its regional rates run slightly above these first-party
 * list rates, so treat the figure as indicative.
 */
const PRICE_BY_FAMILY = [
  [/opus/, { input: 5, output: 25 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku/, { input: 1, output: 5 }],
];
const priceFor = (modelId) =>
  PRICE_BY_FAMILY.find(([re]) => re.test(modelId))?.[1] ?? { input: 3, output: 15 };

// Lazy: ESM hoists imports above dotenv.config() in entrypoints, so the env
// var may not exist at module-evaluation time. Trim guards stray whitespace
// pasted into .env (an invalid header value otherwise).
let client;
const getClient = () =>
  (client ??=
    PROVIDER === "bedrock"
      ? new AnthropicBedrock({ awsRegion: AWS_REGION })
      : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() }));

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
      const price = priceFor(MODEL);
      const costUsd =
        ((usage.input_tokens || 0) * price.input + (usage.output_tokens || 0) * price.output) / 1e6;
      log?.({ kind: "ai_call", tag, provider: PROVIDER, model: MODEL, latencyMs, usage, costUsd });

      const text = res.content.find((b) => b.type === "text")?.text ?? "";
      const match = text.match(/\{[\s\S]*\}/); // tolerate stray prose/fences
      if (!match) throw new Error("no JSON object in model response");
      return JSON.parse(match[0]);
    } catch (err) {
      lastErr = err;
      log?.({ kind: "ai_error", tag, provider: PROVIDER, attempt: i + 1, message: err.message });
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

/**
 * Is an AI provider configured? Gates every AI stage — when false the pipeline
 * fails closed to human triage rather than erroring (HANDOFF_PROMPT.md §2).
 *
 * On Bedrock there is no key to look for: credentials come from the instance
 * role, an SSO profile, or the environment, and the SDK resolves them at call
 * time. A region is the one thing that must be known up front, so that is what
 * we check — a genuinely absent credential surfaces as a failed call, which the
 * retry/fail-closed path already handles.
 */
export function aiAvailable() {
  return PROVIDER === "bedrock" ? Boolean(AWS_REGION) : Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Which provider and model this process will use — surfaced by /healthz. */
export function aiProvider() {
  return { provider: PROVIDER, model: MODEL, region: PROVIDER === "bedrock" ? AWS_REGION : null };
}
