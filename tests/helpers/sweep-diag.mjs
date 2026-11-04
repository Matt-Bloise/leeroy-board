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

export const LIMITS = { msg: 400, source: 300, workerUrl: 240, workers: 8, fetchUrl: 240, fetches: 8, total: 2600 };

export function formatDiag(msg, loc, st, workers) {
  const L = LIMITS, out = [];
  out.push(clip(msg, L.msg));
  if (loc && loc.url) out.push(`[source ${clip(`${loc.url}:${loc.lineNumber}`, L.source)}]`);
  const wk = [...new Set([...(workers || []), ...((st && st.wk) || [])])];
  out.push(`[workers ${JSON.stringify(wk.slice(0, L.workers).map((u) => clip(u, L.workerUrl)))}${wk.length > L.workers ? ` +${wk.length - L.workers} more` : ""}]`);
  const xr = ((st && st.xr) || []);
  out.push(`[cross-origin fetches ${JSON.stringify(xr.slice(-L.fetches).map((x) => ({ ...x, u: clip(x.u, L.fetchUrl) })))}]`);
  return clip(out.join(" "), L.total);
}
