import React from "react";
import { toast } from "react-toastify";
import { FiCheckCircle } from "react-icons/fi";
import { fetchTodos, todoDone, addManualPrice, errMsg } from "../api.js";

const TYPE_LABEL = {
  price_missing: "Price missing",
  media_missing: "Media missing",
  bk_id_pending: "BK category ID pending",
};

/* ─── D4: the todo queue is a first-class pipeline output ─── */
export default function Todo() {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    fetchTodos()
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((err) => toast.error(errMsg(err, "Could not load todos")))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const open = items.filter((i) => i.status === "open");
  const done = items.filter((i) => i.status === "done");

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-slate-200/70" />;

  return (
    <div>
      <h2 className="text-2xl font-bold text-bk-navy">Todo</h2>
      <p className="mt-1 mb-6 text-sm text-slate-600">
        {open.length} open · {done.length} done. Missing prices accept manual entry (D4) — history is append-only (D10).
      </p>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-semibold">Type</th>
              <th className="px-4 py-3 font-semibold">SKU</th>
              <th className="px-4 py-3 font-semibold">Detail</th>
              <th className="px-4 py-3 font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {open.map((item) => (
              <TodoRow key={item._id} item={item} onDone={load} />
            ))}
            {!open.length && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  No open todos.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TodoRow({ item, onDone }) {
  const [price, setPrice] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submitPrice = async () => {
    if (!(Number(price) > 0)) return toast.warn("Enter a positive price");
    setBusy(true);
    try {
      await addManualPrice({ sku: item.sku, brand: "unknown", vendor: item.vendor ?? "Satkay Limited", price: Number(price) });
      toast.success(`₦${Number(price).toLocaleString()} recorded for ${item.sku}`);
      onDone();
    } catch (err) {
      toast.error(errMsg(err, "Could not record price"));
    } finally {
      setBusy(false);
    }
  };

  const markDone = async () => {
    try {
      await todoDone(item._id);
      onDone();
    } catch (err) {
      toast.error(errMsg(err, "Could not update"));
    }
  };

  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-2.5">
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
          {TYPE_LABEL[item.type] ?? item.type}
        </span>
      </td>
      <td className="px-4 py-2.5 font-mono text-xs">{item.sku ?? "—"}</td>
      <td className="max-w-md truncate px-4 py-2.5 text-slate-600">{item.detail}</td>
      <td className="px-4 py-2.5">
        {item.type === "price_missing" ? (
          <span className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="₦ price"
              className="w-28 rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
            <button
              onClick={submitPrice}
              disabled={busy}
              className="rounded-md bg-bk-navy px-3 py-1 text-xs font-semibold text-white transition-colors duration-200 hover:bg-bk-navy-mid disabled:opacity-50"
            >
              Save
            </button>
          </span>
        ) : (
          <button
            onClick={markDone}
            className="flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 transition-colors duration-200 hover:border-emerald-400 hover:text-emerald-700"
          >
            <FiCheckCircle className="h-3.5 w-3.5" aria-hidden /> Done
          </button>
        )}
      </td>
    </tr>
  );
}
