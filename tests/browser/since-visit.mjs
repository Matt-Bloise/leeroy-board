// Cinematic slice 3: since-last-visit marks (js/since.js), Chromium 390x844 and 1366x768, fixtures, zero Worker requests, page clock pinned. The "last visit" is a MOCKED epoch:
// localStorage "board-last-visit" is set before the page loads, so nothing depends on when the test runs.
//   node since-visit.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh since-visit)
// Fixture dates (tests/fixtures/api-snapshot + data/library/index.json): sign-up answers updated 2026-10-29T02:42Z, 2026-10-27T00:45Z and one more; the newest library change is 2026-10-31.
// CLS: the board has its own late shifts (the five tile grows when the display font arrives, about 3.6 s in; the Next steps card). Marks are judged on a quiet page: wait until no layout
// shift for 1.5 s, clear the marks, read CLS, re-apply them (BoardSince.run, the same code path) and read CLS again: the difference must be 0.
// Checks: epoch after every change marks nothing; an epoch between marks only what is newer (the Library tile and its newer rows, not the Sign-ups tile); an older epoch marks Sign-ups too;
// at most 3 items; no stamp (first visit) and a stamp in the future mark nothing; the stamp is written when the page is hidden; CLS stays 0; marks cool (class removed at 8 s,
// checked with a fast clock) and reduced motion keeps no animation on a mark.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { loadSnapshot } from "../helpers/api-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node since-visit.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const VIEW = { phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, laptop: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 } };
const E = (iso) => String(Date.parse(iso));
// the sign-up answers of the fixture, read from the snapshot the page is served: who changed after a stamp is computed here, not guessed
const ENTRIES = JSON.parse(loadSnapshot().routes["/bootstrap"].body).signups.entries.map((e) => ({ name: e.name.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").toLowerCase(), at: Date.parse(e.updated) }));
const changedAfter = (iso) => ENTRIES.filter((e) => e.at > Date.parse(iso)).map((e) => e.name).sort();
const browser = stubbed(await pw.chromium.launch());

async function visit(view, epoch, { reduced = false, openScene = null } = {}) {
  const ctx = await browser.newContext({ ...VIEW[view], serviceWorkers: "block", ...(reduced ? { reducedMotion: "reduce" } : {}) });
  await ctx.addInitScript((epoch) => {
    try { localStorage.setItem("board-as", "Santa"); localStorage.setItem("board-hinted", "1"); localStorage.setItem("board-room", "off"); if (epoch) localStorage.setItem("board-last-visit", epoch); } catch (e) {}
    window.__cls = 0; window.__lsrc = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__lsrc.push(`${e.value.toFixed(4)}@${Math.round(e.startTime)} ` + e.sources.map((s) => { const n = s.node; return (n && (n.id ? "#" + n.id : n.tagName + "." + String(n.className && n.className.baseVal === undefined ? n.className : "").split(" ")[0])) + " " + Math.round(s.previousRect.y) + ">" + Math.round(s.currentRect.y); }).join(",")); } }).observe({ type: "layout-shift", buffered: true }); } catch (e) {}
  }, epoch);
  const page = await ctx.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.BoardSince && !!document.querySelector("#wall .tile"), null, { timeout: 15000 });
  await page.locator("#scene-close").click({ timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("#scene").hidden, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1600); // tiles are marked after the library index and the board settle
  const out = { ctx, page, errors };
  out.tiles = () => page.evaluate(() => [...document.querySelectorAll("#wall > li.since")].map((l) => l.className.split(" ")[0]));
  if (openScene) {
    await page.locator(`#wall a.tile[data-scene="${openScene}"], #wall .tile[data-scene="${openScene}"] a.tile-band`).first().dispatchEvent("click");
    await page.waitForFunction(() => !document.querySelector("#scene").hidden, null, { timeout: 5000 });
    await page.waitForTimeout(1900); // rows are marked at 0, 350 and 1100 ms
  }
  return out;
}
async function quiet(page) { let last = -1, stable = 0; for (let i = 0; i < 60 && stable < 8; i++) { await page.waitForTimeout(250); const c = await page.evaluate(() => window.__cls); if (c === last) stable++; else { stable = 0; last = c; } } }
async function marksShift(page) {
  await quiet(page);
  await page.evaluate(() => window.BoardSince.clear()); await page.waitForTimeout(300);
  const c0 = await page.evaluate(() => window.__cls); await page.evaluate(() => window.BoardSince.run()); await page.waitForTimeout(900);
  const c1 = await page.evaluate(() => window.__cls), n = await page.evaluate(() => document.querySelectorAll(".since").length);
  return { delta: c1 - c0, marked: n };
}
const rowsOf = (page) => page.evaluate(() => ({
  names: [...document.querySelectorAll("#dsu-body .trow-who .who.since")].map((e) => e.textContent.trim()),
  all: [...document.querySelectorAll("#dsu-body .trow-who .who")].map((e) => e.textContent.trim()),
  changes: [...document.querySelectorAll("#panel-library .ribbon > li.since")].map((e) => (e.querySelector("time") || {}).getAttribute("datetime")),
  changeRows: [...document.querySelectorAll("#panel-library .ribbon > li")].map((e) => (e.querySelector("time") || {}).getAttribute("datetime")),
}));

try {
  for (const view of Object.keys(VIEW)) {
    const tag = `[${view}]`;
    // nothing is newer than the stamp
    { const v = await visit(view, E("2026-11-02T00:00:00Z")); const t = await v.tiles(); ok(`${tag} a stamp after every change marks nothing`, t.length === 0, JSON.stringify(t));
      await v.ctx.close(); }
    // between: only the newer library change is marked, the sign-ups answers (older) are not
    { const v = await visit(view, E("2026-10-30T00:00:00Z")); const t = await v.tiles(); ok(`${tag} stamp 2026-10-30: only the Library tile is marked (its newest change is 2026-10-31); Sign-ups (2026-10-29) is not`, t.length === 1 && t[0] === "t-library", JSON.stringify(t));
      { const m = await marksShift(v.page); ok(`${tag} applying the marks adds 0 layout shift (${m.marked} marked)`, m.marked >= 1 && m.delta === 0, `delta ${m.delta} marked ${m.marked} ${JSON.stringify(await v.page.evaluate(() => window.__lsrc.slice(-2)))}`); }
      ok(`${tag} a mark is an edge, not a layout change (the tile keeps its box)`, await v.page.evaluate(() => { const li = document.querySelector("#wall > li.t-library"), r = li.getBoundingClientRect(), a = getComputedStyle(li, "::after"); return r.width > 50 && a.position === "absolute" && a.pointerEvents === "none"; }));
      await v.ctx.close(); }
    // older: sign-ups answers are newer than the stamp too
    { const v = await visit(view, E("2026-10-28T00:00:00Z")); const t = await v.tiles(); ok(`${tag} stamp 2026-10-28: Sign-ups and Library are marked`, t.includes("t-signups") && t.includes("t-library") && t.length === 2, JSON.stringify(t)); await v.ctx.close(); }
    // a date-only library change is compared by calendar day: the same UTC day as the stamp is NOT new, a later day is
    { const v = await visit(view, E("2026-10-31T08:00:00Z")); const t = await v.tiles(); ok(`${tag} a stamp on the same UTC day as the newest library change (2026-10-31) marks nothing`, t.length === 0, JSON.stringify(t)); await v.ctx.close(); }
    { const v = await visit(view, E("2026-10-30T23:00:00Z")); const t = await v.tiles(); ok(`${tag} a stamp the evening before it (2026-10-30) marks the Library tile`, t.length === 1 && t[0] === "t-library", JSON.stringify(t)); await v.ctx.close(); }
    // first visit and a stamp from the future
    { const v = await visit(view, null); const t = await v.tiles(); ok(`${tag} no stamp (first visit): nothing is marked`, t.length === 0, JSON.stringify(t)); await v.ctx.close(); }
    { const v = await visit(view, E("2099-01-01T00:00:00Z")); const t = await v.tiles(); ok(`${tag} a stamp in the future marks nothing`, t.length === 0, JSON.stringify(t)); await v.ctx.close(); }
    // an ancient stamp: everything is newer, but never more than 3 items
    { const v = await visit(view, E("2020-01-01T00:00:00Z")); const t = await v.tiles(); ok(`${tag} an ancient stamp marks at most 3 tiles`, t.length >= 1 && t.length <= 3, JSON.stringify(t)); await v.ctx.close(); }
  }
  // rows inside the scenes (laptop: wide, one pass is enough)
  { const v = await visit("laptop", E("2026-10-28T00:00:00Z"), { openScene: "signups" }); const r = await rowsOf(v.page);
    const want = changedAfter("2026-10-28T00:00:00Z").slice(0, 3), got = r.names.map((n) => n.toLowerCase()).sort();
    ok("[rows] Sign-ups, stamp 2026-10-28: exactly the people whose answer changed after it are marked (from the fixture timestamps), nobody else", want.length >= 1 && JSON.stringify(got) === JSON.stringify(want), `marked ${JSON.stringify(got)} expected ${JSON.stringify(want)} of ${JSON.stringify(r.all)}`);
    { const m = await marksShift(v.page); ok("[rows] applying the row marks in the open Sign-ups scene adds 0 layout shift", m.marked >= 1 && m.delta === 0, `delta ${m.delta} marked ${m.marked}`); }
    await v.ctx.close(); }
  { const v = await visit("laptop", E("2026-10-30T00:00:00Z"), { openScene: "library" }); const r = await rowsOf(v.page);
    const newerRows = r.changeRows.filter((d) => d && d > "2026-10-30");
    ok("[rows] Library what-changed rows: exactly the rows dated after the stamp day are marked (2026-10-31), at most 3, no older row", newerRows.length >= 1 && r.changes.length === Math.min(3, newerRows.length) && r.changes.every((d) => d > "2026-10-30"), JSON.stringify(r.changes) + " of " + JSON.stringify(r.changeRows));
    // rows that render late are marked too: clear the marks, then change the panel the way a late render would; the observer marks them again
    await v.page.evaluate(() => { window.BoardSince.clear(); const m = document.querySelector("#panel-library .lib-main") || document.querySelector("#panel-library"); m.appendChild(document.createElement("span")); });
    await v.page.waitForTimeout(500);
    const r2 = await rowsOf(v.page);
    ok("[rows] a panel that gets content after the first second is marked when it renders (mutation observer)", r2.changes.length === Math.min(3, newerRows.length), JSON.stringify(r2.changes));
    await v.ctx.close(); }
  // the stamp is written when the page is hidden
  { const v = await visit("phone", E("2026-10-30T00:00:00Z")); const before = await v.page.evaluate(() => localStorage.getItem("board-last-visit"));
    await v.page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    const after = await v.page.evaluate(() => Number(localStorage.getItem("board-last-visit")));
    ok("[stamp] hiding the page writes the new last-visit stamp (later than the old one)", Number(before) < after, `${before} -> ${after}`);
    await v.ctx.close(); }
  // cooling: the class goes at 8 s (a fast clock), and reduced motion keeps no animation on a mark
  { const v = await visit("laptop", E("2026-10-30T00:00:00Z")); await v.page.clock.fastForward(9000).catch(() => {}); await v.page.waitForTimeout(300);
    ok("[cooling] a mark is removed after 8 s", (await v.tiles()).length === 0, JSON.stringify(await v.tiles())); await v.ctx.close(); }
  { const v = await visit("laptop", E("2026-10-30T00:00:00Z"), { reduced: true }); const a = await v.page.evaluate(() => { const li = document.querySelector("#wall > li.t-library.since"); return li ? getComputedStyle(li, "::after").animationName : "no mark"; });
    ok("[reduced motion] the mark is shown without an animation", a === "none", a); await v.ctx.close(); }
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
