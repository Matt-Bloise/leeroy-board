// Cinematic slice 3 (open and return), Chromium, fixtures, zero Worker requests. Scenes open and close through a small state machine (js/scene-fsm.js: closed, opening, open, closing) with plain CSS
// animations and a hard watchdog at 1.5 x the transition. These checks assert the FINAL STATE only, reached within a bound of 2 x the transition (plus slack for a slow machine), never frame-level
// animation counts: there are no View Transitions and no FLIP choreography any more.
//   node open-return.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh open-return)   --runs N (default 10)   --throttle N (CDP CPU throttling)
// A: a tile opens a sheet, and Esc folds it back to the same tile (focus on the tile, wall scroll restored); opening and closing a built scene adds 0 layout shift.
// B: interrupted and resized transitions end correct 10 of 10 per scenario (open then close at 40 percent, close then open again, a resize in flight, three rapid toggles). "Correct" is the final
//    state alone: scene shown or hidden as asked, board inert only while open, scene-open class matching, no closing class left, sheet inside the viewport when open, focus on the tile or in the scene, scroll unchanged.
// C: the heading takes focus on open from the wall, sibling tiles dim while a scene is open, reduced motion opens and closes at once.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node open-return.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const RUNS = Number(arg("--runs") || 10), ONLY = arg("--only"), THROTTLE = Number(arg("--throttle") || process.env.OPEN_RETURN_THROTTLE || 1);
const TOKEN = 540; // the longest transition (ms): the close
const WATCHDOG = Math.round(1.5 * TOKEN); // js/scene-fsm.js forces the end state this long after a move starts (factor 1.5)
const BOUND = Math.round((WATCHDOG + 1200) * Math.max(1, THROTTLE / 2)); // the final state must hold by the watchdog plus 1200 ms of slack: a timer firing late on a loaded runner must not fail a correct end state
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const VIEW = { phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, laptop: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 } };
const KEY = "roads";

const state = () => {
  const layer = document.querySelector("#scene"), board = document.querySelector("#board"), sheet = document.querySelector(".sheet"), root = document.documentElement;
  const r = sheet.getBoundingClientRect(), a = document.activeElement, shut = layer.hidden || layer.classList.contains("warming"); // the idle warm-up un-hides the layer inert and unseen for a few frames: that is closed
  return {
    hidden: shut, inert: board.inert, sceneOpen: root.classList.contains("scene-open"), closing: layer.classList.contains("closing"), hash: location.hash, scrollY: Math.round(scrollY),
    inside: !shut && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.width > 100,
    focus: a ? `${a.tagName}${a.id ? "#" + a.id : ""}` : "none", focusInScene: !!(a && a.closest && a.closest("#scene")), focusOnTile: !!(a && a.closest && a.closest(`#wall [data-scene="roads"]`)),
  };
};
// poll the state (bounded) until the asked final state holds, return how long it took
async function settle(page, want, bound = BOUND) {
  const t0 = Date.now();
  await page.waitForFunction(({ want }) => {
    const l = document.querySelector("#scene"), shut = l.hidden || l.classList.contains("warming");
    if (want === "closed" ? !shut : shut) return false;
    return !l.classList.contains("closing") && document.querySelector("#board").inert === (want === "open") && document.documentElement.classList.contains("scene-open") === (want === "open");
  }, { want }, { timeout: bound }).catch(() => {});
  return Date.now() - t0;
}
const verdict = (s, want, scrollY) => {
  const bad = [];
  if (want === "closed") {
    if (!s.hidden) bad.push("scene still shown"); if (s.inert) bad.push("board still inert"); if (s.sceneOpen) bad.push("scene-open class left"); if (s.hash === "#roads") bad.push("hash left on the scene");
    if (!s.focusOnTile) bad.push(`focus ${s.focus} is not on the tile`); if (s.scrollY !== scrollY) bad.push(`scroll ${scrollY} -> ${s.scrollY}`);
  } else {
    if (s.hidden) bad.push("scene hidden"); if (!s.inert) bad.push("board not inert"); if (!s.sceneOpen) bad.push("scene-open class missing"); if (!s.inside) bad.push("sheet outside the viewport"); if (!s.focusInScene) bad.push(`focus ${s.focus} is not in the scene`);
  }
  if (s.closing) bad.push("closing class left");
  return bad;
};

let browser = stubbed(await pw.chromium.launch());
async function fresh(view, extra) {
  const ctx = await browser.newContext({ ...VIEW[view], serviceWorkers: "block", ...(extra || {}) });
  await ctx.addInitScript(() => { try { localStorage.setItem("board-as", "Santa"); localStorage.setItem("board-hinted", "1"); localStorage.setItem("board-room", "off"); } catch (e) {} });
  await ctx.addInitScript(() => { window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch (e) {} });
  const page = await ctx.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message));
  if (THROTTLE > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE }); }
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__boardKit || !!document.querySelector("#wall .tile"), null, { timeout: 15000 });
  await page.locator("#scene-close").click({ timeout: 8000 }).catch(() => {}); // a member lands on Next steps: close it to the wall
  await settle(page, "closed", 6000);
  return { ctx, page, errors };
}
const tile = (page) => page.locator(`#wall a.tile[data-scene="${KEY}"]`);
const wait = (page, ms) => page.waitForTimeout(ms);
// a synthetic click on the focused tile: no scroll-into-view side effect, so the wall scroll at the tap is the scroll the test measured
const tap = async (page) => { await tile(page).focus(); await tile(page).dispatchEvent("click"); };
const onTile = (page) => page.waitForFunction(() => { const a = document.activeElement; return !!(a && a.closest && a.closest('#wall [data-scene="roads"]')); }, null, { timeout: BOUND });

try {
  const lane = async (view) => {
    if (ONLY && ONLY !== view) return;
    const tag = `[${view}]`, { ctx, page, errors } = await fresh(view);
    const yNow = async () => { await page.evaluate((k) => { const t = document.querySelector(`#wall a.tile[data-scene="${k}"]`); if (t) t.scrollIntoView({ block: "nearest" }); }, KEY); return page.evaluate(() => Math.round(scrollY)); };
    let y0 = await yNow();
    // A: open, Esc folds back to the same tile
    await tap(page); const tOpen = await settle(page, "open");
    let s = await page.evaluate(state), bad = verdict(s, "open", y0);
    ok(`${tag} A open: shown, inert board, sheet inside the viewport, focus inside the scene (reached in ${tOpen} ms, bound ${BOUND})`, bad.length === 0, bad.join("; "));
    await page.keyboard.press("Escape"); const tShut = await settle(page, "closed");
    s = await page.evaluate(state); bad = verdict(s, "closed", y0);
    ok(`${tag} A Esc folds back to its slot: focus on the tile, scroll restored, nothing left over (reached in ${tShut} ms)`, bad.length === 0, bad.join("; "));
    // A2: layout shift over one open and close of a built scene (Ledger), on a page that has been quiet for 1.5 s; the first open of a scene builds its panel (about 0.02 inside the sheet): not the transition
    { let last = -1, stable = 0; for (let i = 0; i < 60 && stable < 6; i++) { await page.waitForTimeout(250); const c = await page.evaluate(() => window.__cls); if (c === last) stable++; else { stable = 0; last = c; } } }
    const led = page.locator('#wall a.tile[data-scene="ledger"]');
    await led.dispatchEvent("click"); await settle(page, "open"); await page.keyboard.press("Escape"); await settle(page, "closed");
    { let last = -1, stable = 0; for (let i = 0; i < 40 && stable < 4; i++) { await page.waitForTimeout(250); const c = await page.evaluate(() => window.__cls); if (c === last) stable++; else { stable = 0; last = c; } } }
    const cls0 = await page.evaluate(() => window.__cls);
    await led.dispatchEvent("click"); await settle(page, "open"); await page.keyboard.press("Escape"); await settle(page, "closed");
    const added = (await page.evaluate(() => window.__cls)) - cls0;
    // 0 on an unthrottled machine (measured). Under CPU throttling the scene content settles later and a small shift appears (0.0087 at 4x on a laptop view): reported, not asserted.
    if (THROTTLE === 1) ok(`${tag} A2 opening and closing a built scene again adds 0 layout shift`, added <= 1e-9, `added ${added.toFixed(4)}`);
    else console.log(`INFO ${tag} A2 layout shift added over one open and close at ${THROTTLE}x CPU throttle: ${added.toFixed(4)}`);
    await page.evaluate(() => { document.querySelector("#wall").scrollIntoView({ block: "start" }); }); y0 = await yNow();
    // B: interruptions, RUNS times each
    const scenarios = {
      "open then close at 40 percent": async () => { await tap(page); await wait(page, 140); await page.keyboard.press("Escape"); return "closed"; },
      "close then open again": async () => { await tap(page); await settle(page, "open"); await page.keyboard.press("Escape"); await onTile(page); await page.keyboard.press("Enter"); return "open"; },
      "resize in flight": async () => { await tap(page); await wait(page, 120); const vp = page.viewportSize(); await page.setViewportSize({ width: vp.width === 390 ? 360 : 1100, height: 700 }); return "open"; },
      "three rapid toggles": async () => { await tap(page); await wait(page, 60); await page.keyboard.press("Escape"); await onTile(page); await page.keyboard.press("Enter"); await wait(page, 60); await page.keyboard.press("Escape"); return "closed"; },
    };
    for (const [name, run] of Object.entries(scenarios)) {
      let good = 0, slowest = 0; const why = [];
      for (let i = 0; i < RUNS; i++) {
        const vp0 = page.viewportSize(); y0 = await yNow();
        // Evidence for a CI-only flake (Nov 8: "open then close at 40 percent ... scroll 192 -> 0, run 1" failed five full runs in a row on CI hardware and never locally): record, per frame, only the CHANGES of scrollY and of the <html> classes for 4 s.
        // Read on failure only. It asserts nothing and changes no bound.
        await page.evaluate(() => { if (!window.__scw) { window.__scw = true; const rel = () => Math.round(performance.now() - (window.__base || 0)), at = (...a) => window.__calls.push(a), note = (fn, a) => at(rel(), fn, JSON.stringify(a).slice(0, 40), (new Error().stack || "").split("\n").slice(2, 5).map((x) => x.trim().replace(/https?:\/\/[^/]+/, "")).join(" < ")); for (const fn of ["scrollTo", "scroll", "scrollBy"]) { const o = window[fn]; window[fn] = function (...a) { note(fn, a); return o.apply(this, a); }; } const si = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (...a) { note("scrollIntoView", a); return si.apply(this, a); }; addEventListener("scroll", () => at(rel(), "scroll-event", Math.round(scrollY)), { passive: true }); addEventListener("popstate", () => at(rel(), "popstate", Math.round(scrollY))); addEventListener("hashchange", () => at(rel(), "hashchange", location.hash)); } window.__base = performance.now(); window.__calls = []; window.__y0 = Math.round(scrollY); cancelAnimationFrame(window.__trRaf); const tok = (window.__trTok = (window.__trTok || 0) + 1); window.__tr = []; const t0 = performance.now(); const f = () => { if (tok !== window.__trTok) return; const r = document.documentElement, last = window.__tr[window.__tr.length - 1], cur = [Math.round(performance.now() - t0), Math.round(scrollY), r.className.replace(/\s+/g, ".").slice(0, 100)]; if (!last || last[1] !== cur[1] || last[2] !== cur[2]) window.__tr.push(cur); if (performance.now() - t0 < 4000) window.__trRaf = requestAnimationFrame(f); }; window.__trRaf = requestAnimationFrame(f); });
        let want; try { want = await run(); } catch (e) { why.push(`run ${i + 1}: ${String(e.message).split("\n")[0]}`); break; }
        const took = await settle(page, want === "open" ? "open" : "closed"); slowest = Math.max(slowest, took);
        const st = await page.evaluate(state), b = verdict(st, want, y0); if (b.length === 0) good++; else if (why.length < 3) { await page.waitForTimeout(600); const tr = await page.evaluate(() => ({ y0: window.__y0, frames: (window.__tr || []).slice(0, 30), calls: (window.__calls || []).slice(0, 25) })), cx = await page.evaluate(() => ({ sr: history.scrollRestoration, sh: document.documentElement.scrollHeight, ih: innerHeight, main: document.getElementById("main") ? getComputedStyle(document.getElementById("main")).display : null, y: Math.round(scrollY) })); why.push(`run ${i + 1}: ${b.join(", ")} ${process.env.OPEN_RETURN_DEBUG ? JSON.stringify(st) : ""} TRACE[ms,scrollY,html classes] ${JSON.stringify(tr)} CTX ${JSON.stringify(cx)}`); }
        if (want === "open") { await page.keyboard.press("Escape"); await settle(page, "closed"); }
        if (name === "resize in flight") { await page.setViewportSize(vp0); await settle(page, "closed"); }
      }
      ok(`${tag} B ${name}: ends correct ${good} of ${RUNS} (slowest ${slowest} ms, bound ${BOUND})`, good === RUNS, why.join(" | "));
    }
    ok(`${tag} no page error through all of it`, errors.length === 0, errors.slice(0, 2).join("; "));
    await ctx.close();
  };
  await lane("phone"); await lane("laptop"); // one after the other: two pages driven at once in one browser interfered with each other's keyboard focus
  // C: sibling dimming, heading focus, reduced motion
  { const { ctx, page } = await fresh("phone");
    await tap(page); await settle(page, "open");
    const c = await page.evaluate(() => { const li = (k) => document.querySelector(`#wall > li.t-${k}`), v = (el) => getComputedStyle(el).getPropertyValue("--tv").trim(); return { focus: document.activeElement && document.activeElement.id, open: v(li("roads")), sib: v(li("racials")), sibTier: li("racials").dataset.tier }; });
    ok("[phone] the sheet heading takes focus when a tile opens it", c.focus === "sheet-title", c.focus);
    ok("[phone] siblings dim to tier 3 while a scene is open and the opened tile keeps full brightness", Number(c.open) === 1 && Number(c.sib) < 0.5, JSON.stringify(c));
    await page.keyboard.press("Escape"); await settle(page, "closed");
    const back = await page.evaluate(() => getComputedStyle(document.querySelector("#wall > li.t-library")).getPropertyValue("--tv").trim());
    ok("[phone] siblings return to their own tiers after closing", Number(back) > 0.5, back);
    await ctx.close(); }
  /* the reduced-motion check gets its own browser: keyboard focus state leaked between contexts of one Chromium (two lanes at once broke each other; a later context returned focus to MAIN), though the page itself is right when run alone */
  await browser.close(); browser = stubbed(await pw.chromium.launch());
  { const { ctx, page } = await fresh("phone", { reducedMotion: "reduce" });
    await tap(page); await page.waitForFunction(() => !document.querySelector("#scene").hidden, null, { timeout: BOUND }); await settle(page, "open");
    const open = await page.evaluate(() => ({ inert: document.querySelector("#board").inert, closing: document.querySelector("#scene").classList.contains("closing") }));
    ok("[reduced motion] a tap opens the scene at once: shown and settled in the first frames, no closing class, board inert", open.inert && !open.closing, JSON.stringify(open));
    await wait(page, 250); // a person does not press Escape within a few milliseconds of the sheet appearing
    await page.keyboard.press("Escape");
    const t0 = Date.now(); await page.waitForFunction(() => document.querySelector("#scene").hidden || document.querySelector("#scene").classList.contains("warming"), null, { timeout: BOUND });
    const took = Date.now() - t0; await onTile(page).catch(() => {});
    const cl = await page.evaluate(state);
    ok("[reduced motion] Esc closes at once: hidden, board live, focus on the tile", cl.hidden && !cl.inert && !cl.sceneOpen && cl.focusOnTile && took < 400, JSON.stringify(cl) + ` ${took} ms ` + JSON.stringify(await page.evaluate(() => { const t = document.querySelector('#wall a.tile[data-scene="roads"]'); return { rects: t.getClientRects().length, tabindex: t.getAttribute("tabindex"), connected: t.isConnected, inertAnc: !!t.closest("[inert]"), disp: getComputedStyle(t).display, vis: getComputedStyle(t).visibility }; })));
    await ctx.close(); }
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
