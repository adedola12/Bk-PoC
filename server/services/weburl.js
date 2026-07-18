import dns from "node:dns/promises";
import net from "node:net";

/**
 * D16 — URL ingestion fetcher. http/https only; refuses private, loopback and
 * link-local targets (SSRF guard); 25 MB cap. Returns the bytes plus enough
 * metadata for Stage 0 to treat the result like any uploaded file.
 */

const MAX_BYTES = 25 * 1024 * 1024;

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\./,
];

function isPrivateAddress(addr) {
  if (net.isIPv6(addr)) return /^(::1|f[cd]|fe80)/i.test(addr);
  return PRIVATE_V4.some((re) => re.test(addr));
}

export async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw Object.assign(new Error("Only http/https URLs are allowed"), { status: 400 });
  }
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => {
    throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 });
  });
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error("URL resolves to a private address — refused"), { status: 400 });
  }
  return url;
}

/** Extension by content type / URL path — decides the triage entry point. */
export function classifyFetched(contentType, urlPath) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf")) return { ext: ".pdf", kind: "file" };
  if (ct.includes("spreadsheetml") || /\.xlsx?$/i.test(urlPath)) return { ext: ".xlsx", kind: "file" };
  if (ct.includes("wordprocessingml") || /\.docx$/i.test(urlPath)) return { ext: ".docx", kind: "file" };
  if (ct.startsWith("image/")) return { ext: `.${ct.split("/")[1].replace("jpeg", "jpg").split(";")[0]}`, kind: "file" };
  if (ct.includes("html") || ct.includes("text/plain")) return { ext: ".html", kind: "page" };
  // fall back to the URL path extension when the server lies about types
  const m = urlPath.match(/\.(pdf|xlsx|docx|jpe?g|png|webp)$/i);
  if (m) return { ext: `.${m[1].toLowerCase().replace("jpeg", "jpg")}`, kind: "file" };
  return { ext: ".html", kind: "page" };
}

/**
 * @returns {Promise<{buffer: Buffer, contentType: string, ext: string, kind: "file"|"page", finalUrl: string}>}
 */
export async function fetchUrl(rawUrl) {
  const url = await assertSafeUrl(rawUrl);
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
    headers: { "User-Agent": "BK-Ingest/1.0 (catalog onboarding PoC)" },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Fetch failed: HTTP ${res.status}`), { status: 400 });
  }
  // re-check the FINAL address after redirects
  await assertSafeUrl(res.url || rawUrl);

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      reader.cancel();
      throw Object.assign(new Error("Remote file exceeds the 25 MB limit"), { status: 400 });
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  const contentType = res.headers.get("content-type") || "";
  const { ext, kind } = classifyFetched(contentType, new URL(res.url || rawUrl).pathname);
  return { buffer, contentType, ext, kind, finalUrl: res.url || rawUrl };
}

/**
 * D16 crawl support — same-host link discovery with product-page scoring.
 * A pasted site ROOT (manufacturer homepage) rarely lists products itself;
 * we follow its most product-looking links, bounded hard.
 */
const PRODUCT_LINK_HINTS = /product|catalog|catalogue|category|categories|range|shop|item|sku|datasheet|download/i;

export function extractLinks(html, baseUrl) {
  const links = new Set();
  const base = new URL(baseUrl);
  for (const m of String(html).matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(m[1], base);
      if (!/^https?:$/.test(url.protocol)) continue;
      if (url.hostname !== base.hostname) continue; // same host only
      if (/\.(css|js|ico|svg|woff2?|png|jpe?g|gif|webp|mp4)$/i.test(url.pathname)) continue;
      url.hash = "";
      links.add(url.toString());
    } catch {
      /* malformed href — skip */
    }
  }
  return [...links];
}

export function scoreProductLink(url) {
  const path = new URL(url).pathname.toLowerCase();
  let score = 0;
  if (PRODUCT_LINK_HINTS.test(path)) score += 2;
  if (/\.pdf$|\.xlsx?$/.test(path)) score += 3; // direct catalogue files are gold
  score += Math.min(path.split("/").filter(Boolean).length, 3) * 0.5; // deeper = more specific
  return score;
}

/** Heuristic: does this page's text actually talk about products? */
export function productSignal(text) {
  const t = String(text);
  const priceHits = (t.match(/₦|NGN|USD|\$\s?\d|price/gi) || []).length;
  const codeHits = (t.match(/\b[A-Z]{2,4}[-/]?\d{3,}\b/g) || []).length;
  const unitHits = (t.match(/\b\d+\s?(mm|cm|kg|w|v|mpa|rpm)\b/gi) || []).length;
  return { score: priceHits + codeHits + unitHits, priceHits, codeHits, unitHits, chars: t.length };
}

/**
 * Bounded crawl: fetch up to `maxPages` best-scored same-host links from a
 * root page and return their text. Never recursive beyond depth 1.
 */
export async function crawlForProducts(rootHtml, rootUrl, { maxPages = 6 } = {}) {
  const ranked = extractLinks(rootHtml, rootUrl)
    .map((url) => ({ url, score: scoreProductLink(url) }))
    .filter((l) => l.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages);

  const pages = [];
  const files = [];
  for (const { url } of ranked) {
    try {
      const fetched = await fetchUrl(url);
      if (fetched.kind === "file") {
        files.push({ url: fetched.finalUrl, ext: fetched.ext, buffer: fetched.buffer, contentType: fetched.contentType });
      } else {
        const text = htmlToText(fetched.buffer.toString("utf8"));
        if (productSignal(text).score >= 3) pages.push({ url: fetched.finalUrl, text });
      }
    } catch {
      /* dead/blocked link — crawl continues */
    }
  }
  return { pages, files, followed: ranked.map((r) => r.url) };
}

/** Very light HTML → text: strip scripts/styles/tags, collapse whitespace. */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
