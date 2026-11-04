// Pieces of the layout sweep's cross-origin diagnostics (B55b), kept here so unit tests can run them without a browser.
//   XR_JS      runs in every page (Playwright addInitScript): records the page's cross-origin fetches that answered non-2xx or failed in window.__xr, and the Worker scripts it started in window.__wk.
//   sameOrigin(url, origin)   true when url parses and its origin equals origin (a parsed comparison, not a prefix: https://leeroy.party.evil.example is NOT same-origin with https://leeroy.party).
//   clip(text, n)             first n characters, with an ellipsis mark when cut.
//   formatDiag(msg, loc, st, workers)   the diagnostic suffix of a CORS console line: source, de-duplicated workers, cross-origin fetches. Each part has its own length budget, so a long message or long URLs cannot push the others out.
export function XR_JS() {
  try {
    window.__xr = []; window.__wk = [];
    const base = location.href, here = location.origin;
    const abs = (input) => {
      try {
        if (typeof input === "string") return new URL(input, base).href;
        if (input && typeof input.href === "string") return new URL(input.href, base).href; // URL object
        if (input && typeof input.url === "string") return new URL(input.url, base).href; // Request
        return new URL(String(input), base).href;
      } catch (e) { return ""; }
    };
    const cross = (u) => { try { const p = new URL(u); return /^https?:$/.test(p.protocol) && p.origin !== here; } catch (e) { return false; } };
    const f = window.fetch;
    if (typeof f === "function") window.fetch = function (input) {
      const u = abs(input), x = u && cross(u);
      const p = f.apply(this, arguments);
      if (x) p.then((r) => { if (!r.ok) window.__xr.push({ u, s: r.status }); }, (e) => window.__xr.push({ u, err: String((e && e.message) || e).slice(0, 80) }));
      return p;
    };
    const W = window.Worker;
    if (typeof W === "function") {
      window.Worker = function (url, o) { const u = abs(url); if (u) window.__wk.push(u); return new W(url, o); };
      window.Worker.prototype = W.prototype;
    }
  } catch (e) {}
}

export function sameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch (e) { return false; }
}

export const clip = (text, n) => { const t = String(text); return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t; };

// Each part has its OWN reserved budget and the parts are joined without a final cut, so no part can push another out:
// the longest possible output is msg + source + workers + fetches + separators, and every fetch URL (clipped to fetchUrl) is always present.
export const LIMITS = { msg: 400, source: 300, workerUrl: 160, workers: 8, fetchUrl: 200, fetches: 8, errText: 80 };
// 8 x (160 + 4) + 22 for the workers part, 8 x (200 + errText + 24) + 40 for the fetches part
export const MAX_DIAG = LIMITS.msg + LIMITS.source + (LIMITS.workers * (LIMITS.workerUrl + 4) + 40) + (LIMITS.fetches * (LIMITS.fetchUrl + LIMITS.errText + 24) + 40) + 30;

export function formatDiag(msg, loc, st, workers) {
  const L = LIMITS, out = [];
  out.push(clip(msg, L.msg));
  if (loc && loc.url) out.push(`[source ${clip(`${loc.url}:${loc.lineNumber}`, L.source)}]`);
  const wk = [...new Set([...(workers || []), ...((st && st.wk) || [])])];
  out.push(`[workers ${JSON.stringify(wk.slice(0, L.workers).map((u) => clip(u, L.workerUrl)))}${wk.length > L.workers ? ` +${wk.length - L.workers} more` : ""}]`);
  const xr = ((st && st.xr) || []);
  out.push(`[cross-origin fetches ${JSON.stringify(xr.slice(-L.fetches).map((x) => ({ ...x, u: clip(x.u, L.fetchUrl), ...(x.err ? { err: clip(x.err, L.errText) } : {}) })))}]`);
  return out.join(" ");
}

// Records a console error at once (the scene and the failure are fixed synchronously, so a later navigation or a hung page cannot lose or mislabel it)
// and attaches the diagnostic afterwards. `record(text)` returns the failure object (or null for a duplicate); `evaluate()` reads window.__xr / __wk
// from the page and may hang or throw: the failure then still carries the message source and the workers Playwright reported.
// The promise is added to `pending`; the caller awaits Promise.allSettled([...pending]) before the cell closes.
export function captureConsoleError({ text, loc, record, evaluate, workers, pending, timeoutMs = 3000 }) {
  const entry = record(text);
  if (!entry) return null;
  entry.diag = formatDiag(text, loc, null, workers()); // already useful if the page never answers
  let timer;
  const gone = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("diagnostic read timed out")), timeoutMs); });
  const p = Promise.race([Promise.resolve().then(evaluate), gone])
    .then((st) => { entry.diag = formatDiag(text, loc, st, workers()); }, () => {})
    .finally(() => { clearTimeout(timer); pending.delete(p); });
  pending.add(p);
  return p;
}
