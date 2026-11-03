// Visual quality audit: loads a deployed board in a matrix of browser contexts and MEASURES how it looks and performs. Non-gating.
//   node visual/audit.mjs https://pr-13.leeroy-board.pages.dev/     (or env PREVIEW_PAGES)   run from tests/ after `npm ci`
// Options (flag or env): --out DIR (AUDIT_OUT, default ./visual-audit) | --budget-min N (AUDIT_BUDGET_MIN, default 10) | --only TEXT (AUDIT_ONLY, context id filter)
// Local only: AUDIT_CHROMIUM_PATH = a chromium binary to use instead of Playwright's own.
// Per context (15: chromium + webkit; viewports 390x844 to 3840x2160; DPR 1/2/3; light/dark; reduced motion; forced colors once) and per page
// (first visit + 14 scene hashes): overflow, console errors, failed requests, tap targets, small text, text contrast, CLS, LCP, long animation frames,
// bytes, infinite animations under reduced motion, image efficiency (img + CSS backgrounds). Writes visual-audit.json, visual-audit.md, screenshots/.
// Exit 0 whatever it finds; exit 1 only on a crash (no browser could run, or the script itself threw) or a stub miss (see below). Tests make no AI calls and send nothing.
// API: every /api/ call is answered from tests/fixtures/api-snapshot (tests/helpers/api-stub.mjs), so an audit sends ZERO requests to the Worker; --live-api (or LIVE_API=1) uses the real API.
// A path the snapshot lacks fails the run like in every browser suite (opt out: API_STUB_ALLOW_MISS=1). The audit judges the page, not the API.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stubbed } from "../helpers/browser-stub.mjs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.find((a) => /^https?:/.test(a));
const BASE = positional || flag("url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node visual/audit.mjs <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const OUT = path.resolve(flag("out") || process.env.AUDIT_OUT || "visual-audit");
const BUDGET_MS = Number(flag("budget-min") || process.env.AUDIT_BUDGET_MIN || 10) * 60000;
const ONLY = flag("only") || process.env.AUDIT_ONLY || "";
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const T0 = Date.now(), DEADLINE = T0 + BUDGET_MS;

const SCENES = ["tonight", "timeline", "five", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "decide", "atlas", "data"];
/* thresholds, repeated in docs/visual-quality.md */
const TH = { tapPx: 44, textPx: 12, contrast: 4.5, contrastLarge: 3, cls: 0.1, lcpMs: 2500, loafCount: 3, loafMs: 200, bytesFirst: 3e6, bytesScene: 1.5e6, underArea: 1, overArea: 3, legacyFormatBytes: 150e3 };

const P = (w, h, dpr, extra = {}) => ({ w, h, dpr, ...extra });
/* priority order: the budget cuts from the tail */
const CONTEXTS = [
  ["chromium", P(390, 844, 3, { touch: 1 })],
  ["chromium", P(390, 844, 3, { touch: 1, dark: 1, reduced: 1 })],
  ["webkit", P(390, 844, 3, { touch: 1 })],
  ["chromium", P(1366, 768, 1)],
  ["webkit", P(1366, 768, 2, { dark: 1 })],
  ["chromium", P(768, 1024, 2, { touch: 1 })],
  ["chromium", P(430, 932, 3, { touch: 1, dark: 1 })],
  ["chromium", P(2560, 1080, 1)],
  ["chromium", P(3840, 2160, 1, { dark: 1 })],
  ["chromium", P(1080, 1920, 1, { reduced: 1 })],
  ["chromium", P(1024, 1366, 2, { touch: 1, dark: 1 })],
  ["chromium", P(1366, 768, 2, { dark: 1, reduced: 1 })],
  ["chromium", P(1366, 768, 1, { forced: 1 })],
  ["webkit", P(768, 1024, 2, { touch: 1, reduced: 1 })],
  ["webkit", P(2560, 1080, 1, { dark: 1 })],
].map(([engine, p]) => ({ engine, ...p, id: `${engine === "chromium" ? "cr" : "wk"}-${p.w}x${p.h}@${p.dpr}-${p.dark ? "dark" : "light"}${p.reduced ? "-reduced" : ""}${p.forced ? "-forced" : ""}${p.touch ? "-touch" : ""}` }))
  .filter((c) => !ONLY || c.id.includes(ONLY));

const r2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 100) / 100);
const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return String(u).slice(0, 120); } };
const fmtOf = (u, ct) => { const m = (ct || "").match(/image\/([a-z0-9.+-]+)/); if (m) return m[1].replace("jpeg", "jpg").replace("svg+xml", "svg"); const e = pathOf(u).match(/\.([a-z0-9]+)$/i); return e ? e[1].toLowerCase().replace("jpeg", "jpg") : "?"; };

/* ---- what the stylesheets and scripts promise about wide gamut and HDR: a grep of css/, scenes/ and js/ ---- */
function grepSource() {
  const pats = { dynamicRangeMedia: /@media[^{]*\(dynamic-range:\s*high\)/, displayP3: /color\(display-p3/, colorGamutMedia: /color-gamut/, dynamicRangeLimit: /dynamic-range-limit/, imageSet: /image-set\(/, canvasColorSpace: /colorSpace/, plusLighter: /plus-lighter/ };
  const out = Object.fromEntries(Object.keys(pats).map((k) => [k, { count: 0, files: {} }]));
  const walk = (dir, exts, depth = 0) => { let r = []; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const p = path.join(dir, e.name); if (e.isDirectory() && depth < 3) r = r.concat(walk(p, exts, depth + 1)); else if (exts.some((x) => e.name.endsWith(x))) r.push(p); } } catch (e) {} return r; };
  const files = [...walk(path.join(ROOT, "css"), [".css"]), ...walk(path.join(ROOT, "scenes"), [".css", ".js"]), ...walk(path.join(ROOT, "js"), [".js"])];
  for (const f of files) {
    const isCss = f.endsWith(".css"), rel = path.relative(ROOT, f);
    let text = ""; try { text = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    const lines = text.split("\n");
    for (const [k, re] of Object.entries(pats)) {
      if (k === "canvasColorSpace" && isCss) continue;
      let n = 0; lines.forEach((l) => { if (re.test(l)) n++; });
      if (n) { out[k].count += n; out[k].files[rel] = n; }
    }
  }
  return { filesScanned: files.length, ...out };
}

/* ---- runs in the page at document start ---- */
const initScript = () => {
  const a = (window.__aq = { cls: 0, lcp: null, lcpEl: "", loaf: 0, loafMs: 0, loafMax: 0, sup: {} });
  const sup = (PerformanceObserver.supportedEntryTypes || []);
  a.sup = { cls: sup.includes("layout-shift"), lcp: sup.includes("largest-contentful-paint"), loaf: sup.includes("long-animation-frame") };
  const ob = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch (e) {} };
  ob("layout-shift", (e) => { if (!e.hadRecentInput) a.cls += e.value; });
  ob("largest-contentful-paint", (e) => { a.lcp = e.startTime; a.lcpEl = e.url ? e.url.replace(/[?#].*$/, "") : (e.element ? e.element.tagName.toLowerCase() : ""); });
  ob("long-animation-frame", (e) => { a.loaf++; a.loafMs += e.duration; a.loafMax = Math.max(a.loafMax, e.duration); });
};

/* ---- runs in the page after a page has settled: every measure that needs layout or style ---- */
const measure = async (opt) => {
  const vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const r2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 100) / 100);
  const vis = (el) => { try { if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) {} const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const sel = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += `#${el.id}`; const c = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2); if (c.length) s += `.${c.join(".")}`; return s.slice(0, 80); };
  const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const out = { hash: location.hash, vw, vh, dpr: devicePixelRatio };
  /* overflow */
  const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0), cw = de.clientWidth;
  const wide = [];
  if (sw > cw) for (const el of document.body.querySelectorAll("*")) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > cw + 1 && vis(el)) { wide.push([Math.round(r.right), sel(el)]); if (wide.length > 400) break; } }
  wide.sort((x, y) => y[0] - x[0]);
  out.overflow = { scrollWidth: sw, clientWidth: cw, over: sw > cw, excess: Math.max(0, sw - cw), culprits: wide.slice(0, 4).map((w) => `${w[1]} (right ${w[0]})`) };
  /* tap targets (touch contexts only; inline links in running text are exempt, as in WCAG 2.5.8) */
  if (opt.touch) {
    const small = []; let total = 0, inline = 0;
    document.querySelectorAll("a[href],button,[role=button],[role=tab],[role=link],[role=menuitem],[role=switch],[role=checkbox],input:not([type=hidden]),select,textarea,summary").forEach((el) => {
      if (!vis(el)) return; const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return;
      total++;
      if (r.width >= opt.tapPx && r.height >= opt.tapPx) return;
      if (el.tagName === "A" && getComputedStyle(el).display === "inline") { inline++; return; }
      small.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 24) });
    });
    small.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h));
    out.tap = { total, small: small.length, inlineExempt: inline, samples: small.slice(0, 8) };
  } else out.tap = null;
  /* text size and contrast */
  const cv = document.createElement("canvas"); cv.width = cv.height = 1; const g = cv.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const rgba = (c) => { if (cache.has(c)) return cache.get(c); g.clearRect(0, 0, 1, 1); g.fillStyle = "#000"; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; const v = [d[0], d[1], d[2], d[3] / 255]; cache.set(c, v); return v; };
  const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); if (a === 0) return [0, 0, 0, 0]; return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat([a]); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /* effective background: null when an image sits behind the text (not decidable from computed style) */
  const bgOf = (el) => { const layers = []; let n = el; while (n && n.nodeType === 1) { const cs = getComputedStyle(n); if (cs.backgroundImage !== "none") return null; const c = rgba(cs.backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; } n = n.parentElement; } let base = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const byEl = new Map(); let nodes = 0;
  for (let n = walker.nextNode(); n && nodes < 6000; n = walker.nextNode()) {
    const t = n.nodeValue.replace(/\s+/g, " ").trim(); if (!t) continue; const el = n.parentElement; if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    nodes++; const e = byEl.get(el) || { chars: 0, text: "" }; e.chars += t.length; if (e.text.length < 30) e.text += t; byEl.set(el, e);
  }
  const tiny = [], low = []; let tinyChars = 0, tinyEls = 0, unknownBg = 0, lowN = 0; const dom = new Map(); let measured = 0;
  for (const [el, e] of byEl) {
    if (measured > 700) break; if (!vis(el)) continue; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue; measured++;
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize);
    if (fs < opt.textPx) { tinyEls++; tinyChars += e.chars; tiny.push({ sel: sel(el), px: r2(fs), text: e.text.slice(0, 24), chars: e.chars }); }
    const bg = bgOf(el); if (!bg) { unknownBg++; continue; }
    const fg = over(rgba(cs.color), bg), rt = ratio(fg, bg), large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    const key = `${cs.color}|${bg.map((v) => Math.round(v)).join(",")}`; const d = dom.get(key) || { chars: 0, rt, fs, sel: sel(el), color: cs.color }; d.chars += e.chars; dom.set(key, d);
    if (rt < (large ? opt.contrastLarge : opt.contrast)) { lowN++; low.push({ sel: sel(el), ratio: r2(rt), px: r2(fs), text: e.text.slice(0, 24), chars: e.chars }); }
  }
  tiny.sort((a, b) => b.chars - a.chars); low.sort((a, b) => a.ratio - b.ratio);
  const domTop = [...dom.values()].sort((a, b) => b.chars - a.chars)[0];
  out.text = { measured, tinyEls, tinyChars, tinySamples: tiny.slice(0, 6), dominant: domTop ? { ratio: r2(domTop.rt), px: r2(domTop.fs), sel: domTop.sel, color: domTop.color } : null, lowCount: lowN, lowSamples: low.slice(0, 5), unknownBgEls: unknownBg };
  /* animations still running (reduced motion should stop the infinite ones) */
  const infinite = []; let running = 0;
  try { for (const a of document.getAnimations()) { if (a.playState !== "running") continue; running++; let it = 1; try { it = a.effect.getComputedTiming().iterations; } catch (e) {} if (it === Infinity) infinite.push(`${a.animationName || a.transitionProperty || "anim"} on ${a.effect && a.effect.target ? sel(a.effect.target) : "?"}`); } } catch (e) {}
  out.motion = { running, infinite: infinite.length, samples: infinite.slice(0, 5) };
  /* images in view: <img> and CSS backgrounds. need = device px per natural px; area ratio = natural pixels / required pixels = 1 / need^2 */
  const imgs = [], seen = new Set();
  const isVec = (u) => /\.svg([?#]|$)|^data:image\/svg/.test(u);
  for (const im of document.images) {
    const r = im.getBoundingClientRect(); if (!inView(r) || !vis(im)) continue; const src = im.currentSrc || im.src; if (!src) continue;
    const key = `i|${src}|${Math.round(r.width)}`; if (seen.has(key)) continue; seen.add(key);
    const nw = im.naturalWidth, nh = im.naturalHeight, fit = getComputedStyle(im).objectFit;
    let need = null; if (nw && nh) { const sx = r.width / nw, sy = r.height / nh; need = (fit === "contain" || fit === "scale-down" ? Math.min(sx, sy) : Math.max(sx, sy)) * devicePixelRatio; }
    imgs.push({ kind: "img", src: src.replace(/[?#].*$/, ""), vec: isVec(src), broken: im.complete && !nw, nw, nh, cssW: r2(r.width), cssH: r2(r.height), need: r2(need), sel: sel(im) });
  }
  const splitTop = (s) => { const parts = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) parts.push(cur.trim()); return parts; };
  const bgScale = (sz, nw, nh, bw, bh) => {
    if (sz === "cover") return Math.max(bw / nw, bh / nh); if (sz === "contain") return Math.min(bw / nw, bh / nh);
    const p = sz.split(/\s+/); const pv = (x, ref) => (x === undefined || x === "auto" ? null : x.endsWith("%") ? (parseFloat(x) / 100) * ref : parseFloat(x));
    let w = pv(p[0], bw), h = pv(p[1], bh); if (w == null && h == null) return 1; if (w == null) w = (h * nw) / nh; if (h == null) h = (w * nh) / nw; return Math.max(w / nw, h / nh);
  };
  const bgJobs = []; let scanned = 0;
  for (const el of [de, ...document.body.querySelectorAll("*")]) {
    if (++scanned > 3500 || bgJobs.length >= 60) break;
    const r = el.getBoundingClientRect(); if (!inView(r)) continue; const cs = getComputedStyle(el);
    if (cs.backgroundImage === "none" || !cs.backgroundImage.includes("url(") || cs.display === "none" || cs.visibility === "hidden") continue;
    const urls = splitTop(cs.backgroundImage), sizes = splitTop(cs.backgroundSize);
    urls.forEach((u, i) => { const m = u.match(/url\((['"]?)(.*?)\1\)/); if (!m) return; const abs = new URL(m[2], location.href).href; bgJobs.push({ abs, sz: sizes[i % Math.max(sizes.length, 1)] || "auto", bw: r.width, bh: r.height, sel: sel(el) }); });
  }
  const loadNat = (u) => new Promise((res) => { const im = new Image(); const t = setTimeout(() => res(null), 4000); im.onload = () => { clearTimeout(t); res([im.naturalWidth, im.naturalHeight]); }; im.onerror = () => { clearTimeout(t); res(null); }; im.src = u; });
  for (const j of bgJobs) {
    const key = `b|${j.abs}|${j.sz}|${Math.round(j.bw)}`; if (seen.has(key)) continue; seen.add(key);
    const vec = isVec(j.abs), nat = vec ? null : await loadNat(j.abs);
    let need = null; if (nat && nat[0] && nat[1]) need = bgScale(j.sz, nat[0], nat[1], j.bw, j.bh) * devicePixelRatio;
    imgs.push({ kind: "bg", src: j.abs.replace(/[?#].*$/, ""), vec, broken: false, nw: nat ? nat[0] : 0, nh: nat ? nat[1] : 0, cssW: r2(j.bw), cssH: r2(j.bh), need: r2(need), bgSize: j.sz, sel: j.sel });
  }
  out.images = imgs;
  return out;
};

/* ---- run one context ---- */
async function runContext(browsers, c) {
  const rec = { id: c.id, engine: c.engine, viewport: `${c.w}x${c.h}`, dpr: c.dpr, touch: !!c.touch, scheme: c.dark ? "dark" : "light", reducedMotion: !!c.reduced, forcedColors: !!c.forced, phases: [], status: "ok" };
  const browser = browsers[c.engine]; if (!browser) { rec.status = "engine-unavailable"; return rec; }
  const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: c.dpr, hasTouch: !!c.touch, isMobile: !!c.touch && c.w < 1100, colorScheme: c.dark ? "dark" : "light", reducedMotion: c.reduced ? "reduce" : "no-preference", forcedColors: c.forced ? "active" : "none", serviceWorkers: "block" });
  try {
    const page = await ctx.newPage(); page.setDefaultTimeout(20000);
    await page.addInitScript(initScript);
    const st = { errs: [], fails: [], bytes: 0, net: new Map(), pending: new Set() };
    page.on("console", (m) => { if (m.type() === "error") { let at = ""; try { at = (m.location() || {}).url || ""; } catch (e) {} st.errs.push({ text: m.text().slice(0, 200), at: pathOf(at) }); } });
    page.on("pageerror", (e) => st.errs.push({ text: `pageerror ${String(e.message).slice(0, 200)}`, at: "" }));
    page.on("response", (r) => { try { if (r.status() >= 400) st.fails.push({ status: r.status(), method: r.request().method(), url: pathOf(r.url()), origin: new URL(r.url()).origin }); } catch (e) {} });
    page.on("requestfailed", (r) => { const f = (r.failure() || {}).errorText || "failed"; if (!/ERR_ABORTED|cancelled|aborted/i.test(f)) st.fails.push({ status: 0, method: r.method(), url: pathOf(r.url()), origin: "", failure: f }); });
    page.on("requestfinished", (r) => {
      const p = (async () => { try { const s = await r.sizes(), resp = await r.response(); st.bytes += s.responseBodySize + s.responseHeadersSize; st.net.set(r.url().replace(/[?#].*$/, ""), { bytes: s.responseBodySize, ct: resp ? (await resp.allHeaders())["content-type"] || "" : "" }); } catch (e) {} })();
      st.pending.add(p); p.finally(() => st.pending.delete(p));
    });
    const snap = () => page.evaluate(() => { const a = window.__aq || {}; return { cls: a.cls || 0, lcp: a.lcp, lcpEl: a.lcpEl, loaf: a.loaf || 0, loafMs: a.loafMs || 0, loafMax: a.loafMax || 0, sup: a.sup || {} }; });
    const phase = async (name, act) => {
      if (Date.now() > DEADLINE) return false;
      const ph = { name }; const e0 = st.errs.length, f0 = st.fails.length, b0 = st.bytes;
      try {
        let s0 = { cls: 0, loaf: 0, loafMs: 0 }; if (name !== "first-visit") s0 = await snap();
        await act(); await Promise.allSettled([...st.pending]);
        const m = await page.evaluate(measure, { touch: !!c.touch, tapPx: TH.tapPx, textPx: TH.textPx, contrast: TH.contrast, contrastLarge: TH.contrastLarge });
        const s1 = await snap(); await Promise.allSettled([...st.pending]);
        Object.assign(ph, m);
        ph.cls = s1.sup.cls ? r2(s1.cls - s0.cls) : null;
        ph.lcp = name === "first-visit" && s1.sup.lcp && s1.lcp !== null ? { ms: r2(s1.lcp), el: s1.lcpEl } : null;
        ph.loaf = s1.sup.loaf ? { count: s1.loaf - s0.loaf, ms: r2(s1.loafMs - s0.loafMs), max: r2(s1.loafMax) } : null;
        ph.bytes = st.bytes - b0; ph.errors = st.errs.slice(e0); ph.failed = st.fails.slice(f0);
        for (const im of ph.images) { const n = st.net.get(im.src); im.fmt = fmtOf(im.src, n && n.ct); im.bytes = n ? n.bytes : null; }
        rec.support = s1.sup;
      } catch (e) { ph.error = String(e.message || e).split("\n")[0].slice(0, 200); }
      rec.phases.push(ph); return !page.isClosed();
    };
    const dwell = c.reduced ? 700 : 1100;
    await phase("first-visit", async () => {
      await page.goto(`${BASE}${BASE.includes("?") ? "&" : "?"}cb=${Date.now()}${Math.random().toString(36).slice(2, 6)}`, { waitUntil: "load", timeout: 45000 });
      await page.waitForSelector("#tn-me .tn-name", { state: "visible", timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(1500);
    });
    /* what the engine reports about the display, and the first screen */
    try {
      rec.report = await page.evaluate(() => { const m = (q) => matchMedia(q).matches; return { dynamicRangeHigh: m("(dynamic-range: high)"), colorGamutP3: m("(color-gamut: p3)"), colorGamutRec2020: m("(color-gamut: rec2020)"), colorGamutSrgb: m("(color-gamut: srgb)"), forcedColors: m("(forced-colors: active)"), reducedMotion: m("(prefers-reduced-motion: reduce)"), dark: m("(prefers-color-scheme: dark)"), colorDepth: screen.colorDepth, dpr: devicePixelRatio, hdrImgClass: document.documentElement.classList.contains("hdr-img"), hdrOff: document.documentElement.classList.contains("hdr-off"), ua: navigator.userAgent.replace(/^Mozilla\/5.0 /, "").slice(0, 90) }; });
      fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });
      rec.screenshot = `screenshots/${c.id}.jpg`;
      await page.screenshot({ path: path.join(OUT, rec.screenshot), type: "jpeg", quality: 80, timeout: 20000 });
    } catch (e) { rec.reportError = String(e.message || e).split("\n")[0].slice(0, 160); }
    for (const sc of SCENES) {
      const ok = await phase(sc, async () => { await page.evaluate((h) => { window.scrollTo(0, 0); location.hash = h; }, sc); await page.waitForTimeout(dwell); });
      if (Date.now() > DEADLINE) { rec.status = "budget-cut"; break; }
      if (!ok) { rec.status = "page-closed"; break; }
    }
    if (rec.phases.length < SCENES.length + 1 && rec.status === "ok") rec.status = "partial";
  } catch (e) { rec.status = "error"; rec.error = String(e.message || e).split("\n")[0].slice(0, 200); }
  finally { await ctx.close().catch(() => {}); }
  return rec;
}

/* ---- findings: pure, from the recorded phases ---- */
function findingsOf(rec) {
  const F = [];
  const add = (ph, cat, score, subjects, detail, extra = {}) => F.push({ cat, ctx: rec.id, page: ph.name, score: Math.round(score), subjects, detail, ...extra });
  for (const ph of rec.phases) {
    if (ph.error) { add(ph, "crash", 90, [`${ph.name}: ${ph.error}`], `phase did not complete: ${ph.error}`); continue; }
    if (ph.overflow && ph.overflow.over) add(ph, "overflow", 100 + Math.min(ph.overflow.excess, 300) / 3, ph.overflow.culprits.length ? ph.overflow.culprits : [`page ${ph.name}`], `scrollWidth ${ph.overflow.scrollWidth} > clientWidth ${ph.overflow.clientWidth} (+${ph.overflow.excess}px)`);
    const seenE = new Set(); for (const e of ph.errors) { const k = e.text.replace(/\d+/g, "N"); if (seenE.has(k)) continue; seenE.add(k); add(ph, "console_errors", 60, [`${e.text}${e.at ? ` @ ${e.at}` : ""}`], e.text); }
    const seenF = new Set(); for (const f of ph.failed) { const k = `${f.status}${f.url}`; if (seenF.has(k)) continue; seenF.add(k); add(ph, "failed_requests", f.status >= 500 ? 80 : 60, [`${f.status || f.failure} ${f.url}`], `${f.method} ${f.url} -> ${f.status || f.failure}${f.origin ? ` (${f.origin})` : ""}`); }
    if (ph.tap && ph.tap.small) add(ph, "tap_targets", Math.min(10 + ph.tap.small, 50), ph.tap.samples.map((s) => `${s.sel} ${s.w}x${s.h}`), `${ph.tap.small} of ${ph.tap.total} targets under ${TH.tapPx}px (${ph.tap.inlineExempt} inline links exempt)`, { count: ph.tap.small });
    if (ph.text && ph.text.tinyEls) add(ph, "small_text", Math.min(10 + ph.text.tinyEls / 2, 50), ph.text.tinySamples.map((s) => `${s.sel} ${s.px}px`), `${ph.text.tinyEls} text elements under ${TH.textPx}px (${ph.text.tinyChars} characters)`, { count: ph.text.tinyEls });
    if (ph.text && ph.text.dominant && ph.text.dominant.ratio < TH.contrast) add(ph, "contrast", 50 + (TH.contrast - ph.text.dominant.ratio) * 10, [`main text ${ph.text.dominant.sel}`], `main text ${ph.text.dominant.ratio}:1 (${ph.text.dominant.sel}, ${ph.text.dominant.px}px)`, { ratio: ph.text.dominant.ratio });
    else if (ph.text && ph.text.lowCount) add(ph, "contrast", Math.min(25 + ph.text.lowCount, 60), ph.text.lowSamples.map((s) => `${s.sel} ${s.ratio}:1`), `${ph.text.lowCount} text elements below the WCAG ratio on a solid background (main text ${ph.text.dominant ? ph.text.dominant.ratio : "?"}:1)`, { count: ph.text.lowCount });
    if (ph.cls !== null && ph.cls > TH.cls) add(ph, "cls", Math.min(40 + ph.cls * 200, 100), [`layout shift on ${ph.name}`], `CLS ${ph.cls} over ${TH.cls}`);
    if (ph.lcp && ph.lcp.ms > TH.lcpMs) add(ph, "lcp", Math.min(30 + (ph.lcp.ms - TH.lcpMs) / 100, 80), [`LCP ${ph.lcp.el || "element"}`], `LCP ${Math.round(ph.lcp.ms)} ms over ${TH.lcpMs}`);
    if (ph.loaf && (ph.loaf.count >= TH.loafCount || ph.loaf.ms >= TH.loafMs)) add(ph, "long_frames", Math.min(20 + ph.loaf.ms / 20, 80), [`long animation frames on ${ph.name}`], `${ph.loaf.count} long animation frames, ${Math.round(ph.loaf.ms)} ms total, longest ${Math.round(ph.loaf.max)} ms`);
    const cap = ph.name === "first-visit" ? TH.bytesFirst : TH.bytesScene; if (ph.bytes > cap) add(ph, "bytes", 20 + ((ph.bytes - cap) / 1e6) * 10, [`transfer on ${ph.name}`], `${(ph.bytes / 1e6).toFixed(2)} MB transferred over ${(cap / 1e6).toFixed(1)} MB`);
    if (rec.reducedMotion && ph.motion && ph.motion.infinite) add(ph, "motion", Math.min(30 + ph.motion.infinite, 60), ph.motion.samples, `${ph.motion.infinite} infinite animations still running under prefers-reduced-motion`, { count: ph.motion.infinite });
    for (const im of ph.images || []) {
      const name = im.src.replace(/^https?:\/\/[^/]+/, "");
      if (im.broken) { add(ph, "failed_requests", 60, [`broken image ${name}`], `${im.sel} did not decode ${name}`); continue; }
      if (im.vec || !im.need) continue;
      const area = 1 / (im.need * im.need), dim = `${im.nw}x${im.nh} shown at ${Math.round(im.cssW)}x${Math.round(im.cssH)} css px, ${rec.dpr}x (${im.kind})`;
      if (area < TH.underArea) add(ph, "image_under", Math.min(30 + 20 * Math.log2(im.need), 100), [name], `${dim}: ${(area * 100).toFixed(0)}% of required pixels`, { areaRatio: r2(area), fmt: im.fmt });
      else if (area > TH.overArea) add(ph, "image_over", Math.min(10 + area, 40), [name], `${dim}: ${area.toFixed(1)}x required pixels${im.bytes ? `, ${Math.round(im.bytes / 1024)} KB` : ""}`, { areaRatio: r2(area), fmt: im.fmt });
      if ((im.fmt === "png" || im.fmt === "jpg") && im.bytes > TH.legacyFormatBytes) add(ph, "format", Math.min(5 + im.bytes / 50e3, 30), [name], `${im.fmt} of ${Math.round(im.bytes / 1024)} KB (webp or avif would be smaller)`, { fmt: im.fmt });
    }
  }
  return F;
}

const CATS = ["overflow", "console_errors", "failed_requests", "tap_targets", "small_text", "contrast", "cls", "lcp", "long_frames", "bytes", "motion", "image_under", "image_over", "format", "crash"];

function summarise(contexts, findings) {
  const counts = Object.fromEntries(CATS.map((k) => [k, 0])), items = { ...counts };
  for (const f of findings) { counts[f.cat]++; items[f.cat] += f.count || 1; }
  const perCtx = Object.fromEntries(contexts.map((c) => [c.id, findings.filter((f) => f.ctx === c.id).length]));
  /* distinct: unique subjects (an image path, a selector, a message) per category, so one hero image seen on 225 pages counts once */
  const distinct = Object.fromEntries(CATS.map((k) => [k, new Set(findings.filter((f) => f.cat === k).flatMap((f) => f.subjects)).size]));
  const agg = new Map();
  for (const f of findings) for (const s of f.subjects) { const k = `${f.cat}|${s}`; const a = agg.get(k) || { cat: f.cat, subject: s, score: 0, ctx: new Set(), pages: new Set(), worst: f.detail, worstScore: -1 }; a.score += f.score; a.ctx.add(f.ctx); a.pages.add(f.page); if (f.score > a.worstScore) { a.worstScore = f.score; a.worst = f.detail; } agg.set(k, a); }
  const offenders = [...agg.values()].sort((a, b) => b.score - a.score).map((a) => ({ cat: a.cat, subject: a.subject, score: a.score, contexts: a.ctx.size, pages: a.pages.size, worst: a.worst }));
  return { counts, items, distinct, total: findings.length, perContext: perCtx, offenders };
}

function markdown(meta, contexts, findings, summary) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);
  const L = [];
  const usedCats = CATS.filter((k) => summary.counts[k]);
  L.push("# Visual quality audit", "", `Target: ${meta.base}`, `Run: ${meta.startedAt}, ${Math.round(meta.elapsedMs / 1000)} s of a ${Math.round(meta.budgetMs / 60000)} min budget. Non-gating: findings never fail CI. Method and thresholds: docs/visual-quality.md.`, "");
  L.push("## Findings by category", "", "| Category | Distinct subjects | Findings (per page and context) | Items |", "| :--- | ---: | ---: | ---: |");
  for (const k of usedCats) L.push(`| ${k} | ${summary.distinct[k]} | ${summary.counts[k]} | ${summary.items[k]} |`);
  if (!summary.total) L.push("| none | 0 | 0 | 0 |");
  L.push("", `Total: ${summary.total} findings across ${contexts.filter((c) => c.phases.length).length} of ${contexts.length} contexts.`, "");
  L.push("## Worst offenders first", "", "| # | Category | Subject | Score | Contexts | Pages | Worst case |", "| ---: | :--- | :--- | ---: | ---: | ---: | :--- |");
  summary.offenders.slice(0, 30).forEach((o, i) => L.push(`| ${i + 1} | ${o.cat} | ${cell(o.subject)} | ${o.score} | ${o.contexts} | ${o.pages} | ${cell(o.worst)} |`));
  if (!summary.offenders.length) L.push("| - | none | - | - | - | - | - |");
  L.push("", "## Contexts", "", "| Context | Engine | Viewport @ DPR | Scheme | Motion | Findings | Status | First screen |", "| :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |");
  for (const c of contexts) L.push(`| ${c.id} | ${c.engine} | ${c.viewport} @ ${c.dpr}${c.touch ? " touch" : ""} | ${c.scheme}${c.forcedColors ? " forced-colors" : ""} | ${c.reducedMotion ? "reduced" : "full"} | ${summary.perContext[c.id] ?? 0} | ${c.status} | ${c.screenshot ? `[${c.screenshot}](${c.screenshot})` : "-"} |`);
  if (usedCats.length) {
    L.push("", "## Findings by page", "", `| Page | ${usedCats.join(" | ")} | All |`, `| :--- | ${usedCats.map(() => "---:").join(" | ")} | ---: |`);
    for (const p of ["first-visit", ...SCENES]) { const fp = findings.filter((f) => f.page === p); L.push(`| ${p} | ${usedCats.map((k) => fp.filter((f) => f.cat === k).length).join(" | ")} | ${fp.length} |`); }
  }
  L.push("", "## What each engine reports (HDR and wide gamut)", "", "Playwright cannot force these; the values are what the engine on this runner reports. A headless runner normally reports an sRGB, standard-dynamic-range display, so the P3 and HDR branches of the CSS are not exercised here.", "", "| Context | dynamic-range: high | color-gamut: p3 | rec2020 | srgb | colour depth | hdr-img class |", "| :--- | :--- | :--- | :--- | :--- | ---: | :--- |");
  for (const c of contexts) if (c.report) L.push(`| ${c.id} | ${c.report.dynamicRangeHigh} | ${c.report.colorGamutP3} | ${c.report.colorGamutRec2020} | ${c.report.colorGamutSrgb} | ${c.report.colorDepth} | ${c.report.hdrImgClass} |`);
  const g = meta.source;
  L.push("", "What the source promises (grep of css/, scenes/ and js/):", "", `- \`@media (dynamic-range: high)\`: ${g.dynamicRangeMedia.count} lines in ${Object.keys(g.dynamicRangeMedia.files).join(", ") || "-"}`, `- \`color(display-p3\`: ${g.displayP3.count} lines in ${Object.entries(g.displayP3.files).map(([f, n]) => `${f} (${n})`).join(", ") || "-"}`, `- \`color-gamut\`: ${g.colorGamutMedia.count}; \`dynamic-range-limit\`: ${g.dynamicRangeLimit.count}; \`image-set(\`: ${g.imageSet.count}; canvas \`colorSpace\`: ${g.canvasColorSpace.count}; \`plus-lighter\`: ${g.plusLighter.count}`);
  L.push("", "## Notes", "", "- Scenes are reached by changing the hash in the already loaded page, so LCP and the load transfer belong to the first visit; CLS, long frames and bytes on a scene are the change during that scene's first moments.", "- WebKit reports no LCP, layout shift or long animation frame entries here; those cells are n/a for it, not zero.", "- Image sizes use what is in the viewport at scroll top.");
  const skipped = contexts.filter((c) => c.status !== "ok"); if (skipped.length) L.push("- Contexts not fully run: " + skipped.map((c) => `${c.id} (${c.status}${c.error ? `: ${c.error}` : ""})`).join("; "));
  return L.join("\n") + "\n";
}

async function main() {
  const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
  fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });
  const meta = { base: BASE, startedAt: new Date(T0).toISOString(), budgetMs: BUDGET_MS, node: process.version, thresholds: TH, source: grepSource(), contextsPlanned: CONTEXTS.length };
  const browsers = {}, launchErrors = {};
  for (const eng of ["chromium", "webkit"]) {
    if (!CONTEXTS.some((c) => c.engine === eng)) continue;
    try { browsers[eng] = stubbed(await pw[eng].launch(eng === "chromium" && process.env.AUDIT_CHROMIUM_PATH ? { executablePath: process.env.AUDIT_CHROMIUM_PATH, args: ["--no-sandbox"] } : {}), { label: `visual api-stub (${eng})` }); } catch (e) { launchErrors[eng] = String(e.message || e).split("\n")[0]; console.log(`WARN ${eng} did not launch: ${launchErrors[eng]}`); }
  }
  meta.launchErrors = launchErrors;
  if (!Object.keys(browsers).length) { console.error("crash: no browser could be launched"); process.exit(1); }
  const contexts = [];
  for (const c of CONTEXTS) {
    if (Date.now() > DEADLINE) { contexts.push({ id: c.id, engine: c.engine, viewport: `${c.w}x${c.h}`, dpr: c.dpr, touch: !!c.touch, scheme: c.dark ? "dark" : "light", reducedMotion: !!c.reduced, forcedColors: !!c.forced, phases: [], status: "skipped-budget" }); continue; }
    const t = Date.now(); const rec = await runContext(browsers, c); contexts.push(rec);
    console.log(`${rec.status} ${c.id}: ${rec.phases.length} pages in ${Math.round((Date.now() - t) / 1000)} s`);
  }
  for (const b of Object.values(browsers)) await b.close().catch(() => {});
  meta.elapsedMs = Date.now() - T0; meta.finishedAt = new Date().toISOString();
  const findings = contexts.flatMap(findingsOf).sort((a, b) => b.score - a.score);
  const summary = summarise(contexts, findings);
  const ran = contexts.filter((c) => c.phases.length);
  const json = { meta, summary: { counts: summary.counts, items: summary.items, distinct: summary.distinct, total: summary.total, perContext: summary.perContext, offenders: summary.offenders.slice(0, 60) }, contexts, findings };
  fs.writeFileSync(path.join(OUT, "visual-audit.json"), JSON.stringify(json, null, 1));
  fs.writeFileSync(path.join(OUT, "visual-audit.md"), markdown(meta, contexts, findings, summary));
  if (!ran.length) { console.error("crash: no context produced a page"); process.exit(1); }
  console.log(`visual-audit: ${summary.total} findings in ${ran.length} contexts (${Math.round(meta.elapsedMs / 1000)} s)`);
  console.log(CATS.filter((k) => summary.counts[k]).map((k) => `${k}=${summary.counts[k]} (${summary.distinct[k]} distinct)`).join(" ") || "no findings");
  /* the head of the report, so it can be read from the CI log without the artifact */
  console.log("\nTop offenders (category | subject | contexts | pages | worst case):");
  summary.offenders.slice(0, 40).forEach((o, i) => console.log(`${i + 1}. ${o.cat} | ${o.subject.slice(0, 110)} | ${o.contexts} ctx | ${o.pages} pages | ${o.worst.slice(0, 150)}`));
  console.log("\nEngine report (dynamic-range high | gamut p3 | rec2020 | depth):");
  contexts.filter((c) => c.report).forEach((c) => console.log(`${c.id}: ${c.report.dynamicRangeHigh} | ${c.report.colorGamutP3} | ${c.report.colorGamutRec2020} | ${c.report.colorDepth}`));
  console.log("\nContexts:"); contexts.forEach((c) => console.log(`${c.id}: ${c.status}, ${c.phases.length} pages, ${summary.perContext[c.id] ?? 0} findings`));
}
main().catch((e) => { console.error("crash:", e && e.stack ? e.stack : e); process.exit(1); });
