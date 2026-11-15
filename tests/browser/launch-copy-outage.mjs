// Two honest-board checks. (1) After launch, no launch wording is left in the future tense or points at a date already past (mini clock, hero line, tiles, tonight card, scene question).
// (2) When the API answers 503 and the live socket closes, the board shows one plain role="status" line instead of looking frozen; a board with no API at all shows none.
//   node launch-copy-outage.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES)
// No AI call, nothing sent. Clocks from tests/helpers/clock-arg.mjs LAUNCH_CLOCKS. Sizes 390x844 and 1440x900. Exit 0 when every check passes.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { LAUNCH_CLOCKS } from "../helpers/clock-arg.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node launch-copy-outage.mjs --url <pages origin>"); process.exit(2); }
let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? `: ${x}` : ""}`); };
const SIZES = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1440x900", { viewport: { width: 1440, height: 900 } }]];
const browser = stubbed(await pw.chromium.launch());
async function open(opts, clock, url) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" }); await ctx.clock.install({ time: new Date(clock) });
  return { ctx, page: await ctx.newPage(), url };
}
async function enter(page, url, strict = true) {
  await page.goto(url, { waitUntil: "load" });
  if (!strict) return;
  await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 });
  await page.getByText("Just take a look", { exact: false }).first().click({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.classList.contains("scene-open"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("#clock-launch") && document.querySelector("#clock-launch").textContent, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
try {
  const plain = pageUrl(BASE, { params: { preview: "1" } });
  for (const [tag, opts] of SIZES) for (const [state, clock] of [["before", LAUNCH_CLOCKS.before], ["after", LAUNCH_CLOCKS.after]]) {
    const { ctx, page } = await open(opts, clock), t = `[${tag} ${state}]`;
    await enter(page, plain);
    const info = await page.evaluate(() => ({ mini: (document.getElementById("mini-clock") || {}).textContent || "", hero: document.getElementById("clock-launch").textContent, body: document.body.textContent.replace(/\s+/g, " "), offline: (document.getElementById("offline-line") || {}).textContent || "" }));
    console.log(t, JSON.stringify({ mini: info.mini, hero: info.hero }));
    ok(`${t} a board with no API shows no offline line`, info.offline === "");
    if (state === "before") {
      ok(`${t} hero says Launch:`, /^Launch: /.test(info.hero));
      ok(`${t} future wording stays before launch`, /earning starts at launch|To play from launch|When is launch, and what comes after/.test(info.body), "");
    } else {
      ok(`${t} mini clock has no Launch suffix`, !/Launch/.test(info.mini), info.mini);
      ok(`${t} hero line is past tense`, /^Launched: /.test(info.hero), info.hero);
      ok(`${t} no "earning starts at launch"`, !/earning starts at launch/.test(info.body));
      ok(`${t} no "To play from launch"`, !/To play from launch/.test(info.body));
      ok(`${t} no "When is launch, and what comes after?"`, !/When is launch, and what comes after\?/.test(info.body));
      ok(`${t} no tenseless "Launch: Wed"`, !/Launch: (Wed|Wednesday)/.test(info.body));
    }
    await ctx.close();
  }
  for (const [tag, opts] of SIZES) {
    const { ctx, page } = await open(opts, LAUNCH_CLOCKS.before), t = `[${tag} outage]`;
    const dead = (u) => u.port === "1";
    await ctx.route(dead, (route) => route.fulfill({ status: 503, contentType: "text/html", body: "<h1>503</h1>" }).catch(() => {}));
    if (ctx.routeWebSocket) await ctx.routeWebSocket(dead, (ws) => ws.close());
    await enter(page, pageUrl(BASE, { params: { preview: "1", brain: "http://127.0.0.1:1" } }), false);
    await page.waitForFunction(() => { const e = document.getElementById("offline-line"); return e && e.textContent.trim().length > 0; }, null, { timeout: 40000 }).catch(() => {});
    const o = await page.evaluate(() => { const e = document.getElementById("offline-line"), r = e && e.getBoundingClientRect(); return { n: document.querySelectorAll("[id=offline-line]").length, role: e && e.getAttribute("role"), text: e ? e.textContent.trim() : "", shown: !!(r && r.width > 0 && r.height > 0), scrollOk: document.documentElement.scrollWidth <= innerWidth }; });
    console.log(t, JSON.stringify(o));
    ok(`${t} one offline line with role=status`, o.n === 1 && o.role === "status");
    ok(`${t} it says something plain`, /not (reach|answer)/i.test(o.text) && o.text.length < 200, o.text);
    ok(`${t} it is visible and the page does not scroll sideways`, o.shown && o.scrollOk);
    await ctx.close();
  }
} finally { await browser.close(); }
process.exit(fail ? 1 : 0);
