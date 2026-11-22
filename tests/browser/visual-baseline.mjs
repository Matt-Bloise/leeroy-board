// Visual baselines, GATING. Screenshots the board's first screen, the wall behind it, every scene (window.__boardKit.SCENES) and the landing page at the sizes the
// board is built for, phone first (390x844, touch) then desktop (1366x768), and compares each with a committed PNG in tests/browser/baselines/<screen>-<size>.png.
//   node browser/visual-baseline.mjs --url http://127.0.0.1:8080/        compare; exit 1 when a screen changed beyond the threshold, a baseline is missing or extra, or a screen is broken
//   --write-baselines [dir]   write the screenshots as the new baselines (default tests/browser/baselines) and compare nothing; the Visual Baselines workflow runs this on the CI image
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
const SCHEDULE = Object.freeze({ load: 2000, look: 3000, close: 2000, open: 3000, flush: 12000 }); // fake ms after each action; flush covers the wall's 10 s settle
const SETTLE_TRIES = 12, STABLE_GAP_MS = 250; // up to 12 shots a quarter second apart (clock paused) to find two identical ones in a row
const BASELINES = path.resolve(arg("--baselines") || path.join(here, "baselines")); // --baselines DIR compares with another set (calibration: two renders against each other)
const OUT = path.resolve(arg("--out") || path.join(here, "out", "visual-baseline")), ACTUAL = path.join(OUT, "actual"), DIFF = path.join(OUT, "diff");
const wi = argv.indexOf("--write-baselines");
const WRITE = wi >= 0 ? path.resolve(argv[wi + 1] && !argv[wi + 1].startsWith("--") ? argv[wi + 1] : BASELINES) : null;
const ONLY = arg("--only") ? new Set(arg("--only").split(",").filter(Boolean)) : null;
const ONLY_SIZES = arg("--sizes") ? new Set(arg("--sizes").split(",").filter(Boolean)) : null;
const REPEAT = Math.max(1, Number(arg("--repeat", "1")) || 1);
const INJECT_CSS = arg("--inject-css") ? readFileSync(arg("--inject-css"), "utf8") : "";
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
const sceneScreen = (k) => ({
  go: async (page, net) => {
    if (k === "tonight") return lookAround(page, net);
    await toWall(page, net);
    await page.evaluate((s) => window.__boardKit.goScene(s), k);
    await advance(page, net, SCHEDULE.open);
  },
  ready: (s) => { const sh = document.querySelector("#scene .sheet"), body = document.querySelector("#sheet-body"); return window.__boardKit.SC.open === s && document.documentElement.classList.contains("scene-open") && !!sh && sh.getClientRects().length > 0 && Number(getComputedStyle(sh).opacity) > 0.99 && !!body && body.innerText.trim().length > 20; },
  arg: k,
});

// Two consecutive identical screenshots, with the clock paused (no timer or animation frame runs between them). Returns { png, shots } or throws.
async function stableShot(page) {
  let prev = null;
  for (let i = 1; i <= SETTLE_TRIES; i++) {
    const png = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
    if (prev && png.equals(prev)) return { png, shots: i };
    prev = png;
    await page.waitForTimeout(STABLE_GAP_MS);
  }
  throw new Error(`the screen never held still: ${SETTLE_TRIES} screenshots ${STABLE_GAP_MS} ms apart with the page clock paused, no two in a row identical`);
}

async function newContext(browser, size) {
  const { id: _id, ...opts } = size;
  const ctx = await browser.newContext({ ...opts, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: "light", serviceWorkers: "block", timezoneId: TZ, locale: LOCALE });
  await ctx.clock.pauseAt(new Date(pinnedClock(argv).getTime() + PAUSE_AT_MS)); // before any page exists: every page starts at this instant, paused
  await ctx.addInitScript({ content: SEED_JS });
  return ctx;
}

async function shoot(browser, size, screen) {
  const ctx = await newContext(browser, size), problems = [];
  try {
    const page = await ctx.newPage(), net = { inflight: 0, last: Date.now(), loud: 0 };
    page.on("request", () => { net.inflight++; net.last = Date.now(); });
    for (const ev of ["requestfinished", "requestfailed"]) page.on(ev, () => { net.inflight--; net.last = Date.now(); });
    page.on("pageerror", (e) => problems.push(`page error: ${String(e.message).split("\n")[0]}`));
    await screen.go(page, net);
    await advance(page, net, SCHEDULE.flush);
    await expect(page, screen.ready, screen.arg ?? null, "its expected state (element missing or scene not open)");
    if (INJECT_CSS) await page.addStyleTag({ content: INJECT_CSS });
    await page.evaluate(() => document.fonts.ready);
    const { png, shots } = await stableShot(page);
    if (!(await page.evaluate(screen.ready, screen.arg ?? null))) throw new Error("the screen left its expected state while settling");
    const named = await page.evaluate((names) => {
      const text = [document.body.innerText, ...[...document.querySelectorAll("[aria-label],[title],[alt],[placeholder],input,textarea")].map((e) => [e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("alt"), e.getAttribute("placeholder"), e.value].join(" "))].join("\n").toLowerCase();
      return names.map((n, i) => (new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(text) ? i : -1)).filter((i) => i >= 0);
    }, REAL_NAMES);
    if (named.length) throw new Error(`the screen shows a real member name (data/party.json member index ${named.join(", ")}); a baseline must show fixture names only`);
    const img = decodePng(png), colours = new Set();
    for (let i = 0; i < img.data.length && colours.size <= 64; i += 4 * 97) colours.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
    if (colours.size < 16) throw new Error(`the screenshot is nearly blank (${colours.size} colours in a sample)`);
    if (problems.length) throw new Error(problems[0]);
    return { png, img, shots, loud: net.loud };
  } finally { await ctx.close().catch(() => {}); }
}

const rows = [], fails = [];
const fail = (row, why) => { row.status = "FAIL"; row.why = why; fails.push(`${row.id}: ${why}`); console.log(`FAIL ${row.id}: ${why}`); };
mkdirSync(ACTUAL, { recursive: true }); mkdirSync(DIFF, { recursive: true });
for (const f of readdirSync(ACTUAL)) rmSync(path.join(ACTUAL, f)); for (const f of readdirSync(DIFF)) rmSync(path.join(DIFF, f));
if (WRITE) mkdirSync(WRITE, { recursive: true });
const T0 = Date.now();
const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}));
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
        try { const t = await shoot(browser, size, screen); takes.push(t); row.shots.push(t.shots); if (t.loud) console.log(`WARN ${id}: the network was still busy after ${t.loud} clock steps (bounded at ${QUIET_MAX_MS} ms each)`); }
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
      }
      if (WRITE) { writeFileSync(path.join(WRITE, `${id}.png`), takes[0].png); row.status = "WROTE"; console.log(`WROTE ${id} (held still after ${row.shots.join("/")} shots)`); continue; }
      const bp = path.join(BASELINES, `${id}.png`);
      if (!existsSync(bp)) { fail(row, `no baseline at ${path.relative(path.join(here, "..", ".."), bp) || bp}: run the Visual Baselines workflow on this branch (docs/runbooks/visual-baselines.md)`); continue; }
      let base;
      try { base = decodePng(readFileSync(bp)); } catch (e) { fail(row, `the baseline does not decode: ${e.message}`); continue; }
      const results = takes.map((t) => diffImages(base, t.img, THRESHOLD));
      const worstAt = results.reduce((w, r, i) => (results[w].sizeMismatch ? w : r.sizeMismatch || r.ratio > results[w].ratio ? i : w), 0), worst = results[worstAt];
      const verdict = judge(worst, THRESHOLD);
      row.ratio = worst.sizeMismatch ? 1 : worst.ratio; row.changed = worst.changed ?? null; row.maxDelta = worst.maxDelta ?? null; row.box = worst.box || null;
      if (!worst.sizeMismatch && worst.changed > 0) writeFileSync(path.join(DIFF, `${id}.png`), encodePng(diffImage(base, takes[worstAt].img, THRESHOLD)));
      if (!verdict.pass) { fail(row, `${verdict.why}${worst.box ? `, inside x ${worst.box.x} y ${worst.box.y} w ${worst.box.w} h ${worst.box.h}` : ""}; if the change is intended, commit the new baseline in this PR (docs/runbooks/visual-baselines.md)`); continue; }
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
const summary = { mode: WRITE ? "write-baselines" : "compare", url: BASE, threshold: THRESHOLD, sizes: SIZES.map((s) => s.id), repeat: REPEAT, injectedCss: !!INJECT_CSS, cpu: os.cpus()[0] && os.cpus()[0].model, seconds: Math.round((Date.now() - T0) / 1000), maxDiffRatio: compared.length ? max : null, failures: fails, screens: rows };
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(path.join(OUT, "summary.md"), ["| Screen | Status | Changed | Max delta | Held still after |", "| :--- | :--- | ---: | ---: | ---: |", ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.ratio === null ? "-" : (r.ratio * 100).toFixed(3) + "%"} | ${r.maxDelta ?? "-"} | ${(r.shots || []).join("/") || "-"} |`), ""].join("\n"));
console.log(`visual-baseline: ${WRITE ? `wrote ${rows.filter((r) => r.status === "WROTE").length} of ${rows.length} screens` : `compared ${compared.length} of ${rows.length} screens, max ${(max * 100).toFixed(3)}% changed`}, ${fails.length} failed, ${summary.seconds} s on ${summary.cpu} (threshold: more than ${THRESHOLD.maxRatio * 100}% of pixels off by more than ${THRESHOLD.tolerance}/255)`);
process.exit(fails.length ? 1 : 0);
