/**
 * MongoDB field names may not contain "." and may not begin with "$", and a
 * Mongoose Map rejects the WHOLE object if any single key breaks those rules.
 *
 * Attribute keys are model output — whatever label the extractor read off a
 * spec table. One mis-parsed row ("3.7", a value read as its own label) is
 * therefore enough to fail the entire IPR insert with "Cast to Map failed",
 * taking every other attribute on that product down with it and surfacing an
 * error that names Mongoose internals rather than the offending label.
 *
 * Keys are rewritten, never dropped: the label is evidence of what the
 * extractor saw, and integrity rule §6.1 says nothing wrong may pass silently.
 * Callers get the rewrites back so they can raise them for human review.
 */
export function sanitizeMapKeys(obj) {
  const source = obj ?? {};
  const original = new Set(Object.keys(source));
  const out = {};
  const rewrites = [];

  for (const [key, value] of Object.entries(source)) {
    let safe = key.replace(/\./g, "_").replace(/^\$+/, "_");
    if (!safe) safe = "_";

    if (safe !== key) {
      // The repaired key can collide with a sibling that was already legal, or
      // with another repair. Suffix rather than let one attribute silently
      // overwrite another — a lost attribute is worse than an ugly key.
      let candidate = safe;
      let n = 2;
      while (candidate in out || (candidate !== key && original.has(candidate))) {
        candidate = `${safe}_${n++}`;
      }
      safe = candidate;
      rewrites.push({ from: key, to: safe });
    }

    out[safe] = value;
  }

  return { map: out, rewrites };
}
