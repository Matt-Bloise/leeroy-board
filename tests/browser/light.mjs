// Cinematic slice 4 (Light), Chromium at 1366x768 and 390x844. API answered from tests/fixtures/api-snapshot: zero Worker requests.
//   node light.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh light)   --out <dir> keeps the screenshots (used for tools oled-audit)
// A mouse or pen move always wins over tilt (a desktop); touch moves do not override a phone that shares motion.
// Checks: the lamp exists and is aria-hidden; it follows a synthetic pointer move and stays inside the viewport; the crests' light vector (--lx/--ly) moves with it;
// the lamp is absent under prefers-reduced-motion; the Calm switch removes it, is remembered (localStorage) and restores it; nothing throws.
// Every wait is bounded (WAIT ms) and a watchdog ends the run.
import fs from "node:fs";
import path from "node:path";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node light.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const OUT = arg("--out"); if (OUT) fs.mkdirSync(OUT, { recursive: true });
const WAIT = 8000, WATCHDOG = 120000;
const dog = setTimeout(() => { console.log(`FAIL watchdog: the run took longer than ${WATCHDOG / 1000} s`); process.exit(1); }, WATCHDOG); dog.unref();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const until = async (page, fn, a) => { try { await page.waitForFunction(fn, a, { timeout: WAIT }); return true; } catch (e) { return false; } };
async function open(page) {
  await page.goto(url, { waitUntil: "load", timeout: WAIT * 2 }).catch(() => {});
  if (await until(page, () => { const b = document.querySelector("#nx-fr2-look"); return !!b && b.getBoundingClientRect().width > 0; })) await page.click("#nx-fr2-look", { timeout: WAIT }).catch(() => {});
  await page.waitForTimeout(500);
  if (await page.evaluate(() => document.documentElement.classList.contains("scene-open"))) await page.click("#scene-close", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
}
// a pointer move the page sees on both desktop and touch emulation (page.mouse does not raise pointermove on a touch context)
const move = (page, x, y) => page.evaluate(([x, y]) => window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, pointerType: "mouse", bubbles: true })), [x, y]);
const lamp = (page) => page.evaluate(() => { const l = document.querySelector("#lamp"); if (!l) return null; const r = l.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, hidden: l.getAttribute("aria-hidden"), op: +getComputedStyle(l).opacity, w: innerWidth, h: innerHeight, lx: getComputedStyle(document.documentElement).getPropertyValue("--lx").trim() }; }).catch(() => null);

const browser = stubbed(await pw.chromium.launch());
async function run(label, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block" });
  ctx.setDefaultTimeout(WAIT); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await open(page);
  ok(`${label}: the lamp exists and is hidden from assistive tech`, await until(page, () => !!document.querySelector("#lamp")) && (await lamp(page)).hidden === "true");
  // phones that share motion: the light follows the tilt (js/tilt.js calibrates on the first 12 readings, then maps 18 deg of gamma / 14 deg of beta to -1..1); otherwise the pointer
  const centre = () => page.evaluate(() => { const r = document.querySelector("#lamp").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  let l1, l2;
  {
    const a = { x: Math.round(viewport.width * 0.2), y: Math.round(viewport.height * 0.25) }, b = { x: Math.round(viewport.width * 0.8), y: Math.round(viewport.height * 0.75) };
    await move(page, a.x, a.y);
    ok(label + ": the lamp settles at the first pointer position", await until(page, (p) => { const r = document.querySelector("#lamp").getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - p.x) < 6 && Math.abs(r.top + r.height / 2 - p.y) < 6; }, a));
    l1 = await lamp(page);
    await move(page, b.x, b.y);
    ok(label + ": the lamp follows a pointer move", await until(page, (p) => { const r = document.querySelector("#lamp").getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - p.x) < 6 && Math.abs(r.top + r.height / 2 - p.y) < 6; }, b));
    l2 = await lamp(page);
    ok(label + ": the crest light vector moved with the lamp", !!l1 && !!l2 && l1.lx !== l2.lx && l2.lx !== "", (l1 && l1.lx) + " -> " + (l2 && l2.lx));
  }
  // the tilt path is run on the phone viewport only, after the pointer path: js/tilt.js is switched on by hand here (its auto start gives up after 1.5 s without readings)
  const tiltOn = mobile && await page.evaluate(() => { try { return !!(window.BoardTilt && window.BoardTilt.enable() && window.BoardTilt.status().on); } catch (e) { return false; } });
  if (mobile) ok(label + ": tilt can be switched on", tiltOn);
  if (tiltOn) {
    const send = (g, b, n) => page.evaluate(([g, b, n]) => { for (let i = 0; i < n; i++) window.dispatchEvent(Object.assign(new Event("deviceorientation"), { gamma: g, beta: b })); }, [g, b, n]);
    await send(0, 40, 14); await page.waitForTimeout(250); const c0 = await centre();
    for (let i = 0; i < 12; i++) { await send(-18, 40, 3); await page.waitForTimeout(100); } // js/tilt.js treats readings older than 600 ms as a phone laid down, so keep them coming
    ok(label + ": the lamp follows the phone tilt", await until(page, (x0) => { const r = document.querySelector("#lamp").getBoundingClientRect(); return r.left + r.width / 2 < x0 - 40; }, c0[0]));
    l2 = await lamp(page);
    ok(label + ": the crest light vector moved with the tilt", !!l2 && l2.lx !== "" && l2.lx !== "0.0", String(l2 && l2.lx));
  }
  ok(label + ": the lamp stays inside the viewport and is quiet (opacity <= 1, centre on screen)", !!l2 && l2.cx >= 0 && l2.cx <= l2.w && l2.cy >= 0 && l2.cy <= l2.h && l2.op <= 1);
  await page.waitForTimeout(700);
  if (OUT) await page.screenshot({ path: path.join(OUT, "home-" + label + ".png") }).catch(() => {});
  // Calm switch
  const btn = await page.$("#light-calm");
  ok(`${label}: the Calm light switch exists`, !!btn);
  if (btn) {
    await until(page, () => !document.documentElement.classList.contains("scene-open") && !document.documentElement.classList.contains("scene-closing"));
    await page.waitForTimeout(600);
    await btn.dispatchEvent("click"); // the presence bar is still settling after the open/return transition, which fails Playwright's stability check; the handler is what is under test
    await page.waitForTimeout(700); if (OUT) await page.screenshot({ path: path.join(OUT, "home-" + label + "-calm.png") }).catch(() => {});
    ok(`${label}: Calm removes the lamp`, await until(page, () => !document.querySelector("#lamp") && document.documentElement.classList.contains("light-off")));
    ok(`${label}: Calm is remembered`, (await page.evaluate(() => localStorage.getItem("board-light-calm"))) === "1");
    await page.reload({ waitUntil: "load" }).catch(() => {}); await page.waitForTimeout(500);
    ok(`${label}: Calm survives a reload`, (await page.evaluate(() => !document.querySelector("#lamp"))));
    const b2 = await page.$("#light-calm"); if (b2) await b2.dispatchEvent("click");
    ok(`${label}: switching back restores the lamp`, await until(page, () => !!document.querySelector("#lamp")));
  }
  ok(`${label}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
  // reduced motion
  const rc = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block", reducedMotion: "reduce" });
  rc.setDefaultTimeout(WAIT); const rp = await rc.newPage(); await open(rp);
  await move(rp, 100, 100); await move(rp, 200, 200); await rp.waitForTimeout(300);
  ok(`${label}: no lamp under prefers-reduced-motion`, (await rp.evaluate(() => !document.querySelector("#lamp"))));
  await rc.close();
}
await run("1366x768", { width: 1366, height: 768 }, false);
await run("390x844", { width: 390, height: 844 }, true);
await browser.close();
console.log(`light: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
