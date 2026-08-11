import React from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { toast } from "react-toastify";
import { IconUploadCloud, IconFile, IconX, IconLink } from "../icons.jsx";
import { uploadFiles, uploadFromUrl, errMsg } from "../api.js";

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);

export default function Upload() {
  const [mode, setMode] = React.useState("files"); // files | url (D16)
  const [url, setUrl] = React.useState("");
  const [files, setFiles] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const navigate = useNavigate();

  const handleUrlSubmit = async (e) => {
    e.preventDefault();
    if (!/^https?:\/\//i.test(url)) return toast.warn("Paste a full http(s):// link");
    setBusy(true);
    try {
      const { items } = await uploadFromUrl(url);
      toast.success(`Fetched and triaged: ${items[0].originalName} → ${items[0].triage.label}`);
      navigate("/triage");
    } catch (err) {
      toast.error(errMsg(err, "Could not fetch that link"));
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (list) => {
    const incoming = [...list];
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...incoming.filter((f) => !names.has(f.name))];
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!files.length) return toast.warn("Choose at least one file");
    setBusy(true);
    try {
      const { items, runId } = await uploadFiles(files);
      toast.success(`${items.length} file(s) triaged — run ${runId.slice(0, 19)}`);
      navigate("/triage");
    } catch (err) {
      toast.error(errMsg(err, "Upload failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold text-bk-navy">Vendor upload</h2>
      <p className="mt-1 mb-4 text-sm text-slate-600">
        PDF, Excel, Word, images — or a manufacturer weblink (D16). Every source is classified
        before any extraction (D7) — nothing is filed silently (D11).
      </p>

      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1" role="tablist">
        {[
          { key: "files", label: "Upload files", Icon: IconUploadCloud },
          { key: "url", label: "From weblink", Icon: IconLink },
        ].map(({ key, label, Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors duration-200 ${
              mode === key ? "bg-white text-bk-navy shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {/* shrink-0: the tabs are flex-1, so without it the icon is the
                thing that gives way and renders squashed (11x16 for a 16x16
                box). Predates the icon-library change — the old set squashed
                identically. */}
            <Icon className="h-4 w-4 shrink-0" aria-hidden /> {label}
          </button>
        ))}
      </div>

      {mode === "url" && (
        <form onSubmit={handleUrlSubmit} className="rounded-lg border border-slate-200 bg-white p-6">
          <label htmlFor="weburl" className="text-sm font-semibold text-bk-navy">
            Catalogue / product page URL
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Direct PDF/Excel/image links enter triage as files; product web pages are read as
            catalogue sources.
          </p>
          <input
            id="weburl"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://manufacturer.com/catalog.pdf"
            className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-md bg-bk-navy px-4 py-2.5 font-semibold text-white transition-colors duration-200 hover:bg-bk-navy-mid disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Fetching & classifying…" : "Fetch & triage"}
          </button>
        </form>
      )}

      {mode === "files" && (
      <form onSubmit={handleSubmit} className="rounded-lg border border-slate-200 bg-white p-6">
        <label
          htmlFor="files"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-6 py-12 text-center transition-colors duration-200 ${
            dragOver ? "border-bk-gold bg-bk-gold/5" : "border-slate-300 hover:border-bk-gold"
          }`}
        >
          <IconUploadCloud className="mb-3 h-8 w-8 text-bk-navy" aria-hidden />
          <span className="text-sm font-semibold text-bk-navy">
            Drag files here, or click to browse
          </span>
          <span className="mt-1 text-xs text-slate-500">pdf · xlsx · docx · jpg · png — up to 20 files</span>
          <input
            id="files"
            type="file"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </label>

        {files.length > 0 && (
          <ul className="mt-4 space-y-2">
            {files.map((f, i) => (
              <motion.li
                key={f.name}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, delay: i * 0.04 }}
                className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
              >
                <IconFile className="h-4 w-4 shrink-0 text-bk-navy" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-slate-700">{f.name}</span>
                <span className="shrink-0 text-xs text-slate-500">{fmtSize(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((prev) => prev.filter((x) => x.name !== f.name))}
                  className="rounded p-1 text-slate-400 transition-colors duration-150 hover:bg-slate-200 hover:text-slate-700"
                >
                  <IconX className="h-4 w-4" />
                </button>
              </motion.li>
            ))}
          </ul>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-md bg-bk-navy px-4 py-2.5 font-semibold text-white transition-colors duration-200 hover:bg-bk-navy-mid disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Classifying with AI…" : `Upload & triage${files.length ? ` (${files.length})` : ""}`}
        </button>
      </form>
      )}
    </div>
  );
}
