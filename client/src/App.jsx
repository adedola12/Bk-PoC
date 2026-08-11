import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { IconUploadCloud, IconCheckSquare, IconBox, IconMenu, IconX } from "./icons.jsx";

/* ─────────── navigation — the three demo steps.
   The review queue, todo list, price comparison and run report stay routed
   (/review, /todo, /prices, /report) so they can be opened on demand, but
   they are off the main flow: load → process → fill. ─────────── */
const NAV = [
  { to: "/upload", step: 1, label: "Load file", icon: IconUploadCloud },
  { to: "/triage", step: 2, label: "Process file", icon: IconCheckSquare },
  { to: "/products", step: 3, label: "Fill template", icon: IconBox },
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

  // The same sidebar on a phone, as a drawer. Closed by default so it does not
  // cover the page, opened from the header.
  const [navOpen, setNavOpen] = React.useState(false);

  // Close on navigation, or the drawer stays over the page you just opened.
  React.useEffect(() => setNavOpen(false), [location.pathname]);

  // Escape closes it — a drawer with no visible way out is a trap on a phone.
  React.useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Below `sm` the sidebar slides; from `sm` up it is a static column and must
  // carry no transform at all. Driven from JS and applied inline because both
  // Tailwind's translate utilities and a plain stylesheet rule were losing to
  // the utility layer here — the panel stayed at -100% while the backdrop
  // showed, so the menu button looked dead. An inline style cannot be
  // outranked, which is what this needs to be.
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches
  );
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const drawerStyle = isMobile
    ? { transform: navOpen ? "translateX(0)" : "translateX(-100%)", transition: "transform 200ms ease-out" }
    : undefined;

  return (
    <div className="flex min-h-screen">
      {/* Backdrop: only below sm, only while open. */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-bk-navy-deep/60 backdrop-blur-sm sm:hidden"
        />
      )}

      {/* ─────────── sidebar ───────────
          Static from sm up. Below that it is the same panel, slid off-canvas
          and brought in by the header button — hiding it outright left a phone
          with no navigation at all. */}
      <aside
        data-open={navOpen}
        style={drawerStyle}
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-bk-navy-deep text-white sm:static sm:z-auto sm:w-60 ${
          navOpen ? "shadow-2xl" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => setNavOpen(false)}
          aria-label="Close menu"
          className="absolute right-3 top-4 rounded-md p-1.5 text-white/70 transition-colors duration-200 hover:bg-white/10 hover:text-white sm:hidden"
        >
          <IconX className="h-5 w-5" aria-hidden />
        </button>
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
              {/* Opens the sidebar below sm. Sized past the 44px touch minimum
                  and placed first, where a thumb reaches on a phone. */}
              <button
                type="button"
                onClick={() => setNavOpen(true)}
                aria-label="Open menu"
                aria-expanded={navOpen}
                className="-ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-bk-navy transition-colors duration-200 hover:bg-slate-100 sm:hidden"
              >
                <IconMenu className="h-6 w-6" aria-hidden />
              </button>
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
          className="mx-auto max-w-6xl px-4 py-8 sm:px-6"
        >
          <Outlet />
        </motion.main>
      </div>

      <ToastContainer position="top-right" autoClose={3000} hideProgressBar newestOnTop />
    </div>
  );
}
