import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "react-toastify";
import { FiAlertTriangle, FiCheck, FiRefreshCw } from "react-icons/fi";
import { fetchTriage, verifyTriage, previewUrl, errMsg } from "../api.js";

const LABELS = ["bk_template", "catalogue", "product_datasheet", "product_image", "vendor_document", "other"];

const BADGE = {
  bk_template: "bg-indigo-100 text-indigo-800",
  catalogue: "bg-blue-100 text-blue-800",
  product_datasheet: "bg-sky-100 text-sky-800",
  product_image: "bg-emerald-100 text-emerald-800",
  vendor_document: "bg-amber-100 text-amber-900",
  other: "bg-slate-200 text-slate-700",
};

const Badge = ({ label }) => (
  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${BADGE[label] || BADGE.other}`}>
    {label}
  </span>
);

/* ─────────── D11: no silent dismissal ─────────── */
export default function TriageVerify() {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    fetchTriage()
      .then(setItems)
      .catch((err) => toast.error(errMsg(err, "Could not load triage queue")))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const act = async (id, payload) => {
    try {
      await verifyTriage(id, payload);
      toast.success(payload.confirm ? "Classification confirmed" : `Reclassified as ${payload.label}`);
      load();
    } catch (err) {
      toast.error(errMsg(err, "Verification failed"));
    }
  };

  const pending = items.filter((i) => i.triage?.needsVerification);
  const rest = items.filter((i) => !i.triage?.needsVerification);

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading triage queue">
        {[1, 2, 3].map((n) => (
          <div key={n} className="h-16 animate-pulse rounded-lg bg-slate-200/70" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-bk-navy">Triage verification</h2>
          <p className="mt-1 text-sm text-slate-600">
            {pending.length
              ? `${pending.length} file(s) require human confirmation before filing (D11).`
              : "No files awaiting verification."}
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            load();
          }}
          className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors duration-200 hover:border-bk-gold"
        >
          <FiRefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </button>
      </div>

      <AnimatePresence>
        {pending.map((item) => (
          <motion.div
            key={item._id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.25 }}
            className="mt-5 rounded-lg border-l-4 border-bk-gold bg-white p-5 shadow-sm"
          >
            <VerifyCard item={item} onAct={act} />
          </motion.div>
        ))}
      </AnimatePresence>

      {rest.length > 0 && (
        <>
          <h3 className="mt-10 mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">
            Classified uploads
          </h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">File</th>
                  <th className="px-4 py-3 font-semibold">Route</th>
                  <th className="px-4 py-3 font-semibold">Confidence</th>
                  <th className="px-4 py-3 font-semibold">Method</th>
                  <th className="px-4 py-3 font-semibold">Verified</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((i, idx) => (
                  <motion.tr
                    key={i._id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2, delay: idx * 0.03 }}
                    className="border-t border-slate-100 transition-colors duration-150 hover:bg-slate-50"
                  >
                    <td className="max-w-xs truncate px-4 py-2.5 font-medium text-slate-800">{i.originalName}</td>
                    <td className="px-4 py-2.5">
                      <Badge label={i.triage?.verifiedLabel || i.triage?.label} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-slate-700">{i.triage?.confidence?.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-slate-700">{i.triage?.method}</td>
                    <td className="px-4 py-2.5">
                      {i.triage?.verified ? (
                        <FiCheck className="h-4 w-4 text-emerald-600" aria-label="verified" />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function VerifyCard({ item, onAct }) {
  const [label, setLabel] = React.useState(item.triage?.label || "other");

  return (
    <div className="flex flex-col gap-5 sm:flex-row">
      {/* D11: document snapshot preview */}
      <div className="w-full shrink-0 sm:w-44">
        {item.previewPath ? (
          <img
            src={previewUrl(item._id)}
            alt={`First page of ${item.originalName}`}
            className="rounded border border-slate-200"
            loading="lazy"
          />
        ) : (
          <div className="flex h-32 items-center justify-center rounded border border-slate-200 bg-slate-50 text-xs text-slate-400">
            no snapshot
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <FiAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bk-gold" aria-hidden />
          <div className="min-w-0">
            <p className="truncate font-semibold text-bk-navy">{item.originalName}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              classified <Badge label={item.triage?.label} /> · confidence{" "}
              {item.triage?.confidence?.toFixed(2)} · {item.triage?.method}
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-slate-700">{item.triage?.summary}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => onAct(item._id, { confirm: true })}
            className="rounded-md bg-bk-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-bk-navy-mid"
          >
            Confirm classification
          </button>
          <label className="sr-only" htmlFor={`relabel-${item._id}`}>
            Reclassify as
          </label>
          <select
            id={`relabel-${item._id}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
          >
            {LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            onClick={() => onAct(item._id, { confirm: false, label })}
            className="rounded-md border border-bk-gold px-4 py-2 text-sm font-semibold text-bk-navy transition-colors duration-200 hover:bg-bk-gold/10"
          >
            Reclassify
          </button>
        </div>
      </div>
    </div>
  );
}
