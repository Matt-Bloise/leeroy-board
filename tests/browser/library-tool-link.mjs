// Professions tool link in the Library: a plain link out to WoW Forever Tools (community site; it refuses framing, so no embed).
//   node library-tool-link.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh library-tool-link)   --out <dir> keeps screenshots
// Checks at 1366x768 and 390x844: the link exists on the professions shelf and on a profession page, points at the https URL, opens in a new tab with
// rel noopener noreferrer, has an accessible name that starts with its visible text, is reached by the keyboard (Tab) with a visible focus ring,
// is at least 44 px tall, and the page has no console errors or page errors. Every wait is bounded (WAIT ms) and a watchdog ends the run.
import fs from "node:fs";
import path from "node:path";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node library-tool-link.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const OUT = arg("--out");
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const WAIT = 8000, WATCHDOG = 90000;
const dog = setTimeout(() => { console.log(`FAIL watchdog: the run took longer than ${WATCHDOG / 1000} s`); process.exit(1); }, WATCHDOG); dog.unref();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const until = async (page, fn, arg0) => { try { await page.waitForFunction(fn, arg0, { timeout: WAIT }); return true; } catch (e) { return false; } };
async function open(page, hash) {
  await page.goto(url, { waitUntil: "load", timeout: WAIT * 2 }).catch(() => {});
  if (await until(page, () => { const b = document.querySelector("#nx-fr2-look"); return !!b && b.getBoundingClientRect().width > 0; })) await page.click("#nx-fr2-look", { timeout: WAIT }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate((h) => { location.hash = h; }, hash).catch(() => {});
}
const SEL = "#lib-main a.pro-tool-a";
async function check(page, label, where) {
  ok(`${label} ${where}: the Professions tool link is on screen`, await until(page, (s) => { const a = document.querySelector(s); return !!a && a.getBoundingClientRect().width > 0; }, SEL));
  const info = await page.evaluate((s) => {
    const a = document.querySelector(s); if (!a) return null;
    const r = a.getBoundingClientRect();
    return { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), aria: a.getAttribute("aria-label"), text: a.textContent, h: r.height, para: a.parentElement.textContent };
  }, SEL).catch(() => null);
  ok(`${label} ${where}: https URL to the professions page`, !!info && info.href === "https://wowforevertools.com/professions", JSON.stringify(info && info.href));
  ok(`${label} ${where}: opens in a new tab with noopener noreferrer`, !!info && info.target === "_blank" && /\bnoopener\b/.test(info.rel || "") && /\bnoreferrer\b/.test(info.rel || ""), JSON.stringify(info && [info.target, info.rel]));
  ok(`${label} ${where}: accessible name starts with the visible text and says new tab`, !!info && (info.aria || "").startsWith(info.text) && /new tab/i.test(info.aria), JSON.stringify(info && info.aria));
  ok(`${label} ${where}: touch target is at least 44 px tall`, !!info && info.h >= 44, String(info && info.h));
  ok(`${label} ${where}: the note says community site and that Blizzard may change recipes`, !!info && /community site/.test(info.para) && /Blizzard may change recipes before launch/.test(info.para));
  // keyboard: Tab from the top of the scene until the link has focus (bounded), then it must show a focus ring
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); const b = document.querySelector("#sheet-body"); if (b) b.scrollTop = 0; });
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate((s) => document.activeElement === document.querySelector(s), SEL).catch(() => false);
  }
  ok(`${label} ${where}: Tab reaches the link`, reached);
  const ring = await page.evaluate((s) => { const a = document.querySelector(s); if (!a || document.activeElement !== a) return null; const c = getComputedStyle(a); return { style: c.outlineStyle, w: parseFloat(c.outlineWidth) }; }, SEL).catch(() => null);
  ok(`${label} ${where}: the focus ring is visible`, !!ring && ring.style !== "none" && ring.w >= 2, JSON.stringify(ring));
}
const browser = stubbed(await pw.chromium.launch());
async function run(label, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block", reducedMotion: "reduce" });
  ctx.setDefaultTimeout(WAIT); const page = await ctx.newPage();
  const errors = [], outbound = [];
  await ctx.route(/wowforevertools\.com/, (r) => { outbound.push(r.request().url()); r.abort(); }); // the test must never reach the community site: only the href is asserted
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]|^Failed to load resource|^Refused to/.test(m.text()) && !/cloudflareinsights|beacon\.min\.js/i.test(m.text())) errors.push(m.text()); }); // report-only CSP notes, failed third-party loads (the runner has no network for fonts or the beacon) and the analytics beacon are exempt, as in layout-sweep
  await open(page, "library.c.professions");
  await check(page, label, "shelf");
  if (OUT) await page.screenshot({ path: path.join(OUT, `professions-tool-shelf-${label}.png`), timeout: WAIT * 2 }).catch(() => {});
  await open(page, "library.professions.alchemy");
  await check(page, label, "page");
  if (OUT) await page.screenshot({ path: path.join(OUT, `professions-tool-page-${label}.png`), timeout: WAIT * 2 }).catch(() => {});
  ok(`${label}: no console error and no page error`, errors.length === 0, errors.join(" | ").slice(0, 300));
  ok(`${label}: nothing requested wowforevertools.com`, outbound.length === 0, outbound.join(" "));
  await ctx.close();
}
try {
  await run("1366x768", { width: 1366, height: 768 }, false);
  await run("390x844", { width: 390, height: 844 }, true);
} finally { await browser.close().catch(() => {}); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
