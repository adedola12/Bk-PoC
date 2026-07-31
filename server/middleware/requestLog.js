/**
 * Request log — Render's log is the only window into a running deploy (no
 * shell on the free plan), and without this it shows nothing but startup and
 * 5xx stacks, so a slow extraction and an idle service look identical.
 *
 * One line per request, emitted on finish so status and duration are real.
 * Never logs bodies, headers or query strings: uploads carry customer data and
 * query strings carry filters we don't need in a shared log.
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.write] - sink, defaults to console.log
 * @param {number} [opts.slowMs] - duration above which a request is marked slow
 */
export function requestLog({ write = console.log, slowMs = 10000 } = {}) {
  return function requestLogger(req, res, next) {
    const started = Date.now();
    res.on("finish", () => {
      // Render probes /healthz constantly; logging the successes drowns
      // everything else, but a failing health check is worth seeing.
      const isHealth = req.path === "/health" || req.path === "/healthz";
      if (isHealth && res.statusCode < 400) return;
      const ms = Date.now() - started;
      write(`${mark(res.statusCode, ms, slowMs)} ${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${ms}ms`);
    });
    next();
  };
}

function mark(status, ms, slowMs) {
  if (status >= 500) return "✖";
  if (status >= 400) return "▲";
  return ms > slowMs ? "…" : "·";
}
