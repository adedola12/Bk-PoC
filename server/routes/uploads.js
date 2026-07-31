import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { UploadLedger } from "../models/UploadLedger.js";
import { triageFile } from "../stages/stage0_triage.js";
import { createRun, toRunRelative } from "../services/runs.js";
import { fetchUrl, htmlToText, productSignal, crawlForProducts } from "../services/weburl.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ─── POST / — intake + Stage 0 triage ─── */
router.post("/", upload.array("files", 20), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: "No files uploaded" });

    const run = createRun("intake");
    const intakeDir = path.join(run.dir, "intake");
    fs.mkdirSync(intakeDir, { recursive: true });

    const results = [];
    for (const f of req.files) {
      // basename, not the raw upload name: multer reports whatever the client
      // sent, and "../../x" would otherwise write outside the run directory.
      const storedPath = path.join(intakeDir, path.basename(f.originalname));
      fs.writeFileSync(storedPath, f.buffer);
      const sha256 = crypto.createHash("sha256").update(f.buffer).digest("hex");

      const started = Date.now();
      const triage = await triageFile(storedPath, {
        log: run.log,
        previewsDir: path.join(run.dir, "previews"),
      });
      run.log({ kind: "triage", file: f.originalname, ms: Date.now() - started, label: triage.label });

      const doc = await UploadLedger.create({
        originalName: f.originalname,
        storedPath: toRunRelative(storedPath),
        previewPath: toRunRelative(triage.previewPath),
        mimeType: f.mimetype,
        size: f.size,
        sha256,
        runId: run.runId,
        triage,
      });
      results.push(doc);
    }
    res.status(201).json({ runId: run.runId, items: results });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /api/uploads/url — D16: ingest from a manufacturer weblink.
   Direct file link → triage as a file. Product page → its text is the source.
   Site root/homepage → bounded crawl of its most product-looking links;
   crawled catalogue FILES (pdf/xlsx) enter triage individually. A JS-rendered
   site that yields nothing gets an honest D11 verification entry explaining
   what to provide instead — never a silent no-op. ─── */
router.post("/url", async (req, res, next) => {
  try {
    const { url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url required" });

    const fetched = await fetchUrl(url); // SSRF-guarded, 25 MB cap
    const run = createRun("url-intake");
    const intakeDir = path.join(run.dir, "intake");
    fs.mkdirSync(intakeDir, { recursive: true });
    const host = new URL(fetched.finalUrl).hostname.replace(/^www\./, "");

    const saveEntry = async (fileName, buffer, contentType, sourceUrl, presetTriage = null) => {
      const storedPath = path.join(intakeDir, fileName);
      fs.writeFileSync(storedPath, buffer);
      const triage =
        presetTriage ??
        (await triageFile(storedPath, { log: run.log, previewsDir: path.join(run.dir, "previews") }));
      run.log({ kind: "triage", file: fileName, url: sourceUrl, label: triage.label });
      return UploadLedger.create({
        originalName: fileName,
        storedPath: toRunRelative(storedPath),
        previewPath: toRunRelative(triage.previewPath ?? null),
        mimeType: contentType,
        size: buffer.length,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        sourceUrl,
        runId: run.runId,
        triage,
      });
    };

    // 1 — direct file link (pdf/xlsx/docx/image): standard flow
    if (fetched.kind === "file") {
      const urlName = path.basename(new URL(fetched.finalUrl).pathname) || "download";
      const fileName = urlName.toLowerCase().endsWith(fetched.ext) ? urlName : `${urlName}${fetched.ext}`;
      const doc = await saveEntry(fileName, fetched.buffer, fetched.contentType, fetched.finalUrl);
      return res.status(201).json({ runId: run.runId, items: [doc] });
    }

    // 2 — HTML page: does THIS page already carry product content?
    const rootHtml = fetched.buffer.toString("utf8");
    const rootText = htmlToText(rootHtml);
    const signal = productSignal(rootText);
    const items = [];

    if (signal.score >= 8 && signal.chars > 600) {
      const doc = await saveEntry(`${host}.html`, fetched.buffer, fetched.contentType, fetched.finalUrl);
      items.push(doc);
    } else {
      // 3 — homepage / thin page: bounded crawl of product-looking links
      run.log({ kind: "crawl_start", url: fetched.finalUrl, signal });
      const crawl = await crawlForProducts(rootHtml, fetched.finalUrl, { maxPages: 6 });
      run.log({ kind: "crawl_done", followed: crawl.followed.length, pages: crawl.pages.length, files: crawl.files.length });

      for (const f of crawl.files) {
        const name = path.basename(new URL(f.url).pathname) || `download${f.ext}`;
        items.push(await saveEntry(name.endsWith(f.ext) ? name : `${name}${f.ext}`, f.buffer, f.contentType, f.url));
      }
      if (crawl.pages.length) {
        const combined = crawl.pages.map((p) => `[source: ${p.url}]\n${p.text}`).join("\n\n");
        items.push(
          await saveEntry(`${host}-products.html`, Buffer.from(combined, "utf8"), "text/html", fetched.finalUrl)
        );
      }

      if (!items.length) {
        // honest dead-end: JS-rendered or no product-bearing links reachable.
        // Document-viewer sites (Scribd etc.) get targeted guidance — the
        // document exists but lives behind a JS viewer, not in the page HTML.
        const isViewer = /scribd|issuu|slideshare|docdroid|calameo|yumpu/i.test(host);
        const summary = isViewer
          ? `${host} is a document-viewer site — the catalogue itself is displayed inside a JavaScript viewer and is not part of the page we can read. Use the viewer's Download button to save the PDF, then upload that file here (or paste a direct .pdf link).`
          : `No product data reachable from ${host} — the site appears to render its catalog with JavaScript. Ask the vendor for a direct catalogue link (PDF/Excel), a printable product page, or use file upload. Followed ${crawl.followed.length} candidate link(s).`;
        items.push(
          await saveEntry(`${host}.html`, fetched.buffer, fetched.contentType, fetched.finalUrl, {
            label: "other",
            confidence: 0.3,
            method: "rule",
            summary,
            signals: { signal, followed: crawl.followed },
            needsVerification: true,
            previewPath: null,
          })
        );
      }
    }

    res.status(201).json({ runId: run.runId, items });
  } catch (err) {
    next(err);
  }
});

export default router;
