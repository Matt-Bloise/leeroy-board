// First screen check (flag firstrun.v2): purpose, one primary button, one quiet link, no list of names, against a deployed board or a local static server.
//   node firstrun.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   optional: --shots <dir> (default os tmpdir)
// No AI call, nothing sent. Viewports: 390x844 (touch), 1080x1920, 1366x768. Per viewport: heading and line present, no name button visible,
// the primary button is inside the viewport with the page scrolled to 0, the quiet link is visible, screenshot saved; "Just take a look" opens the name grid
// (five names); a Discord Activity query (?frame_id=) changes the primary label to "Show me my group". Exit 0 when every check passes, 1 otherwise.
import os from "node:os";
import path from "node:path";
import { pageUrl, originOf, dirOf } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node firstrun.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
const SHOTS = arg("--shots") || os.tmpdir();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const SIZES = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1080x1920", { viewport: { width: 1080, height: 1920 } }], ["1366x768", { viewport: { width: 1366, height: 768 } }]];
const url = (q) => { const u = new URL(pageUrl(BASE, { params: { preview: "1" } })); for (const [k, v] of new URLSearchParams(q || "")) u.searchParams.set(k, v); return u.href; };

async function open(browser, opts, q) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" }), page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url(q), { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-go", { state: "visible", timeout: 20000 }).catch(() => {});
  return { ctx, page, errors };
}
const visibleNames = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".tn-name")).filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== "hidden").length);

const browser = stubbed(await pw.chromium.launch());
try {
  for (const [tag, opts] of SIZES) {
    const { ctx, page, errors } = await open(browser, opts);
    const t = `[${tag}]`;
    ok(`${t} heading`, (await page.locator("#nx-fr2-h").innerText().catch(() => "")) === "Your guild's companion for WoW Forever.");
    ok(`${t} line`, /Pick your name to see your build, the party's, and the next dated thing\./.test(await page.locator(".nx-fr2-line").innerText().catch(() => "")));
    ok(`${t} primary label`, (await page.locator("#nx-fr2-go").innerText().catch(() => "")) === "Open the Discord card");
    ok(`${t} quiet link`, (await page.locator("#nx-fr2-look").innerText().catch(() => "")) === "Just take a look");
    ok(`${t} no names`, (await visibleNames(page)) === 0);
    const r = await page.evaluate(() => { const b = document.getElementById("nx-fr2-go"), x = b ? b.getBoundingClientRect() : null; return { y: window.scrollY, h: window.innerHeight, w: window.innerWidth, x: x && { t: x.top, b: x.bottom, l: x.left, r: x.right, n: x.width * x.height } }; });
    ok(`${t} primary inside viewport without scroll`, !!r.x && r.y === 0 && r.x.n > 0 && r.x.t >= 0 && r.x.b <= r.h && r.x.l >= 0 && r.x.r <= r.w, JSON.stringify(r));
    await page.screenshot({ path: path.join(SHOTS, `firstrun-${tag}.png`) });
    ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
    await page.locator("#nx-fr2-look").click();
    await page.waitForTimeout(500);
    ok(`${t} Just take a look shows the five names`, (await visibleNames(page)) === 5, String(await visibleNames(page)));
    ok(`${t} first screen gone after peek`, (await page.locator("#nx-fr2").count()) === 0);
    await ctx.close();
  }
  const a = await open(browser, SIZES[0][1], "&frame_id=1");
  ok("[activity] primary label", (await a.page.locator("#nx-fr2-go").innerText().catch(() => "")) === "Show me my group");
  ok("[activity] no names", (await visibleNames(a.page)) === 0);
  await a.ctx.close();
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
