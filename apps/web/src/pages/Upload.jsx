import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { uploadFiles } from "../api.js";

export default function Upload() {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!files.length) return toast.warn("Choose at least one file");
    setBusy(true);
    try {
      const { items, runId } = await uploadFiles(files);
      toast.success(`${items.length} file(s) triaged — run ${runId}`);
      navigate("/triage");
    } catch (err) {
      toast.error(err.response?.data?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-1 text-2xl font-semibold text-bk-navy">Vendor upload</h2>
      <p className="mb-6 text-sm text-slate-500">
        PDF, Excel, Word or images. Every file is classified before any extraction (D7) —
        nothing is filed silently (D11).
      </p>

      <form onSubmit={handleSubmit} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <label
          htmlFor="files"
          className="flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-slate-300 px-6 py-10 text-center hover:border-bk-gold"
        >
          <span className="text-sm font-medium text-bk-navy">Click to choose files</span>
          <span className="mt-1 text-xs text-slate-400">pdf · xlsx · docx · jpg · png (max 20)</span>
          <input
            id="files"
            type="file"
            multiple
            className="hidden"
            onChange={(e) => setFiles([...e.target.files])}
          />
        </label>

        {files.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm text-slate-600">
            {files.map((f) => (
              <li key={f.name} className="flex justify-between">
                <span className="truncate">{f.name}</span>
                <span className="ml-4 shrink-0 text-slate-400">{(f.size / 1024).toFixed(0)} KB</span>
              </li>
            ))}
          </ul>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-md bg-bk-navy px-4 py-2.5 font-medium text-white transition hover:bg-bk-navy-deep disabled:opacity-50"
        >
          {busy ? "Triaging…" : "Upload & triage"}
        </button>
      </form>
    </div>
  );
}
