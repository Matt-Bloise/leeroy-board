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
// Outage helpers. The brain host is 127.0.0.1:1: routed here, never reached. flags.up flips its /state and /bootstrap between 200 and 503.
async function outagePage(opts, { api = "down", hash = "", params = {} } = {}) {
  const { ctx, page } = await open(opts, LAUNCH_CLOCKS.before);
  const dead = (u) => u.port === "1", flags = { up: api === "up" };
  await ctx.route(dead, async (route) => {
    const u = new URL(route.request().url());
    const dm = /^\/api\/data\/([^/]+?)(\.json)?$/.exec(u.pathname); /* the data documents are fine; only the live state API is down (as in a brain outage that leaves the files up) */
    if (dm) { try { const r = await route.fetch({ url: new URL(`/data/${dm[1]}.json${u.search}`, BASE).href }); return await route.fulfill({ response: r }); } catch (e) { return route.abort().catch(() => {}); } }
    if (flags.up) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(u.pathname === "/bootstrap" ? { ver: 1, launch: [] } : { ver: 1 }) }).catch(() => {});
    return route.fulfill({ status: 503, contentType: "text/html", body: "<h1>503</h1>" }).catch(() => {});
  });
  if (ctx.routeWebSocket) await ctx.routeWebSocket(dead, (ws) => ws.close());
  await page.goto(pageUrl(BASE, { params: { preview: "1", brain: "http://127.0.0.1:1", ...params } }) + hash, { waitUntil: "load" });
  return { ctx, page, flags };
}
const lineText = (page) => page.evaluate(() => (document.getElementById("offline-line") || {}).textContent || "");
const waitLine = (page, on = true) => page.waitForFunction((want) => !!(document.getElementById("offline-line").textContent.trim()) === want, on, { timeout: 40000 }).catch(() => {});
const hits = (page) => page.evaluate(() => {
  const line = document.getElementById("offline-line"), lr = line.getBoundingClientRect(), out = { line: [Math.round(lr.top), Math.round(lr.bottom), Math.round(lr.width)], bar: null, bad: [], n: 0, vw: innerWidth };
  const bar = document.getElementById("bottombar"), br = bar && bar.getBoundingClientRect();
  if (br && br.width > 0) {
    out.bar = [Math.round(br.top), Math.round(br.bottom)]; out.overlap = lr.top < br.bottom && lr.bottom > br.top + 0.5;
    for (const b of bar.querySelectorAll("button")) { const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; if (x < br.left + 2 || x > br.right - 2 || y < br.top || y > br.bottom) continue; out.n++; const e = document.elementFromPoint(x, y); if (!(e === b || b.contains(e))) out.bad.push(`${b.dataset.go || b.getAttribute('aria-label') || b.textContent.trim()} -> ${e && (e.id || e.className || e.tagName)}`); }
  }
  return out;
});
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
    const info = await page.evaluate(() => ({ mini: (document.getElementById("mini-clock") || {}).textContent || "", hero: document.getElementById("clock-launch").textContent, body: document.body.textContent.replace(/\s+/g, " "), lede: ((document.querySelector("#panel-timeline .lede") || {}).textContent || ""), offline: (document.getElementById("offline-line") || {}).textContent || "" }));
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
      ok(`${t} the Bonuses scene does not say nobody can earn a point before launch`, !/nobody can earn a point before launch/.test(info.body));
      ok(`${t} the Dates lede does not promise ET marks the guided sign-ups slots do not carry`, !/marked ET/.test(info.lede), info.lede);
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
    ok(`${t} it says something plain`, /(could not reach|did not load)/i.test(o.text) && o.text.length < 200, o.text);
    ok(`${t} it is visible and the page does not scroll sideways`, o.shown && o.scrollOk);
    await ctx.close();
  }
  // HIGH 1 and MED 5: the line never covers navigation, at phone and laptop sizes, in several scenes.
  for (const [tag, opts] of [["390x844", SIZES[0][1]], ["1366x768", { viewport: { width: 1366, height: 768 } }]]) for (const hash of ["#tonight", "#five", "#librarian", "#legacy", "#timeline"]) {
    const { ctx, page } = await outagePage(opts, { hash }), t = `[${tag} ${hash} outage layout]`;
    await waitLine(page); await page.waitForTimeout(1200);
    const o = await hits(page);
    console.log(t, JSON.stringify(o));
    ok(`${t} the line is shown`, o.line[2] > 0);
    if (opts.viewport.width < 700) { ok(`${t} the phone bottom bar is there and every button is the element hit at its centre`, !!o.bar && o.n >= 3 && o.bad.length === 0, o.bad.join("; ") || `${o.n} buttons`); ok(`${t} the line does not overlap the bottom bar`, o.overlap === false, `line ${o.line} bar ${o.bar}`); }
    else ok(`${t} the line is full width, not a narrow box`, o.line[2] >= o.vw - 1, `width ${o.line[2]} of ${o.vw}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await outagePage({ viewport: { width: 1366, height: 768 } }), t = "[1366x768 outage wall]";
    await waitLine(page);
    const look = page.getByText("Just take a look", { exact: false }).first(); if (await look.isVisible().catch(() => false)) await look.click({ timeout: 15000 });
    await page.waitForTimeout(1500); await page.keyboard.press("Escape"); await page.waitForTimeout(1500);
    const o = await page.evaluate(() => { const a = document.getElementById("foot-legal"); if (!a) return { found: false }; a.scrollIntoView({ block: "end" }); const r = a.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { found: true, hit: e === a || a.contains(e), r: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], top: e && (e.id || e.className || e.tagName) }; });
    console.log(t, JSON.stringify(o));
    ok(`${t} the Privacy and terms link is the element hit at its centre while the line is shown`, o.found && o.hit, JSON.stringify(o));
    await ctx.close();
  }
  // LOW: an empty status line stays in the accessibility tree (display none drops the live region, so the first announcement can be lost)
  {
    const { ctx, page } = await outagePage(SIZES[0][1], { api: "up" }), t = "[390x844 live region]";
    await page.waitForTimeout(2500);
    const o = await page.evaluate(() => { const e = document.getElementById("offline-line"), c = getComputedStyle(e), r = e.getBoundingClientRect(); return { text: e.textContent, display: c.display, visibility: c.visibility, role: e.getAttribute("role"), w: r.width, h: r.height }; });
    console.log(t, JSON.stringify(o));
    ok(`${t} a healthy board: the region is empty, still rendered (not display:none or visibility:hidden), and takes no room`, o.text === "" && o.display !== "none" && o.visibility !== "hidden" && o.role === "status" && o.h <= 1 && o.w <= 1, JSON.stringify(o));
    await ctx.close();
  }
  // MED 4: the poll-to-line wiring. The brain starts healthy, then its polls fail mid-session: the line must appear through the status handler (js/v13d.js), and go when the polls recover.
  for (const [tag, opts] of SIZES) {
    const { ctx, page, flags } = await outagePage(opts, { api: "up" }), t = `[${tag} mid-session]`;
    await page.waitForFunction(() => window.BoardBrain && window.BoardBrain.status().polls > 0, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const s0 = await page.evaluate(() => ({ down: window.BoardBrain.status().down, polls: window.BoardBrain.status().polls, text: document.getElementById("offline-line").textContent }));
    ok(`${t} healthy start: brain polled, not down, no line`, s0.polls > 0 && !s0.down && s0.text === "", JSON.stringify(s0));
    flags.up = false;
    await page.evaluate(async () => { await window.BoardBrain._poll(); });
    ok(`${t} one failed poll shows no line`, (await lineText(page)) === "");
    await page.evaluate(async () => { await window.BoardBrain._poll(); });
    await waitLine(page);
    const t1 = await lineText(page);
    ok(`${t} two failed polls: the line appears through the status handler`, /could not reach/i.test(t1), t1);
    flags.up = true;
    await page.evaluate(async () => { await window.BoardBrain._poll(); });
    await waitLine(page, false);
    ok(`${t} a good poll clears the line`, (await lineText(page)) === "");
    await ctx.close();
  }
  // LOW: a failed first load says one plain thing. "Out of date" is wrong when nothing loaded, and the detail line is not repeated in the footer.
  {
    const { ctx, page } = await open(SIZES[0][1], LAUNCH_CLOCKS.before), t = "[390x844 first load fails]";
    await ctx.route((u) => /\/data\/[^/]+\.json$/.test(u.pathname), (route) => route.fulfill({ status: 500, body: "no" }).catch(() => {}));
    await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("offline-line").textContent.trim().length > 0, null, { timeout: 30000 }).catch(() => {});
    const o = await page.evaluate(() => ({ line: document.getElementById("offline-line").textContent.trim(), foot: document.getElementById("footer").textContent.replace(/\s+/g, " ") }));
    console.log(t, JSON.stringify(o));
    ok(`${t} the status line says the data did not load, not "out of date"`, /did not load/i.test(o.line) && !/out of date/i.test(o.line), o.line);
    ok(`${t} the footer does not repeat it as a third line`, !/Could not read the board's data/.test(o.foot), o.foot.slice(0, 200));
    await ctx.close();
  }
} finally { await browser.close(); }
process.exit(fail ? 1 : 0);
