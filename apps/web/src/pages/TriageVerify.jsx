import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { fetchTriage, verifyTriage } from "../api.js";

const LABELS = ["bk_template", "catalogue", "product_datasheet", "product_image", "vendor_document", "other"];

const badge = (label) =>
  ({
    bk_template: "bg-indigo-100 text-indigo-700",
    catalogue: "bg-blue-100 text-blue-700",
    product_datasheet: "bg-sky-100 text-sky-700",
    product_image: "bg-emerald-100 text-emerald-700",
    vendor_document: "bg-amber-100 text-amber-800",
    other: "bg-slate-200 text-slate-600",
  })[label] || "bg-slate-200 text-slate-600";

/* ─── D11: no silent dismissal — non-product files need explicit confirmation ─── */
export default function TriageVerify() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () =>
    fetchTriage()
      .then(setItems)
      .catch(() => toast.error("Could not load triage queue"))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  const act = async (id, payload) => {
    try {
      await verifyTriage(id, payload);
      toast.success(payload.confirm ? "Classification confirmed" : `Reclassified as ${payload.label}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Verification failed");
    }
  };

  const pending = items.filter((i) => i.triage?.needsVerification);
  const rest = items.filter((i) => !i.triage?.needsVerification);

  if (loading) return <p className="text-slate-500">Loading…</p>;

  return (
    <div>
      <h2 className="mb-1 text-2xl font-semibold text-bk-navy">Triage verification</h2>
      <p className="mb-6 text-sm text-slate-500">
        {pending.length
          ? `${pending.length} file(s) require human confirmation before filing (D11).`
          : "No files awaiting verification."}
      </p>

      {pending.map((item) => (
        <div key={item._id} className="mb-4 rounded-lg border-2 border-amber-300 bg-white p-4 shadow-sm">
          <VerifyCard item={item} onAct={act} />
        </div>
      ))}

      {rest.length > 0 && (
        <>
          <h3 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Classified uploads
          </h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2">File</th>
                  <th className="px-4 py-2">Route</th>
                  <th className="px-4 py-2">Confidence</th>
                  <th className="px-4 py-2">Method</th>
                  <th className="px-4 py-2">Verified</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((i) => (
                  <tr key={i._id} className="border-t border-slate-100">
                    <td className="max-w-xs truncate px-4 py-2">{i.originalName}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge(i.triage?.verifiedLabel || i.triage?.label)}`}>
                        {i.triage?.verifiedLabel || i.triage?.label}
                      </span>
                    </td>
                    <td className="px-4 py-2">{i.triage?.confidence?.toFixed(2)}</td>
                    <td className="px-4 py-2">{i.triage?.method}</td>
                    <td className="px-4 py-2">{i.triage?.verified ? "✅" : "—"}</td>
                  </tr>
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
  const [label, setLabel] = useState(item.triage?.label || "other");

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      {/* D11: document snapshot preview */}
      <div className="w-full shrink-0 sm:w-48">
        {item.previewPath ? (
          <img
            src={`/api/triage/${item._id}/preview`}
            alt={`First page of ${item.originalName}`}
            className="rounded border border-slate-200"
          />
        ) : (
          <div className="flex h-32 items-center justify-center rounded border border-slate-200 bg-slate-50 text-xs text-slate-400">
            no snapshot
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-bk-navy">{item.originalName}</p>
        <p className="mt-0.5 text-xs text-slate-400">
          classified <span className={`rounded px-1.5 py-0.5 font-medium ${badge(item.triage?.label)}`}>{item.triage?.label}</span>{" "}
          · confidence {item.triage?.confidence?.toFixed(2)} · {item.triage?.method}
        </p>
        <p className="mt-2 text-sm text-slate-600">{item.triage?.summary}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => onAct(item._id, { confirm: true })}
            className="rounded-md bg-bk-navy px-3 py-1.5 text-sm font-medium text-white hover:bg-bk-navy-deep"
          >
            Confirm classification
          </button>
          <select
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {LABELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <button
            onClick={() => onAct(item._id, { confirm: false, label })}
            className="rounded-md border border-bk-gold px-3 py-1.5 text-sm font-medium text-bk-navy hover:bg-bk-gold-soft/30"
          >
            Reclassify
          </button>
        </div>
      </div>
    </div>
  );
}
