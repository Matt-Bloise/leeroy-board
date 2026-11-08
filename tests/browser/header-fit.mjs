// Header fit check: the scene header must show its title on one line with room to read it, never under a control, in a readable colour, and Settings must not look like the Room eye.
//   node header-fit.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// No AI call, nothing sent. Viewports: 320x568, 390x844, 768x1024, 1366x768. Per viewport: first-run gate title colour is light, then after "Just take a look" the title is one line,
// at least 60 px wide, does not overlap the close button, and has a light colour; on a phone the last card clears the floating coin (bottom padding of 56 px, or the body ends above the coin: css/shell.css); under 1200 px a visible Settings button draws a gear.
// Exit 0 when every check passes, 1 otherwise.
import { pageUrl, originOf, dirOf } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node header-fit.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const SIZES = [["320x568", { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true }], ["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["768x1024", { viewport: { width: 768, height: 1024 } }], ["960x540", { viewport: { width: 960, height: 540 } }], ["1024x768", { viewport: { width: 1024, height: 768 } }], ["1280x720", { viewport: { width: 1280, height: 720 } }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const url = pageUrl(BASE, { params: { preview: "1" } });
const lum = (c) => { const m = (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
const browser = stubbed(await pw.chromium.launch());
try {
  for (const [tag, opts] of SIZES) {
    const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" }), page = await ctx.newPage(), t = `[${tag}]`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    const gate = await page.evaluate(() => getComputedStyle(document.querySelector("#sheet-title")).color);
    ok(`${t} first-run header title is light`, lum(gate) > 0.5, gate);
    await page.locator("#nx-fr2-look").click().catch(() => {});
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => {
      const el = document.querySelector("#sheet-title"), r = el.getBoundingClientRect(), cs = getComputedStyle(el), fs = parseFloat(cs.fontSize);
      const cl = document.querySelector("#scene-close").getBoundingClientRect();
      const st = document.querySelector("#scene-settings"), sr = st.getBoundingClientRect(), sv = !!(sr.width && sr.height) && getComputedStyle(st).visibility !== "hidden";
      return { w: r.width, h: r.height, fs, color: cs.color, overlapClose: !(r.right <= cl.left || r.left >= cl.right || r.bottom <= cl.top || r.top >= cl.bottom), pb: parseFloat(getComputedStyle(document.querySelector("#sheet-body")).paddingBottom), coinGap: (() => { const c = document.querySelector("#bb-coin"), b = document.querySelector("#sheet-body"); if (!c || getComputedStyle(c).display === "none" || getComputedStyle(c).visibility === "hidden") return null; return c.getBoundingClientRect().top - b.getBoundingClientRect().bottom; })(), settingsVisible: sv, gear: getComputedStyle(st, "::before").content };
    });
    ok(`${t} title is one line`, m.h <= m.fs * 1.7, `h ${m.h.toFixed(0)} font ${m.fs}`);
    ok(`${t} title is at least 60 px wide`, m.w >= 60, `w ${m.w.toFixed(0)}`);
    ok(`${t} title does not overlap the close button`, !m.overlapClose);
    ok(`${t} title colour is light on the oak header`, lum(m.color) > 0.5, m.color);
    if (opts.viewport.width < 700) ok(`${t} last card clears the coin (padding-bottom >= 56, or the body ends above the coin)`, m.pb >= 56 || (m.coinGap !== null && m.coinGap >= -1), `pb ${m.pb}, coin top minus body bottom ${m.coinGap}`);
    if (m.settingsVisible && opts.viewport.width < 1200) ok(`${t} Settings draws a gear`, /2699/i.test(JSON.stringify(m.gear)) || m.gear.includes("\u2699"), m.gear);
    // laptop sizes: the longest scene title ("Who buffs whom") must not be truncated or push the close button out of the sheet or under another element
    await page.evaluate(() => { location.hash = "buffs"; }); await page.waitForTimeout(1200);
    const q = await page.evaluate(() => {
      const el = document.querySelector("#sheet-title"), cl = document.querySelector("#scene-close"), r = cl.getBoundingClientRect(), sh = document.querySelector(".sheet").getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { trunc: el.scrollWidth > el.clientWidth + 1, inView: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, inSheet: r.right <= sh.right + 1, free: !!top && (top === cl || cl.contains(top)), hs: document.documentElement.scrollWidth <= innerWidth + 1 };
    });
    if (opts.viewport.width >= 960) ok(`${t} buffs: title not truncated`, !q.trunc); /* phones and tablets ellipsize by design */
    ok(`${t} buffs: close button inside the viewport and the sheet`, q.inView && q.inSheet);
    ok(`${t} buffs: close button is not covered`, q.free);
    ok(`${t} buffs: no horizontal page scroll`, q.hs);
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`header-fit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
