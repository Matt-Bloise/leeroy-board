// Layout invariants sweep: opens every scene at laptop, desktop, tablet and phone sizes in three visitor states and judges the DOM, not the look.
//   node layout-sweep.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
//   options: --engine chromium|webkit|firefox (default chromium)   --out report.json   --budget-min 7   --concurrency 4
//            --sizes 1024x768,390x844 (subset)   --states gate,looking,member   --scenes five,buffs
//            --inject-css file.css   adds a stylesheet to every page, to prove an invariant can fail (self-test only)
// No AI call, nothing is sent: the only requests are the page's own. Exit 0 when every invariant holds in every cell, 1 otherwise (also when the time budget runs out first).
// Matrix: 18 viewport sizes (touch + isMobile under 700 wide) x 3 states (gate = first visit, looking = "Just take a look", member = name chip then "Show me what is next")
// x 12 scenes (set through location.hash). Each scene must really open (html.scene-open, #scene not hidden) or that is a failure of its own.
// Invariants per cell (name in the report):
//   scene-open      the hash opened the scene
//   hscroll         the document does not scroll sideways
//   close-viewport  #scene-close is fully inside the viewport and inside .sheet
//   close-hit       elementFromPoint at the centre of #scene-close returns it or a child (nothing covers it)
//   head-overlap    no two visible controls in .sheet-head overlap
//   title-ellipsis  at 960 wide and up #sheet-title is not cut (scrollWidth <= clientWidth + 1)
//   title-stack     #sheet-title is never one character per line
//   touch-height    on touch sizes every visible button, link and tab in the header and bottom bar is at least 44 px tall
//   body-scroll     #sheet-body scrolls (overflow-y auto/scroll) when its content is taller
//   body-last       after scrolling to the end, the last visible child sits inside #sheet-body and inside the viewport
//   http-error      a same-origin response was 4xx or 5xx
//   console-error   a page error or console error (resource-load lines are covered by http-error; the Cloudflare insights beacon is ignored)
// Report: array of {w,h,engine,state,scene,invariant,detail} for failures only, plus a summary, written to --out as {summary, failures}.
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2), arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node layout-sweep.mjs --url <pages origin> (or set PREVIEW_PAGES) [--engine chromium|webkit|firefox] [--out report.json]"); process.exit(2); }
// run.mjs runs every suite in this folder; CI runs this one in its own `layout` job, so the `browser` job sets LAYOUT_SWEEP_SKIP=1 rather than sweeping twice.
if (process.env.LAYOUT_SWEEP_SKIP === "1") { console.log("layout-sweep: skipped (LAYOUT_SWEEP_SKIP=1; the layout job runs it)"); process.exit(0); }
const ENGINE = arg("--engine", "chromium");
if (!["chromium", "webkit", "firefox"].includes(ENGINE) || !pw[ENGINE]) { console.error(`unknown engine ${ENGINE}`); process.exit(2); }
const OUT = arg("--out"), BUDGET_MS = Number(arg("--budget-min", "7")) * 60000, CONC = Math.max(1, Number(arg("--concurrency", "4")));
const T0 = Date.now();

const ALL_SIZES = ["1920x1080", "1536x864", "1440x900", "1366x768", "1280x720", "1280x600", "1024x768", "1024x576", "960x540", "800x600", "768x1024", "600x800", "430x932", "390x844", "360x640", "320x568", "568x320", "844x390"];
const ALL_STATES = ["gate", "looking", "member"];
const ALL_SCENES = ["timeline", "five", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "tonight", "decide"];
const pick = (k, all) => { const v = arg(k); if (!v) return all; const l = v.split(",").filter(Boolean); const bad = l.filter((x) => !all.includes(x)); if (bad.length) { console.error(`${k}: unknown ${bad.join(",")}`); process.exit(2); } return l; };
const SIZES = pick("--sizes", ALL_SIZES).map((s) => { const [w, h] = s.split("x").map(Number); return { w, h, touch: w < 700 }; });
const STATES = pick("--states", ALL_STATES), SCENES = pick("--scenes", ALL_SCENES);
const INJECT = arg("--inject-css") ? readFileSync(arg("--inject-css"), "utf8") : "";
const url = `${BASE.replace(/\/$/, "")}/?preview=1`;
const ORIGIN = new URL(url).origin;
// Known by-design exceptions, listed so they are visible and easy to delete. A member who has picked a name and opens #tonight lands on the wall: the app clears the hash and no scene opens.
// Confirmed by hand on master (scene-open class off, #scene hidden, hash emptied); if the owner decides that deep link should open Next steps, delete the entry and the sweep will judge it.
const NO_OPEN = new Set(["member/tonight"]);
const failures = [];
let skipped = 0, cells = 0, checks = 0, truncated = false;
const fail = (c, state, scene, invariant, detail) => failures.push({ w: c.w, h: c.h, engine: ENGINE, state, scene, invariant, detail: String(detail).slice(0, 300) });

// Runs in the page: resolves once the sheet is opaque and the header controls have stopped moving (open animation, async tab arrows, fonts), or after 3.5 s.
async function settle() {
  const snap = () => { const sh = document.querySelector("#scene .sheet"), hd = document.querySelector("#scene .sheet-head"); if (!sh || !hd) return "none"; return `${getComputedStyle(sh).opacity}|${[...hd.querySelectorAll("button, a[href], [role=tab], h2")].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; }).join(";")}|${document.querySelector("#sheet-body")?.scrollHeight}`; };
  let last = "", same = 0;
  for (let t = 0; t < 3500; t += 100) {
    await new Promise((r) => setTimeout(r, 100));
    const cur = snap();
    same = cur === last && /^1\|/.test(cur) ? same + 1 : 0; last = cur;
    if (same >= 3) return true;
  }
  return false;
}

// Runs in the page. Returns [{invariant, detail}] for this cell and the number of invariants it evaluated.
function measure({ touch, w }) {
  const out = [];
  let n = 0;
  const bad = (invariant, detail) => out.push({ invariant, detail });
  const R = (el) => el.getBoundingClientRect();
  const fmt = (r) => `[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`;
  const visible = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (e.hidden) return false;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    }
    const r = R(el);
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""}${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24) ? ` "${(el.getAttribute("aria-label") || el.textContent).trim().replace(/\s+/g, " ").slice(0, 24)}"` : ""}`;
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  // hscroll
  n++;
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1 || document.body.scrollWidth > de.clientWidth + 1) bad("hscroll", `document ${de.scrollWidth} body ${document.body.scrollWidth} > viewport ${de.clientWidth}`);
  const sheet = document.querySelector("#scene .sheet"), head = document.querySelector("#scene .sheet-head"), close = document.querySelector("#scene-close");
  const title = document.querySelector("#sheet-title"), body = document.querySelector("#sheet-body");
  if (!sheet || !head || !close || !title || !body) { bad("scene-open", "sheet, header, close button, title or body missing from the DOM"); return { out, n }; }
  // close button inside the viewport and the sheet, and not covered
  n += 2;
  const cr = R(close), sr = R(sheet), tol = 1;
  if (!visible(close)) bad("close-viewport", `close button is not visible (${(() => { for (let e = close; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (e.hidden || cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return `${label(e)} hidden=${e.hidden} display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity}`; } return "zero size " + fmt(cr); })()})`);
  else {
    if (cr.left < -tol || cr.top < -tol || cr.right > vw + tol || cr.bottom > vh + tol) bad("close-viewport", `close ${fmt(cr)} outside viewport ${vw}x${vh}`);
    else if (cr.left < sr.left - tol || cr.top < sr.top - tol || cr.right > sr.right + tol || cr.bottom > sr.bottom + tol) bad("close-viewport", `close ${fmt(cr)} outside sheet ${fmt(sr)}`);
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    if (cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(hit === close || close.contains(hit))) bad("close-hit", `at close centre (${Math.round(cx)},${Math.round(cy)}) the top element is ${hit ? label(hit) : "nothing"}`);
    } else bad("close-hit", `close centre (${Math.round(cx)},${Math.round(cy)}) is outside the viewport`);
  }
  // pairwise overlap of visible controls in the header
  n++;
  // the part of a control a visitor can actually see: its rect cut by every clipping ancestor (the tab strip scrolls, so tabs scrolled out of it are not on screen)
  const shown = (el) => {
    let r = R(el);
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const pr = R(p);
      r = { left: Math.max(r.left, pr.left), top: Math.max(r.top, pr.top), right: Math.min(r.right, pr.right), bottom: Math.min(r.bottom, pr.bottom) };
      if (r.right <= r.left || r.bottom <= r.top) return null;
    }
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top };
  };
  const ctl = [...head.querySelectorAll("button, a[href], [role=tab], input, select, textarea")].filter(visible).filter((e) => shown(e));
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], b = ctl[j];
    if (a.contains(b) || b.contains(a)) continue;
    // overlaps of 4 px or less are rounded corners and sub-pixel edges (the seal and the emblem are circles), not collisions
    // the tab strip's scroll arrows sit on the strip's edges on purpose (v13d.css .tabs-arrow); they are not a collision with the tabs under them
    if ((a.classList.contains("tabs-arrow") && b.closest("#tabs")) || (b.classList.contains("tabs-arrow") && a.closest("#tabs"))) continue;
    const ra = shown(a), rb = shown(b), ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ox > 4 && oy > 4) bad("head-overlap", `${label(a)} ${fmt(ra)} overlaps ${label(b)} ${fmt(rb)} by ${Math.round(ox)}x${Math.round(oy)}`);
  }
  // title
  n += 2;
  const ts = getComputedStyle(title), fs = parseFloat(ts.fontSize) || 16, tr = R(title), text = title.textContent.trim();
  if (w >= 960 && title.scrollWidth > title.clientWidth + 1) bad("title-ellipsis", `"${text}" scrollWidth ${title.scrollWidth} > clientWidth ${title.clientWidth}`);
  if (text.length >= 4 && visible(title)) {
    const lh = parseFloat(ts.lineHeight) || fs * 1.3, lines = Math.max(1, Math.round(tr.height / lh));
    if (lines >= text.length - 1 || tr.width < fs * 1.5) bad("title-stack", `"${text}" is ${lines} line(s) in a ${Math.round(tr.width)}px box (font ${fs}px)`);
  }
  // touch height
  if (touch) {
    n++;
    const bar = document.querySelector("#bottombar");
    const hit = [...head.querySelectorAll("button, a[href], [role=tab]"), ...(bar ? bar.querySelectorAll("button, a[href], [role=tab]") : [])].filter(visible);
    for (const el of hit) { const r = R(el); if (r.height < 43.5) bad("touch-height", `${label(el)} is ${r.height.toFixed(1)}px tall (${fmt(r)})`); }
  }
  // sheet body scroll
  n += 2;
  const bs = getComputedStyle(body), br = R(body), over = body.scrollHeight > body.clientHeight + 1;
  if (over && !/auto|scroll/.test(bs.overflowY)) bad("body-scroll", `content ${body.scrollHeight}px in a ${body.clientHeight}px body but overflow-y is ${bs.overflowY}`);
  else if (over) {
    const kids = [...body.children].filter(visible), last = kids[kids.length - 1];
    const prev = body.scrollTop;
    body.scrollTop = body.scrollHeight;
    if (last) {
      // the last visible child of the active panel is the thing a visitor must be able to reach
      let leaf = last;
      while (leaf.lastElementChild && visible(leaf.lastElementChild) && leaf.matches("[role=tabpanel]")) leaf = leaf.lastElementChild;
      const lr = R(leaf), brn = R(body);
      if (lr.bottom > brn.bottom + 2 || lr.bottom > vh + 2) bad("body-last", `after scrolling to the end the last child ${label(leaf)} ends at ${Math.round(lr.bottom)} (body ends ${Math.round(brn.bottom)}, viewport ${vh})`);
    }
    body.scrollTop = prev;
  }
  return { out, n };
}

async function openState(page, state) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(500);
  if (state !== "gate") await page.getByText("Just take a look", { exact: false }).first().click({ timeout: 8000 });
  if (state === "member") {
    await page.getByRole("button", { name: /Bloise/ }).first().click({ timeout: 8000 });
    await page.getByRole("button", { name: /Show me what is next/ }).first().click({ timeout: 8000 });
  }
  await page.waitForTimeout(state === "gate" ? 300 : 1200);
}

async function cell(browser, size, state) {
  const opts = { viewport: { width: size.w, height: size.h }, serviceWorkers: "block", reducedMotion: "reduce" };
  if (size.touch) { opts.hasTouch = true; if (ENGINE !== "firefox") opts.isMobile = true; }
  const ctx = await browser.newContext(opts), page = await ctx.newPage();
  if (INJECT) await ctx.addInitScript((css) => { addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.textContent = css; document.documentElement.append(st); }); }, INJECT);
  let scene = "-";
  const seen = new Set();
  const once = (inv, detail) => { const k = `${scene}|${inv}|${detail}`; if (!seen.has(k)) { seen.add(k); fail(size, state, scene, inv, detail); } };
  page.on("pageerror", (e) => once("console-error", `pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource|^Refused to|cloudflareinsights|beacon\.min\.js/i.test(m.text())) once("console-error", m.text()); });
  page.on("response", (r) => { const u = r.url(); if (u.startsWith(ORIGIN) && r.status() >= 400 && !/cloudflareinsights/.test(u)) once("http-error", `${r.status()} ${u.slice(ORIGIN.length)}`); });
  try {
    await openState(page, state);
    for (const sc of state === "gate" ? ["gate", ...SCENES.slice(0, 0)] : SCENES) {
      scene = sc;
      cells++;
      if (sc !== "gate") {
        if (NO_OPEN.has(`${state}/${sc}`)) { skipped++; continue; }
        await page.evaluate((h) => { location.hash = h; }, sc);
        // really opened: html.scene-open, #scene shown, and the scene's own panel (when it has one) is the visible one
        const isOpen = (k) => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden && (() => { const p = document.querySelector(`#panel-${k}`); return !p || !p.hidden; })();
        let opened = await page.waitForFunction(isOpen, sc, { timeout: 5000 }).then(() => true, () => false);
        if (opened) { await page.waitForTimeout(450); opened = await page.evaluate(isOpen, sc); } // still open after the open animation settles
        checks++;
        if (!opened) { fail(size, state, sc, "scene-open", `#${sc} did not open or closed again (html.scene-open, #scene hidden, #panel-${sc} hidden)`); continue; }
      } else {
        const opened = await page.evaluate(() => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden);
        if (!opened) { // the gate is not a scene sheet: only the document-level invariant applies
          const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
          checks++;
          if (sw[0] > sw[1] + 1) fail(size, state, sc, "hscroll", `document ${sw[0]} > viewport ${sw[1]}`);
          continue;
        }
      }
      // a slow preview can still be opening the sheet after one settle window (seen once in CI: opacity 0 after 4 s); give it up to three before judging
      for (let i = 0; i < 3 && !(await page.evaluate(settle)); i++);
      const { out, n } = await page.evaluate(measure, { touch: size.touch, w: size.w });
      checks += n;
      for (const f of out) once(f.invariant, f.detail);
    }
  } catch (e) {
    fail(size, state, scene, "harness", `${e.message.split("\n")[0]}`);
  } finally { await ctx.close().catch(() => {}); }
}

const launch = { ...(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {}) };
const browser = await pw[ENGINE].launch(launch);
const jobs = [];
for (const size of SIZES) for (const state of STATES) jobs.push([size, state]);
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < jobs.length) {
    if (Date.now() - T0 > BUDGET_MS) { truncated = true; return; }
    const [size, state] = jobs[next++];
    await cell(browser, size, state);
  }
}));
await browser.close();

failures.sort((a, b) => b.w - a.w || b.h - a.h || a.state.localeCompare(b.state) || a.scene.localeCompare(b.scene) || a.invariant.localeCompare(b.invariant));
const byInv = {}, bySize = {}, byScene = {};
for (const f of failures) { byInv[f.invariant] = (byInv[f.invariant] || 0) + 1; const s = `${f.w}x${f.h}`; bySize[s] = (bySize[s] || 0) + 1; byScene[f.scene] = (byScene[f.scene] || 0) + 1; }
const summary = { url: BASE, engine: ENGINE, sizes: SIZES.length, states: STATES.length, scenes: SCENES.length, cells, invariantChecks: checks, failures: failures.length, byInvariant: byInv, bySize, byScene, skippedCells: skipped, truncated, seconds: Math.round((Date.now() - T0) / 1000) };
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, failures }, null, 1));

if (failures.length) {
  // grouped table: one row per invariant + size, with the states and scenes it hits and one example
  const groups = new Map();
  for (const f of failures) { const k = `${f.invariant}|${f.w}x${f.h}`; const g = groups.get(k) || { invariant: f.invariant, size: `${f.w}x${f.h}`, states: new Set(), scenes: new Set(), n: 0, ex: f.detail }; g.states.add(f.state); g.scenes.add(f.scene); g.n++; groups.set(k, g); }
  console.log("\ninvariant        size       n   states                  scenes");
  for (const g of [...groups.values()].sort((a, b) => a.invariant.localeCompare(b.invariant) || parseInt(b.size) - parseInt(a.size))) {
    const sc = g.scenes.size === SCENES.length ? "all" : [...g.scenes].join(",");
    console.log(`${g.invariant.padEnd(16)} ${g.size.padEnd(10)} ${String(g.n).padStart(3)}  ${[...g.states].join(",").padEnd(22)}  ${sc}`);
    console.log(`    e.g. ${g.ex}`);
  }
}
for (const f of failures.slice(0, 20)) console.log(`FAIL ${f.w}x${f.h} ${f.engine} ${f.state}/${f.scene} ${f.invariant}: ${f.detail}`);
if (truncated) console.log(`FAIL time budget of ${BUDGET_MS / 60000} min ran out after ${cells} cells; the sweep is incomplete`);
console.log(`layout-sweep: ${ENGINE}, ${cells} cells, ${checks} invariant checks, ${failures.length} failures${truncated ? " (INCOMPLETE)" : ""} in ${summary.seconds}s`);
process.exit(failures.length || truncated ? 1 : 0);
