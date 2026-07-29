# HANDOFF PROMPT — BK-Ingest continuation

**How to use:** open Claude Code (or any ADLM AI agent) in `C:\Users\ADLM\source\repos\bk-ingest`
and paste everything below the line as the first prompt.

---

You are picking up **BK-Ingest** — BuildersKonnect's AI catalog-onboarding PoC — exactly where
the previous session stopped on **19-Jul-2026**. I am Adedolapo Quasim (ADLM Studio), engineer
of record; I ratify decisions. Evaluation day with the client is **31-Jul-2026**.

## Read first, in this order
1. `docs/BUILD_REPORT.md` — full system summary and final metrics (Word version:
   `docs/BK_Ingest_Build_Report.docx`).
2. `docs/DECISIONS.md` — D12–D18 ratified, D19 open. D1–D11 live in the KB + Addendum.
3. `docs/CONCIERGE_PROMPT.md` — the ratified Milestone F spec (Konnect Concierge easter egg),
   **plus the council-review conditions in this handoff §3** which amend it.
4. `docs/BK_PoC_Acceptance_Tests_and_Evaluation_Strategy.pdf` — the closed T1–T8 contract.

## 1. State of the build (all verified 19-Jul)
- Milestones A–E complete. T1/T3/T4/T5/T6/T7/T8 **PASS**; T2 = 94.7% interim
  (100% post-Stage-5) — final only after my ground-truth verification.
- 57/57 Vitest tests green (`cd server && npx vitest run`); client builds clean.
- Deployed: client `https://bk-po-c.vercel.app` (Vercel, `VITE_API_BASE` set), API
  `https://bk-poc-1.onrender.com` (Render free; env vars in dashboard; CORS normalizes origins
  and auto-allows `bk-po-c*.vercel.app` previews). Auto-deploy from GitHub `main`
  (`adedola12/Bk-PoC`).
- Data: Atlas `bkIngest` holds 42 IPR rows (21 Twyford template + 1 Alca + 10 Jaquar +
  10 Artize incl. derived variants), taxonomy (49 nodes + 4 BK crosswalk IDs), brands, price
  events, todos. Latest emission: 42/42 rows, 100% zero-touch, Cloudinary covers live.
- UX added last: sticky toolbars with search on Triage Verify + Products, bulk
  **Confirm all** (`POST /api/triage/verify-all`), marketplace product cards, weblink
  ingestion (D16) with bounded crawl + honest dead-ends (Scribd-style viewer guidance).

## 2. Blockers cleared by me before you start coding
- **Anthropic credits**: the client is topping up. Until funded, every AI call fails (the
  system degrades honestly — uploads route to human triage). Confirm credits before any AI run.
- **Ground-truth verification (my 30-min task)**: verify values in `ground-truth/*.json`
  against the source datasheets, flip `status` to `human_verified`. This finalizes T2.

## 3. Work queue, in priority order
1. **Full systems check for the demo**: `npm run eval -- --full` in `server/` (fresh scorecard
   incl. full 104-pp T7); verify both deployed links end-to-end; re-run the T2 scorer after my
   ground-truth verification.
2. **Milestone F — Konnect Concierge** per `docs/CONCIERGE_PROMPT.md`, AMENDED by the
   council-ratified conditions: (a) credits + ground-truth done first; (b) `VITE_CONCIERGE`
   default **off** in production, demo reveal from localhost; (c) hard no-go — if F-gates
   aren't green and rehearsed by **28-Jul**, flag stays off, demo runs without it;
   (d) build F1 (grounded chat + enquiries) first — image search is jettisonable;
   (e) T9/T10 labelled "supplementary — non-ratified", separate eval section; code freeze on
   everything else after 28-Jul. Log as D20 when starting. Gate each F-milestone with me.
3. **Demo rehearsal**: full arc on the deployed stack (script in `docs/BUILD_REPORT.md` §7);
   warm Render ~2 min before; quote T7 from local hardware.
4. **Backlog if time allows**: D19 re-upload identity dedupe (same file re-processed should
   delta-update via Upload Ledger, not duplicate rows).

## 4. House rules (bind everything)
- Docs are law; when they don't answer, ASK me and log D-numbered decisions in
  `docs/DECISIONS.md`. Flag, never silently fix. Raw values sacred. Never guess IDs/brands/
  specs. `fixtures/` read-only; artifacts → `runs/<timestamp>/`. Tests green before every
  commit; small conventional commits; secrets only in root `.env` (gitignored).
- Code style: ADLM house layout (client/ + server/, PascalCase named-export models,
  `{ error }` API responses, `React.*` hooks in new client code is NOT the pattern here —
  this client uses bare hook imports; follow the existing files).
- Known Windows/dev gotchas already solved — don't regress them: `pdfjs-dist` pinned exact
  `4.2.67` (pdf-to-img worker clash), Anthropic + Cloudinary clients constructed lazily
  (ESM import hoisting vs dotenv), vitest `fileParallelism: false`, `.env` lives at repo root.

Start by confirming the two §2 blockers with me, then run the full systems check (§3.1) and
report the scorecard before touching Milestone F.
