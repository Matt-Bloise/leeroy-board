// Phone polish (friend-journey audit 2026-11-07, findings 2 to 6, 14, 16), Chromium at 390x844 (touch) and 1366x768. API answered from tests/fixtures/api-snapshot: zero Worker requests.
//   node mobile-polish.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES; tools/local-browser.sh mobile-polish)
// Checks: "Just take a look" closes the entry card in one tap; the header is not clipped and every control is 44 px or more on a phone; the Light button has a visible label;
// party names never break inside a word (390 and 320 px); The five lists the real party before the sample, which waits closed under "See an example";
// Sign-ups shows no "Change my answer" until a name is picked; the footer links are 44 px tall. Every wait is bounded (WAIT ms) and a watchdog ends the run.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node mobile-polish.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const WAIT = 8000, WATCHDOG = 120000;
const dog = setTimeout(() => { console.log(`FAIL watchdog: the run took longer than ${WATCHDOG / 1000} s`); process.exit(1); }, WATCHDOG); dog.unref();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const url = pageUrl(BASE, { params: { preview: "1" } });
const until = async (page, fn, a) => { try { await page.waitForFunction(fn, a, { timeout: WAIT }); return true; } catch (e) { return false; } };
const browser = stubbed(await pw.chromium.launch());
async function run(label, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block" });
  ctx.setDefaultTimeout(WAIT); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(url, { waitUntil: "load", timeout: WAIT * 2 }).catch(() => {});
  const look = await until(page, () => { const b = document.querySelector("#nx-fr2-look"); return !!b && b.getBoundingClientRect().width > 0; });
  ok(`${label}: the entry card offers "Just take a look"`, look);
  if (look) await page.click("#nx-fr2-look", { timeout: WAIT }).catch(() => {});
  ok(`${label}: one tap on it closes the entry card and shows the wall`, await until(page, () => !document.documentElement.classList.contains("scene-open") && !document.querySelector("#nx-fr2")));
  await until(page, () => !!document.querySelector("#top h1") && document.querySelector("#top h1").getBoundingClientRect().width > 0);
  const hdr = await page.evaluate(() => [...document.querySelectorAll("#top h1, #top .presence button")].filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "none")
    .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.tagName, l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), fs: parseFloat(getComputedStyle(e).fontSize) }; }));
  const clipped = hdr.filter((x) => x.l < 0 || x.r > viewport.width + 1);
  ok(`${label}: nothing in the header is clipped by the screen edge`, hdr.length > 3 && !clipped.length, JSON.stringify(clipped));
  if (mobile) {
    const small = hdr.filter((x) => x.id !== "H1" && x.h < 44);
    ok(`${label}: every header control is at least 44 px tall`, !small.length, JSON.stringify(small));
    const light = hdr.find((x) => x.id === "light-calm"), txt = await page.evaluate(() => (document.querySelector("#light-calm") || {}).textContent || "");
    ok(`${label}: the Light button has a visible label`, !!light && light.fs >= 12 && /Light/.test(txt), JSON.stringify(light));
  }
  const foot = await page.evaluate(() => [...document.querySelectorAll("#legal-foot a")].map((a) => Math.round(a.getBoundingClientRect().height)));
  ok(`${label}: the footer links are 44 px tall`, foot.length >= 3 && foot.every((h) => h >= 44), foot.join(","));
  ok(`${label}: no horizontal overflow`, (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
  if (mobile) for (const w of [390, 320]) {
    await page.setViewportSize({ width: w, height: 844 }); await page.waitForTimeout(250);
    ok(`${label} ${w}px: the party names are on screen to measure`, await until(page, () => { const b = document.querySelector(".t-five .med b"); return !!b && b.getBoundingClientRect().width > 0; }));
    const broken = await page.evaluate(() => [...document.querySelectorAll(".t-five .med b")].filter((b) => {
      const r = document.createRange(), words = (b.textContent || "").trim().split(/\s+/); let lines = new Set();
      r.selectNodeContents(b); for (const q of r.getClientRects()) lines.add(Math.round(q.top));
      const widest = Math.max(...words.map((x) => { const s = document.createElement("span"); s.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:" + getComputedStyle(b).font; s.textContent = x; document.body.appendChild(s); const wd = s.getBoundingClientRect().width; s.remove(); return wd; }));
      return lines.size > words.length || widest > b.getBoundingClientRect().width + 1;
    }).map((b) => b.textContent));
    ok(`${label} ${w}px: party names are not broken inside a word`, !broken.length, broken.join(" | "));
  }
  await page.setViewportSize(viewport);
  // The five: real party first, sample closed behind "See an example"
  await page.evaluate(() => window.__boardKit && window.__boardKit.goScene("five"));
  const sample = await until(page, () => { const b = document.querySelector("#ps-sample"); return !!b && !b.hidden && !!b.querySelector("details"); });
  ok(`${label}: the sample guild waits behind "See an example"`, sample);
  if (sample) {
    const s = await page.evaluate(() => { const b = document.querySelector("#ps-sample"), d = b.querySelector("details"), v = document.querySelector("#ps-views");
      return { open: d.open, sum: d.querySelector("summary").textContent, after: !v || !!(v.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) }; });
    ok(`${label}: it is closed and sits after "Who plays what"`, !s.open && s.sum === "See an example" && s.after, JSON.stringify(s));
  }
  // Sign-ups: no "Change my answer" without a name
  await page.evaluate(() => window.__boardKit && window.__boardKit.goScene("signups"));
  await until(page, () => !!document.querySelector("#panel-signups .jr-core"));
  const acts = await page.evaluate(() => (document.querySelector("#panel-signups .jr-acts") || { textContent: "" }).textContent);
  ok(`${label}: Sign-ups hides "Change my answer" until a name is picked`, !/Change my answer/.test(acts), acts);
  ok(`${label}: no page errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}
await run("phone 390x844", { width: 390, height: 844 }, true);
await run("desktop 1366x768", { width: 1366, height: 768 }, false);
await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
