import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import Upload from "./pages/Upload.jsx";
import TriageVerify from "./pages/TriageVerify.jsx";

const navCls = ({ isActive }) =>
  `px-4 py-2 rounded-md text-sm font-medium transition ${
    isActive ? "bg-bk-gold text-bk-navy-deep" : "text-white/80 hover:text-white"
  }`;

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="bg-bk-navy text-white shadow">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
          <h1 className="text-lg font-semibold tracking-wide">
            BK<span className="text-bk-gold">-Ingest</span>
          </h1>
          <nav className="flex gap-2">
            <NavLink to="/upload" className={navCls}>Upload</NavLink>
            <NavLink to="/triage" className={navCls}>Triage Verify</NavLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/upload" replace />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/triage" element={<TriageVerify />} />
          <Route path="*" element={<Navigate to="/upload" replace />} />
        </Routes>
      </main>

      <ToastContainer position="top-right" autoClose={3000} hideProgressBar newestOnTop />
    </div>
  );
}
