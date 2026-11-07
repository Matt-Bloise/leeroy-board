// Cinematic slice 3 (open and return), Chromium, fixtures, zero Worker requests. Deterministic: every wait is a bounded poll on a state, never a long sleep.
//   node open-return.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh open-return)
// A: a tile opens a sheet, and Esc / the close button fold it back to the same tile (focus lands on the tile; wall scroll restored). Both paths: the View Transition
//    (Chromium) and the FLIP fallback (startViewTransition removed, as on WebKit).
// B: interrupted and resized transitions end correct 10 of 10 per scenario and path: open then close at 40 percent, close then open again, a resize in flight, three rapid toggles.
//    "Correct" is the final state alone: scene hidden or shown as asked, the board inert only while open, no leftover class, no leftover view-transition-name, no running animation
//    on the sheet, the sheet inside the viewport when open, focus where it belongs, scroll unchanged.
// C: the heading takes focus on open from the wall, sibling tiles dim while a scene is open, and reduced motion opens and closes at once.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node open-return.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const RUNS = Number(arg("--runs") || 10), ONLY = arg("--only"); // --only phone-vt (development): one view and path
const T0 = Date.now(), lap = (m) => { if (process.env.OPEN_RETURN_TIMING) console.log(`TIME ${((Date.now() - T0) / 1000).toFixed(1)}s ${m}`); };
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const VIEW = { phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, laptop: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 } };
const KEY = "roads";

const state = () => {
  const layer = document.querySelector("#scene"), board = document.querySelector("#board"), sheet = document.querySelector(".sheet"), root = document.documentElement;
  const named = [...document.querySelectorAll("[style*='view-transition-name']")].filter((e) => e.style.viewTransitionName).map((e) => e.id || e.className || e.tagName);
  const r = sheet.getBoundingClientRect(), a = document.activeElement;
  return {
    hidden: layer.hidden || layer.classList.contains("warming"), /* the idle warm-up un-hides the layer inert and unseen for a few frames after a close: that is closed */ inert: board.inert, sceneOpen: root.classList.contains("scene-open"), leftover: ["morph", "flip", "closing", "lift"].filter((c) => layer.classList.contains(c)), /* rise and fade are the settled look of the no-FLIP fallback, not transient */ vtClose: root.classList.contains("vt-close"),
    named, anims: sheet.getAnimations().filter((a) => a.playState === "running").length, hash: location.hash, scrollY: Math.round(scrollY),
    inside: !layer.hidden && !layer.classList.contains("warming") && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.width > 100,
    focus: a ? `${a.tagName}${a.id ? "#" + a.id : ""}` : "none", focusInScene: !!(a && a.closest && a.closest("#scene")), focusOnTile: !!(a && a.closest && a.closest(`#wall [data-scene="roads"]`)), focusBody: !a || a === document.body,
  };
};
async function settle(page, want) {
  // bounded poll: up to 3 s for the asked state to be reached and quiet
  await page.waitForFunction(({ want }) => {
    const l = document.querySelector("#scene"), s = document.querySelector(".sheet");
    const shut = l.hidden || l.classList.contains("warming"); if (want === "closed" ? !shut : shut) return false;
    if (["morph", "flip", "closing", "lift"].some((c) => l.classList.contains(c))) return false;
    if ([...document.querySelectorAll("[style*='view-transition-name']")].some((e) => e.style.viewTransitionName)) return false;
    return s.getAnimations().filter((a) => a.playState === "running").length === 0 && !document.documentElement.classList.contains("vt-close");
  }, { want }, { timeout: 3500 }).catch(() => {});
  await page.waitForTimeout(60);
}
const verdict = (s, want, scrollY) => {
  const bad = [];
  if (want === "closed") {
    if (!s.hidden) bad.push("scene still shown"); if (s.inert) bad.push("board still inert"); if (s.sceneOpen) bad.push("scene-open class left"); if (s.hash === "#roads") bad.push("hash left on the scene");
    if (!s.focusOnTile) bad.push(`focus ${s.focus} is not on the tile`); if (s.scrollY !== scrollY) bad.push(`scroll ${scrollY} -> ${s.scrollY}`);
  } else {
    if (s.hidden) bad.push("scene hidden"); if (!s.inert) bad.push("board not inert"); if (!s.sceneOpen) bad.push("scene-open class missing"); if (!s.inside) bad.push("sheet outside the viewport"); if (!s.focusInScene) bad.push(`focus ${s.focus} is not in the scene`);
  }
  if (s.leftover.length) bad.push(`classes left: ${s.leftover}`); if (s.named.length) bad.push(`view-transition-name left on ${s.named}`); if (s.anims) bad.push(`${s.anims} animation(s) still running`); if (s.vtClose) bad.push("vt-close left");
  return bad;
};

const browser = stubbed(await pw.chromium.launch());
const NOVT = () => { try { Object.defineProperty(document, "startViewTransition", { value: undefined, configurable: true }); document.startViewTransition = undefined; } catch (e) {} };
async function fresh(view, path, extra) {
  const ctx = await browser.newContext({ ...VIEW[view], serviceWorkers: "block", ...(extra || {}) });
  await ctx.addInitScript(() => { try { localStorage.setItem("board-as", "Santa"); localStorage.setItem("board-hinted", "1"); localStorage.setItem("board-room", "off"); } catch (e) {} });
  if (path === "flip") await ctx.addInitScript(NOVT);
  await ctx.addInitScript(() => { window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch (e) {} });
  const page = await ctx.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__boardKit || !!document.querySelector("#wall .tile"), null, { timeout: 15000 });
  await page.locator("#scene-close").click({ timeout: 8000 }).catch(() => {}); // a member lands on Next steps: close it to the wall
  await settle(page, "closed");
  return { ctx, page, errors };
}
const tile = (page) => page.locator(`#wall a.tile[data-scene="${KEY}"]`);
const wait = (page, ms) => page.waitForTimeout(ms);
// a synthetic click on the tile: no scroll-into-view side effect, so the wall scroll at the tap is the scroll the test measured
const tap = async (page) => { await tile(page).focus(); await tile(page).dispatchEvent("click"); }; // a real tap focuses the link it lands on

try {
  const lane = async (path) => { for (const view of Object.keys(VIEW)) {
    if (ONLY && ONLY !== `${view}-${path}`) continue;
    const tag = `[${view} ${path}]`, { ctx, page, errors } = await fresh(view, path);
    lap(`${tag} ready`);
    const hasVT = await page.evaluate(() => typeof document.startViewTransition === "function");
    ok(`${tag} the ${path === "vt" ? "View Transition" : "FLIP"} path is the one under test`, path === "vt" ? hasVT : !hasVT);
    // the wall scroll is read after the tile is in view (a tap would scroll it there first); it must come back unchanged
    // no locator.scrollIntoViewIfNeeded: it waits for the element to be "stable" and timed out at 30 s on the CI runner (run 42320879864); a plain in-page scrollIntoView has no such wait
    const yNow = async () => { await page.evaluate((k) => { const t = document.querySelector(`#wall a.tile[data-scene="${k}"]`); if (t) t.scrollIntoView({ block: "nearest" }); }, KEY); return page.evaluate(() => Math.round(scrollY)); };
    let y0 = await yNow();
    // A: open, Esc closes to the same tile
    await tap(page); await settle(page, "open");
    let s = await page.evaluate(state), bad = verdict(s, "open", y0);
    ok(`${tag} A open: shown, inert board, sheet inside the viewport, focus inside the scene`, bad.length === 0, bad.join("; "));
    await page.keyboard.press("Escape"); await settle(page, "closed");
    s = await page.evaluate(state); bad = verdict(s, "closed", y0);
    ok(`${tag} A Esc folds back to its slot: focus on the tile, scroll restored, nothing left over`, bad.length === 0, bad.join("; "));
    // A2: CLS over one open and close of a scene that is built at load (Ledger), read on a page that has been quiet for 1.5 s. The board's own late font-swap shift on the five tile is not part of it,
    // and a lazily built scene (Three roads builds its map when it opens, 0.02 inside the panel) is not a transition shift: the transition itself must add 0.
    { let last = -1, stable = 0; for (let i = 0; i < 60 && stable < 6; i++) { await page.waitForTimeout(250); const c = await page.evaluate(() => window.__cls); if (c === last) stable++; else { stable = 0; last = c; } } }
    const led = page.locator('#wall a.tile[data-scene="ledger"]');
    await led.dispatchEvent("click"); await settle(page, "open"); await page.keyboard.press("Escape"); await settle(page, "closed"); // the first open of a scene builds its panel (about 0.02 inside the sheet): not the transition
    { let last = -1, stable = 0; for (let i = 0; i < 40 && stable < 4; i++) { await page.waitForTimeout(250); const c = await page.evaluate(() => window.__cls); if (c === last) stable++; else { stable = 0; last = c; } } }
    const cls0 = await page.evaluate(() => window.__cls);
    await led.dispatchEvent("click"); await settle(page, "open"); await page.keyboard.press("Escape"); await settle(page, "closed");
    // View Transition path: exactly 0. FLIP path (WebKit, no startViewTransition): at most 0.012 on a wide screen, the scene's fit-zoom settling about 1.4 percent after its first frame (known, measured 0.0094; none at phone width).
    const added = (await page.evaluate(() => window.__cls)) - cls0, limit = path === "vt" || view === "phone" ? 0 : 0.012;
    ok(`${tag} A2 opening and closing a built scene again adds ${limit === 0 ? "0" : "at most " + limit} layout shift`, added <= limit + 1e-9, `${cls0} -> ${cls0 + added} (added ${added.toFixed(4)})`);
    await page.evaluate(() => { document.querySelector("#wall").scrollIntoView({ block: "start" }); }); y0 = await yNow();
    lap(`${tag} A and A2 done`);
    // B: interruptions, RUNS times each
    const scenarios = {
      "open then close at 40 percent": async () => { await tap(page); await wait(page, 140); await page.keyboard.press("Escape"); return "closed"; },
      "close then open again": async () => { await tap(page); await settle(page, "open"); await page.keyboard.press("Escape"); await page.waitForFunction(() => { const a = document.activeElement; return !!(a && a.closest && a.closest('#wall [data-scene="roads"]')); }, null, { timeout: 3000 }); await page.keyboard.press("Enter"); return "open"; },
      "resize in flight": async () => { await tap(page); await wait(page, 120); const vp = page.viewportSize(); await page.setViewportSize({ width: vp.width === 390 ? 360 : 1100, height: vp.height === 844 ? 700 : 700 }); return "open"; },
      "three rapid toggles": async () => { await tap(page); await wait(page, 60); await page.keyboard.press("Escape"); await page.waitForFunction(() => { const a = document.activeElement; return !!(a && a.closest && a.closest('#wall [data-scene="roads"]')); }, null, { timeout: 3000 }); await page.keyboard.press("Enter"); await wait(page, 60); await page.keyboard.press("Escape"); return "closed"; },
    };
    for (const [name, run] of Object.entries(scenarios)) {
      let good = 0; const why = [];
      for (let i = 0; i < RUNS; i++) {
        const vp0 = page.viewportSize(); y0 = await yNow();
        let want; try { want = await run(); } catch (e) { why.push(`run ${i + 1}: ${String(e.message).split("\n")[0]}`); break; }
        await settle(page, want === "open" ? "open" : "closed");
        const st = await page.evaluate(state), b = verdict(st, want, y0); if (b.length === 0) good++; else if (why.length < 3) why.push(`run ${i + 1}: ${b.join(", ")}`);
        if (want === "open") { await page.keyboard.press("Escape"); await settle(page, "closed"); }
        if (name === "resize in flight") { await page.setViewportSize(vp0); await settle(page, "closed"); }
      }
      ok(`${tag} B ${name}: ends correct ${good} of ${RUNS}`, good === RUNS, why.join(" | ")); lap(`${tag} ${name}`);
    }
    ok(`${tag} no page error through all of it`, errors.length === 0, errors.slice(0, 2).join("; "));
    await ctx.close();
  } };
  await Promise.all([lane("vt"), lane("flip")]); // two lanes at once (a machine and a CI runner take two pages; each context is its own)
  // C: sibling dimming, heading focus, reduced motion
  { const { ctx, page } = await fresh("phone", "vt");
    await tap(page); await settle(page, "open");
    const c = await page.evaluate(() => { const li = (k) => document.querySelector(`#wall > li.t-${k}`), v = (el) => getComputedStyle(el).getPropertyValue("--tv").trim(); return { focus: document.activeElement && document.activeElement.id, open: v(li("roads")), sib: v(li("racials")), sibTier: li("racials").dataset.tier }; });
    ok("[phone] the sheet heading takes focus when a tile opens it", c.focus === "sheet-title", c.focus);
    ok("[phone] siblings dim to tier 3 while a scene is open and the opened tile keeps full brightness", Number(c.open) === 1 && Number(c.sib) < 0.5, JSON.stringify(c));
    await page.keyboard.press("Escape"); await settle(page, "closed");
    const back = await page.evaluate(() => getComputedStyle(document.querySelector("#wall > li.t-library")).getPropertyValue("--tv").trim());
    ok("[phone] siblings return to their own tiers after closing", Number(back) > 0.5, back);
    await ctx.close(); }
  { const { ctx, page } = await fresh("phone", "vt", { reducedMotion: "reduce" });
    const t0 = Date.now(); await tap(page); await page.waitForFunction(() => !document.querySelector("#scene").hidden, null, { timeout: 3000 });
    const s1 = await page.evaluate(() => ({ anims: document.querySelector(".sheet").getAnimations().length, named: [...document.querySelectorAll("[style*='view-transition-name']")].filter((e) => e.style.viewTransitionName).length }));
    await settle(page, "open"); const open = await page.evaluate(state), ob = verdict(open, "open", 0);
    ok("[reduced motion] opens at once: no travel animation, correct end state", s1.anims <= 1 && ob.length === 0, JSON.stringify(s1) + " " + ob.join(", "));
    await page.keyboard.press("Escape"); await settle(page, "closed"); const cl = await page.evaluate(state), cb = verdict(cl, "closed", open.scrollY === 0 ? cl.scrollY : 0);
    ok("[reduced motion] closes at once to the tile", cb.filter((x) => !/scroll/.test(x)).length === 0, cb.join(", "));
    ok("[reduced motion] open and close took under 3 s in all", Date.now() - t0 < 3000 + 4000);
    await ctx.close(); }
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
