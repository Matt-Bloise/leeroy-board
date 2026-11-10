// Dates scene after launch: the dates ahead lead, what already happened sits behind one Earlier control. Before launch the rail is untouched.
//   node dates-post-launch.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// No AI call, nothing sent. Clocks come from data/timeline.json launch time via tests/helpers/clock-arg.mjs LAUNCH_CLOCKS. Sizes 390x844 and 1440x900. Exit 0 when every check passes.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { LAUNCH_CLOCKS } from "../helpers/clock-arg.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node dates-post-launch.mjs --url <pages origin>"); process.exit(2); }
let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? `: ${x}` : ""}`); };
const SIZES = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1440x900", { viewport: { width: 1440, height: 900 } }]];
const browser = stubbed(await pw.chromium.launch());
const url = pageUrl(BASE, { params: { preview: "1" } });
try {
  for (const [tag, opts] of SIZES) for (const [state, clock] of [["before", LAUNCH_CLOCKS.before], ["after", LAUNCH_CLOCKS.after]]) {
    const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" }); await ctx.clock.install({ time: new Date(clock) });
    const page = await ctx.newPage(), t = `[${tag} ${state}]`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector("#nx-fr2-look", { state: "visible", timeout: 20000 }); await page.waitForTimeout(500);
    await page.getByText("Just take a look", { exact: false }).first().click({ timeout: 15000 });
    await page.waitForFunction(() => document.documentElement.classList.contains("scene-open"), null, { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => { location.hash = "timeline"; }); await page.waitForTimeout(800);
    const more = page.locator("#panel-timeline").getByText("Show me more").first(); if (await more.isVisible().catch(() => false)) { await more.click(); await page.waitForTimeout(800); }
    await page.waitForSelector("#rail .stop", { state: "attached", timeout: 20000 });
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => {
      const top = [...document.querySelectorAll("#rail > li")].map((l) => l.classList.contains("stop-earlier") ? "EARLIER" : `${l.dataset.ev}:${l.className.replace("stop", "").replace("lit", "").trim()}`);
      const b = document.querySelector(".earlier-toggle"), list = document.getElementById("rail-earlier");
      return { top, all: [...document.querySelectorAll("#rail .stop")].map((l) => l.dataset.ev), btn: b ? { expanded: b.getAttribute("aria-expanded"), text: b.textContent } : null, hidden: list ? list.hidden : null, texts: [...document.querySelectorAll("#rail .stop:not([hidden])")].filter((l) => l.offsetParent !== null).map((l) => `${l.querySelector("h3").textContent} | ${l.querySelector(".state").textContent}`) };
    });
    console.log(t, JSON.stringify(info));
    ok(`${t} all three events stay in the DOM`, info.all.length === 3);
    if (state === "before") ok(`${t} no Earlier control, order unchanged`, !info.btn && info.top.join() === "names_open:open,launch:next,raids:");
    else {
      ok(`${t} future first, one Earlier control last`, info.top[0].startsWith("raids") && info.top[info.top.length - 1] === "EARLIER");
      ok(`${t} collapsed, aria-expanded=false`, info.btn && info.btn.expanded === "false" && info.hidden === true);
      await page.focus(".earlier-toggle"); await page.keyboard.press("Enter");
      ok(`${t} Enter expands`, await page.evaluate(() => document.querySelector(".earlier-toggle").getAttribute("aria-expanded") === "true" && !document.getElementById("rail-earlier").hidden));
      ok(`${t} no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      // (2) focus survives a forced re-render while the Earlier button is focused
      const kept = await page.evaluate(() => { const b = document.querySelector(".earlier-toggle"); b.focus(); __boardKit.render.timeline(); const n = document.querySelector(".earlier-toggle"); return { same: document.activeElement === n, exp: n.getAttribute("aria-expanded") }; });
      ok(`${t} focus and expanded state survive a re-render`, kept.same && kept.exp === "true", JSON.stringify(kept));
      // (1) order from out-of-order data: late (+9000 s) listed before early (+100 s); two past events listed oldest first
      const order = await page.evaluate(() => { const now = Date.now() / 1000, ev = __boardKit.D.timeline.events, keep = ev.slice(); const mk = (key, off) => ({ key, epoch: Math.round(now + off), label: key, format: "F" });
        __boardKit.D.timeline.events = [mk("late", 9000), mk("p_old", -90000), launchEv(keep), mk("early", 100), mk("p_new", -5000)]; __boardKit.render.timeline();
        const r = { top: [...document.querySelectorAll("#rail > li:not(.stop-earlier)")].map((l) => l.dataset.ev), earlier: [...document.querySelectorAll("#rail-earlier .stop")].map((l) => l.dataset.ev) };
        // (3) all past: nothing upcoming
        __boardKit.D.timeline.events = [mk("p_old", -90000), launchEv(keep), mk("p_new", -5000)]; __boardKit.render.timeline();
        const b = document.querySelector(".earlier-toggle"); if (b.getAttribute("aria-expanded") !== "true") b.click();
        r.none = (document.querySelector(".stop-none") || {}).textContent; r.vis = [...document.querySelectorAll("#rail .stop")].filter((l) => l.getClientRects().length > 0).map((l) => l.dataset.ev);
        __boardKit.D.timeline.events = keep; __boardKit.render.timeline(); return r; function launchEv(k) { const l = k.find((x) => x.key === "launch"); return { ...l, epoch: Math.round(now - 20000) }; } });
      ok(`${t} upcoming ascending, Earlier most recent first`, order.top.join() === "early,late" && order.earlier.join() === "p_new,launch,p_old", JSON.stringify(order));
      ok(`${t} all past: one honest line, every event visible when expanded`, order.none === "Nothing dated ahead right now." && order.vis.length === 3, JSON.stringify(order));
    }
    await ctx.close();
  }
} finally { await browser.close(); }
process.exit(fail ? 1 : 0);
