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
  await page.evaluate(() => document.querySelector("#map .road-g[data-zone]").focus());
  ok(`${label}: focusing a zone opens its tip`, await until(page, () => { const t = document.getElementById("road-card"); return !!t && !t.hidden; }));
  let ts = await tipState(page);
  ok(`${label}: the tip sits inside the viewport`, !!ts && ts.l >= 0 && ts.t >= 0 && ts.r <= ts.w && ts.b <= ts.h, JSON.stringify(ts));
  ok(`${label}: the tip covers no pin or name card`, !!ts && ts.hits.length === 0, JSON.stringify(ts && ts.hits));
  ok(`${label}: the card says the road to Orgrimmar`, !!ts && /To Orgrimmar/.test(ts.text), ts && ts.text);
  if (OUT) await page.screenshot({ path: path.join(OUT, `roads-tip-${label}.png`), timeout: WAIT * 2 }).catch(() => {});
  const panelShown = await page.evaluate(() => { const p = document.querySelector("#map .road-panel"); return !!p && getComputedStyle(p).display !== "none"; }).catch(() => true);
  ok(`${label}: the old side panel that covered the map is hidden`, panelShown === false);
  // Esc closes the tip but not the scene
  await page.keyboard.press("Escape");
  ok(`${label}: Esc closes the tip`, await until(page, () => { const t = document.getElementById("road-card"); return !t || t.hidden; }));
  const sceneOpen = await page.evaluate(() => !document.getElementById("panel-roads").hidden && location.hash === "#roads").catch(() => false);
  ok(`${label}: Esc on a tip leaves the scene open`, sceneOpen);
  // blur closes
  await page.evaluate(() => document.querySelectorAll("#map .road-g[data-zone]")[1].focus());
  await until(page, () => { const t = document.getElementById("road-card"); return !!t && !t.hidden; });
  await page.evaluate(() => document.activeElement.blur());
  ok(`${label}: blur closes the tip`, await until(page, () => { const t = document.getElementById("road-card"); return !t || t.hidden; }));
  // pointer: mouse hover on desktop, tap on touch, every pin
  for (let i = 0; i < pins.length; i++) {
    const box = await page.evaluate((k) => { const r = document.querySelectorAll("#map .map-pin")[k].querySelector(".pin-body").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i).catch(() => null);
    if (!box) continue;
    if (mobile) await page.touchscreen.tap(box.x, box.y); else await page.mouse.move(box.x, box.y);
    const shown = await until(page, () => { const t = document.getElementById("road-card"); return !!t && !t.hidden; });
    ts = await tipState(page);
    ok(`${label}: pin ${i + 1} ${mobile ? "tap" : "hover"} opens a tip that is inside the view and covers nothing`, shown && !!ts && ts.l >= 0 && ts.t >= 0 && ts.r <= ts.w && ts.b <= ts.h && ts.hits.length === 0, JSON.stringify(ts));
    await page.keyboard.press("Escape");
    await until(page, () => { const t = document.getElementById("road-card"); return !t || t.hidden; });
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
