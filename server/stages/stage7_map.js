import fs from "node:fs";
import path from "node:path";
import { hasCloudinary, uploadBufferToCloudinary } from "../services/cloudinary.js";
import { normCode } from "./vision_extract.js";

/**
 * Stage 7 — Attribute mapping & media pairing (D6). IPR fields map to the
 * template's own columns via per-category mapping profiles; dropdown fields
 * match controlled vocabulary (exact → synonym → flagged custom); media pairs
 * by filename tokens against product identity, then uploads to Cloudinary and
 * the delivery URL rides in the template's media columns (D8).
 *
 * D17: profiles declare which required columns are APPLICABLE per category;
 * inapplicable ones are exempt from the PASS gate and surfaced in the report.
 */

const get = (ipr, group, key) => {
  const g = ipr[group];
  if (!g) return null;
  const f = g instanceof Map ? g.get(key) : g[key];
  return f?.value != null ? f : null;
};

const val = (f) => (f == null ? "" : Array.isArray(f.value) ? f.value.join(",") : String(f.value));

/** Dropdown matching: exact → synonym → custom (flagged, never silently coerced). */
export function matchDropdown(value, allowed, synonyms = {}) {
  if (!value) return { value: "", status: "empty" };
  const v = String(value).trim();
  const hit = (allowed || []).find((a) => a.toLowerCase() === v.toLowerCase());
  if (hit) return { value: hit, status: "exact" };
  const syn = synonyms[v.toLowerCase()];
  if (syn && (allowed || []).some((a) => a.toLowerCase() === syn.toLowerCase())) {
    return { value: syn, status: "synonym" };
  }
  return { value: v, status: "custom" }; // template allows "dropdown + custom" — flagged for review
}

const MATERIAL_SYNONYMS = {
  "vitreous china": "Ceramic/Vitreous China",
  ceramic: "Ceramic/Vitreous China",
  brass: "Stainless Steel", // no honest match — will surface as custom via allowed-check failing
};

/**
 * Per-category mapping profiles: template column → IPR getter.
 * `applicable` lists the required columns that make sense for the category —
 * everything else required is a D17 exemption.
 */
export const CATEGORY_PROFILES = {
  "Plumbing & Sanitary Ware > Sanitary Ware > Wash Basins & Pedestals": {
    applicable: null, // null = every required column applies (native category)
    map: (ipr) => (ipr.templateRow ? { ...ipr.templateRow } : {}),
  },
  "Plumbing & Sanitary Ware > Bathroom Accessories": {
    applicable: ["Brand", "Color", "Dimensions (1)", "Dimensions (2)", "Dimensions (3)", "Dimensions Unit", "Material"],
    map: (ipr) => ({
      Brand: val(get(ipr, "identity", "brand")),
      Collection: val(get(ipr, "identity", "collection")),
      Color: val(get(ipr, "attributes", "color")),
      "Dimensions (1)": val(get(ipr, "attributes", "dimensions1")),
      "Dimensions (2)": val(get(ipr, "attributes", "dimensions2")),
      "Dimensions (3)": val(get(ipr, "attributes", "dimensions3")),
      "Dimensions Unit": "mm",
      "Unique Product Name": uniqueName(ipr),
      "Product SKU": val(get(ipr, "identity", "productCode")),
      Material: val(get(ipr, "attributes", "material")),
      "Country of Origin": val(get(ipr, "attributes", "countryOfOrigin")),
    }),
  },
  "Plumbing & Sanitary Ware > Concealed Cisterns & Installation Systems": {
    applicable: ["Brand", "Dimensions (1)", "Dimensions (2)", "Dimensions (3)", "Dimensions Unit"],
    map: (ipr) => ({
      Brand: val(get(ipr, "identity", "brand")),
      Collection: val(get(ipr, "identity", "collection")),
      Color: val(get(ipr, "attributes", "color")),
      "Dimensions (1)": val(get(ipr, "attributes", "dimensions1")),
      "Dimensions (2)": val(get(ipr, "attributes", "dimensions2")),
      "Dimensions (3)": val(get(ipr, "attributes", "dimensions3")),
      "Dimensions Unit": "mm",
      "Unique Product Name": uniqueName(ipr),
      "Product SKU": val(get(ipr, "identity", "productCode")),
      Material: val(get(ipr, "attributes", "material")),
    }),
  },
  fallback: {
    applicable: ["Brand"],
    map: (ipr) => ({
      Brand: val(get(ipr, "identity", "brand")),
      "Unique Product Name": uniqueName(ipr),
      "Product SKU": val(get(ipr, "identity", "productCode")),
    }),
  },
};

function uniqueName(ipr) {
  const name = val(get(ipr, "identity", "name"));
  const brand = val(get(ipr, "identity", "brand"));
  const color = val(get(ipr, "attributes", "color"));
  const dims = ["dimensions1", "dimensions2", "dimensions3"]
    .map((k) => val(get(ipr, "attributes", k)))
    .filter(Boolean)
    .join(" x ");
  return [brand, name, color, dims ? `${dims}mm` : ""].filter(Boolean).join(" — ");
}

/** Find the profile for an IPR's taxonomy path (nearest ancestor wins). */
export function profileFor(taxonomyPath) {
  if (!taxonomyPath) return CATEGORY_PROFILES.fallback;
  for (const [prefix, profile] of Object.entries(CATEGORY_PROFILES)) {
    if (prefix !== "fallback" && taxonomyPath.startsWith(prefix)) return profile;
  }
  return CATEGORY_PROFILES.fallback;
}

/** Map one IPR → template row values + dropdown statuses. */
export function mapIprToRow(ipr, schema) {
  // template short-circuit rows carry the FULL column map — they are already
  // contract-shaped (lossless round-trip guarantee) regardless of taxonomy
  const profile = ipr.templateRow
    ? CATEGORY_PROFILES["Plumbing & Sanitary Ware > Sanitary Ware > Wash Basins & Pedestals"]
    : profileFor(ipr.taxonomyPath ?? null);
  const row = profile.map(ipr);
  const dropdownFlags = [];
  for (const col of schema.columns) {
    const allowed = schema.dropdowns[col.name];
    if (!allowed || !row[col.name]) continue;
    const match = matchDropdown(row[col.name], allowed, MATERIAL_SYNONYMS);
    row[col.name] = match.value;
    if (match.status === "custom") dropdownFlags.push({ column: col.name, value: match.value });
  }
  return { row, profile, dropdownFlags };
}

/**
 * Media pairing: image files ↔ products by filename tokens vs identity tokens
 * (brand aliases included — "Jaguar_..." pairs with Jaquar). Uploads paired
 * images to Cloudinary; variants inherit the base product's image.
 * @param {Array<{originalName:string, storedPath:string}>} images
 * @param {Array} iprs
 * @returns {Promise<{paired: Map<string,string>, unpaired: string[]}>} identityKey → URL
 */
export async function pairAndUploadMedia(images, iprs, { log } = {}) {
  const paired = new Map();
  const unpaired = [];
  const tokensOf = (s) =>
    new Set(String(s).toLowerCase().replace(/\.[a-z]+$/, "").split(/[^a-z0-9]+/).filter((t) => t.length > 2));

  for (const img of images) {
    const imgTokens = tokensOf(img.originalName);
    let best = null;
    for (const ipr of iprs.filter((i) => !i.variantLabel)) {
      const idTokens = tokensOf(
        `${ipr.identity?.brand?.value ?? ""} ${ipr.identity?.brand?.raw ?? ""} ${ipr.identity?.name?.value ?? ""}`
      );
      const overlap = [...imgTokens].filter((t) => idTokens.has(t)).length;
      if (overlap >= 2 && (!best || overlap > best.overlap)) best = { ipr, overlap };
    }
    if (!best) {
      unpaired.push(img.originalName); // → review, never silently dropped
      continue;
    }
    const sku = normCode(best.ipr.identity?.productCode?.value ?? "product");
    let url = `local://${img.originalName}`;
    if (hasCloudinary()) {
      try {
        url = await uploadBufferToCloudinary(fs.readFileSync(img.storedPath), sku);
      } catch (err) {
        log?.({ kind: "cloudinary_failed", file: img.originalName, message: err.message });
      }
    }
    paired.set(identityKey(best.ipr), url);
    log?.({ kind: "media_paired", image: img.originalName, sku, url });
  }
  return { paired, unpaired };
}

export function identityKey(ipr) {
  return [
    (ipr.identity?.brand?.value ?? "").toLowerCase(),
    normCode(ipr.identity?.productCode?.value ?? ""),
  ].join("|");
}

/** Variant rows inherit the base image (same base code family). */
export function mediaUrlFor(ipr, paired) {
  const own = paired.get(identityKey(ipr));
  if (own) return own;
  if (ipr.variantOfCode) {
    const baseKey = [
      (ipr.identity?.brand?.value ?? "").toLowerCase(),
      normCode(ipr.variantOfCode),
    ].join("|");
    return paired.get(baseKey) ?? "";
  }
  return "";
}
