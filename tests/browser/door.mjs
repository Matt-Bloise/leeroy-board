// The door (docs/cinematic/door.md): the reimagined first screen at /door/, Chromium, API answered from tests/fixtures/api-snapshot (zero Worker requests),
// page clock pinned (tests/helpers/clock-arg.mjs), fictional names only.
//   node door.mjs --url http://127.0.0.1:8080/?brain=http://127.0.0.1:8787   (or env PREVIEW_PAGES)
//   --write-baselines [dir]   write the canvas-visible baselines (default tests/browser/door-baselines) and judge nothing else
// The fixed audit session, at five sizes (360x780, 390x844 and 430x932 phones, 768x1024 tablet, all touch; 1366x768 laptop):
//   load /door/ -> settle 3 s -> idle window 2 s -> scroll to the end in steps -> settle 2 s; on the laptop it then steps into the tavern for 4 s and out.
// Budgets (FAIL when missed): CLS at most 0.1 (WARN above the program's 0.05), transfer over the session at most 3 MB (the session with the tavern too),
// zero idle loops (no animation frame, no timer started and no running infinite animation in the idle window, and none after the tavern closes),
// decorative 3D at most 30 frames a second, every transition instant under reduced motion. Also: no sideways scroll, no text under 12 px, touch targets
// of 44 px or more, no page error, the map canvas drawn and its roads written out, three.js not fetched before Step inside, keyboard order, axe-core.
// Visual baselines (non-gating, WARN above 2% of pixels, like visual-baseline.mjs): the first screen and the map at the five sizes, reduced motion so
// the map is in its final frame, canvases NOT masked: the art is what is being compared.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const { AxeBuilder } = await import("@axe-core/playwright").catch(() => { console.error("@axe-core/playwright not found; run npm install in tests/"); process.exit(2); });
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node door.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const wi = argv.indexOf("--write-baselines");
const WRITE = wi >= 0 ? path.resolve(argv[wi + 1] && !argv[wi + 1].startsWith("--") ? argv[wi + 1] : path.join(here, "door-baselines")) : null;
const BASELINES = path.join(here, "door-baselines"), OUT = path.join(here, "out", "door");
mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const warn = (msg) => console.log(`WARN ${msg}`);
const DOOR = pageUrl(BASE, { path: "door/" });
const SIZES = [["360x780", 360, 780, true, 3], ["390x844", 390, 844, true, 3], ["430x932", 430, 932, true, 3], ["768x1024", 768, 1024, true, 2], ["844x390", 844, 390, true, 3], ["667x375", 667, 375, true, 3], ["1366x768", 1366, 768, false, 1]];
const MB = 1024 * 1024, CLS_MAX = 0.1, CLS_TARGET = 0.05, BYTES_MAX = 3 * MB, FPS_MAX = 30;
const browser = stubbed(await pw.chromium.launch({ args: ["--enable-unsafe-swiftshader"] }), { label: "door api-stub" });

const OBSERVE = () => {
  window.__door = { cls: 0, shifts: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__door.cls += e.value; window.__door.shifts.push(e.sources.map((s) => (s.node && (s.node.id || s.node.className || s.node.nodeName)) || "?").join(" ")); } }).observe({ type: "layout-shift", buffered: true }); } catch (e) {}
};
// counts what runs in a window: animation frames, timers started, infinite animations still running (wrapped at the start of the window, so a loop already
// running is caught on its next request: every loop on the page asks the global requestAnimationFrame each frame)
const IDLE_START = () => {
  const w = window, c = (w.__idle = { raf: 0, timers: 0 });
  const raf = w.requestAnimationFrame, st = w.setTimeout, si = w.setInterval;
  w.requestAnimationFrame = function (f) { c.raf++; return raf.call(w, f); };
  w.setTimeout = function (...a) { c.timers++; return st.apply(w, a); };
  w.setInterval = function (...a) { c.timers++; return si.apply(w, a); };
};
const IDLE_READ = () => ({ raf: window.__idle.raf, timers: window.__idle.timers, loops: document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.getComputedTiming().iterations === Infinity).length });
const LAYOUT = (touch) => {
  const vis = (el) => { const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity !== 0 && r.width > 1 && r.height > 1 && !el.closest("[hidden], dialog:not([open]), .sprite"); };
  const small = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|svg|use|path|SYMBOL)$/i.test(el.tagName) || !vis(el)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
    const cs = getComputedStyle(el); if (cs.clip === "rect(0px, 0px, 0px, 0px)" || el.classList.contains("sr-only")) continue;
    if (parseFloat(cs.fontSize) < 12) small.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${cs.fontSize}`);
  }
  const taps = [];
  if (touch) for (const el of document.querySelectorAll("a[href], button, input, select, summary")) {
    if (!vis(el) || el.classList.contains("skip")) continue;
    if (el.tagName === "A" && el.closest("p") && !el.matches(".btn, .card-go")) continue; // a link inside running text (WCAG 2.5.8 inline exception)
    const r = el.getBoundingClientRect(); if (r.width < 44 || r.height < 44) taps.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${el.textContent.trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, small, taps };
};
const mapState = () => {
  const c = document.querySelector("#map"), g = c.getContext("2d"), seen = new Set();
  if (c.width < 10 || c.height < 10) return { colours: 0, roads: 0 };
  const d = g.getImageData(0, 0, c.width, c.height).data;
  for (let y = 0; y < c.height; y += Math.max(1, Math.floor(c.height / 40))) for (let x = 0; x < c.width; x += Math.max(1, Math.floor(c.width / 60))) { const i = (y * c.width + x) * 4; seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`); }
  return { colours: seen.size, roads: document.querySelectorAll("#rd-list li.road:not(.road-wait)").length, heading: document.querySelector("#rd-h").textContent, label: c.getAttribute("aria-label") || "" };
};

async function session(id, w, h, touch, dpr, { room = false } = {}) {
  const tag = `[${id}]`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: touch, isMobile: touch, serviceWorkers: "block" });
  const seen = [];
  let bytes = 0;
  ctx.on("requestfinished", async (r) => { seen.push(r.url()); try { const s = await r.sizes(); bytes += s.responseBodySize + s.responseHeadersSize; } catch (e) {} });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(OBSERVE);
  await page.goto(room ? pageUrl(DOOR, { params: { room: "gl" } }) : DOOR, { waitUntil: "load" });
  await page.waitForSelector("#su-who:not(:empty)", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
  ok(`${tag} the invitation and the one action are on the first screen`, await page.evaluate(() => { const a = document.querySelector("h1").getBoundingClientRect(), g = document.querySelector("#go").getBoundingClientRect(); return a.top >= 0 && g.bottom <= innerHeight && g.height >= 44; }));
  await page.evaluate(IDLE_START);
  await page.waitForTimeout(2000);
  const idle = await page.evaluate(IDLE_READ);
  ok(`${tag} zero idle loops: no animation frame, no timer, no infinite animation in a 2 s idle window`, idle.raf === 0 && idle.timers === 0 && idle.loops === 0, JSON.stringify(idle));
  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= H; y += Math.round(h * 0.8)) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(250); }
  await page.waitForTimeout(2000);
  const lay = await page.evaluate(LAYOUT, touch);
  ok(`${tag} no sideways scroll`, lay.sw <= lay.cw, `${lay.sw} > ${lay.cw}`);
  ok(`${tag} no visible text under 12 px`, lay.small.length === 0, lay.small.slice(0, 5).join(" | "));
  if (touch) ok(`${tag} every control is at least 44 px in both sides`, lay.taps.length === 0, lay.taps.slice(0, 5).join(" | "));
  const map = await page.evaluate(mapState);
  ok(`${tag} the map canvas is drawn, not blank`, map.colours >= 12, JSON.stringify(map));
  ok(`${tag} every road on the map is written out under it, and the canvas has a label`, map.roads >= 1 && /road/.test(map.label) && /road/i.test(map.heading), JSON.stringify(map));
  ok(`${tag} three.js is not fetched before Step inside`, !seen.some((u) => /three\.module/.test(u)));
  const cls = await page.evaluate(() => window.__door);
  ok(`${tag} CLS at most ${CLS_MAX} over the session`, cls.cls <= CLS_MAX, `${cls.cls.toFixed(4)} ${cls.shifts.slice(0, 3).join(" | ")}`);
  if (cls.cls > CLS_TARGET) warn(`${tag} CLS ${cls.cls.toFixed(4)} is above the program target ${CLS_TARGET}`);
  ok(`${tag} transfer over the session at most 3 MB`, bytes <= BYTES_MAX, `${(bytes / MB).toFixed(2)} MB`);
  console.log(`INFO ${tag} session: ${(bytes / MB).toFixed(2)} MB in ${seen.length} requests, CLS ${cls.cls.toFixed(4)}`);
  if (room) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#room-go").click();
    const started = await page.waitForFunction(() => window.__doorRoom && (window.__doorRoom.status() || !document.querySelector("#room-still").hidden), null, { timeout: 45000 }).then(() => true, () => false);
    const gl = started && await page.evaluate(() => !!(window.__doorRoom && window.__doorRoom.status()));
    ok(`${tag} Step inside opens the tavern dialog with focus on its close button`, await page.evaluate(() => document.querySelector("#room").open && document.activeElement && document.activeElement.id === "room-x"));
    if (gl) {
      await page.waitForTimeout(1500);
      const s1 = await page.evaluate(() => window.__doorRoom.status()), t1 = Date.now();
      await page.waitForTimeout(3000);
      const s2 = await page.evaluate(() => window.__doorRoom.status()), fps = (s2.frames - s1.frames) / ((Date.now() - t1) / 1000);
      ok(`${tag} the tavern is the medium tier and draws at most ${FPS_MAX} frames a second`, s2.tier === "medium" && fps <= FPS_MAX + 1, `${s2.tier}, ${fps.toFixed(1)} draws a second`);
      ok(`${tag} three.js and the room come only after Step inside`, seen.some((u) => /three\.module/.test(u)));
    } else warn(`${tag} this browser started no WebGL room (${await page.textContent("#room-d")}); the 30 fps check is not run here`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await page.evaluate(IDLE_START);
    await page.waitForTimeout(2000);
    const after = await page.evaluate(IDLE_READ);
    ok(`${tag} Escape closes the tavern, focus goes back to Step inside`, await page.evaluate(() => !document.querySelector("#room").open && document.activeElement && document.activeElement.id === "room-go"));
    ok(`${tag} nothing runs after the tavern closes`, after.raf === 0 && after.timers === 0 && after.loops === 0, JSON.stringify(after));
    ok(`${tag} transfer over the session with the tavern at most 3 MB`, bytes <= BYTES_MAX, `${(bytes / MB).toFixed(2)} MB`);
    console.log(`INFO ${tag} session with the tavern: ${(bytes / MB).toFixed(2)} MB in ${seen.length} requests`);
  }
  ok(`${tag} no page error`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function reduced() {
  const tag = "[reduced motion 390x844]";
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, reducedMotion: "reduce", serviceWorkers: "block" });
  const seen = []; ctx.on("request", (r) => seen.push(r.url()));
  const page = await ctx.newPage();
  await page.goto(pageUrl(DOOR, { params: { room: "gl" } }), { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const slow = await page.evaluate(() => [...document.querySelectorAll(".btn, .card, .places a, #room")].map((e) => getComputedStyle(e)).flatMap((cs) => [cs.transitionDuration, cs.animationDuration]).flatMap((v) => v.split(",")).map((v) => parseFloat(v) * (/ms/.test(v) ? 1 : 1000)).filter((ms) => ms > 1));
  ok(`${tag} every transition and animation is 1 ms or less`, slow.length === 0, slow.slice(0, 5).join(", "));
  await page.locator("#room-go").click();
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => ({ open: document.querySelector("#room").open, still: !document.querySelector("#room-still").hidden, say: document.querySelector("#room-d").textContent }));
  ok(`${tag} the tavern opens at once as the painting, and no WebGL starts`, st.open && st.still && /reduced/i.test(st.say) && !seen.some((u) => /three\.module|room\/room\.js/.test(u)), JSON.stringify(st));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  ok(`${tag} Escape closes it at once`, await page.evaluate(() => !document.querySelector("#room").open));
  await ctx.close();
}

async function keyboard() {
  const tag = "[keyboard 1366x768]";
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.goto(DOOR, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement && document.activeElement.className);
  await page.keyboard.press("Tab");
  const second = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok(`${tag} Tab reaches the skip link first, then the one action`, /skip/.test(first) && second === "go", `${first}, ${second}`);
  for (const [size, w, h] of [["390x844", 390, 844], ["1366x768", 1366, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    ok(`[axe ${size}] no serious or critical violation`, bad.length === 0, bad.map((v) => `${v.id} (${v.nodes.length})`).join(", "));
    for (const v of r.violations.filter((x) => !bad.includes(x))) warn(`[axe ${size}] ${v.impact} ${v.id} (${v.nodes.length})`);
  }
  await ctx.close();
}

// ---- the cases the plain session cannot see: late data, a stalled API, a hidden class, long names, closing while loading, a resize after the room rests ----
const CORS = { "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8" };
// answers /api/bootstrap from the fixtures, after `delay` ms (Infinity: never), with `mutate` applied to the document
async function boot(ctx, { delay = 0, mutate = null } = {}) {
  await ctx.route(/\/api\/bootstrap/, async (r) => {
    const res = await r.fetch(); let body = await res.text();
    if (mutate) { const j = JSON.parse(body); mutate(j); body = JSON.stringify(j); }
    if (delay === Infinity) return; // held for ever: the page's own time limit has to end the wait
    if (delay) await new Promise((x) => setTimeout(x, delay));
    await r.fulfill({ status: 200, headers: CORS, body }).catch(() => {});
  });
}
async function edge() {
  // 1. late data while the reader is already looking at the table: layout shift stays within the budget
  for (const [id, w, h, touch] of [["390x844", 390, 844, true], ["768x1024", 768, 1024, true], ["1280x720", 1280, 720, false]]) {
    const tag = `[late data ${id}]`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, serviceWorkers: "block" });
    await boot(ctx, { delay: 2500 });
    await ctx.route(/\/data\/atlas\/(routes|world)\.json/, async (r) => { const res = await r.fetch(); await new Promise((x) => setTimeout(x, 2500)); await r.fulfill({ status: 200, headers: CORS, body: await res.text() }).catch(() => {}); });
    const page = await ctx.newPage(); await page.addInitScript(OBSERVE);
    await page.goto(DOOR, { waitUntil: "load" });
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector("#table").scrollIntoView());
    await page.waitForTimeout(700);
    // phones and tablets: the party card stays on screen while it fills; the laptop: the reader is at the bottom while the roads arrive
    if (touch) await page.evaluate(() => document.querySelector("#c-party").scrollIntoView()); else await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(7000);
    const cls = await page.evaluate(() => window.__door);
    ok(`${tag} CLS at most ${CLS_MAX} when the data and the roads arrive late`, cls.cls <= CLS_MAX, `${cls.cls.toFixed(4)} ${cls.shifts.slice(0, 3).join(" | ")}`);
    await ctx.close();
  }
  // 2. a stalled API: the table says so, the map is drawn anyway, nothing stays busy
  { const tag = "[API held 12 s 390x844]", ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
    await boot(ctx, { delay: Infinity });
    const page = await ctx.newPage(); await page.goto(DOOR, { waitUntil: "load" });
    await page.waitForTimeout(12500);
    const st = await page.evaluate(() => ({ busy: document.querySelector("#table").getAttribute("aria-busy"), next: document.querySelector("#next-what").textContent }));
    ok(`${tag} the page gives up waiting and says so`, st.busy === "false" && /did not load/.test(st.next), JSON.stringify(st));
    await page.locator("#c-roads").scrollIntoViewIfNeeded(); await page.waitForTimeout(2000);
    const m = await page.evaluate(mapState);
    ok(`${tag} the map is drawn from the static data, with its label and written roads`, m.colours >= 12 && m.roads >= 1 && /road/.test(m.label), JSON.stringify(m));
    await ctx.close(); }
  // 3. a hidden class is never named or coloured on the roads; a 49-letter name wraps instead of widening the page
  { const tag = "[hidden class and long names 360x780]", ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
    await boot(ctx, { mutate: (j) => { const m = j.party.members; delete m[0].class_key; delete m[0].class; m[1].name = "W".repeat(49); } });
    const page = await ctx.newPage(); await page.goto(DOOR, { waitUntil: "load" });
    await page.locator("#c-roads").scrollIntoViewIfNeeded(); await page.waitForTimeout(2500);
    const r = await page.evaluate(() => ({ roads: document.querySelector("#rd-list").textContent, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ok(`${tag} the roads do not name the hidden class`, !/druid/i.test(r.roads) && /Nobody on the board starts here/.test(r.roads), r.roads.slice(0, 160));
    ok(`${tag} no sideways scroll with a 49-letter name`, r.sw <= r.cw, `${r.sw} > ${r.cw}`);
    await ctx.close(); }
  // 4. Escape while the room is still loading: the dialog closes and focus goes back to Step inside
  { const tag = "[close while loading 1366x768]", ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block" });
    await ctx.route(/three\.module/, async (r) => { await new Promise((x) => setTimeout(x, 3000)); await r.continue().catch(() => {}); });
    const page = await ctx.newPage(); await page.goto(pageUrl(DOOR, { params: { room: "gl" } }), { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.focus("#room-go"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    await page.keyboard.press("Escape"); await page.waitForTimeout(900);
    const f = await page.evaluate(() => ({ open: document.querySelector("#room").open, id: document.activeElement && document.activeElement.id }));
    ok(`${tag} focus is back on Step inside and the dialog is closed`, !f.open && f.id === "room-go", JSON.stringify(f));
    await ctx.close(); }
  // 5. the rested room stays at rest through a resize (it used to wake and draw 30 times a second with nobody there)
  { const tag = "[rest then resize 1366x768]", ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block" });
    await ctx.clock.install({ time: new Date("2026-11-03T22:10:00Z") });
    const page = await ctx.newPage(); await page.goto(pageUrl(DOOR, { params: { room: "gl" } }), { waitUntil: "load" });
    await page.waitForTimeout(1500); await page.click("#room-go");
    const gl = await page.waitForFunction(() => window.__doorRoom && window.__doorRoom.status(), null, { timeout: 45000 }).then(() => true, () => false);
    if (!gl) warn(`${tag} no WebGL room here; not run`);
    else {
      await page.waitForTimeout(1500); await page.clock.fastForward(31000); await page.waitForTimeout(1500);
      const a = await page.evaluate(() => ({ f: window.__doorRoom.status().frames, say: document.querySelector("#room-d").textContent }));
      await page.setViewportSize({ width: 1280, height: 720 }); await page.waitForTimeout(3000);
      const b = await page.evaluate(() => window.__doorRoom.status().frames);
      ok(`${tag} a resize does not wake the resting room`, /resting/.test(a.say) && b - a.f <= 2, `${a.say} | ${b - a.f} draws in 3 s`);
    }
    await ctx.close(); }
}

// ---- visual baselines: seeded (clock pinned, fixtures, reduced motion, fonts and the hero decoded), canvases visible ----
async function compare(a, b) {
  const helper = await (await browser.newContext()).newPage();
  const r = await helper.evaluate(async ([x, y]) => {
    const load = (b64) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "data:image/png;base64," + b64; });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    const da = px(ia), db = px(ib); let diff = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 32 || Math.abs(da[i + 1] - db[i + 1]) > 32 || Math.abs(da[i + 2] - db[i + 2]) > 32) diff++;
    return { ratio: diff / (ia.width * ia.height) };
  }, [a.toString("base64"), b.toString("base64")]);
  await helper.context().close();
  return r;
}
async function baselines() {
  if (WRITE) mkdirSync(WRITE, { recursive: true });
  const actual = path.join(OUT, "actual"); mkdirSync(actual, { recursive: true });
  for (const [id, w, h, touch] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.goto(DOOR, { waitUntil: "load" });
    await page.waitForSelector("#su-who:not(:empty)", { timeout: 20000 }).catch(() => {});
    await page.locator("#c-roads").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll("#rd-list li.road:not(.road-wait)").length > 0, null, { timeout: 20000 }).catch(() => {});
    await page.evaluate(async () => { await document.fonts.ready; for (const i of document.images) if (i.loading !== "lazy") { try { await i.decode(); } catch (e) {} } });
    await page.waitForTimeout(600);
    const shots = { map: await page.locator(".map-frame").screenshot() };
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);
    shots.first = await page.screenshot();
    for (const [shot, png] of Object.entries(shots)) {
      const name = `${shot}-${id}.png`;
      writeFileSync(path.join(actual, name), png);
      if (WRITE) { writeFileSync(path.join(WRITE, name), png); console.log(`INFO wrote baseline ${name}`); continue; }
      const base = path.join(BASELINES, name);
      if (!existsSync(base)) { console.log(`SKIP baseline ${name}: none committed`); continue; }
      const r = await compare(readFileSync(base), png);
      if (r.size) warn(`baseline ${name}: size changed (${r.size})`);
      else if (r.ratio > 0.02) warn(`baseline ${name}: ${(r.ratio * 100).toFixed(2)}% of pixels differ (over 2%)`);
      else console.log(`INFO baseline ${name}: ${(r.ratio * 100).toFixed(2)}% of pixels differ`);
    }
    await ctx.close();
  }
}

if (WRITE) { await baselines(); await browser.close(); process.exit(0); }
for (const [id, w, h, touch, dpr] of SIZES) await session(id, w, h, touch, dpr, { room: id === "1366x768" });
await reduced();
await keyboard();
await edge();
await baselines();
await browser.close();
console.log(`door: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
