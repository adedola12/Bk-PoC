import React from "react";
import { motion } from "framer-motion";
import { toast } from "react-toastify";
import { FiAlertCircle, FiCheck, FiX } from "react-icons/fi";
import { fetchReview, resolveReview, errMsg } from "../api.js";

const REASON_LABEL = {
  low_confidence: "Low confidence",
  anomaly_rule: "Anomaly rule",
  duplicate_code: "Duplicate part number",
  unit_implausible: "Implausible unit/value",
  unmapped_taxonomy: "Unmapped taxonomy",
  unconfirmed_brand: "Unconfirmed brand",
  triage_uncertain: "Triage uncertain",
  fact_check_failed: "Fact-check failed",
  unpaired_media: "Unpaired media",
};

/* ─── §6.1: everything flagged lands here — nothing wrong passes silently ─── */
export default function ReviewQueue() {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    fetchReview()
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((err) => toast.error(errMsg(err, "Could not load review queue")))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const act = async (id, resolution, correctedValue = null) => {
    try {
      await resolveReview(id, { resolution, correctedValue });
      toast.success(`Marked ${resolution}`);
      load();
    } catch (err) {
      toast.error(errMsg(err, "Could not resolve"));
    }
  };

  const open = items.filter((i) => i.status === "open");
  const closed = items.filter((i) => i.status !== "open");

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-slate-200/70" />;

  return (
    <div>
      <h2 className="text-2xl font-bold text-bk-navy">Review queue</h2>
      <p className="mt-1 mb-6 text-sm text-slate-600">
        {open.length} open item(s). Every resolution is recorded as calibration data.
      </p>

      <div className="space-y-3">
        {open.map((item, idx) => (
          <motion.div
            key={item._id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(idx * 0.03, 0.3) }}
            className="rounded-lg border border-slate-200 bg-white p-4"
          >
            <ReviewCard item={item} onAct={act} />
          </motion.div>
        ))}
        {!open.length && (
          <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            Queue clear — nothing awaiting review.
          </p>
        )}
      </div>

      {closed.length > 0 && (
        <p className="mt-6 text-xs text-slate-400">{closed.length} resolved/dismissed item(s) retained as calibration history.</p>
      )}
    </div>
  );
}

function ReviewCard({ item, onAct }) {
  const [correction, setCorrection] = React.useState("");
  const sku = item.ipr?.identity?.productCode?.value;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <FiAlertCircle className="h-4 w-4 text-bk-gold" aria-hidden />
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
          {REASON_LABEL[item.reason] ?? item.reason}
        </span>
        {sku && <span className="font-mono text-xs text-slate-500">{sku}</span>}
        {item.fieldKey && <span className="text-xs text-slate-400">field: {item.fieldKey}</span>}
        {item.upload?.originalName && <span className="text-xs text-slate-400">· {item.upload.originalName}</span>}
      </div>
      <p className="mt-2 text-sm text-slate-700">{item.detail}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => onAct(item._id, "accepted")}
          className="flex items-center gap-1.5 rounded-md bg-bk-navy px-3 py-1.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-bk-navy-mid"
        >
          <FiCheck className="h-4 w-4" aria-hidden /> Accept as-is
        </button>
        <input
          value={correction}
          onChange={(e) => setCorrection(e.target.value)}
          placeholder="corrected value…"
          className="w-44 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          onClick={() => correction && onAct(item._id, "corrected", correction)}
          disabled={!correction}
          className="rounded-md border border-bk-gold px-3 py-1.5 text-sm font-medium text-bk-navy transition-colors duration-200 hover:bg-bk-gold/10 disabled:opacity-40"
        >
          Save correction
        </button>
        <button
          onClick={() => onAct(item._id, "rejected")}
          className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors duration-200 hover:border-red-300 hover:text-red-600"
        >
          <FiX className="h-4 w-4" aria-hidden /> Reject row
        </button>
      </div>
    </div>
  );
}
