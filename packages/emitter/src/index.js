/**
 * @bk/emitter — template-driven xlsx writer (D6).
 * Milestone B (amended §8): template reader + Twyford lossless round-trip.
 * The template file IS the contract: headers, required markers, dropdowns and
 * the Instructions sheet are read from the workbook at runtime — never hardcoded.
 *
 * Milestone A ships only the signature detector used by Stage 0 triage (D12);
 * it lives in apps/api/src/services/xlsx.js so the emitter stays output-only.
 */
export const NOT_YET_IMPLEMENTED = "emitter lands in Milestone B per amended §8";
