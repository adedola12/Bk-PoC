/**
 * Which source files this walkthrough has extracted.
 *
 * The IPR store accumulates across every run ever made, so a demo that
 * extracts one datasheet would otherwise land on a Products page showing
 * every previously extracted file. Step 2 records each extraction here and
 * step 3 scopes to it, with an explicit toggle back to the full store.
 *
 * localStorage rather than component state so a page refresh mid-demo does
 * not silently widen the scope back to everything.
 */
const KEY = "bk.session.uploads";

export function extractedUploads() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
  } catch {
    return []; // corrupt or unavailable storage → behave as a fresh session
  }
}

/** The most recently extracted upload, or "" — what step 3 opens on. */
export function lastExtracted() {
  const all = extractedUploads();
  return all.length ? all[all.length - 1] : "";
}

export function rememberExtracted(uploadId) {
  if (!uploadId) return;
  const id = String(uploadId);
  // Drop any earlier entry first, then append: a Set spread would have kept an
  // already-present id at its original index, so re-extracting the same file
  // would not have made it the most recent and step 3 would open on the wrong one.
  const next = [...extractedUploads().filter((x) => x !== id), id];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — scope just falls back to the full store */
  }
}

export function clearExtracted() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
