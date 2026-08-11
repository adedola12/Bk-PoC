import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { FiUploadCloud, FiCheckSquare, FiBox } from "react-icons/fi";

/* ─────────── navigation — the three demo steps.
   The review queue, todo list, price comparison and run report stay routed
   (/review, /todo, /prices, /report) so they can be opened on demand, but
   they are off the main flow: load → process → fill. ─────────── */
const NAV = [
  { to: "/upload", step: 1, label: "Load file", icon: FiUploadCloud },
  { to: "/triage", step: 2, label: "Process file", icon: FiCheckSquare },
  { to: "/products", step: 3, label: "Fill template", icon: FiBox },
];

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

/** The numbered step badge, shared by the sidebar and the mobile bar. */
const StepBadge = ({ step, isActive, className = "h-5 w-5 text-[11px]" }) => (
  <span
    className={`flex shrink-0 items-center justify-center rounded-full font-bold ${className} ${
      isActive ? "bg-bk-gold text-bk-navy-deep" : "bg-white/15 text-white/70"
    }`}
    aria-hidden
  >
    {step}
  </span>
);

export default function App() {
  const location = useLocation();
  const today = new Date().toLocaleDateString("en-NG", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="flex min-h-screen">
      {/* ─────────── sidebar ─────────── */}
      <aside className="hidden w-60 shrink-0 flex-col bg-bk-navy-deep text-white sm:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-bk-gold font-extrabold text-bk-navy-deep">
            BK
          </span>
          <div>
            <p className="text-sm font-bold leading-tight">BK-Ingest</p>
            <p className="text-[11px] text-white/50">Catalog Onboarding</p>
          </div>
        </div>

        <nav className="mt-2 flex-1 space-y-1 px-3">
          {NAV.map(({ to, step, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors duration-200 ${
                  isActive
                    ? "bg-bk-navy-mid text-bk-gold-soft"
                    : "text-white/70 hover:bg-bk-navy hover:text-white"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <StepBadge step={step} isActive={isActive} />
                  <Icon className="h-4.5 w-4.5 shrink-0" aria-hidden />
                  {label}
                </>
              )}
            </NavLink>
          ))}

        </nav>

        <p className="px-5 py-4 text-[11px] leading-relaxed text-white/40">
          Nothing wrong enters silently.
          <br />
          Nothing is dismissed silently.
        </p>
      </aside>

      {/* ─────────── main ─────────── */}
      <div className="min-w-0 flex-1">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              {/* The sidebar carries the brand from `sm` up; below that it is
                  hidden, so without this the app is unbranded on a phone. */}
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bk-gold text-sm font-extrabold text-bk-navy-deep sm:hidden">
                BK
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold text-bk-navy sm:text-lg">
                  {greeting()}, Adedolapo
                </h1>
                <p className="truncate text-xs text-slate-500">{today}</p>
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-bk-gold/40 bg-bk-gold/10 px-3 py-1 text-[11px] font-semibold text-bk-navy sm:text-xs">
              PoC · Full pipeline
            </span>
          </div>
        </header>

        <motion.main
          key={location.pathname}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          /* pb-28 on mobile clears the fixed step bar below; without it the
             last row of any page sits underneath it and cannot be reached. */
          className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-6 sm:pb-8"
        >
          <Outlet />
        </motion.main>
      </div>

      {/* ─────────── mobile step bar ───────────
          The sidebar is `sm:flex`, so below 640px there was NO navigation at
          all — on a phone you could not move between the three steps. Three
          fixed tabs instead: always visible, thumb-height, same numbering. */}
      <nav
        aria-label="Steps"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-white/10 bg-bk-navy-deep pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        {NAV.map(({ to, step, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium transition-colors duration-200 ${
                isActive ? "text-bk-gold-soft" : "text-white/60"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className="flex items-center gap-1.5">
                  <StepBadge step={step} isActive={isActive} className="h-4 w-4 text-[10px]" />
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="truncate">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <ToastContainer position="top-right" autoClose={3000} hideProgressBar newestOnTop />
    </div>
  );
}
