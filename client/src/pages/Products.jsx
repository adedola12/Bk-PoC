import React from "react";
import { motion } from "framer-motion";
import { toast } from "react-toastify";
import { FiPlay, FiDownload, FiBox, FiTruck, FiTag, FiSearch } from "react-icons/fi";
import { fetchIprs, fetchTriage, extractUpload, runEmission, emissionDownloadUrl, errMsg } from "../api.js";

const DISPOSITION = {
  PASS: "bg-emerald-100 text-emerald-800",
  REVIEW: "bg-amber-100 text-amber-900",
  TODO: "bg-sky-100 text-sky-800",
};

/* ─── extracted products with per-field provenance + one-click emission ─── */
export default function Products() {
  const [iprs, setIprs] = React.useState([]);
  const [uploads, setUploads] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(null);
  const [emission, setEmission] = React.useState(null);
  const [query, setQuery] = React.useState("");

  const load = React.useCallback(() => {
    Promise.all([fetchIprs(), fetchTriage()])
      .then(([i, u]) => {
        setIprs(Array.isArray(i) ? i : []);
        setUploads(Array.isArray(u) ? u : []);
      })
      .catch((err) => toast.error(errMsg(err, "Could not load products")))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const extractable = [
    ...new Map(
      uploads
        .filter((u) => {
          const label = u.triage?.verifiedLabel || u.triage?.label;
          return ["product_datasheet", "bk_template", "catalogue"].includes(label);
        })
        .map((u) => [u.originalName, u]) // newest ledger entry per filename
    ).values(),
  ];

  const runExtract = async (upload) => {
    setBusy(upload._id);
    try {
      const r = await extractUpload(upload._id);
      toast.success(`${r.count} row(s) extracted from ${upload.originalName}${r.anomaliesFlagged ? ` · ${r.anomaliesFlagged} anomalies → review` : ""}`);
      load();
    } catch (err) {
      toast.error(errMsg(err, "Extraction failed"));
    } finally {
      setBusy(null);
    }
  };

  const emit = async () => {
    setBusy("emit");
    try {
      const r = await runEmission();
      setEmission(r);
      toast.success(`Emitted ${r.emittedRows} rows — zero-touch ${(r.zeroTouch * 100).toFixed(0)}%`);
      load();
    } catch (err) {
      toast.error(errMsg(err, "Emission failed"));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-slate-200/70" />;

  // search across name, brand, SKU, color, category and latest price
  const q = query.trim().toLowerCase();
  const shown = !q
    ? iprs
    : iprs.filter((ipr) =>
        [
          ipr.identity?.name?.value,
          ipr.templateRow?.["Unique Product Name"],
          ipr.identity?.brand?.value,
          ipr.templateRow?.["Brand"],
          ipr.identity?.productCode?.value,
          ipr.templateRow?.["Product SKU"],
          ipr.attributes?.color?.value,
          ipr.taxonomyPath,
          ipr.templateRow?.["Description"],
          ipr.latestPrice?.price != null ? String(ipr.latestPrice.price) : null,
        ]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q))
      );

  return (
    <div>
      {/* sticky toolbar — search + emit stay reachable during scroll */}
      <div className="sticky top-0 z-10 -mx-6 border-b border-slate-200 bg-surface/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold text-bk-navy">Products</h2>
            <p className="text-xs text-slate-600">
              {q ? `${shown.length} of ${iprs.length} rows match "${query}"` : `${iprs.length} extracted rows in the IPR store.`}
            </p>
          </div>
          <label className="relative" aria-label="Search products">
            <FiSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, brand, SKU, price…"
              className="w-60 rounded-md border border-slate-300 bg-white py-2 pl-8 pr-3 text-sm"
            />
          </label>
          <button
            onClick={emit}
            disabled={busy === "emit" || !iprs.length}
            className="flex items-center gap-2 rounded-md bg-bk-gold px-4 py-2 text-sm font-bold text-bk-navy-deep transition-colors duration-200 hover:bg-bk-gold-soft disabled:opacity-50"
          >
            <FiDownload className="h-4 w-4" aria-hidden />
            {busy === "emit" ? "Emitting…" : "Emit BK template"}
          </button>
        </div>
      </div>

      {emission?.files?.length > 0 && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
          <p className="font-semibold text-emerald-900">
            Emission complete — zero-touch {(emission.zeroTouch * 100).toFixed(0)}% ({emission.dispositions.PASS} PASS ·{" "}
            {emission.dispositions.TODO} TODO · {emission.dispositions.REVIEW} REVIEW)
          </p>
          <p className="mt-1 space-x-3">
            {emission.files.map((f) => (
              <a key={f} href={emissionDownloadUrl(emission.runId, f)} className="font-medium text-bk-navy underline">
                {f}
              </a>
            ))}
          </p>
        </div>
      )}

      {extractable.length > 0 && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">Run extraction</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {extractable.map((u) => (
              <button
                key={u._id}
                onClick={() => runExtract(u)}
                disabled={busy === u._id}
                className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors duration-200 hover:border-bk-gold disabled:opacity-50"
              >
                <FiPlay className="h-3 w-3" aria-hidden />
                {busy === u._id ? "Extracting…" : u.originalName}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* marketplace-style card grid (BK storefront format) */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.slice(0, 60).map((ipr, idx) => (
          <ProductCard key={ipr._id} ipr={ipr} idx={idx} />
        ))}
      </div>
      {shown.length > 60 && <p className="mt-3 text-xs text-slate-400">Showing first 60 of {shown.length}.</p>}
      {q && !shown.length && (
        <p className="mt-6 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No products match "{query}".
        </p>
      )}
    </div>
  );
}

/* ─────────── product card — BK storefront format ─────────── */

const PLACEHOLDER_TINTS = [
  "from-slate-100 to-slate-200 text-slate-300",
  "from-sky-50 to-slate-200 text-sky-200",
  "from-amber-50 to-slate-200 text-amber-200",
];

function ProductCard({ ipr, idx }) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const name = ipr.identity?.name?.value ?? ipr.templateRow?.["Unique Product Name"] ?? "Unnamed product";
  const brand = ipr.identity?.brand?.value ?? ipr.templateRow?.["Brand"] ?? "";
  const sku = ipr.identity?.productCode?.value ?? ipr.templateRow?.["Product SKU"] ?? "—";
  const color = ipr.attributes?.color?.value ?? ipr.templateRow?.["Color"] ?? null;
  const price = ipr.latestPrice;
  const cover = !imgFailed ? ipr.coverUrl : null;
  const tint = PLACEHOLDER_TINTS[idx % PLACEHOLDER_TINTS.length];

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(idx * 0.03, 0.5) }}
      className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow duration-200 hover:shadow-md"
    >
      {/* image area */}
      <div className="relative h-44 w-full">
        {cover ? (
          <img
            src={cover}
            alt={name}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-contain p-3"
          />
        ) : (
          <div className={`flex h-full w-full flex-col items-center justify-center bg-gradient-to-br ${tint}`}>
            <FiBox className="h-12 w-12" aria-hidden />
            <span className="mt-1 text-xs font-semibold uppercase tracking-widest opacity-70">
              {brand || "image pending"}
            </span>
          </div>
        )}
        {ipr.disposition && (
          <span className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${DISPOSITION[ipr.disposition]}`}>
            {ipr.disposition}
          </span>
        )}
        {ipr.variantLabel && (
          <span className="absolute right-2 top-2 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800">
            derived
          </span>
        )}
      </div>

      {/* body */}
      <div className="flex flex-1 flex-col border-t border-slate-100 px-4 pb-3 pt-3">
        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-slate-800">
          {brand && <span className="text-bk-navy">{brand} </span>}
          {name}
          {color ? `, ${color}` : ""}
        </h3>
        <p className="mt-1 border-b border-slate-100 pb-2 text-right font-mono text-[11px] text-bk-navy-mid">{sku}</p>

        <p className="mt-2 text-lg font-extrabold text-slate-900">
          {price ? (
            <>
              ₦{Number(price.price).toLocaleString()}
              <span className="text-xs font-medium text-slate-500">/Unit</span>
            </>
          ) : (
            <span className="text-sm font-semibold text-slate-400">Price pending → Todo</span>
          )}
        </p>

        <div className="mt-auto border-t border-slate-100 pt-2 text-xs text-slate-500">
          <p className="flex items-center gap-1.5">
            <FiTruck className="h-3.5 w-3.5 text-bk-navy" aria-hidden /> 48hr delivery — Satkay Limited
          </p>
          <p className="mt-1 flex items-center gap-1.5">
            <FiTag className="h-3.5 w-3.5 text-bk-navy" aria-hidden />
            <span className="truncate">{(ipr.taxonomyPath ?? "BK template row").split(" > ").at(-1)}</span>
          </p>
        </div>
      </div>
    </motion.article>
  );
}
