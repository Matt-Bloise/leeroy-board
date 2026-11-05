// First paint on a slow connection (B71). Serves a folder over HTTP/2 with brotli, like Cloudflare Pages does, and loads the board in a fresh Chromium context
// (cold cache, service workers blocked) under the degraded-modes slow cell: 400 kbps, 800 ms (tests/browser/degraded-modes.mjs, condition slow-network).
// For each cell it times navigation start to the first moment the page is a "usable screen" by exactly the degraded-modes criteria:
//   the body shows at least 40 visible characters, at least one visible, focusable link or control, and a first paint has happened
// (the probe below is the one in degraded-modes.mjs; here it runs inside the page on every animation frame, so the time is not rounded to a 250 ms poll).
//   node tools/first-paint-measure.mjs [--root <dir> | --url <deployed page, e.g. https://leeroy.party/>] [--reps 5] [--budget 3000] [--cells 390x844:first,390x844:repeat,1366x768:first,1366x768:repeat]
//        [--out result.json] [--no-throttle] [--totals] [--label text] [--shots <dir>]
// --url measures a deployed page (production or a preview) under the same throttle, with real TLS and the real network on top of the emulation; no local server is started.
// Pass: every repetition of every cell is under --budget ms (default 3000). Exit 1 otherwise (so it can gate by hand; no workflow runs it).
// --totals also loads the page once with no throttle and prints how many requests and compressed bytes the cold load makes, by type.
// --shots <dir> saves a screenshot of the card at the moment it became usable, and of the page after it has loaded (unthrottled), for each viewport.
// The API is answered from tests/fixtures/api-snapshot (installApiStub), and the page clock is REAL: tests/helpers/browser-stub.mjs stubbed() would pin it (B64), and under Playwright's clock
// install performance.getEntries() is empty, so there is no paint entry and the "usable screen" criterion can never be met. degraded-modes.mjs slow-network goes through stubbed().
// Makes no AI call and sends nothing off this machine. Needs openssl (for a throwaway certificate) and Playwright (tests/node_modules); set PW_EXECUTABLE for another Chromium.
import http2 from "node:http2";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), REPO = path.join(here, "..");
const argv = process.argv.slice(2), arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const REMOTE = arg("--url"), ROOT = path.resolve(arg("--root", REPO)), REPS = Number(arg("--reps", 5)), BUDGET = Number(arg("--budget", 3000)), LABEL = arg("--label", "");
const CELLS = (arg("--cells", "390x844:first,390x844:repeat,1366x768:first,1366x768:repeat")).split(",").map((c) => { const [s, v] = c.split(":"); const [w, h] = s.split("x").map(Number); return { w, h, visit: v, touch: w < 700 }; });
const THROTTLE = !argv.includes("--no-throttle");
const pw = await import(pathToFileURL(path.join(REPO, "tests", "node_modules", "playwright", "index.mjs")).href).catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
const { installApiStub } = await import(pathToFileURL(path.join(REPO, "tests", "helpers", "api-stub.mjs")).href); /* the API answers from tests/fixtures/api-snapshot; NOT stubbed() from browser-stub.mjs, which also pins the page clock, and a pinned clock empties performance.getEntries() (no paint entries) */

// ---- the server: HTTP/2 + brotli (quality 5 is close to what Pages sends for a static file), the same Content-Types as tools/static-server.mjs
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".webmanifest": "application/manifest+json" };
const COMPRESS = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".xml", ".webmanifest"]);
const cache = new Map();
function load(rel) {
  if (cache.has(rel)) return cache.get(rel);
  let abs = path.join(ROOT, path.normalize(rel)), out = null;
  try { if (statSync(abs).isDirectory()) abs = path.join(abs, "index.html"); const raw = readFileSync(abs), ext = path.extname(abs).toLowerCase(); out = { type: TYPES[ext] || "application/octet-stream", body: COMPRESS.has(ext) ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : raw, br: COMPRESS.has(ext), raw: raw.length }; } catch (e) {}
  cache.set(rel, out); return out;
}
const tmp = mkdtempSync(path.join(os.tmpdir(), "first-paint-"));
let server = null, PORT = 0;
const HOST = "local.leeroy.party";
if (!REMOTE) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"), "-days", "2", "-subj", "/CN=local.leeroy.party", "-addext", "subjectAltName=DNS:local.leeroy.party"], { stdio: "ignore" });
  server = http2.createSecureServer({ key: readFileSync(path.join(tmp, "k.pem")), cert: readFileSync(path.join(tmp, "c.pem")), allowHTTP1: true });
  server.on("request", (req, res) => {
    let rel; try { rel = decodeURIComponent(new URL(req.url, "https://x").pathname); } catch { res.writeHead(400).end(); return; }
    const f = load(rel);
    if (!f) { const nf = load("/404.html"); res.writeHead(404, { "content-type": "text/html; charset=utf-8", ...(nf && nf.br ? { "content-encoding": "br" } : {}) }); res.end(nf ? nf.body : "not found"); return; }
    res.writeHead(200, { "content-type": f.type, "cache-control": "public, max-age=0, must-revalidate", ...(f.br ? { "content-encoding": "br" } : {}) });
    res.end(f.body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
}
const URL0 = REMOTE ? `${REMOTE}${REMOTE.includes("?") ? "&" : "?"}preview=1` : `https://${HOST}:${PORT}/?preview=1`;

// ---- the in-page probe: degraded-modes.mjs `probe`, run on every frame from the first byte; records performance.now() (ms since navigation start) when it first passes
function PAGE_PROBE() {
  const t = (window.__fp = { ok: null });
  const shown = (e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); if (!(r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none") || e.closest("[hidden],[inert]")) return false; for (let n = e; n && n.nodeType === 1; n = n.parentElement) if (+getComputedStyle(n).opacity === 0) return false; return true; };
  const tick = () => {
    if (t.ok !== null) return;
    if (document.body) {
      const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
      const ctl = [...document.querySelectorAll("a[href],button,input,select,textarea,summary,[tabindex]")].filter((e) => !e.disabled && e.tabIndex >= 0 && shown(e));
      const paint = performance.getEntriesByType("paint").map((p) => p.name);
      if (text.length >= 40 && ctl.length >= 1 && paint.length > 0) {
        t.ok = performance.now(); t.len = text.length; t.ctl = ctl.length; t.text = text.slice(0, 90);
        const nav = performance.getEntriesByType("navigation")[0], fp = performance.getEntriesByType("paint");
        t.fp = Object.fromEntries(fp.map((p) => [p.name, Math.round(p.startTime)]));
        const before = performance.getEntriesByType("resource").filter((e) => e.responseEnd > 0 && e.responseEnd <= t.ok);
        const started = performance.getEntriesByType("resource").filter((e) => e.startTime <= t.ok);
        t.requestsStarted = started.length + 1; t.requestsDone = before.length + 1;
        t.bytes = Math.round((nav ? nav.transferSize : 0) + before.reduce((s, e) => s + (e.transferSize || 0), 0));
        t.byKind = before.reduce((o, e) => { const k = e.initiatorType; o[k] = (o[k] || 0) + 1; return o; }, {});
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = { args: REMOTE ? [] : [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, "--ignore-certificate-errors", "--no-proxy-server"], ...(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {}) };
const browser = await pw.chromium.launch(launch);
const slug = await (async () => { if (REMOTE) { try { const r = await fetch(new URL("data/party.json", REMOTE)); const j = await r.json(); return String(j.members[0].name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); } catch (e) { return "just-looking"; } } try { const j = JSON.parse(readFileSync(path.join(ROOT, "data", "party.json"), "utf8")); return String(j.members[0].name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); } catch (e) { return "just-looking"; } })();

async function once(cell, { throttle, shotDir }) {
  const opts = { viewport: { width: cell.w, height: cell.h }, serviceWorkers: "block", ignoreHTTPSErrors: true };
  if (cell.touch) { opts.hasTouch = true; opts.isMobile = true; }
  const ctx = await browser.newContext(opts); await installApiStub(ctx); const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
  try {
    if (cell.visit === "repeat") await ctx.addInitScript((me) => { try { localStorage.setItem("board-me", me); } catch (e) {} }, slug);
    await ctx.addInitScript(PAGE_PROBE);
    if (throttle) { await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 800, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 }); }
    page.goto(URL0, { waitUntil: "commit", timeout: 60000 }).catch(() => {});
    const t0 = Date.now(); let fp = null;
    while (Date.now() - t0 < 12000) { fp = await page.evaluate(() => window.__fp && window.__fp.ok !== null ? window.__fp : null).catch(() => null); if (fp) break; await sleep(40); }
    if (fp && shotDir) await page.screenshot({ path: path.join(shotDir, `card-${cell.w}x${cell.h}-${cell.visit}.png`) }).catch(() => {});
    return fp ? { ms: Math.round(fp.ok), ...fp } : { ms: null };
  } finally { await ctx.close().catch(() => {}); }
}
async function totals(cell, shotDir) {
  const ctx = await browser.newContext({ viewport: { width: cell.w, height: cell.h }, serviceWorkers: "block", ignoreHTTPSErrors: true, ...(cell.touch ? { hasTouch: true, isMobile: true } : {}) }); await installApiStub(ctx); const page = await ctx.newPage();
  try {
    const seen = new Map(); const cdp = await ctx.newCDPSession(page); await cdp.send("Network.enable");
    const reqs = new Map();
    cdp.on("Network.responseReceived", (e) => reqs.set(e.requestId, { url: e.response.url, type: e.type }));
    cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) seen.set(e.requestId, { ...r, bytes: e.encodedDataLength }); });
    await page.goto(URL0, { waitUntil: "load", timeout: 60000 }); await sleep(3000);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `board-${cell.w}x${cell.h}.png`) }).catch(() => {});
    const by = {}; for (const r of seen.values()) { const k = r.type; by[k] = by[k] || { n: 0, bytes: 0 }; by[k].n++; by[k].bytes += r.bytes; }
    const all = [...seen.values()]; return { requests: all.length, bytes: all.reduce((s, r) => s + r.bytes, 0), by };
  } finally { await ctx.close().catch(() => {}); }
}

const shotDir = arg("--shots"); if (shotDir) mkdirSync(shotDir, { recursive: true });
const report = { label: LABEL, root: ROOT, budgetMs: BUDGET, throttle: THROTTLE ? "400 kbps, 800 ms" : "none", cells: [], totals: null }; let bad = 0;
for (const cell of CELLS) {
  const runs = []; for (let i = 0; i < REPS; i++) runs.push(await once(cell, { throttle: THROTTLE, shotDir: i === 0 ? shotDir : null }));
  const ms = runs.map((r) => r.ms), pass = ms.every((m) => m !== null && m < BUDGET); if (!pass) bad++;
  const first = runs.find((r) => r.ms !== null) || {};
  report.cells.push({ cell: `${cell.w}x${cell.h} ${cell.visit}`, ms, pass, requestsStartedBeforeCard: first.requestsStarted, bytesOnWireBeforeCard: first.bytes, firstPaint: first.fp, card: first.text, controls: first.ctl });
  console.log(`${pass ? "PASS" : "FAIL"} ${cell.w}x${cell.h} ${cell.visit} visit: ${ms.map((m) => (m === null ? "never" : m)).join(", ")} ms (budget ${BUDGET}); before the card: ${first.requestsStarted ?? "?"} requests started, ${first.bytes ?? "?"} bytes on the wire; paint ${JSON.stringify(first.fp || {})}; card "${first.text || ""}" (${first.ctl ?? 0} controls)`);
}
if (argv.includes("--totals") || shotDir) {
  const c = CELLS[0]; report.totals = await totals(c, shotDir);
  console.log(`totals (cold, no throttle, ${c.w}x${c.h}): ${report.totals.requests} requests, ${report.totals.bytes} bytes on the wire; ${Object.entries(report.totals.by).map(([k, v]) => `${k} ${v.n} / ${v.bytes} B`).join("; ")}`);
}
console.log(`first-paint-measure${LABEL ? ` (${LABEL})` : ""}: ${report.cells.length - bad} of ${report.cells.length} cells under ${BUDGET} ms in all ${REPS} repetitions${THROTTLE ? "" : " (no throttle)"}`);
if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(report, null, 1));
await browser.close(); if (server) server.close(); rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
