import React from "react";
import { motion } from "framer-motion";
import { toast } from "react-toastify";
import { FiPlay, FiDownload } from "react-icons/fi";
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

  const extractable = uploads.filter((u) => {
    const label = u.triage?.verifiedLabel || u.triage?.label;
    return ["product_datasheet", "bk_template", "catalogue"].includes(label);
  });

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

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-bk-navy">Products</h2>
          <p className="mt-1 text-sm text-slate-600">{iprs.length} extracted rows in the IPR store.</p>
        </div>
        <button
          onClick={emit}
          disabled={busy === "emit" || !iprs.length}
          className="flex items-center gap-2 rounded-md bg-bk-gold px-4 py-2 text-sm font-bold text-bk-navy-deep transition-colors duration-200 hover:bg-bk-gold-soft disabled:opacity-50"
        >
          <FiDownload className="h-4 w-4" aria-hidden />
          {busy === "emit" ? "Emitting…" : "Emit BK template"}
        </button>
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

      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-semibold">SKU</th>
              <th className="px-4 py-3 font-semibold">Product</th>
              <th className="px-4 py-3 font-semibold">Brand</th>
              <th className="px-4 py-3 font-semibold">Taxonomy</th>
              <th className="px-4 py-3 font-semibold">Variant</th>
              <th className="px-4 py-3 font-semibold">Disposition</th>
            </tr>
          </thead>
          <tbody>
            {iprs.slice(0, 100).map((ipr, idx) => (
              <motion.tr
                key={ipr._id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.15, delay: Math.min(idx * 0.015, 0.4) }}
                className="border-t border-slate-100 transition-colors duration-150 hover:bg-slate-50"
              >
                <td className="px-4 py-2 font-mono text-xs">
                  {ipr.identity?.productCode?.value ?? ipr.templateRow?.["Product SKU"] ?? "—"}
                </td>
                <td className="max-w-xs truncate px-4 py-2">
                  {ipr.identity?.name?.value ?? ipr.templateRow?.["Unique Product Name"] ?? "—"}
                </td>
                <td className="px-4 py-2">{ipr.identity?.brand?.value ?? ipr.templateRow?.["Brand"] ?? "—"}</td>
                <td className="max-w-[16rem] truncate px-4 py-2 text-xs text-slate-500">{ipr.taxonomyPath ?? "template row"}</td>
                <td className="px-4 py-2">
                  {ipr.variantLabel ? (
                    <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800">
                      {ipr.variantLabel}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2">
                  {ipr.disposition ? (
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${DISPOSITION[ipr.disposition]}`}>
                      {ipr.disposition}
                    </span>
                  ) : (
                    <span className="text-slate-400">pending</span>
                  )}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {iprs.length > 100 && <p className="px-4 py-2 text-xs text-slate-400">Showing first 100 of {iprs.length}.</p>}
      </div>
    </div>
  );
}
