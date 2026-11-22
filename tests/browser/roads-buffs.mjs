// Cinematic slice 6 (Buffs and roads), Chromium at 1366x768 and 390x844. API answered from tests/fixtures/api-snapshot: zero Worker requests.
//   node roads-buffs.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh roads-buffs)   --out <dir> keeps the screenshots
// Roads: every character pin is a keyboard control; hover/focus/tap opens one tip that sits inside the viewport and covers no pin or name card;
//   Esc closes it (and does not close the scene); the old side panel is hidden; name cards are dark (OLED).
// Buffs: level marks are real buttons with the lib-tool class and a 44 px target; the slider is 44 px high; "who buffs whom" is listed and follows the level;
//   a level change ticks the haptic only when Haptics are on (default off).
// Every wait is bounded (WAIT ms) and a watchdog ends the run. Assertions are final states, never animation frame counts.
import fs from "node:fs";
import path from "node:path";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const { AxeBuilder } = await import("@axe-core/playwright").catch(() => { console.error("@axe-core/playwright not found; run npm install in tests/"); process.exit(2); });
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node roads-buffs.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const OUT = arg("--out");
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const WAIT = 8000, WATCHDOG = 150000;
const dog = setTimeout(() => { console.log(`FAIL watchdog: the run took longer than ${WATCHDOG / 1000} s`); process.exit(1); }, WATCHDOG); dog.unref();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const until = async (page, fn, arg0) => { try { await page.waitForFunction(fn, arg0, { timeout: WAIT }); return true; } catch (e) { return false; } };
const lum = (rgb) => { const m = (rgb.match(/[\d.]+/g) || []).slice(0, 3).map((v) => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };

async function open(page, hash) {
  await page.goto(url, { waitUntil: "load", timeout: WAIT * 2 }).catch(() => {});
  if (await until(page, () => { const b = document.querySelector("#nx-fr2-look"); return !!b && b.getBoundingClientRect().width > 0; })) await page.click("#nx-fr2-look", { timeout: WAIT }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate((h) => { location.hash = h; }, hash).catch(() => {});
}
const tipState = (page) => page.evaluate(() => {
  const t = document.getElementById("road-card"); if (!t || t.hidden) return null;
  const r = t.getBoundingClientRect(), hits = [];
  document.querySelectorAll("#map .map-pin, #map .pin-banner, #map .map-town").forEach((n) => { const b = n.getBoundingClientRect(); if (b.width && b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom) hits.push(n.getAttribute("class")); });
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight, hits, text: t.textContent, side: t.dataset.side };
}).catch(() => null);

// Helpers for the tip checks. On desktop a #sheet-body scroll hides a tip opened by hover or tap (scenes/place.js); a tip opened by keyboard focus moves with its zone instead (checked below).
// Escape on a hidden tip closes the SCENE, so Escape is pressed only while the tip is visible (except in the scroll check, which is about exactly that), and every pin first checks
// the scene is still open (one failure stays one failure, no cascade).
const tipVisible = (page) => page.evaluate(() => { const t = document.getElementById("road-card"); return !!t && !t.hidden; }).catch(() => false);
const roadsUp = (page) => page.evaluate(() => { const p = document.getElementById("panel-roads"); return !!p && !p.hidden && location.hash === "#roads"; }).catch(() => false);
// Resolves when #sheet-body scrollTop has been equal across two consecutive animation frames (bounded at 60 frames).
const settle = (page) => page.evaluate(() => new Promise((res) => { const b = document.getElementById("sheet-body"); let last = -1, same = 0, n = 0; const tick = () => { const s = b ? b.scrollTop : 0; same = s === last ? same + 1 : 0; last = s; if (same >= 1 || ++n > 60) res(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })).catch(() => {});
// Focus a zone, let any scroll from the focus settle, and when that scroll hid the tip, focus again once (the scroll position is now stable).
async function focusZone(page, i) {
  const f = () => page.evaluate((k) => document.querySelectorAll("#map .road-g[data-zone]")[k].focus(), i);
  await f(); await until(page, () => { const t = document.getElementById("road-card"); return !!t && !t.hidden; }); await settle(page);
  if (!(await tipVisible(page))) { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await f(); await until(page, () => { const t = document.getElementById("road-card"); return !!t && !t.hidden; }); await settle(page); }
}
const tipGone = (page) => until(page, () => { const t = document.getElementById("road-card"); return !t || t.hidden; });
// Diagnostics for the scroll check (evidence only, never asserted): focus and geometry when the scroll is dispatched, and the call stack of every write that hides the tip after it.
const scrollDiagArm = (page) => page.evaluate(() => {
  const c = document.getElementById("road-card"), d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden"), t = document.querySelectorAll("#map .road-g[data-zone]")[2], a = document.activeElement, K = window.__boardKit;
  if (c && d && !Object.getOwnPropertyDescriptor(c, "hidden")) { window.__tipHid = []; Object.defineProperty(c, "hidden", { configurable: true, get() { return d.get.call(this); }, set(v) { if (v && !d.get.call(this)) window.__tipHid.push(String(new Error().stack).split("\n").slice(2, 8).map((s) => s.trim()).join(" < ")); d.set.call(this, v); } }); }
  const rr = (e) => { if (!e) return null; const q = e.getBoundingClientRect(); return [q.left, q.top, q.right, q.bottom].map(Math.round); };
  const vb = K && K.place && K.place.visibleBounds ? K.place.visibleBounds(0) : null;
  return { tipShown: !!c && !c.hidden, activeIsZone: !!t && a === t, active: a ? `${a.tagName}.${a.getAttribute("class") || ""}` : null, zone: rr(t), vb: vb ? [vb.x, vb.y, vb.r, vb.b].map(Math.round) : null, hasFocus: document.hasFocus(), coarse: innerWidth < 700 || matchMedia("(pointer: coarse)").matches };
}).catch((e) => ({ error: String(e.message).slice(0, 80) }));
const scrollDiagRead = (page) => page.evaluate(() => window.__tipHid || null).catch(() => null);

// Diagnostics for a failed pin hover/tap check: says why (tip element count, box, computed style, page visibility, the point used, viewport, scroll, what is under the pointer). Evidence only; never asserted.
const hoverDiag = (page, box, shown) => page.evaluate(([b, sh]) => {
  const d = (e) => (e ? e.tagName + (e.id ? "#" + e.id : "") + "." + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className).slice(0, 40) : null);
  const tips = document.querySelectorAll("#road-card"), c = tips[0], r = c && c.getBoundingClientRect(), cs = c && getComputedStyle(c), m = document.querySelector("#map"), mr = m && m.getBoundingClientRect(), under = document.elementFromPoint(b.x, b.y);
  return { shownByWait: sh, tipMatches: tips.length, tipBox: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null, tipHiddenAttr: c ? c.hidden : null, display: cs ? cs.display : null, visibility: cs ? cs.visibility : null, opacity: cs ? cs.opacity : null, documentHidden: document.hidden, visibilityState: document.visibilityState, hasFocus: document.hasFocus(), hoverXY: [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10], vp: [innerWidth, innerHeight], scroll: [Math.round(scrollX), Math.round(scrollY)], under: d(under), underInsidePin: !!(under && under.closest && under.closest(".map-pin")), hash: location.hash, map: mr ? [Math.round(mr.left), Math.round(mr.top), Math.round(mr.width), Math.round(mr.height)] : null, hoverMedia: matchMedia("(hover: hover)").matches };
}, [box, shown]).catch((e) => ({ diagError: String(e && e.message).slice(0, 80) }));

const browser = stubbed(await pw.chromium.launch());
async function run(label, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block", reducedMotion: "reduce" });
  ctx.setDefaultTimeout(WAIT); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.addInitScript(() => { try { localStorage.setItem("board-journey", "everything"); } catch (e) {} window.__vib = []; Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p) => { window.__vib.push(Array.isArray(p) ? p.slice() : [p]); return true; } }); });

  // ---- Roads
  await open(page, "roads");
  ok(`${label}: the Roads scene opens with a map and pins`, await until(page, () => document.querySelectorAll("#map .map-pin").length >= 3 && !document.getElementById("panel-roads").hidden && document.querySelector("#map .map-pin").getBoundingClientRect().width > 4));
  ok(`${label}: the road card module is ready`, await until(page, () => !!document.getElementById("road-card") && !document.querySelector("#map .map-pin title")));
  await page.waitForTimeout(700); // banners are laid out in an animation frame after the scene opens
  const pins = await page.evaluate(() => [...document.querySelectorAll("#map .map-pin")].map((p) => ({ title: p.querySelectorAll("title").length }))).catch(() => []);
  const zones = await page.evaluate(() => [...document.querySelectorAll("#map .road-g[data-zone]")].map((g) => ({ tab: g.getAttribute("tabindex"), role: g.getAttribute("role"), label: g.getAttribute("aria-label") }))).catch(() => []);
  ok(`${label}: every zone is a keyboard control with a name`, zones.length === 3 && zones.every((z) => z.tab === "0" && z.role === "button" && /^Zoom to .+/.test(z.label || "")), JSON.stringify(zones));
  ok(`${label}: no native title tooltips are left on the pins`, pins.length >= 3 && pins.every((p) => p.title === 0));
  // keyboard: focus opens the tip
  await page.keyboard.press("Tab"); // keyboard modality, as a keyboard user has
  await focusZone(page, 0);
  ok(`${label}: focusing a zone opens its tip`, await tipVisible(page));
  let ts = await tipState(page);
  ok(`${label}: the tip sits inside the viewport`, !!ts && ts.l >= 0 && ts.t >= 0 && ts.r <= ts.w && ts.b <= ts.h, JSON.stringify(ts));
  ok(`${label}: the tip covers no pin or name card`, !!ts && ts.hits.length === 0, JSON.stringify(ts && ts.hits));
  ok(`${label}: the card says the road to Orgrimmar`, !!ts && /To Orgrimmar/.test(ts.text), ts && ts.text);
  if (OUT) await page.screenshot({ path: path.join(OUT, `roads-tip-${label}.png`), timeout: WAIT * 2 }).catch(() => {});
  const panelShown = await page.evaluate(() => { const p = document.querySelector("#map .road-panel"); return !!p && getComputedStyle(p).display !== "none"; }).catch(() => true);
  ok(`${label}: the old side panel that covered the map is hidden`, panelShown === false);
  // Esc closes the tip but not the scene
  // Escape is pressed only while the tip is visible (a hidden tip would let Escape close the scene).
  if (await tipVisible(page)) await page.keyboard.press("Escape");
  ok(`${label}: Esc closes the tip`, await tipGone(page));
  ok(`${label}: Esc on a tip leaves the scene open`, await roadsUp(page));
  // blur closes
  if (!(await roadsUp(page))) await open(page, "roads");
  await focusZone(page, 1);
  await page.evaluate(() => document.activeElement.blur());
  ok(`${label}: blur closes the tip`, await tipGone(page));
  // A scroll of the sheet while a zone holds keyboard focus (what a focus() scroll does at 768 px height), then Esc. The tip opened by focus stays with its zone through the scroll
  // (scenes/place.js re-places it), so this Esc closes the tip, not the scene. It is pressed whatever the tip's state: a tip lost to the scroll would let it close the scene, which is the bug.
  // The sheet really scrolls by 40 px when it can; the dispatched event covers a size where it cannot.
  if (!(await roadsUp(page))) await open(page, "roads");
  await focusZone(page, 2);
  const armed = await scrollDiagArm(page);
  const moved = await page.evaluate(() => { const b = document.getElementById("sheet-body"); if (!b) return null; const before = b.scrollTop, max = b.scrollHeight - b.clientHeight; b.scrollTop = before + (before + 40 <= max ? 40 : -40); b.dispatchEvent(new Event("scroll")); return { before, after: b.scrollTop, max }; }).catch(() => null);
  await page.waitForTimeout(150);
  const keptOpen = await tipVisible(page);
  ok(`${label}: a scroll while a zone has focus keeps its tip open`, keptOpen, JSON.stringify(moved) + (keptOpen ? "" : " DIAG(evidence for a CI-only failure, nothing asserted) " + JSON.stringify({ atScroll: armed, hiddenBy: await scrollDiagRead(page) })));
  ts = await tipState(page);
  ok(`${label}: after that scroll the tip is inside the viewport and covers no pin or name card`, !!ts && ts.l >= 0 && ts.t >= 0 && ts.r <= ts.w && ts.b <= ts.h && ts.hits.length === 0, JSON.stringify({ moved, ts }));
  await page.keyboard.press("Escape");
  ok(`${label}: Esc after that scroll closes the tip`, await tipGone(page));
  await page.waitForTimeout(250);
  ok(`${label}: Esc after that scroll leaves the scene open`, await roadsUp(page));
  if (!(await roadsUp(page))) { await open(page, "roads"); await until(page, () => document.querySelectorAll("#map .map-pin").length >= 3); await page.waitForTimeout(700); }
  // pointer: mouse hover on desktop, tap on touch, every pin
  for (let i = 0; i < pins.length; i++) {
    // One missed tip must stay one failure: when the scene is gone, count it against this pin and re-open it for the next.
    const sceneUp = await roadsUp(page);
    ok(`${label}: pin ${i + 1}: the Roads scene is still open before the pointer check`, sceneUp, `hash=${await page.evaluate(() => location.hash).catch(() => "?")}`);
    if (!sceneUp) { await open(page, "roads"); await until(page, () => document.querySelectorAll("#map .map-pin").length >= 3); await page.waitForTimeout(700); }
    // Aim at the pin's computed centre only once the map layout has settled: the same box on two consecutive frames AND the point hits this pin (CI evidence: the centre read before layout settled landed on path.map-land, so no hover reached the pin). Falls back to the last read after 4 s.
    const box = await page.evaluate((k) => new Promise((res) => { const read = () => { const p = document.querySelectorAll("#map .map-pin")[k]; if (!p) return null; const r = p.querySelector(".pin-body").getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, on: !!(hit && hit.closest && hit.closest(".map-pin") === p) }; }; let prev = null, same = 0; const t0 = performance.now(); const tick = () => { const b = read(); if (!b) return res(null); same = prev && Math.abs(prev.x - b.x) < 0.5 && Math.abs(prev.y - b.y) < 0.5 ? same + 1 : 0; prev = b; if ((same >= 2 && b.on) || performance.now() - t0 > 4000) return res({ x: b.x, y: b.y }); requestAnimationFrame(tick); }; requestAnimationFrame(tick); }), i).catch(() => null);
    if (!box) continue;
    // The page keeps hover quiet after a scene opens until the pointer really moves (scenes/place.js: Q); the first move only records where the pointer rests. A single mouse.move from an unmoved pointer is therefore one event and never counts as a move.
    // Travel there in steps (several pointermove events, the last more than 4 px from the first), as a hand does; one wiggle on the pin is the fallback.
    const tipUp = () => until(page, () => { const t = document.getElementById("road-card"); return !!t && !t.hidden; });
    if (mobile) await page.touchscreen.tap(box.x, box.y); else await page.mouse.move(box.x, box.y, { steps: 6 });
    let shown = await tipUp();
    if (!shown && !mobile) { await page.mouse.move(box.x + 6, box.y + 3, { steps: 3 }); await page.mouse.move(box.x, box.y, { steps: 3 }); shown = await tipUp(); }
    ts = await tipState(page);
    const pass = shown && !!ts && ts.l >= 0 && ts.t >= 0 && ts.r <= ts.w && ts.b <= ts.h && ts.hits.length === 0;
    ok(`${label}: pin ${i + 1} ${mobile ? "tap" : "hover"} opens a tip that is inside the view and covers nothing`, pass, JSON.stringify(ts) + (pass ? "" : " DIAG(evidence for a CI-only flake, nothing asserted) " + JSON.stringify(await hoverDiag(page, box, shown))));
    if (await tipVisible(page)) await page.keyboard.press("Escape");
    await tipGone(page);
  }
  const axeRoads = await new AxeBuilder({ page }).include("#panel-roads").analyze().then((r) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}:${v.nodes[0].target}`)).catch((e) => [String(e.message).slice(0, 80)]);
  ok(`${label}: axe finds no serious or critical violation on the Roads scene`, axeRoads.length === 0, axeRoads.join(" | "));
  const card = await page.evaluate(() => { const c = document.querySelector("#map .pin-banner:not(.route-plate) .banner-cloth"); return c ? getComputedStyle(c).fill : null; }).catch(() => null);
  ok(`${label}: name cards are dark (OLED: luminance at most 0.05)`, !!card && lum(card) <= 0.05, String(card));
  if (OUT) await page.screenshot({ path: path.join(OUT, `roads-${label}.png`), timeout: WAIT * 2 }).catch(() => {});

  // ---- Buffs
  await open(page, "buffs");
  ok(`${label}: the Buffs scene opens with the level controls`, await until(page, () => !!document.querySelector("#deep-level") && document.querySelectorAll(".deep-marks button").length >= 3 && document.querySelector(".deep-marks button").getBoundingClientRect().height > 4));
  const marks = await page.evaluate(() => [...document.querySelectorAll(".deep-marks button")].map((b) => { const r = b.getBoundingClientRect(); return { tag: b.tagName, lib: b.classList.contains("lib-tool"), w: b.offsetWidth, h: b.offsetHeight, name: b.getAttribute("aria-label") }; })).catch(() => []);
  ok(`${label}: level marks are real buttons that keep the lib-tool class`, marks.length >= 3 && marks.every((m) => m.tag === "BUTTON" && m.lib && /^Level \d+$/.test(m.name || "")), JSON.stringify(marks));
  ok(`${label}: level marks are at least 44 x 44`, marks.every((m) => m.w >= 44 && m.h >= 44), JSON.stringify(marks.map((m) => [Math.round(m.w), Math.round(m.h)])));
  const sh = await page.evaluate(() => document.querySelector("#deep-level").offsetHeight).catch(() => 0);
  ok(`${label}: the level slider is at least 44 high`, sh >= 44, String(sh));
  const axeBuffs = await new AxeBuilder({ page }).include("#panel-buffs").analyze().then((r) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}:${v.nodes[0].target}`)).catch((e) => [String(e.message).slice(0, 80)]);
  ok(`${label}: axe finds no serious or critical violation on the Buffs scene`, axeBuffs.length === 0, axeBuffs.join(" | "));
  ok(`${label}: "who buffs whom" is listed with a heading`, await until(page, () => !!document.querySelector("#buffs-deep .bw-glance h4") && document.querySelectorAll("#buffs-deep .bw-row").length >= 1));
  const rows60 = await page.evaluate(() => document.querySelectorAll("#buffs-deep .bw-row").length).catch(() => 0);
  const everyone = await page.evaluate(() => [...document.querySelectorAll("#buffs-deep .bw-to")].some((n) => n.textContent === "everyone")).catch(() => false);
  ok(`${label}: at least one giver buffs everyone`, everyone);
  // default: haptics off, so a level change makes no pulse
  await page.click(".deep-marks button[aria-label='Level 20']", { timeout: WAIT }).catch(() => {});
  ok(`${label}: choosing Level 20 changes the level and the list`, await until(page, () => document.querySelector("#deep-l").textContent === "20" && /level 20/.test((document.querySelector("#buffs-deep .bw-glance h4") || {}).textContent || "")));
  const pressed = await page.evaluate(() => document.querySelector(".deep-marks button[aria-pressed='true']").getAttribute("aria-label")).catch(() => "");
  ok(`${label}: the pressed mark follows the level`, pressed === "Level 20", pressed);
  const rows20 = await page.evaluate(() => document.querySelectorAll("#buffs-deep .bw-row").length).catch(() => -1);
  ok(`${label}: the list is rebuilt for the level (one block, no duplicate)`, rows20 >= 0 && (await page.evaluate(() => document.querySelectorAll("#buffs-deep .bw-glance").length)) === 1, `${rows60} -> ${rows20}`);
  await page.waitForTimeout(400);
  ok(`${label}: haptics are off by default: no pulse for a level change`, (await page.evaluate(() => window.__vib.length).catch(() => -1)) === 0);
  // switched on (as the Sensory Haptics toggle does): a mark taps, a step ticks lighter
  await page.evaluate(() => window.BoardHaptics.set(true, true));
  await page.click(".deep-marks button[aria-label='Level 40']", { timeout: WAIT }).catch(() => {});
  ok(`${label}: with haptics on, landing on a mark taps (8 ms select)`, await until(page, () => window.__vib.some((p) => p.length === 1 && p[0] === 8)), JSON.stringify(await page.evaluate(() => window.__vib).catch(() => null)));
  await page.focus("#deep-level").catch(() => {});
  await page.evaluate(() => { window.__vib.length = 0; });
  await page.keyboard.press("ArrowRight");
  ok(`${label}: with haptics on, a one-step change ticks lighter (5 ms)`, await until(page, () => window.__vib.some((p) => p.length === 1 && p[0] === 5)), JSON.stringify(await page.evaluate(() => window.__vib).catch(() => null)));
  if (OUT) await page.screenshot({ path: path.join(OUT, `buffs-${label}.png`), timeout: WAIT * 2 }).catch(() => {});
  ok(`${label}: no page error`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}
try {
  await run("1366x768", { width: 1366, height: 768 }, false);
  await run("390x844", { width: 390, height: 844 }, true);
} finally { await browser.close().catch(() => {}); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
