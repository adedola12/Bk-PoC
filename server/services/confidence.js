/**
 * Confidence gate configuration — the ONE place thresholds live (§6.5).
 * Dispositions: PASS (auto-emit) / REVIEW / TODO.
 */
export const THRESHOLDS = {
  requiredFieldPass: 0.85, // required template field ≥ this → counts toward PASS
  // D18 (proposed): fields whose method is "derived" (drawing-read dims,
  // substituted finish codes) gate at a lower bar BECAUSE they are visibly
  // labelled derived in the output and UI — mirroring D5's derived_unverified
  // SKUs, which emit labelled rather than blocked.
  derivedFieldPass: 0.6,
  triageAuto: 0.8, // Stage 0: below this → human triage queue, never guessed
};

/**
 * @param {{requiredFields: Array<{confidence:number}>, anomalies: number, priceMissing: boolean}} row
 * @returns {"PASS"|"REVIEW"|"TODO"}
 */
export function disposeRow({ requiredFields, anomalies, priceMissing }) {
  const allPass = requiredFields.every((f) => f.confidence >= THRESHOLDS.requiredFieldPass);
  if (!allPass || anomalies > 0) return "REVIEW";
  if (priceMissing) return "TODO";
  return "PASS";
}
