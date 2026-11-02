// Degraded-modes check: what a visitor gets when something around the page fails. A blank or frozen screen is the worst outcome.
//   node degraded-modes.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Optional: --host-map "local.leeroy.party=127.0.0.1" points a made-up board host at a local static server (Chromium --host-resolver-rules, http, so use a host that is
//   not on an HSTS list such as .dev), so a local run takes the same code path as the web (the API address is only used off localhost). Optional env PREVIEW_API = the preview Worker origin, aborted too.
// Every condition runs at 390x844 touch and 1366x768 (zoom conditions use their own small viewport), on a first visit and on a repeat visit (the name remembered
// under the localStorage key board-me). Each run passes only when, inside the budget (6 s; the slow-network run: a first paint inside 3 s):
//   the body shows at least 40 visible characters, at least one link or control is visible and focusable, and the page threw no uncaught error.
// Conditions: the API aborted, answering 500, or held for 12 s; JavaScript off (a visible <noscript> note with a link); storage, IndexedDB and cookies throwing,
// and storage access itself throwing; analytics blocked (also: no console error from our code); reduced motion, forced colours, dark scheme, more contrast;
// zoom equivalents (640x360, 480x270, text at 200 percent); a very slow network (400 kbps, 800 ms); a stale index.html whose script 404s.
// Makes no AI call and sends nothing. Chromium only. Exit 0 when every check passes, 1 otherwise.
// Late rejections from routes or pages that closed with the context are not test failures; anything else still fails the run.
process.on("unhandledRejection", (e) => { if (/Target page, context or browser has been closed/.test(String(e && e.message || e))) return; console.error(e); process.exit(1); });
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node degraded-modes.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const HOST_MAP = arg("--host-map"), ONLY = arg("--only"), POOL = +(arg("--pool") || 3);
const url = `${BASE.replace(/\/$/, "")}/?preview=1`, origin = new URL(BASE).origin;
const API_ORIGIN = (() => { try { return process.env.PREVIEW_API ? new URL(process.env.PREVIEW_API).origin : null; } catch (e) { return null; } })();
let pass = 0, fail = 0; const lines = [];
const ok = (name, cond, extra = "") => { if (cond) pass++; else fail++; lines.push(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? `: ${extra}` : ""}`); };

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, LAPTOP = { viewport: { width: 1366, height: 768 } };
const SIZES = [["390x844", PHONE], ["1366x768", LAPTOP]];
const isApi = (u) => { try { const x = new URL(u); return x.hostname === "api.leeroy.party" || (API_ORIGIN && x.origin === API_ORIGIN) || /\.workers\.dev$/.test(x.hostname) || (x.origin === origin && /^\/api\//.test(x.pathname)); } catch (e) { return false; } };
const isInsights = (u) => /static\.cloudflareinsights\.com|\/cdn-cgi\/rum/.test(u);
const routeApi = async (ctx, fn) => { await ctx.route((u) => isApi(u.href), fn); if (ctx.routeWebSocket) await ctx.routeWebSocket((u) => isApi(u.href.replace(/^ws/, "http")), (ws) => ws.close()); }; /* the live socket is the API too */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the in-page probe: visible characters and visible, focusable links or controls */
const probe = () => {
  const shown = (e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); if (!(r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none") || e.closest("[hidden],[inert]")) return false; for (let n = e; n && n.nodeType === 1; n = n.parentElement) if (+getComputedStyle(n).opacity === 0) return false; return true; }; /* opacity counts through the ancestors: a card still fading in is not visible */
  const text = (document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim();
  const ctl = [...document.querySelectorAll("a[href],button,input,select,textarea,summary,[tabindex]")].filter((e) => !e.disabled && e.tabIndex >= 0 && shown(e));
  const paint = performance.getEntriesByType ? performance.getEntriesByType("paint").map((p) => p.name) : [];
  return { len: text.length, text: text.slice(0, 70), ctl: ctl.length, paint };
};

/* conditions: id, label, optional ctx options, optional sizes, setup(ctx, page, cdp, state), after(page) once usable. */
const MEDIA = (f) => async (ctx, page, cdp) => { await cdp.send("Emulation.setEmulatedMedia", { features: f }); };
const failReq = (kind) => (ctx) => routeApi(ctx, async (route) => {
  // A route can still be pending when the context closes; that rejects with TargetClosedError, which must not crash the suite (seen on PRs 130 and 131, Nov 2).
  if (kind === "abort") return route.abort().catch(() => {});
  if (kind === "500") return route.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"boom\"}" }).catch(() => {});
  await sleep(12000); await route.abort().catch(() => {});
});
const STORAGE_METHODS = () => {
  const boom = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  for (const m of ["getItem", "setItem", "removeItem", "clear", "key"]) { try { Object.defineProperty(Storage.prototype, m, { configurable: true, value: boom }); } catch (e) {} }
  try { Object.defineProperty(indexedDB.constructor.prototype, "open", { configurable: true, value: boom }); } catch (e) {}
  try { Object.defineProperty(Document.prototype, "cookie", { configurable: true, get: boom, set: boom }); } catch (e) {}
};
const STORAGE_ACCESS = () => {
  const boom = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  for (const k of ["localStorage", "sessionStorage", "indexedDB"]) { try { Object.defineProperty(window, k, { configurable: true, get: boom }); } catch (e) {} }
  try { Object.defineProperty(Document.prototype, "cookie", { configurable: true, get: () => undefined, set: () => {} }); } catch (e) {}
};
/* a stale index: the document is served with one script address that does not exist (404) */
const stale = (which) => async (ctx) => {
  await ctx.route((u) => /\/js\/stale-/.test(u.pathname), (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }));
  await ctx.route((u) => u.origin === origin && /\/(index\.html)?$/.test(u.pathname), async (route) => {
    try {
      const real = HOST_MAP ? route.request().url().replace(/^(https?:\/\/)[^/:]+/, `$1${HOST_MAP.split("=")[1]}`) : undefined; /* the node side does not use the browser's host map */
      const r = await route.fetch(real ? { url: real } : {}); let body = await r.text();
      body = body.replace(new RegExp(`js/${which}\\.js\\?v=[0-9a-f]+`), `js/stale-${which}.js?v=0000000000`);
      const headers = { ...r.headers() }; delete headers["content-encoding"]; delete headers["content-length"];
      await route.fulfill({ status: r.status(), headers, body });
    } catch (e) { await route.continue().catch(() => {}); }
  });
};
const CONDITIONS = [
  { id: "control", label: "no fault (control)" },
  { id: "api-abort", label: "API requests aborted", setup: failReq("abort") },
  { id: "api-500", label: "API answers 500", setup: failReq("500") },
  { id: "api-delay", label: "API held for 12 s", setup: failReq("delay") },
  { id: "no-js", label: "JavaScript disabled", ctx: { javaScriptEnabled: false }, noscript: true },
  { id: "storage-throws", label: "storage, IndexedDB and cookies throw", init: STORAGE_METHODS },
  { id: "storage-blocked", label: "reaching storage throws, no cookies", init: STORAGE_ACCESS },
  { id: "analytics-blocked", label: "analytics blocked", analytics: true, setup: (ctx) => ctx.route((u) => isInsights(u.href), (r) => r.abort()) },
  { id: "reduced-motion", label: "prefers-reduced-motion: reduce", ctx: { reducedMotion: "reduce" } },
  { id: "forced-colors", label: "forced-colors: active", ctx: { forcedColors: "active" } },
  { id: "dark-scheme", label: "prefers-color-scheme: dark", ctx: { colorScheme: "dark" } },
  { id: "contrast-more", label: "prefers-contrast: more", setup: MEDIA([{ name: "prefers-contrast", value: "more" }]) },
  { id: "zoom-640x360", label: "zoom 200 percent of a laptop (640x360)", sizes: [["640x360", { viewport: { width: 640, height: 360 } }]] },
  { id: "zoom-480x270", label: "zoom 400 percent of a laptop (480x270)", sizes: [["480x270", { viewport: { width: 480, height: 270 } }]] },
  { id: "text-200", label: "text scaled to 200 percent", init: () => { const set = () => { if (document.documentElement) document.documentElement.style.fontSize = "200%"; }; set(); document.addEventListener("readystatechange", set); }, after: (page) => page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }) }, /* set from the first byte, as a text-size setting is, and again once the page is up */
  { id: "slow-network", label: "400 kbps, 800 ms (a visible card in 3 s)", budget: 3000, paint: true, slow: true },
  { id: "stale-board", label: "stale index, board.js 404s", sw: "allow", setup: stale("board") },
  { id: "stale-shell", label: "stale index, shell.js 404s", sw: "allow", setup: stale("shell") },
];

async function runOne(browser, cond, [size, sopts], visit, slug) {
  const name = `${cond.label} | ${size} | ${visit} visit`;
  const ctx = await browser.newContext({ ...sopts, ...(cond.ctx || {}), serviceWorkers: cond.sw || "block" }), errs = [], cons = [];
  try {
    if (visit === "repeat") await ctx.addInitScript((me) => { try { localStorage.setItem("board-me", me); } catch (e) {} }, slug);
    if (cond.init) await ctx.addInitScript(cond.init);
    const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
    page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 140)));
    page.on("console", (m) => { if (m.type() === "error") { let at = ""; try { at = (m.location() || {}).url || ""; } catch (e) {} cons.push({ text: m.text().slice(0, 140), at }); } });
    if (cond.setup) await cond.setup(ctx, page, cdp);
    if (cond.slow) { await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 800, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 }); }
    if (cond.sw === "allow") { await page.goto(url, { waitUntil: "load", timeout: 45000 }).catch(() => {}); await page.goto(url, { waitUntil: "load", timeout: 45000 }).catch(() => {}); await page.unrouteAll?.({ behavior: "ignoreErrors" }).catch(() => {}); }
    const t0 = Date.now(); let nav = page.goto(url, { waitUntil: "commit", timeout: 60000 }).catch(() => {});
    if (!cond.slow) await nav;
    const budget = cond.budget || 6000; let p = { len: 0, ctl: 0, paint: [], text: "" };
    while (Date.now() - t0 < budget) {
      p = await page.evaluate(probe).catch(() => p);
      if (p.len >= 40 && p.ctl >= 1 && (!cond.paint || p.paint.length > 0)) break;
      await sleep(250);
    }
    if (cond.after) { /* the change lands on a page that is up; give it the same budget to settle (a sheet may be mid-open) */
      await cond.after(page).catch(() => {}); const t1 = Date.now();
      do { await sleep(300); p = await page.evaluate(probe).catch(() => p); } while (!(p.len >= 40 && p.ctl >= 1) && Date.now() - t1 < budget);
    }
    const detail = `${p.len} chars, ${p.ctl} controls${cond.paint ? `, paint ${p.paint.join("/") || "none"}` : ""}, text "${p.text}"`;
    ok(`${name} | usable screen`, p.len >= 40 && p.ctl >= 1 && (!cond.paint || p.paint.length > 0), detail);
    if (cond.noscript) {
      const ns = await page.evaluate(() => { const link = [...document.querySelectorAll("body a[href]")].some((a) => a.getBoundingClientRect().width > 0 && !a.closest("[hidden]")); return { text: document.body.innerText.replace(/\s+/g, " "), link }; }).catch(() => ({ text: "", link: false }));
      ok(`${name} | the no-script note is visible, plain, and has a link`, /JavaScript|script/i.test(ns.text) && ns.link, ns.text.slice(0, 80));
    }
    if (cond.slow) { await sleep(Math.max(0, 15000 - (Date.now() - t0))); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await nav; }
    ok(`${name} | no uncaught page error`, !errs.length, errs.join(" ; "));
    if (cond.analytics) { const ours = cons.filter((c) => !isInsights(c.at) && !/cloudflareinsights|cdn-cgi\/rum/.test(c.text) && !(/^Failed to load resource/.test(c.text) && c.at && !c.at.startsWith(origin))); /* a refusal from another host is that host's, not ours */ ok(`${name} | no console error from our code`, !ours.length, ours.map((c) => `${c.text} @ ${c.at}`).join(" ; ")); }
  } catch (e) { ok(`${name} | ran`, false, String(e.message).slice(0, 160)); }
  finally { await ctx.close().catch(() => {}); }
}

const launchArgs = HOST_MAP ? [`--host-resolver-rules=MAP ${HOST_MAP.split("=")[0]} ${HOST_MAP.split("=")[1]}`, "--no-proxy-server", "--disable-features=PrivateNetworkAccessChecks,PrivateNetworkAccessForNavigations,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"] /* a mapped loopback host: no proxy, and a served-by-route page may still fetch its own files */ : [];
const browser = await pw.chromium.launch({ args: launchArgs });
const slug = await (async () => { try { const r = await fetch(`${BASE.replace(/\/$/, "")}/data/party.json`); const j = await r.json(); return String(j.members[0].name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); } catch (e) { return "just-looking"; } })();
const jobs = [];
const ONLY_LIST = ONLY ? ONLY.split(",").map((x) => x.trim()).filter(Boolean) : null; /* --only takes one id fragment or a comma list: "api-abort,api-500,no-js" */
for (const c of CONDITIONS) { if (ONLY_LIST && !ONLY_LIST.some((o) => c.id.includes(o))) continue; for (const s of c.sizes || SIZES) for (const v of ["first", "repeat"]) jobs.push(() => runOne(browser, c, s, v, slug)); }
try { await Promise.all(Array.from({ length: POOL }, async () => { while (jobs.length) await jobs.shift()(); })); }
finally { await browser.close(); }
lines.sort(); for (const l of lines) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
