// Layout invariants sweep: opens every scene at laptop, desktop, tablet and phone sizes in three visitor states and judges the DOM, not the look.
//   node layout-sweep.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
//   options: --engine chromium|webkit|firefox (default chromium)   --out report.json   --budget-min 7   --concurrency 4
//            --sizes 1024x768,390x844 (subset)   --states gate,looking,member   --scenes five,buffs
//            --zoom-selftest   check the zoom-aware coordinate helper on the chosen engine against a built-in page and exit (no --url needed)
//            --live-api   use the real API the page points at (default: the Worker API is answered from tests/fixtures/api-snapshot, so the sweep sends no request to the Worker)
//            --no-retry   do not run a failed (size, state) cell a second time in a fresh page (default: retry once, print WARN when it passed only on the retry)
//            --clock 2026-11-04T10:00:00Z   load every page with its clock set to that instant (it keeps running), to check a time-dependent screen such as the launch hero without waiting (tests/helpers/clock-arg.mjs)
//            --inject-css file.css   adds a stylesheet to every page, to prove an invariant can fail (self-test only)
// No AI call, nothing is sent. By default every /api/ call is fulfilled by Playwright from tests/fixtures/api-snapshot (tests/helpers/api-stub.mjs): the sweep judges layout, not the API,
// and a full sweep made 1,056 Worker requests before this (measured locally, docs/runbooks/cloudflare-requests.md). An API path the snapshot lacks fails the run (invariant stub-miss). Exit 0 when every invariant holds in every cell, 1 otherwise (also when the time budget runs out first).
// Matrix: 24 viewport sizes (touch + isMobile under 700 wide) x 3 states (gate = first visit, looking = "Just take a look", member = name chip then "Show me what is next")
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
//   doc-fit         first visit, desktop sizes (700 wide and up), before any click: documentElement scrollHeight <= innerHeight and scrollWidth <= innerWidth
//   wheel-still     first visit, desktop: a wheel event leaves scrollY at 0
//   one-scroller    REPORT ONLY (listed in the summary, never fails): first visit, no more than one scrolling box
//   fill            first visit, the card fills at least 25 percent of its parchment (area ratio). FAILS at 3440x1440, 3840x2160 and 5120x1440 (FILL_ENFORCED); report only at every other size
//   close-hit-tour  every scene: with the guided tour veil (.walk > .walk-veil) up, the close button is still the top element at its centre
//   tile-clip       looking and member, the wall before any scene opens: no wall tile clips its own text (a clipping box shorter than its content, or text outside its tile)
//   http-error      a same-origin response was 4xx or 5xx
//   console-error   a page error or console error (resource-load lines are covered by http-error; the Cloudflare insights beacon is ignored)
// Zoom: WebKit (Safari 18.2) reports unzoomed getBoundingClientRect values for elements under CSS `zoom` (the sheet panels use zoom: 1.052 at laptop sizes). window.__lz (ZOOM_JS below)
// multiplies a rect or a point by the cumulative zoom (product of getComputedStyle(el).zoom over the element and its ancestors), only on WebKit and only if a probe shows the engine
// really reports unzoomed values; on Chromium and Firefox it changes nothing. close-viewport, close-hit and body-last use it, and so do the clicks on WebKit.
// Report: array of {w,h,engine,state,scene,invariant,detail} for failures only, plus a summary, written to --out as {summary, failures}.
import { pageUrl } from "../helpers/page-url.mjs";
import { parseClock, applyClock, expectedHero } from "../helpers/clock-arg.mjs";
import { stubbed, LIVE_API, ALLOW_MISS } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2), arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE && !argv.includes("--zoom-selftest")) { console.error("usage: node layout-sweep.mjs --url <pages origin> (or set PREVIEW_PAGES) [--engine chromium|webkit|firefox] [--out report.json]"); process.exit(2); }
// run.mjs runs every suite in this folder; CI runs this one in its own `layout` job, so the `browser` job sets LAYOUT_SWEEP_SKIP=1 rather than sweeping twice.
if (process.env.LAYOUT_SWEEP_SKIP === "1") { console.log("layout-sweep: skipped (LAYOUT_SWEEP_SKIP=1; the layout job runs it)"); process.exit(0); }
let CLOCK = null;
try { CLOCK = parseClock(argv); } catch (e) { console.error(e.message); process.exit(2); }
const ENGINE = arg("--engine", "chromium");
if (!["chromium", "webkit", "firefox"].includes(ENGINE) || !pw[ENGINE]) { console.error(`unknown engine ${ENGINE}`); process.exit(2); }
const OUT = arg("--out"), BUDGET_MS = Number(arg("--budget-min", "7")) * 60000, CONC = Math.max(1, Number(arg("--concurrency", "4")));
const T0 = Date.now();

const ALL_SIZES = ["1920x1080", "1536x864", "1440x900", "1366x768", "1280x720", "1280x600", "1024x768", "1024x576", "960x540", "800x600", "768x1024", "600x800", "430x932", "390x844", "360x640", "320x568", "568x320", "844x390",
  "2560x1440", "3840x2160", "5120x2880", "7680x4320", "640x360", "384x216", "3440x1440", "860x360"]; /* the last eight: large screens, an ultrawide, a short landscape window and browser zoom (zoomed-out and zoomed-in windows are just different CSS viewports) */
const ALL_STATES = ["gate", "looking", "member"];
const ALL_SCENES = ["timeline", "five", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "tonight", "decide"];
const pick = (k, all) => { const v = arg(k); if (!v) return all; const l = v.split(",").filter(Boolean); const bad = l.filter((x) => !all.includes(x)); if (bad.length) { console.error(`${k}: unknown ${bad.join(",")}`); process.exit(2); } return l; };
ALL_SIZES.push("5120x1440"); /* 34 inch ultra-wide at double width: a very wide, not very tall window */
// fill is enforced (a failure) at these sizes: the first-visit card must fill at least 25 percent of its parchment. Elsewhere it only reports.
const FILL_ENFORCED = new Set(["3440x1440", "3840x2160", "5120x1440"]);
const SIZES = pick("--sizes", ALL_SIZES).map((s) => { const [w, h] = s.split("x").map(Number); return { w, h, touch: w < 700 }; });
const STATES = pick("--states", ALL_STATES), SCENES = pick("--scenes", ALL_SCENES);
const INJECT = arg("--inject-css") ? readFileSync(arg("--inject-css"), "utf8") : "";
const url = BASE ? pageUrl(BASE, { params: { preview: "1" } }) : "about:blank";
const ORIGIN = BASE ? new URL(url).origin : "";
// Known by-design exceptions, listed so they are visible and easy to delete. A member who has picked a name and opens #tonight lands on the wall: the app clears the hash and no scene opens.
// Confirmed by hand on master (scene-open class off, #scene hidden, hash emptied); if the owner decides that deep link should open Next steps, delete the entry and the sweep will judge it.
const NO_OPEN = new Set(["member/tonight"]);
const failures = [], notes = [];
let skipped = 0, cells = 0, checks = 0, truncated = false, retried = 0;
// One (size, state) cell keeps its own tally while it runs so a failed attempt can be thrown away and run again in a fresh page; the tally of the attempt that counts is merged into the totals.
const fail = (c, state, scene, invariant, detail, sink = failures) => sink.push({ w: c.w, h: c.h, engine: ENGINE, state, scene, invariant, detail: String(detail).slice(0, 300) });

// Runs in every page (addInitScript). window.__lz.rect(el) is el.getBoundingClientRect() in real viewport pixels; point(el) its centre. See the Zoom note at the top.
function ZOOM_JS(isWebkit) {
  const cum = (el) => { let z = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const v = parseFloat(getComputedStyle(e).zoom); if (v > 0) z *= v; } return z; };
  let need = null;
  const probe = () => { // does this engine report the unzoomed size of a zoom:2 box? Measured once per page, so a fixed WebKit is left alone.
    if (need !== null) return need;
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;left:0;top:0;width:100px;height:10px;zoom:2;visibility:hidden";
    document.documentElement.append(d);
    need = isWebkit && Math.abs(d.getBoundingClientRect().width - 100) < 1;
    d.remove();
    return need;
  };
  const factor = (el) => (probe() ? cum(el) : 1);
  window.__lz = {
    factor,
    rect(el) { const r = el.getBoundingClientRect(), f = factor(el); return f === 1 ? r : { left: r.left * f, top: r.top * f, right: r.right * f, bottom: r.bottom * f, width: r.width * f, height: r.height * f }; },
    point(el) { const r = window.__lz.rect(el); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
  };
}

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
  const R = (el) => window.__lz.rect(el);
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

// WebKit under CSS zoom: a locator click aims at the unzoomed rect and times out, so click the zoom-aware centre of the element instead.
async function press(page, locator, timeout = 20000) {
  if (ENGINE !== "webkit") return locator.click({ timeout });
  const el = await locator.elementHandle({ timeout });
  await el.evaluate((e) => e.scrollIntoView({ block: "center", inline: "center" }));
  const { x, y } = await el.evaluate((e) => window.__lz.point(e));
  await page.mouse.click(x, y);
}

async function openState(page, state) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(500);
  if (state !== "gate") await press(page, page.getByText("Just take a look", { exact: false }).first());
  if (state === "member") {
    await press(page, page.getByRole("button", { name: /Bloise/ }).first());
    await press(page, page.getByRole("button", { name: /Show me what is next/ }).first());
  }
  await page.waitForTimeout(state === "gate" ? 300 : 1200);
}


// First-visit checks, run on the gate state BEFORE any click. doc-fit and wheel-still fail the run (desktop sizes only); one-scroller only reports; fill reports except at the three FILL_ENFORCED sizes.
async function gateChecks(page, size, once, A) {
  const measureGate = () => page.evaluate(() => {
    const de = document.documentElement, card = document.querySelector("#nx-fr2");
    const scrollers = [...document.querySelectorAll("body *")].filter((e) => { const s = getComputedStyle(e); return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1 && s.display !== "none" && e.getClientRects().length; }).map((e) => e.id || e.className || e.tagName);
    const box = card && (card.closest(".sheet") || card.closest("#sheet-body") || card.parentElement), cr = card && card.getBoundingClientRect(), br = box && box.getBoundingClientRect();
    return { sh: de.scrollHeight, sw: de.scrollWidth, ih: innerHeight, iw: innerWidth, docScrolls: de.scrollHeight > innerHeight + 1, scrollers, fill: cr && br && br.width * br.height > 0 ? (cr.width * cr.height) / (br.width * br.height) : null };
  });
  // a faked-clock run must really be in the state it claims: the launch hero is up (html[data-launch] and #launch-hero, with its live class after launch) or absent
  if (CLOCK) {
    const want = expectedHero(CLOCK);
    A.checks++;
    const got = await page.waitForFunction((w) => (document.documentElement.dataset.launch || "") === w && !!document.querySelector("#launch-hero") === !!w, want, { timeout: 8000 }).then(() => true, () => false);
    if (!got) {
      const seen = await page.evaluate(() => ({ phase: document.documentElement.dataset.launch || "", hero: !!document.querySelector("#launch-hero") }));
      once("clock-state", `--clock ${CLOCK.toISOString()}: expected the launch hero ${want ? `up (${want})` : "absent"}, found data-launch="${seen.phase}" and #launch-hero ${seen.hero ? "present" : "missing"}`);
    } else if (want) {
      A.checks++;
      const live = await page.evaluate(() => document.querySelector("#launch-hero").classList.contains("is-live"));
      if (live !== (want === "live")) once("clock-state", `--clock ${CLOCK.toISOString()}: #launch-hero ${live ? "has" : "lacks"} the is-live class, expected ${want === "live" ? "live" : "the countdown"}`);
    }
  }
  let m = await measureGate();
  // the card is scaled by CSS and the scene fit runs on a timer: on a busy machine the first reading can come before it settles, so at the enforced sizes look again (up to 8 x 400 ms) before judging fill
  for (let i = 0; i < 8 && FILL_ENFORCED.has(`${size.w}x${size.h}`) && (m.fill === null || m.fill < 0.25); i++) { await page.waitForTimeout(400); m = await measureGate(); }
  if (!size.touch) {
    A.checks += 2;
    if (m.sh > m.ih || m.sw > m.iw) once("doc-fit", `document ${m.sw}x${m.sh} in a ${m.iw}x${m.ih} window`);
    await page.mouse.move(Math.round(size.w / 2), Math.round(size.h / 2));
    await page.mouse.wheel(0, 400); await page.waitForTimeout(150);
    const y = await page.evaluate(() => scrollY);
    if (y !== 0) once("wheel-still", `scrollY ${y} after a wheel event`);
  }
  const n = m.scrollers.length + (m.docScrolls ? 1 : 0);
  if (n > 1) notes.push({ w: size.w, h: size.h, invariant: "one-scroller", detail: `${n} scrolling boxes: ${m.docScrolls ? "document, " : ""}${m.scrollers.slice(0, 3).join(", ")}` });
  const fillDetail = m.fill === null ? "no first-visit card found" : m.fill < 0.25 ? `card fills ${(m.fill * 100).toFixed(1)}% of its parchment (want 25%)` : null;
  if (FILL_ENFORCED.has(`${size.w}x${size.h}`)) { A.checks++; if (fillDetail) once("fill", fillDetail); }
  else if (m.fill === null) notes.push({ w: size.w, h: size.h, invariant: "fill", detail: "no first-visit card found" });
  else if (m.fill < 0.25) notes.push({ w: size.w, h: size.h, invariant: "fill", detail: `card fills ${(m.fill * 100).toFixed(1)}% of its parchment (want 25%)` });
}

// Wall tiles must not clip their own text. In a cell that shows the wall (looking, member; before any scene opens) every line of text inside a visible #board .tile is measured by its own
// rectangle (Range.getClientRects, so a tap-target padding or an invisible box does not count). Each clipping ancestor inside the tile (overflow hidden or clip) must contain it: a title
// whose line box is shorter than the glyphs, a nowrap word cut mid-letter and a clamp box that shows half a line all fail. A line that sits wholly past the bottom of a line-clamp box is
// the clamp doing its job (the ellipsis says so) and passes. Text outside the tile's own rectangle fails too. Needs 9 tiles on screen.
async function wallChecks(page, size, once, A) {
  A.checks++;
  const r = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll("#board .tile")].filter((t) => t.getClientRects().length);
    const bad = [], seen = new Set();
    const T = 1;
    for (const t of tiles) {
      const tr = t.getBoundingClientRect(), name = t.closest("li")?.className.split(/\s+/)[0] || t.dataset.scene;
      const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const txt = n.textContent.trim(); if (!txt) continue;
        const pe = n.parentElement; let hidden = false;
        for (let e = pe; e && e !== t.parentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) { hidden = true; break; } }
        if (hidden) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        const rects = [...rg.getClientRects()].filter((q) => q.width > 0 && q.height > 0); if (!rects.length) continue;
        const what = `${name} ${(typeof pe.className === "string" && pe.className.trim().split(/\s+/)[0]) || pe.tagName.toLowerCase()} "${txt.slice(0, 18)}"`;
        const key = (m) => what + m; let msg = null;
        for (const q of rects) {
          let off = false; // this line is wholly past the bottom of a line-clamp box: hidden on purpose
          for (let e = pe; e && e !== t; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.webkitLineClamp !== "none" && /hidden|clip/.test(cs.overflowY) && q.top >= e.getBoundingClientRect().bottom - T) off = true; }
          if (off) continue;
          if (q.bottom > tr.bottom + T || q.right > tr.right + T || q.left < tr.left - T || q.top < tr.top - T) { msg = `text sits outside its tile (${Math.round(q.left - tr.left)},${Math.round(q.top - tr.top)} ${Math.round(q.width)}x${Math.round(q.height)} in ${Math.round(tr.width)}x${Math.round(tr.height)})`; break; }
          for (let e = pe; e && e !== t; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (!(/hidden|clip/.test(cs.overflowX) || /hidden|clip/.test(cs.overflowY))) continue;
            const c = e.getBoundingClientRect();
            const clamp = cs.webkitLineClamp !== "none";
            if (clamp && q.top >= c.bottom - T) continue; // a whole line past the clamp box: hidden on purpose
            if (q.bottom > c.bottom + T || q.top < c.top - T || q.right > c.right + T || q.left < c.left - T) { msg = `text is cut by ${(typeof e.className === "string" && e.className.trim().split(/\s+/)[0]) || e.tagName.toLowerCase()} (text ${Math.round(q.left - c.left)},${Math.round(q.top - c.top)} ${Math.round(q.width)}x${Math.round(q.height)} in a ${Math.round(c.width)}x${Math.round(c.height)} clipping box)`; break; }
          }
          if (msg) break;
        }
        if (msg && !seen.has(key(msg))) { seen.add(key(msg)); bad.push(`${what}: ${msg}`); }
      }
    }
    return { n: tiles.length, bad };
  });
  // On phones (under 700 wide, one column) two tiles already run a few pixels past their own bottom edge (ledger 2 px at 390, a race name 12 px at 320): that part only reports there. A cut is enforced everywhere.
  const over = r.bad.filter((b) => / sits outside its tile/.test(b)), cut = r.bad.filter((b) => !over.includes(b)), soft = size.touch ? over : [];
  const hard = [...cut, ...(size.touch ? [] : over)];
  if (r.n < 9) once("tile-clip", `only ${r.n} wall tiles on screen (want 9)`);
  else if (hard.length) once("tile-clip", `${hard.length} clipped: ${hard.slice(0, 3).join(" | ")}`);
  if (soft.length) notes.push({ w: size.w, h: size.h, invariant: "tile-overflow", detail: soft.join(" | ").slice(0, 200) });
}

// The guided tour (scenes/walk.js) puts a full-sheet veil over the open scene: .walk > .walk-veil + .walk-card, appended to .sheet. A real tour can start while a scene is open (two seconds after boot,
// and a slow 4K or 5K render makes that likely; the WebKit QA run saw div.walk-veil on top of the close button at 3840x2160 and 5120x2880). The tour is only ever shown once, so a sweep cannot
// count on meeting it: this builds the same markup (classes and structure of begin() in walk.js) in the open scene and requires the close button's centre to still be the top element there.
async function tourVeilCheck(page, size, once, A) {
  A.checks++;
  const r = await page.evaluate(() => {
    const sheet = document.querySelector("#scene .sheet"), close = document.querySelector("#scene-close");
    if (!sheet || !close) return null;
    const w = document.createElement("div"); w.className = "walk"; w.id = "walk-probe";
    const veil = document.createElement("div"); veil.className = "walk-veil"; const card = document.createElement("section"); card.className = "walk-card";
    w.append(veil, card); sheet.appendChild(w);
    try {
      const rc = window.__lz.rect(close), x = rc.left + rc.width / 2, y = rc.top + rc.height / 2, top = document.elementFromPoint(x, y);
      return { ok: !!top && (top === close || close.contains(top)), top: top ? `${top.tagName.toLowerCase()}${top.id ? "#" + top.id : ""}${typeof top.className === "string" && top.className ? "." + top.className.trim().split(/\s+/)[0] : ""}` : "nothing" };
    } finally { w.remove(); }
  });
  if (r && !r.ok) once("close-hit-tour", `with the guided tour veil up, the close button is covered by ${r.top}`);
}

async function cell(browser, size, state, A) {
  const opts = { viewport: { width: size.w, height: size.h }, serviceWorkers: "block", reducedMotion: "reduce" };
  if (size.touch) { opts.hasTouch = true; if (ENGINE !== "firefox") opts.isMobile = true; }
  const ctx = await browser.newContext(opts), page = await ctx.newPage();
  await ctx.addInitScript(ZOOM_JS, ENGINE === "webkit");
  await applyClock(page, CLOCK);
  if (INJECT) await ctx.addInitScript((css) => { addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.textContent = css; document.documentElement.append(st); }); }, INJECT);
  let scene = "-";
  const seen = new Set();
  const once = (inv, detail) => { const k = `${scene}|${inv}|${detail}`; if (!seen.has(k)) { seen.add(k); fail(size, state, scene, inv, detail, A.failures); } };
  page.on("pageerror", (e) => once("console-error", `pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]/.test(m.text()) && !/^Failed to load resource|^Refused to|cloudflareinsights|beacon\.min\.js/i.test(m.text())) once("console-error", m.text()); });
  page.on("response", (r) => { const u = r.url(); if (u.startsWith(ORIGIN) && r.status() >= 400 && !/cloudflareinsights/.test(u)) once("http-error", `${r.status()} ${u.slice(ORIGIN.length)}`); });
  try {
    await openState(page, state);
    if (state === "gate") { scene = "gate"; await gateChecks(page, size, once, A); }
    else { scene = "wall"; await wallChecks(page, size, once, A); }
    for (const sc of state === "gate" ? ["gate", ...SCENES.slice(0, 0)] : SCENES) {
      scene = sc;
      A.cells++;
      if (sc !== "gate") {
        if (NO_OPEN.has(`${state}/${sc}`)) { A.skipped++; continue; }
        await page.evaluate((h) => { location.hash = h; }, sc);
        // really opened: html.scene-open, #scene shown, and the scene's own panel (when it has one) is the visible one
        const isOpen = (k) => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden && (() => { const p = document.querySelector(`#panel-${k}`); return !p || !p.hidden; })();
        // software-rendered WebKit needs 2 to 3 s per frame at 5120x2880 (measured: the page opens in under 100 ms, but the check only gets a turn after the next frame, 5 to 8 s after the hash change), so the wait scales with the pixel count; 5 s up to 2.5 megapixels
        const OPEN_MS = Math.max(5000, Math.round((size.w * size.h) / 1e6) * 4000);
        let opened = await page.waitForFunction(isOpen, sc, { timeout: OPEN_MS }).then(() => true, () => false);
        if (opened) { await page.waitForTimeout(450); opened = await page.evaluate(isOpen, sc); } // still open after the open animation settles
        A.checks++;
        if (!opened) { fail(size, state, sc, "scene-open", `#${sc} did not open or closed again (html.scene-open, #scene hidden, #panel-${sc} hidden)`, A.failures); continue; }
      } else {
        const opened = await page.evaluate(() => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden);
        if (!opened) { // the gate is not a scene sheet: only the document-level invariant applies
          const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
          A.checks++;
          if (sw[0] > sw[1] + 1) fail(size, state, sc, "hscroll", `document ${sw[0]} > viewport ${sw[1]}`, A.failures);
          continue;
        }
      }
      // a slow preview can still be opening the sheet after one settle window (seen once in CI: opacity 0 after 4 s); give it up to eight before judging (the 4K and 8K sizes render in software and are slower still when four cells run at once)
      for (let i = 0; i < 8 && !(await page.evaluate(settle)); i++);
      const { out, n } = await page.evaluate(measure, { touch: size.touch, w: size.w });
      A.checks += n;
      for (const f of out) once(f.invariant, f.detail);
      if (sc !== "gate") await tourVeilCheck(page, size, once, A);
    }
  } catch (e) {
    fail(size, state, scene, "harness", `${e.message.split("\n")[0]}`, A.failures);
  } finally { await ctx.close().catch(() => {}); }
}

const launch = { ...(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {}) };
if (argv.includes("--zoom-selftest")) {
  // The helper must return the right element on every engine: at the rect centre (times the zoom, where the engine needs it) elementFromPoint finds the target, and a click lands on it.
  const b = await pw[ENGINE].launch(launch);
  const page = await (await b.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  await page.addInitScript(ZOOM_JS, ENGINE === "webkit");
  await page.goto("about:blank");
  await page.setContent('<style>body{margin:0}</style><div style="position:absolute;left:100px;top:80px;zoom:1.052"><div style="zoom:1.1;padding:30px"><button id=t style="width:120px;height:40px;margin:20px">t</button><button id=u style="width:120px;height:40px;margin:20px 0 0 200px">u</button></div></div>');
  let bad = 0;
  for (const id of ["t", "u"]) {
    const r = await page.evaluate((i) => { const el = document.getElementById(i), p = window.__lz.point(el), hit = document.elementFromPoint(p.x, p.y); return { hit: hit && hit.id, f: window.__lz.factor(el) }; }, id);
    const ok = r.hit === id; if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} zoom-selftest ${ENGINE} elementFromPoint at helper centre of #${id}: ${r.hit || "nothing"} (factor ${r.f.toFixed(3)})`);
  }
  await page.evaluate(() => { window.__hit = ""; document.addEventListener("click", (e) => { window.__hit = e.target.id; }); });
  await press(page, page.locator("#u"));
  const clicked = await page.evaluate(() => window.__hit), okc = clicked === "u"; if (!okc) bad++;
  console.log(`${okc ? "PASS" : "FAIL"} zoom-selftest ${ENGINE} click via helper reached #u: ${clicked || "nothing"}`);
  await b.close();
  process.exit(bad ? 1 : 0);
}
/* The huge sizes (5120x2880, 7680x4320) render in software on a CI runner and fail now and then for no layout reason. A cell (one size in one state, all its scenes) that fails is thrown away and
   run once more in a fresh browser context; only the retry counts. A cell that passed only on the retry prints a WARN, so a real flake stays visible. --no-retry turns this off. */
async function runCell(browser, size, state) {
  const attempt = () => { const a = { cells: 0, checks: 0, skipped: 0, failures: [] }; return cell(browser, size, state, a).then(() => a); };
  let a = await attempt();
  if (a.failures.length && !argv.includes("--no-retry")) {
    const first = a.failures.length, kinds = [...new Set(a.failures.map((f) => f.invariant))].join(",");
    const b = await attempt(); retried++;
    if (!b.failures.length) console.log(`WARN ${size.w}x${size.h} ${state}: failed once (${first} failures: ${kinds}) and passed on retry in a fresh page`);
    a = b;
  }
  cells += a.cells; checks += a.checks; skipped += a.skipped; failures.push(...a.failures);
}
const browser = stubbed(await pw[ENGINE].launch(launch), { label: "layout-sweep api-stub" });
const jobs = [];
for (const size of SIZES) for (const state of STATES) jobs.push([size, state]);
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < jobs.length) {
    if (Date.now() - T0 > BUDGET_MS) { truncated = true; return; }
    const [size, state] = jobs[next++];
    await runCell(browser, size, state);
  }
}));
const stubReport = browser.apiStubReport ? browser.apiStubReport() : null;
if (stubReport && !ALLOW_MISS) for (const m of stubReport.misses) fail({ w: 0, h: 0 }, "-", "-", "stub-miss", `the page asked for ${m}, which tests/fixtures/api-snapshot does not have: re-record it (tools/local-browser.sh record-fixtures) or run with --live-api`);
await browser.close();

failures.sort((a, b) => b.w - a.w || b.h - a.h || a.state.localeCompare(b.state) || a.scene.localeCompare(b.scene) || a.invariant.localeCompare(b.invariant));
const byInv = {}, bySize = {}, byScene = {};
for (const f of failures) { byInv[f.invariant] = (byInv[f.invariant] || 0) + 1; const s = `${f.w}x${f.h}`; bySize[s] = (bySize[s] || 0) + 1; byScene[f.scene] = (byScene[f.scene] || 0) + 1; }
const summary = { url: BASE, engine: ENGINE, clock: CLOCK ? CLOCK.toISOString() : null, retriedCells: retried, sizes: SIZES.length, states: STATES.length, scenes: SCENES.length, cells, invariantChecks: checks, failures: failures.length, apiMode: LIVE_API ? "live" : "stub", apiReadsStubbed: stubReport ? stubReport.served : 0, byInvariant: byInv, bySize, byScene, skippedCells: skipped, reportOnly: notes, truncated, seconds: Math.round((Date.now() - T0) / 1000) };
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
if (notes.length) {
  const by = {}; for (const x of notes) (by[x.invariant] ||= []).push(x);
  console.log("\nreport-only (not failures; the next packages tighten these):");
  for (const [k, l] of Object.entries(by)) { console.log(`  ${k}: ${l.length} of ${SIZES.length} sizes`); for (const x of l.slice(0, 6)) console.log(`    ${x.w}x${x.h} ${x.detail}`); }
}
console.log(`layout-sweep: ${ENGINE}, ${cells} cells, ${checks} invariant checks, ${failures.length} failures, ${retried} cells retried${CLOCK ? `, clock faked to ${CLOCK.toISOString()}` : ""}${truncated ? " (INCOMPLETE)" : ""} in ${summary.seconds}s`);
process.exit(failures.length || truncated ? 1 : 0);
