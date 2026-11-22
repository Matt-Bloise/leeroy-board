// Visual baselines, GATING. Screenshots the board's first screen, the wall behind it, every scene (window.__boardKit.SCENES) and the landing page at the sizes the
// board is built for, phone first (390x844, touch) then desktop (1366x768), and compares each with a committed PNG in tests/browser/baselines/<screen>-<size>.png.
//   node browser/visual-baseline.mjs --url http://127.0.0.1:8080/        compare; exit 1 when a screen changed beyond the threshold, a baseline is missing or extra, or a screen is broken
//   --write-baselines [dir]   write the screenshots as the new baselines (default tests/browser/baselines); a screen with no pixel beyond the tolerance keeps its committed bytes. The Visual Baselines workflow runs this on the CI image
//   --only first,five         only these screens (ids without the size); --sizes 390x844 only that size; a partial run never reports "extra baseline"
//   --repeat N                calibration: shoot every screen N times in fresh browser contexts and report the noise between the shots (and against the baseline)
//   --inject-css <file>       add this stylesheet to every page before shooting (the mutation proof: CI injects a small change and requires this suite to FAIL)
//   --out DIR                 where actual/, diff/, summary.json and summary.md go (default tests/browser/out/visual-baseline); --baselines DIR compares with another folder
// Pinned backend: run it against tools/static-server.mjs serving the checkout. /api/ is answered from tests/fixtures/api-snapshot (stubbed(): zero Worker requests, made-up member names),
// Math.random is seeded, motion is reduced, the time zone and locale are fixed, and the page clock (pinned by tests/helpers/clock-arg.mjs) is PAUSED before the page exists and only
// ever moved by this script, in the same fixed steps in every run (see SCHEDULE). Canvases are NOT masked: a shot counts only once two consecutive screenshots are byte-identical.
// A screen whose expected element is missing, that is nearly blank, that threw a page error, or that shows a real member name (read from data/party.json, never printed) FAILS
// and is never written as a baseline. Threshold, calibration and how to refresh the baselines: docs/runbooks/visual-baselines.md.
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { pageUrl, dirOf } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { pinnedClock } from "../helpers/clock-arg.mjs";
import { decodePng, encodePng } from "../helpers/png.mjs";
import { diffImages, diffImage, judge } from "../helpers/pixel-diff.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
// A pixel counts as changed when any channel moved by more than `tolerance` of 255; a screen fails when more than `maxRatio` of its pixels changed.
const THRESHOLD = Object.freeze({ tolerance: 8, maxRatio: 0.002 });
const SIZES = Object.freeze([
  { id: "390x844", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { id: "1366x768", viewport: { width: 1366, height: 768 } },
]);
// The page clock: paused PAUSE_AT_MS after the pinned instant before any page loads. After each action it runs forward a fixed amount in SUB_MS steps, with the network
// quiet between steps (QUIET_MS without a request in flight, at most QUIET_MAX_MS), so timers, idle callbacks and frames always fire in the same order against the same DOM.
// Measured 2026-11-22: with the clock left running, the cloth rail (js/cloth-hook.js) measured the ribbons in an idle callback that raced the first-visit sheet, and the desktop
// Next steps panel landed 10 px higher in some runs; the light (js/board.js) followed wherever the mouse was left. Hence also: taps are dispatched events, the pointer is never used.
const PAUSE_AT_MS = 60000, SUB_MS = 250, QUIET_MS = 150, QUIET_MAX_MS = 5000;
const SCHEDULE = Object.freeze({ load: 2000, look: 3000, close: 2000, journey: 1000, open: 3000, flush: 12000 }); // fake ms after each action; flush covers the wall's 10 s settle
const SETTLE_ROUNDS = 48, STABLE_ROUNDS = 3, ART_MAX_MS = 5000; // the final settle: up to 48 rounds of SUB_MS page time; 3 identical screenshots in a row count
const BASELINES = path.resolve(arg("--baselines") || path.join(here, "baselines")); // --baselines DIR compares with another set (calibration: two renders against each other)
const OUT = path.resolve(arg("--out") || path.join(here, "out", "visual-baseline")), ACTUAL = path.join(OUT, "actual"), DIFF = path.join(OUT, "diff");
const wi = argv.indexOf("--write-baselines");
const WRITE = wi >= 0 ? path.resolve(argv[wi + 1] && !argv[wi + 1].startsWith("--") ? argv[wi + 1] : BASELINES) : null;
const ONLY = arg("--only") ? new Set(arg("--only").split(",").filter(Boolean)) : null;
const ONLY_SIZES = arg("--sizes") ? new Set(arg("--sizes").split(",").filter(Boolean)) : null;
const REPEAT = Math.max(1, Number(arg("--repeat", "1")) || 1);
const INJECT_CSS = arg("--inject-css") ? readFileSync(arg("--inject-css"), "utf8") : "";
// Imitating a slow runner, to test the settling (calibration, 2026-11-22: two screens differed on a slower CI CPU): --throttle N slows the page's CPU N times (CDP),
// --slow-art MS holds every image response back MS milliseconds. Neither may change a single pixel of the result; only the run gets slower.
const THROTTLE = Number(arg("--throttle", "0")) || 0, SLOW_ART = Number(arg("--slow-art", "0")) || 0, JITTER = Number(arg("--jitter", "0")) || 0;
const BLOCK = arg("--block") ? new RegExp(arg("--block")) : null; // --block REGEX: abort the requests whose URL matches (imitates a missing file: the suite must fail, or the shot show it)
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
const PARTIAL = !!(ONLY || ONLY_SIZES);
const TZ = "UTC", LOCALE = "en-US", SEED = 20261122;

if (!BASE) { console.error("FAIL visual-baseline: no --url or PREVIEW_PAGES"); process.exit(1); }
const pw = await import("playwright").catch(() => null);
if (!pw) { console.error("FAIL visual-baseline: playwright not found; run npm ci in tests/"); process.exit(1); }

// The real member names, read from data/party.json at run time and never printed: a screen that shows one fails (the baselines are public).
const REAL_NAMES = (() => { try { return JSON.parse(readFileSync(path.join(here, "..", "..", "data", "party.json"), "utf8")).members.map((m) => String(m.name || "")).filter((n) => n.length >= 3); } catch { return []; } })();
if (!REAL_NAMES.length) { console.error("FAIL visual-baseline: could not read the member names from data/party.json for the privacy check"); process.exit(1); }

// Runs in every page before its own scripts: Math.random from a fixed seed (mulberry32), so the paper grain, sparks and shuffles are the same in every run.
const SEED_JS = `(() => { let a = ${SEED} >>> 0; Math.random = function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;

// On a loopback host (tools/static-server.mjs) the page has no API unless asked: ?brain=local points it at its own origin's /api/, which the stub answers. A --url with its own brain= wins.
const ORIGIN = new URL(BASE).origin;
// The library is pinned, like /api/: every read of data/library (over /api/library or the static files) is answered from tests/fixtures/library, never from the checkout, so a library data PR
// (new facts, new counts in the library header) cannot move a screenshot. Refresh the fixture on purpose (docs/runbooks/visual-baselines.md, Library fixture), with new baselines in the same PR.
const LIBRARY_FIXTURE = path.join(here, "..", "fixtures", "library");
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(BASE).hostname);
const BOARD = pageUrl(BASE, { params: { preview: "1" }, defaults: LOOPBACK ? { brain: "local" } : {} }), ROOT = dirOf(BASE);

// Waits (real time, bounded) until no request of the page has been in flight for QUIET_MS. Returns false when the bound ran out.
async function quiet(page, net) {
  const end = Date.now() + QUIET_MAX_MS;
  while (Date.now() < end) {
    if (net.inflight <= 0 && Date.now() - net.last >= QUIET_MS) return true;
    await page.waitForTimeout(25);
  }
  return false;
}
// Runs the paused page clock forward `ms` in SUB_MS steps, letting the network go quiet after each step.
async function advance(page, net, ms) {
  for (let t = 0; t < ms; t += SUB_MS) { await page.clock.runFor(SUB_MS); if (!(await quiet(page, net))) net.loud++; }
}
// After the fixed advance the page must be in the state the step asked for; a short real-time wait covers rendering only (the clock stays where it is).
async function expect(page, fn, arg, what) {
  await page.waitForFunction(fn, arg, { timeout: 5000 }).catch(() => { throw new Error(`the page did not reach ${what}`); });
}
async function firstVisit(page, net) {
  await page.goto(BOARD, { waitUntil: "load" });
  await advance(page, net, SCHEDULE.load);
  await expect(page, () => { const e = document.getElementById("nx-fr2-look"); return !!e && e.getClientRects().length > 0; }, null, "the first-visit sheet");
}
// A tap as the board sees one: pointerdown, pointerup, click, dispatched on the element (the board settles its wall on the first pointerdown, js/board.js whenSettled),
// without moving a pointer, so nothing is left hovered.
async function tap(page, selector) {
  await page.evaluate((sel) => {
    const e = document.querySelector(sel), touch = matchMedia("(pointer: coarse)").matches;
    const o = { bubbles: true, cancelable: true, composed: true, pointerType: touch ? "touch" : "mouse", isPrimary: true, button: 0 };
    e.dispatchEvent(new PointerEvent("pointerdown", o)); e.dispatchEvent(new PointerEvent("pointerup", o)); e.click();
  }, selector);
}
async function lookAround(page, net) {
  await firstVisit(page, net);
  await tap(page, "#nx-fr2-look");
  await advance(page, net, SCHEDULE.look);
  await expect(page, () => !document.documentElement.classList.contains("nx-first-run") && window.__boardKit && window.__boardKit.SC.open === "tonight", null, "Next steps after \"Just take a look\"");
}
async function toWall(page, net) {
  await lookAround(page, net);
  await page.evaluate(() => window.__boardKit.requestClose());
  await advance(page, net, SCHEDULE.close);
  await expect(page, () => window.__boardKit.SC.open === null && !document.documentElement.classList.contains("scene-open"), null, "the wall (scene closed)");
}
// The journey switch on the wall, used the way a visitor uses it: tap the journey's button. On a phone the first tap only opens the switch (js/v13d.js
// startJourneySwitch), so a second tap chooses; on a desktop the first tap chooses.
async function chooseJourney(page, net, j) {
  for (let i = 0; i < 2; i++) {
    if (await page.evaluate((jj) => document.documentElement.dataset.journey === jj, j)) break;
    await tap(page, `#journey [data-journey="${j}"]`);
    await advance(page, net, SCHEDULE.journey);
  }
  await expect(page, (jj) => document.documentElement.dataset.journey === jj && document.querySelector(`#journey [data-journey="${jj}"]`).getAttribute("aria-pressed") === "true", j, `the ${j} journey`);
}
// The line a scene panel shows when its data did not load (js/board.js MEMBER_DOWN): such a page never becomes a baseline.
const DOWN_LINE = "This part of the board could not load";
// Each screen: how to reach it, and what must be true before it may be shot (a broken page never becomes a baseline).
const SCREENS = {
  first: { go: firstVisit, ready: () => document.documentElement.classList.contains("nx-first-run") && !!document.querySelector("#nx-fr2-go") && document.querySelector("#nx-fr2-go").getClientRects().length > 0 },
  wall: {
    go: toWall,
    ready: () => { const m = document.getElementById("main"); return !document.documentElement.classList.contains("scene-open") && window.__boardKit.SC.open === null && !!m && m.getClientRects().length > 0 && getComputedStyle(m).visibility !== "hidden"; },
  },
  landing: {
    go: async (page, net) => { await page.goto(new URL("landing/", ROOT).href, { waitUntil: "load" }); await advance(page, net, SCHEDULE.load); },
    ready: () => { const h = document.querySelector("h1"); return !!h && h.innerText.trim().length > 0; },
  },
};
// Scenes are shot in the Everything journey, so every panel shows all it has (Guided, the default, hides all but each panel's core: css/v13d.css).
// Next steps (tonight) is shot where "Just take a look" leaves a first visitor: Guided.
const sceneScreen = (k) => ({
  go: async (page, net) => {
    if (k === "tonight") return lookAround(page, net);
    await toWall(page, net);
    await chooseJourney(page, net, "everything");
    await page.evaluate((s) => window.__boardKit.goScene(s), k);
    await advance(page, net, SCHEDULE.open);
  },
  ready: ({ scene, journey, down }) => {
    const sh = document.querySelector("#scene .sheet"), panel = document.getElementById(`panel-${scene}`);
    return window.__boardKit.SC.open === scene && document.documentElement.classList.contains("scene-open") && document.documentElement.dataset.journey === journey && !!sh && sh.getClientRects().length > 0 && Number(getComputedStyle(sh).opacity) > 0.99
      && !!panel && !panel.hidden && panel.getClientRects().length > 0 && panel.innerText.trim().length > 20 && !document.getElementById("sheet-body").innerText.includes(down);
  },
  arg: { scene: k, journey: k === "tonight" ? "guided" : "everything", down: DOWN_LINE },
});

// Waits (bounded) until every <img> in the viewport is loaded and decoded. CSS background art is covered by the network going quiet: asking for it again from here
// (new Image()) sends requests of its own, which on CI's Chromium kept every round "busy" (measured 2026-11-22: 20 requests for 28 background URLs).
async function artReady(page) {
  const work = page.evaluate(async () => {
    const W = innerWidth, H = innerHeight, waits = [];
    for (const img of document.images) {
      const r = img.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W)) continue;
      if (!img.complete) waits.push(new Promise((ok) => { img.addEventListener("load", ok, { once: true }); img.addEventListener("error", ok, { once: true }); }));
      else if (img.naturalWidth) waits.push(img.decode().catch(() => {}));
    }
    await Promise.all(waits);
    return waits.length;
  }).catch(() => -1);
  return Promise.race([work, new Promise((r) => setTimeout(() => r(-2), ART_MAX_MS))]);
}
// The final settle. The page's Date is frozen where the fixed schedule left it (so the launch countdown and every "in 25 hours" read the same however long this
// takes), while timers, idle callbacks and frames keep running in SUB_MS steps. Work that needs real time as well as timers (the light's shader compiles in the GPU
// process and is polled every 16 ms; art that arrives late) therefore finishes instead of being frozen half-done. Calibration 2026-11-22: with the clock simply
// paused, a slower CI CPU (Xeon Platinum 8370C) shot the desktop wall with the light not yet lit. A shot counts once STABLE_ROUNDS rounds in a row, each with the
// clock advanced, the network quiet and the on-screen art decoded, give byte-identical screenshots with no request in between.
async function settle(page, net) {
  await page.clock.setFixedTime(new Date(await page.evaluate(() => Date.now())));
  let prev = null, same = 0, mark = -1, last = "";
  for (let round = 1; round <= SETTLE_ROUNDS; round++) {
    await page.clock.runFor(SUB_MS);
    if (!(await quiet(page, net))) net.loud++;
    await artReady(page);
    if (!(await quiet(page, net))) net.loud++;
    const png = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
    const pixelsSame = !!prev && png.equals(prev), netSame = net.events === mark && net.inflight <= 0;
    same = pixelsSame && netSame ? same + 1 : 0;
    if (same >= STABLE_ROUNDS - 1) return { png, shots: round };
    if (round >= SETTLE_ROUNDS - 1) { // what kept moving, for the failure message
      const moved = prev && !pixelsSame ? diffImages(decodePng(prev), decodePng(png), { tolerance: 0 }) : null;
      last = `${last ? `${last}; ` : ""}round ${round}: ${pixelsSame ? "same pixels" : moved && moved.box ? `${moved.changed} px changed inside x ${moved.box.x} y ${moved.box.y} w ${moved.box.w} h ${moved.box.h} (largest step ${moved.maxDelta})` : "pixels changed"}, ${net.events - Math.max(0, mark)} requests, ${net.inflight} in flight`;
    }
    prev = png; mark = net.events;
  }
  throw new Error(`the screen never held still: ${SETTLE_ROUNDS} rounds of ${SUB_MS} ms page time, no ${STABLE_ROUNDS} identical screenshots in a row (${last})`);
}
// What the page looked like from the inside when it was shot: printed with a failure, so a difference on another runner explains itself in the log.
const pageState = (page) => page.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(","); };
  let gl = "";
  try { const c = document.createElement("canvas"), g = c.getContext("webgl"), d = g && g.getExtension("WEBGL_debug_renderer_info"); gl = g ? String(d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : "none"; const l = g && g.getExtension("WEBGL_lose_context"); if (l) l.loseContext(); } catch (e) { gl = "error"; }
  const sh = document.querySelector("#scene .sheet"), body = document.getElementById("sheet-body"), st = window.__board && typeof window.__board.status === "function" ? window.__board.status() : null;
  const css = (el, props) => { if (!el) return null; const c = getComputedStyle(el), o = {}; for (const p of props) o[p] = String(c[p]).replace(/url\("?[^")]*\/([^/")]+)"?\)/g, "url($1)").slice(0, 160); return o; };
  const root = document.documentElement, mq = (q) => { try { return matchMedia(q).matches; } catch (e) { return null; } };
  return {
    cls: root.className, sheet: r(sh), sheetZoom: sh ? getComputedStyle(sh).zoom : null, sheetTransform: sh ? getComputedStyle(sh).transform : null, body: r(body), bodyScroll: body ? body.scrollTop : null, main: r(document.getElementById("main")), scrollY: window.scrollY,
    fonts: document.fonts.status, imgsPending: [...document.images].filter((i) => i.getClientRects().length && !i.complete).length, light: st && st.light ? { state: st.light.state, why: st.light.why, draws: st.light.draws } : null,
    railPad: document.getElementById("scene") ? document.getElementById("scene").style.getPropertyValue("--rail-pad") : null, cores: navigator.hardwareConcurrency, gl,
    // what decides how the paper and the wood are painted: the sheet and its body, the tile size, the media that switch textures and tints, the attributes on <html>
    sheetCss: css(sh, ["opacity", "filter", "visibility", "mixBlendMode"]), bodyCss: css(body, ["opacity", "filter", "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundBlendMode"]),
    tile: getComputedStyle(root).getPropertyValue("--tile").trim(), dpr: window.devicePixelRatio, vw: innerWidth, vh: innerHeight,
    media: { dark: mq("(prefers-color-scheme: dark)"), light: mq("(prefers-color-scheme: light)"), hdr: mq("(dynamic-range: high)"), res15: mq("(min-resolution: 1.5dppx)"), reduce: mq("(prefers-reduced-motion: reduce)"), coarse: mq("(pointer: coarse)") },
    attrs: [...root.attributes].filter((a) => a.name !== "class" && a.name !== "style").map((a) => `${a.name}=${String(a.value).slice(0, 40)}`),
    // the elements stacked at a point of bare paper (a third of the way down the sheet), top first: an overlay or a veil above the sheet shows here with its opacity and background
    stack: (() => { try { const x = Math.round(innerWidth / 2), y = Math.round(innerHeight * 0.3); return document.elementsFromPoint(x, y).slice(0, 9).map((e) => { const c = getComputedStyle(e); return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.classList.length ? `.${[...e.classList].slice(0, 3).join(".")}` : ""} op=${c.opacity} bg=${c.backgroundColor}${c.mixBlendMode !== "normal" ? ` blend=${c.mixBlendMode}` : ""}${c.filter !== "none" ? ` filter=${c.filter}` : ""}`; }); } catch (e) { return []; } })(),
    // large elements of the page and of the scene, and the root's pseudo-elements: an overlay that is not the sheet shows here even when it ignores the pointer
    covering: (() => { try { const out = [], W = innerWidth, H = innerHeight, nm = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.classList.length ? `.${[...e.classList].slice(0, 3).join(".")}` : ""}`;
      for (const e of document.querySelectorAll("body > *, #scene, #scene > *, #scene .sheet, #scene .sheet > *")) { const b = e.getBoundingClientRect(); if (b.width < W * 0.6 || b.height < H * 0.4) continue; const c = getComputedStyle(e); if (c.display === "none" || c.visibility === "hidden") continue; out.push(`${nm(e)} ${c.position} z=${c.zIndex} op=${c.opacity} bg=${c.backgroundColor}${c.filter !== "none" ? ` filter=${c.filter}` : ""}${c.mixBlendMode !== "normal" ? ` blend=${c.mixBlendMode}` : ""}`); }
      return out.slice(0, 18); } catch (e) { return []; } })(),
    pseudo: (() => { try { return [["html", "::before"], ["html", "::after"], ["body", "::before"], ["body", "::after"]].map(([t, p]) => { const c = getComputedStyle(document.querySelector(t), p); return `${t}${p} content=${c.content} pos=${c.position} z=${c.zIndex} op=${c.opacity} bg=${c.backgroundColor}`; }).filter((x) => !/content=(none|normal)/.test(x)); } catch (e) { return []; } })(),
    animations: document.getAnimations().slice(0, 12).map((a) => `${a.animationName || a.transitionProperty || a.id || a.constructor.name}:${a.playState}`),
    textures: performance.getEntriesByType("resource").filter((e) => /(paper-baked|parchment-tile|oak-tile)/.test(e.name)).map((e) => `${e.name.split("/").pop().split("?")[0]} ${Math.round(e.duration)}ms ${e.transferSize}B`),
  };
}).catch((e) => ({ error: String(e.message).split("\n")[0] }));
// Where and how two images differ: a coarse map of the changed pixels, the mean brightness of each side in the changed box, and the small shift of the whole
// image that matches best (a moved element or a re-laid-out sheet shows as a shift; a lit or unlit light as brightness).
function explain(base, actual, box, tol) {
  const { width: W, height: H } = base, A = base.data, B = actual.data, lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const cols = Math.min(32, W), rows = Math.max(1, Math.round((cols * H) / W / 2)), cw = W / cols, ch = H / rows, grid = [];
  for (let gy = 0; gy < rows; gy++) {
    let line = "";
    for (let gx = 0; gx < cols; gx++) {
      let n = 0, c = 0;
      for (let y = Math.floor(gy * ch); y < Math.floor((gy + 1) * ch); y += 2) for (let x = Math.floor(gx * cw); x < Math.floor((gx + 1) * cw); x += 2) { const i = (y * W + x) * 4; n++; if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > tol) c++; }
      const f = n ? c / n : 0; line += f === 0 ? "." : f < 0.1 ? ":" : f < 0.5 ? "+" : "#";
    }
    grid.push(line);
  }
  let la = 0, lb = 0, n = 0;
  for (let y = box.y; y < box.y + box.h; y += 2) for (let x = box.x; x < box.x + box.w; x += 2) { const i = (y * W + x) * 4; la += lum(A, i); lb += lum(B, i); n++; }
  let best = { dx: 0, dy: 0, match: -1 };
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    let m = 0, t = 0;
    for (let y = Math.max(box.y, 4); y < Math.min(box.y + box.h, H - 4); y += 3) for (let x = Math.max(box.x, 4); x < Math.min(box.x + box.w, W - 4); x += 3) { const i = (y * W + x) * 4, j = ((y + dy) * W + x + dx) * 4; t++; if (Math.max(Math.abs(A[j] - B[i]), Math.abs(A[j + 1] - B[i + 1]), Math.abs(A[j + 2] - B[i + 2])) <= tol) m++; }
    if (t && m / t > best.match) best = { dx, dy, match: m / t };
  }
  const bands = [];
  for (let b = 0; b < 8; b++) {
    const y0 = Math.floor((b * H) / 8), y1 = Math.floor(((b + 1) * H) / 8); let ma = [0, 0, 0], mb = [0, 0, 0], k = 0;
    for (let y = y0; y < y1; y += 3) for (let x = 0; x < W; x += 3) { const i = (y * W + x) * 4; for (let c = 0; c < 3; c++) { ma[c] += A[i + c]; mb[c] += B[i + c]; } k++; }
    bands.push(`y ${y0}-${y1}: ${ma.map((v) => Math.round(v / k)).join(",")} -> ${mb.map((v) => Math.round(v / k)).join(",")}`);
  }
  return { grid, bands, meanLumBaseline: Math.round(la / Math.max(1, n)), meanLumActual: Math.round(lb / Math.max(1, n)), bestShift: { dx: best.dx, dy: best.dy, matching: `${(best.match * 100).toFixed(1)}%` } };
}

async function newContext(browser, size) {
  const { id: _id, ...opts } = size;
  const ctx = await browser.newContext({ ...opts, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: "light", serviceWorkers: "block", timezoneId: TZ, locale: LOCALE });
  // the static copy of the library (the page falls back to it and the data scene reads it): the fixture too, a missing file is a 404 the shot fails on
  await ctx.route((u) => u.origin === ORIGIN && /\/data\/library\/[A-Za-z0-9._-]+$/.test(u.pathname), async (route) => {
    const f = path.join(LIBRARY_FIXTURE, path.basename(new URL(route.request().url()).pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, contentType: "text/plain", body: "not in tests/fixtures/library" });
    return route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", headers: { "cache-control": "no-store" }, body: readFileSync(f, "utf8") });
  });
  await ctx.clock.pauseAt(new Date(pinnedClock(argv).getTime() + PAUSE_AT_MS)); // before any page exists: every page starts at this instant, paused
  await ctx.addInitScript({ content: SEED_JS });
  return ctx;
}

async function shoot(browser, size, screen) {
  const ctx = await newContext(browser, size), problems = [];
  try {
    const page = await ctx.newPage(), net = { inflight: 0, last: Date.now(), loud: 0, events: 0 };
    if (THROTTLE > 1) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    if (SLOW_ART > 0) await page.route(/\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/i, async (route) => { await new Promise((r) => setTimeout(r, SLOW_ART)); return route.fallback(); });
    if (BLOCK) await page.route(BLOCK, (route) => route.abort());
    if (JITTER > 0) await page.route("**/*", async (route) => { await new Promise((r) => setTimeout(r, Math.random() * JITTER)); return route.fallback(); });
    page.on("request", () => { net.inflight++; net.events++; net.last = Date.now(); });
    for (const ev of ["requestfinished", "requestfailed"]) page.on(ev, () => { net.inflight--; net.events++; net.last = Date.now(); });
    page.on("pageerror", (e) => problems.push(`page error: ${String(e.message).split("\n")[0]}`));
    // A page that lost a file of its own (this origin answered 4xx or 5xx, or the request failed) or logged an error is a broken page: its shot must not become a baseline, and
    // must not pass against one. Chromium asks every page for /favicon.ico by itself; the landing page declares no icon and the host answers 404 there too, so that one is left out.
    page.on("response", (r) => { try { const u = new URL(r.url()); if (u.origin === ORIGIN && u.pathname !== "/favicon.ico" && r.status() >= 400) problems.push(`this site answered ${r.status()} for ${u.pathname}`); } catch (e) { /* not a URL */ } });
    page.on("requestfailed", (q) => { try { const u = new URL(q.url()), why = (q.failure() || {}).errorText || "failed"; if (u.origin === ORIGIN && !/ERR_ABORTED/.test(why)) problems.push(`the request for ${u.pathname} failed (${why})`); } catch (e) { /* not a URL */ } });
    page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) problems.push(`console error: ${m.text().split("\n")[0].slice(0, 200)}`); }); // a failed load is reported above, with its path
    await screen.go(page, net);
    await advance(page, net, SCHEDULE.flush);
    await expect(page, screen.ready, screen.arg ?? null, "its expected state (element missing or scene not open)");
    if (INJECT_CSS) await page.addStyleTag({ content: INJECT_CSS });
    await page.evaluate(() => document.fonts.ready);
    const { png, shots } = await settle(page, net);
    const state = await pageState(page);
    if (!(await page.evaluate(screen.ready, screen.arg ?? null))) throw new Error("the screen left its expected state while settling");
    const named = await page.evaluate((names) => {
      const text = [document.title, document.body.innerText, ...[...document.querySelectorAll("[aria-label],[title],[alt],[placeholder],input,textarea")].map((e) => [e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("alt"), e.getAttribute("placeholder"), e.value].join(" "))].join("\n").toLowerCase();
      return names.map((n, i) => (new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(text) ? i : -1)).filter((i) => i >= 0);
    }, REAL_NAMES);
    if (named.length) throw new Error(`the screen shows a real member name (data/party.json member index ${named.join(", ")}); a baseline must show fixture names only`);
    const img = decodePng(png), colours = new Set();
    for (let i = 0; i < img.data.length && colours.size <= 64; i += 4 * 97) colours.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
    if (colours.size < 16) throw new Error(`the screenshot is nearly blank (${colours.size} colours in a sample)`);
    if (problems.length) throw new Error(problems[0]);
    return { png, img, shots, loud: net.loud, state };
  } catch (e) { // a page that lost a file usually stops short of the state asked for: say what it reported as well
    if (problems.length && !String(e.message).includes(problems[0])) e.message = `${String(e.message).split("\n")[0]} (the page reported: ${problems[0]})`;
    throw e;
  } finally { await ctx.close().catch(() => {}); }
}

const rows = [], fails = [];
const fail = (row, why) => { row.status = "FAIL"; row.why = why; fails.push(`${row.id}: ${why}`); console.log(`FAIL ${row.id}: ${why}`); };
mkdirSync(ACTUAL, { recursive: true }); mkdirSync(DIFF, { recursive: true });
for (const f of readdirSync(ACTUAL)) rmSync(path.join(ACTUAL, f)); for (const f of readdirSync(DIFF)) rmSync(path.join(DIFF, f));
if (WRITE) mkdirSync(WRITE, { recursive: true });
const T0 = Date.now();
const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}), { libraryDir: LIBRARY_FIXTURE });
let sceneList = null;
try {
  { // the scene list comes from the page, so a new scene shows up as a screen without a baseline and fails until one is committed
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } }), page = await ctx.newPage();
    await page.goto(BOARD, { waitUntil: "load" });
    await page.waitForFunction(() => window.__boardKit && Array.isArray(window.__boardKit.SCENES) && window.__boardKit.SCENES.length > 0, null, { timeout: 20000 });
    sceneList = await page.evaluate(() => [...window.__boardKit.SCENES]);
    await ctx.close();
    console.log(`visual-baseline: ${sceneList.length} scenes from the page: ${sceneList.join(", ")}`);
  }
  for (const size of SIZES) {
    if (ONLY_SIZES && !ONLY_SIZES.has(size.id)) continue;
    const screens = { first: SCREENS.first, wall: SCREENS.wall, ...Object.fromEntries(sceneList.map((k) => [k, sceneScreen(k)])), landing: SCREENS.landing };
    for (const [name, screen] of Object.entries(screens)) {
      if (ONLY && !ONLY.has(name)) continue;
      const id = `${name}-${size.id}`, row = { id, status: "", ratio: null, changed: null, maxDelta: null, shots: [] };
      rows.push(row);
      const takes = [];
      for (let r = 0; r < REPEAT; r++) {
        try { const t = await shoot(browser, size, screen); takes.push(t); row.shots.push(t.shots); if (t.state && t.state.gl) row.gl = t.state.gl; if (t.loud) console.log(`WARN ${id}: the network was still busy after ${t.loud} clock steps (bounded at ${QUIET_MAX_MS} ms each)`); }
        catch (e) { fail(row, String(e.message).split("\n")[0]); break; }
      }
      if (row.status === "FAIL") continue;
      writeFileSync(path.join(ACTUAL, `${id}.png`), takes[0].png);
      if (REPEAT > 1) { // calibration: the noise between repeat shots of the same screen, each in a fresh browser context
        const noise = takes.slice(1).map((t) => diffImages(takes[0].img, t.img, THRESHOLD));
        row.repeatRatio = Math.max(...noise.map((n) => (n.sizeMismatch ? 1 : n.ratio)));
        row.repeatMaxDelta = Math.max(...noise.map((n) => n.maxDelta || 0));
        row.repeatIdentical = takes.slice(1).every((t) => t.png.equals(takes[0].png));
        takes.slice(1).forEach((t, n) => { if (!noise[n].sizeMismatch && noise[n].changed > 0) { writeFileSync(path.join(ACTUAL, `${id}.take${n + 2}.png`), t.png); writeFileSync(path.join(DIFF, `${id}.take${n + 2}.png`), encodePng(diffImage(takes[0].img, t.img, THRESHOLD))); } });
        console.log(`REPEAT ${id}: ${REPEAT} shots ${row.repeatIdentical ? "byte-identical" : "differ"}, ${(row.repeatRatio * 100).toFixed(4)}% of pixels beyond ${THRESHOLD.tolerance}/255, max channel delta ${row.repeatMaxDelta}`);
        // A screen whose repeat shots disagree is not stable: writing one of them as the baseline would bake a coin flip into the gate, so a write fails it (a comparison judges every shot).
        const bad = noise.findIndex((n) => !judge(n, THRESHOLD).pass);
        if (bad >= 0) { fail(row, `the screen is not stable: shot ${bad + 2} of ${REPEAT} differs from shot 1 (${judge(noise[bad], THRESHOLD).why})${WRITE ? "; not written" : ""}`); continue; }
      }
      if (WRITE) {
        // An existing baseline with no pixel beyond the tolerance is kept byte for byte, so a refresh rewrites only the screens that really changed
        // (a render on another runner can differ by 1/255 here and there; new bytes for an unchanged screen would only grow the repository).
        const prior = path.join(BASELINES, `${id}.png`);
        let same = false;
        try { if (existsSync(prior)) { const d = diffImages(decodePng(readFileSync(prior)), takes[0].img, THRESHOLD); same = !d.sizeMismatch && d.changed === 0; } } catch { same = false; }
        writeFileSync(path.join(WRITE, `${id}.png`), same ? readFileSync(prior) : takes[0].png);
        row.status = same ? "KEPT" : "WROTE";
        console.log(`${row.status} ${id} (held still after ${row.shots.join("/")} shots${same ? `; no pixel beyond ${THRESHOLD.tolerance}/255 against the committed baseline, its bytes are kept` : ""})`);
        continue;
      }
      const bp = path.join(BASELINES, `${id}.png`);
      if (!existsSync(bp)) { fail(row, `no baseline at ${path.relative(path.join(here, "..", ".."), bp) || bp}: run the Visual Baselines workflow on this branch (docs/runbooks/visual-baselines.md)`); continue; }
      let base;
      try { base = decodePng(readFileSync(bp)); } catch (e) { fail(row, `the baseline does not decode: ${e.message}`); continue; }
      const results = takes.map((t) => diffImages(base, t.img, THRESHOLD));
      const worstAt = results.reduce((w, r, i) => (results[w].sizeMismatch ? w : r.sizeMismatch || r.ratio > results[w].ratio ? i : w), 0), worst = results[worstAt];
      const verdict = judge(worst, THRESHOLD);
      row.ratio = worst.sizeMismatch ? 1 : worst.ratio; row.changed = worst.changed ?? null; row.maxDelta = worst.maxDelta ?? null; row.box = worst.box || null;
      if (!worst.sizeMismatch && worst.changed > 0) writeFileSync(path.join(DIFF, `${id}.png`), encodePng(diffImage(base, takes[worstAt].img, THRESHOLD)));
      if (!verdict.pass) {
        fail(row, `${verdict.why}${worst.box ? `, inside x ${worst.box.x} y ${worst.box.y} w ${worst.box.w} h ${worst.box.h}` : ""}; if the change is intended, commit the new baseline in this PR (docs/runbooks/visual-baselines.md)`);
        const why = worst.box ? explain(base, takes[worstAt].img, worst.box, THRESHOLD.tolerance) : null;
        row.diag = { page: takes[worstAt].state, ...(why || {}) };
        if (why) { console.log(`DIAG ${id}: mean brightness in the box ${why.meanLumBaseline} (baseline) vs ${why.meanLumActual} (now); best whole-image shift dx ${why.bestShift.dx} dy ${why.bestShift.dy} matches ${why.bestShift.matching} of the box`); console.log(`DIAG ${id}: changed pixels by area (. none, : under 10%, + under 50%, # more):\n${why.grid.map((l) => `  ${l}`).join("\n")}`); }
        if (why) console.log(`DIAG ${id}: mean colour of eight bands, baseline -> now (r,g,b):\n${why.bands.map((l) => `  ${l}`).join("\n")}`);
        console.log(`DIAG ${id}: page ${JSON.stringify(takes[worstAt].state)}`);
        continue;
      }
      row.status = "PASS";
      console.log(`PASS ${id}: ${verdict.why}, max channel delta ${worst.maxDelta}`);
    }
  }
} catch (e) {
  const row = { id: "visual-baseline", status: "", ratio: null }; rows.push(row); fail(row, `the run stopped: ${String(e.message).split("\n")[0]}`);
} finally { await browser.close().catch(() => {}); }

// A committed baseline that no screen produced (a removed or renamed scene) is stale and fails a full run.
if (!WRITE && !PARTIAL) {
  const made = new Set(rows.map((r) => `${r.id}.png`));
  for (const f of existsSync(BASELINES) ? readdirSync(BASELINES).filter((f) => f.endsWith(".png")) : []) if (!made.has(f)) { const row = { id: f.replace(/\.png$/, ""), status: "", ratio: null }; rows.push(row); fail(row, "a baseline with no screen: delete it, or restore the screen"); }
}

const compared = rows.filter((r) => r.ratio !== null), max = compared.reduce((m, r) => Math.max(m, r.ratio), 0);
const glSeen = (rows.find((r) => r.gl) || {}).gl || "unknown";
const summary = { mode: WRITE ? "write-baselines" : "compare", url: BASE, threshold: THRESHOLD, sizes: SIZES.map((s) => s.id), repeat: REPEAT, injectedCss: !!INJECT_CSS, cpu: os.cpus()[0] && os.cpus()[0].model, gl: glSeen, seconds: Math.round((Date.now() - T0) / 1000), maxDiffRatio: compared.length ? max : null, failures: fails, screens: rows };
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(path.join(OUT, "summary.md"), ["| Screen | Status | Changed | Max delta | Held still after |", "| :--- | :--- | ---: | ---: | ---: |", ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.ratio === null ? "-" : (r.ratio * 100).toFixed(3) + "%"} | ${r.maxDelta ?? "-"} | ${(r.shots || []).join("/") || "-"} |`), ""].join("\n"));
console.log(`visual-baseline: ${WRITE ? `wrote ${rows.filter((r) => r.status === "WROTE").length} of ${rows.length} screens (kept ${rows.filter((r) => r.status === "KEPT").length} unchanged)` : `compared ${compared.length} of ${rows.length} screens, max ${(max * 100).toFixed(3)}% changed`}, ${fails.length} failed, ${summary.seconds} s on ${summary.cpu}, WebGL ${glSeen} (threshold: more than ${THRESHOLD.maxRatio * 100}% of pixels off by more than ${THRESHOLD.tolerance}/255)`);
process.exit(fails.length ? 1 : 0);
