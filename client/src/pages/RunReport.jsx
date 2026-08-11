import React from "react";
import { toast } from "react-toastify";
import { IconCheckCircle, IconXCircle, IconClock } from "../icons.jsx";
import { fetchLatestReport, errMsg } from "../api.js";

const TestRow = ({ id, name, entry }) => {
  const pending = typeof entry === "string";
  const pass = !pending && entry?.pass;
  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-2.5 font-mono text-xs font-bold">{id}</td>
      <td className="px-4 py-2.5">{name}</td>
      <td className="max-w-md px-4 py-2.5 text-xs text-slate-600">{pending ? entry : entry?.metric}</td>
      <td className="px-4 py-2.5">
        {pending ? (
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <IconClock className="h-3.5 w-3.5" aria-hidden /> pending
          </span>
        ) : pass ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
            <IconCheckCircle className="h-4 w-4" aria-hidden /> PASS
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-semibold text-red-700">
            <IconXCircle className="h-4 w-4" aria-hidden /> {entry?.pass === false && entry?.metric?.includes("%") ? "REVIEW" : "FAIL"}
          </span>
        )}
      </td>
    </tr>
  );
};

/* ─── the T1–T8 scorecard + latest emission, straight from runs/ ─── */
export default function RunReport() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetchLatestReport()
      .then(setData)
      .catch((err) => toast.error(errMsg(err, "Could not load reports")))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-slate-200/70" />;
  const s = data?.scorecard;
  const e = data?.emission;

  return (
    <div>
      <h2 className="text-2xl font-bold text-bk-navy">Run report</h2>
      <p className="mt-1 mb-6 text-sm text-slate-600">
        Latest scorecard {data?.scorecardRun ? `(run ${data.scorecardRun})` : ""} — every number reproducible via{" "}
        <code className="rounded bg-slate-100 px-1">npm run eval</code>.
      </p>

      {!s ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No scorecard yet — run the evaluation harness on the server.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Test</th>
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">Result</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              <TestRow id="T1" name="Document triage" entry={s.T1} />
              <TestRow id="T2" name="Field accuracy (interim)" entry={s.T2_interim} />
              <TestRow id="T3" name="Zero-touch rate" entry={s.T3} />
              <TestRow id="T4" name="Safety — no silent errors" entry={s.T4} />
              <TestRow id="T5" name="Pricing policy" entry={s.T5} />
              <TestRow id="T6" name="Variant policy" entry={s.T6} />
              <TestRow id="T7" name="Throughput" entry={s.T7} />
              <TestRow id="T8" name="No silent dismissal" entry={s.T8} />
            </tbody>
          </table>
        </div>
      )}

      {e && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
            Latest emission {data.emissionRun && `(run ${data.emissionRun})`}
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Rows emitted" value={e.emittedRows} />
            <Stat label="Zero-touch" value={`${(e.zeroTouch * 100).toFixed(0)}%`} />
            <Stat label="PASS / TODO / REVIEW" value={`${e.dispositions?.PASS} / ${e.dispositions?.TODO} / ${e.dispositions?.REVIEW}`} />
            <Stat label="Wall clock" value={`${((e.wallMs ?? 0) / 1000).toFixed(0)}s`} />
          </div>
          {e.perCatalog && (
            <table className="mt-4 w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 pr-4 font-semibold">Catalog</th>
                  <th className="py-1 pr-4 font-semibold">Rows</th>
                  <th className="py-1 pr-4 font-semibold">Zero-touch</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(e.perCatalog).map(([file, c]) => (
                  <tr key={file} className="border-t border-slate-100">
                    <td className="max-w-xs truncate py-1.5 pr-4">{file}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{c.total}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{(((c.PASS + c.TODO) / c.total) * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {e.exemptions && Object.keys(e.exemptions).length > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              D17 category exemptions (pending BK per-category templates):{" "}
              {Object.entries(e.exemptions).map(([col, n]) => `${col} ×${n}`).join(" · ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const Stat = ({ label, value }) => (
  <div className="rounded-md bg-slate-50 px-3 py-2">
    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    <p className="mt-0.5 text-lg font-bold text-bk-navy tabular-nums">{value}</p>
  </div>
);
