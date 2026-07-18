import React from "react";
import { toast } from "react-toastify";
import { fetchCompare, fetchPriceHistory, errMsg } from "../api.js";

const CATEGORIES = [
  "Plumbing & Sanitary Ware > Bathroom Accessories",
  "Plumbing & Sanitary Ware > Concealed Cisterns & Installation Systems",
  "Tools & Equipment > Power Tools",
];

/* ─── D10: append-only ledger → per-SKU history + cross-brand comparison ─── */
export default function PriceCompare() {
  const [category, setCategory] = React.useState(CATEGORIES[0]);
  const [rows, setRows] = React.useState([]);
  const [history, setHistory] = React.useState(null); // {sku, events}
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    fetchCompare(category)
      .then((d) => setRows(d.rows ?? []))
      .catch((err) => toast.error(errMsg(err, "Could not load comparison")))
      .finally(() => setLoading(false));
  }, [category]);

  const showHistory = async (sku) => {
    try {
      const events = await fetchPriceHistory(sku);
      setHistory({ sku, events });
    } catch (err) {
      toast.error(errMsg(err, "Could not load history"));
    }
  };

  const priced = rows.filter((r) => r.price != null);
  const brands = [...new Set(priced.map((r) => r.brand))];

  return (
    <div>
      <h2 className="text-2xl font-bold text-bk-navy">Price compare</h2>
      <p className="mt-1 mb-4 text-sm text-slate-600">
        Latest price per SKU from the append-only ledger — {brands.length} brand(s) priced in this category.
      </p>

      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500" htmlFor="cat">
        Category
      </label>
      <select
        id="cat"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="mt-1 mb-6 block w-full max-w-xl rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
      >
        {CATEGORIES.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>

      {loading ? (
        <div className="h-24 animate-pulse rounded-lg bg-slate-200/70" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">SKU</th>
                <th className="px-4 py-3 font-semibold">Product</th>
                <th className="px-4 py-3 font-semibold">Brand</th>
                <th className="px-4 py-3 font-semibold">Latest price</th>
                <th className="px-4 py-3 font-semibold">Method</th>
                <th className="px-4 py-3 font-semibold">History</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku} className="border-t border-slate-100 transition-colors duration-150 hover:bg-slate-50">
                  <td className="px-4 py-2 font-mono text-xs">{r.sku}</td>
                  <td className="max-w-xs truncate px-4 py-2">{r.name ?? "—"}</td>
                  <td className="px-4 py-2">{r.brand ?? "—"}</td>
                  <td className="px-4 py-2 tabular-nums">
                    {r.price != null ? `₦${Number(r.price).toLocaleString()}` : <span className="text-slate-400">no price → todo</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{r.method ?? "—"}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => showHistory(r.sku)}
                      className="text-xs font-medium text-bk-navy underline transition-colors duration-150 hover:text-bk-gold"
                    >
                      view
                    </button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    No products classified in this category yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {history && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-bk-navy">
              Price history — <span className="font-mono">{history.sku}</span>
            </h3>
            <button onClick={() => setHistory(null)} className="text-xs text-slate-400 hover:text-slate-600">
              close
            </button>
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            {history.events.map((e) => (
              <li key={e._id} className="flex justify-between border-b border-slate-100 pb-1">
                <span>
                  ₦{Number(e.price).toLocaleString()}{" "}
                  <span className="text-xs text-slate-400">({e.method}, {e.sourceFile})</span>
                </span>
                <span className="text-xs text-slate-500">{new Date(e.effectiveDate).toLocaleString()}</span>
              </li>
            ))}
            {!history.events.length && <li className="text-slate-400">No price events yet — appears in Todo (D4).</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
