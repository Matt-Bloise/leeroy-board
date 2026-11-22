// Activity wiring, with a stubbed Discord SDK (no Discord, no network beyond the recorded API snapshot).
//   node activity-wiring.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES)   optional: env PW_CHROMIUM
// 1. Late SDK: sdk.ready() resolving after the 4 s preview start still switches the board to Discord mode, exactly once
//    (presence asks Discord once, and one footer click opens one external link: no second listener). A fast SDK behaves the same.
// 2. Footer links: inside the Activity a click on Privacy / Terms does not navigate the frame; it calls
//    sdk.commands.openExternalLink with an http(s) URL. mailto stays a plain link. Outside the Activity (?preview=1, no SDK) nothing is intercepted.
// 3. Settings: a visitor outside the Activity who is not signed in does not see the "Sign in with Discord" row; inside the Activity it shows.
// The stub SDK module replaces vendor/embedded-app-sdk.mjs by route interception; its ready() resolves after window.__sdkDelay ms.
// Every timing check in 1 reads the Activity frame's own clock (window.__marks, the stub's call times), so a slow harness or a slow request cannot move it.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node activity-wiring.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };

const STUB = `export class DiscordSDK {
  constructor(id) { this.clientId = id; this.platform = "desktop"; this.customId = null; this.instanceId = "fictional-instance-1";
    this.commands = {
      setOrientationLockState: async () => {},
      authorize: async () => { throw new Error("stub: no authorize"); },
      getInstanceConnectedParticipants: async () => { window.__participantCalls = (window.__participantCalls || 0) + 1; (window.__participantTimes ||= []).push(performance.now()); return { participants: [{ username: "ada" }, { username: "bram" }] }; },
      openExternalLink: async (a) => { (window.__ext ||= []).push(a.url); return {}; },
    }; }
  ready() { return new Promise((r) => setTimeout(r, window.__sdkDelay || 0)); }
  async subscribe() {}
}
`;

async function open(browser, { delay, query = {}, stub = true, quiet = null, host = null, dataStatus = 0 }) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.addInitScript((d) => { window.__sdkDelay = d; window.__ext = []; }, delay || 0);
  /* The Activity frame writes down, on ITS OWN clock (the one its 4 s preview fallback, the SDK's ready() and the 15 s presence re-poll run on), when it started, when the board
     came up and when Discord mode began. The timing checks below are made on these marks, never on how long the harness slept after the frame's load event (see the loop below). */
  if (host) await ctx.addInitScript((h) => {
    if (location.hostname !== h) return;
    const t = (window.__marks = { start: performance.now(), board: null, discord: null });
    const look = () => {
      const b = document.getElementById("board"), p = document.getElementById("presence-text");
      if (t.board === null && b && !b.hidden) t.board = performance.now();
      if (t.discord === null && p && /In this Activity/.test(p.textContent || "")) t.discord = performance.now();
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  }, host);
  /* Activity runs: the page is served on a fictional https://<id>.discordsays.com host (as the Developer Portal proxy does), every request answered from BASE.
     Registered first so the API stub and the SDK stub below win for /api/ and the SDK module. */
  if (host) await ctx.route(`https://${host}/**`, async (r) => { const u = new URL(r.request().url()); /* /api/data/* and /api/library/* are answered from fixtures (the repo's data files, as the Worker would serve them to an all-visible party): the member documents have no static fallback, so a 404 here would stop the board. dataStatus makes the data routes fail instead (the closed rule: presence and link interception must still start). */
    const dm = /^\/api\/(data|library)\/(.+?)(?:\.json)?$/.exec(u.pathname);
    if (dm) { if (dataStatus) return r.fulfill({ status: dataStatus, contentType: "application/json", body: '{"error":"stub"}' }); try { return r.fulfill({ response: await r.fetch({ url: new URL(`data/${dm[1] === "library" ? "library/" : ""}${dm[2]}.json`, BASE).href }) }); } catch (e) { return r.fulfill({ status: 404, contentType: "application/json", body: '{"error":"stub"}' }); } } if (u.pathname.startsWith("/api/")) return r.fallback(); try { r.fulfill({ response: await r.fetch({ url: new URL(u.pathname + u.search, BASE).href }) }); } catch (e) { r.abort().catch(() => {}); } });
  if (stub) await ctx.route("**/vendor/embedded-app-sdk.mjs*", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: STUB }));
  /* this suite does not test the Worker: an origin named by ?api= answers 503 so the page uses its own data files */
  if (quiet) await ctx.route(quiet, (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"stub"}' }));
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (host) { /* the Activity is an iframe: index.html skips the gate only for a top-level page, so the board is framed by a fictional shell page */
    await ctx.route("https://discord.test/", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><iframe src="https://${host}/${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}" style="width:1366px;height:760px;border:0"></iframe>` }));
    await page.goto("https://discord.test/", { waitUntil: "load" });
    const frame = await (await page.waitForSelector("iframe")).contentFrame(); await frame.waitForLoadState("load");
    return { ctx, page: { evaluate: (...x) => frame.evaluate(...x), waitForFunction: (...x) => frame.waitForFunction(...x), waitForTimeout: (ms) => page.waitForTimeout(ms) }, errors };
  }
  await page.goto(pageUrl(BASE, { params: query }), { waitUntil: "load" });
  return { ctx, page, errors };
}
/* click a footer link the way a user does, but record whether the page prevented the default and stop the navigation ourselves */
const footClick = (page, text) => page.evaluate((t) => {
  const a = [...document.querySelectorAll("#legal-foot a")].find((x) => x.textContent.trim() === t);
  let prevented = null;
  const rec = (e) => { prevented = e.defaultPrevented; e.preventDefault(); };
  window.addEventListener("click", rec, false);
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  window.removeEventListener("click", rec, false);
  return { prevented, href: a.getAttribute("href"), ext: window.__ext.slice() };
}, text);
const presence = (page) => page.evaluate(() => (document.getElementById("presence-text") || {}).textContent || "");

const ACT_HOST = "123456789012345678.discordsays.com"; /* fictional */
const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  // Timing is judged on the frame's own clock (window.__marks and the stub's call times), not on harness sleeps. Until 2026-11-22 this loop slept 4.6 s and then 2.5 s
  // counted from the frame's LOAD event, while the page's timers count from its start: when a load-blocking request of the framed board answered late (in CI every request
  // is proxied to the preview), the "4.6 s" check ran after the SDK was ready and the participant count was read after the board's own 15 s re-poll, so the late-SDK case
  // failed with "Discord mode has not started yet" and "exactly once at start: calls 2" about once in 60 full runs. Reproduced by holding one hero image back 14 s.
  const START_WINDOW_MS = 15000; /* js/board.js startDiscordPresence re-polls every 15 s by design; "exactly once at start" counts the calls before that */
  const SETTLE_MS = 7000; /* past the 6 s race in startDiscordPresence, so a second start's first poll (immediate or after 6 s) would be counted */
  for (const [label, delay] of [["late SDK (ready after 5 s)", 5000], ["fast SDK (ready at once)", 0]]) {
    const { ctx, page, errors } = await open(browser, { delay, host: ACT_HOST });
    await page.waitForFunction(() => window.__marks && window.__marks.discord !== null, null, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction((ms) => window.__marks && window.__marks.discord !== null && performance.now() - window.__marks.discord >= ms, SETTLE_MS, { timeout: 30000 }).catch(() => {});
    const m = await page.evaluate(() => ({ ...window.__marks, now: performance.now(), calls: (window.__participantTimes || []).slice() }));
    const rel = (x) => (x === null || x === undefined ? "never" : `${Math.round(x - m.start)} ms`);
    const marks = `page clock: board up at ${rel(m.board)}, Discord mode at ${rel(m.discord)}, participant calls at ${m.calls.map(rel).join(", ") || "none"}, read at ${rel(m.now)}`;
    if (delay > 4000) {
      ok(`[${label}] the board came up in preview mode (the 4 s fallback) before Discord mode started`, m.board !== null && m.discord !== null && m.board < m.discord, marks);
      ok(`[${label}] and Discord mode started only once the SDK was ready (5 s on the page clock)`, m.discord !== null && m.discord - m.start >= 5000, marks);
    }
    ok(`[${label}] Discord mode is on: presence reads "In this Activity now"`, /In this Activity now/.test(await presence(page)), await presence(page));
    const atStart = m.discord === null ? [] : m.calls.filter((c) => c >= m.discord && c < m.discord + START_WINDOW_MS);
    ok(`[${label}] presence asked Discord for participants exactly once at start (the first ${START_WINDOW_MS / 1000} s of Discord mode)`, atStart.length === 1 && m.calls.every((c) => c >= m.discord), `calls ${atStart.length} in the window, ${m.calls.length} in all; ${marks}`);
    const priv = await footClick(page, "Privacy");
    ok(`[${label}] a footer click is intercepted (default prevented before it reaches the frame)`, priv.prevented === true, JSON.stringify(priv));
    ok(`[${label}] one click, one openExternalLink (no duplicate listener)`, priv.ext.length === 1 && priv.ext[0] === "https://leeroy.party/privacy/", JSON.stringify(priv.ext));
    const terms = await footClick(page, "Terms");
    ok(`[${label}] Terms opens outside too, and only that one more`, terms.ext.length === 2 && terms.ext[1] === "https://leeroy.party/terms/", JSON.stringify(terms.ext));
    const mail = await footClick(page, "Contact");
    ok(`[${label}] mailto is left alone`, mail.prevented === false && mail.ext.length === 2, JSON.stringify(mail));
    ok(`[${label}] no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  { // the member documents fail (the Worker answers 500): the board shows the "could not load" line, and Discord mode still starts: presence and link interception
    const { ctx, page, errors } = await open(browser, { delay: 0, host: ACT_HOST, dataStatus: 500 });
    await page.waitForFunction(() => /In this Activity now/.test((document.getElementById("presence-text") || {}).textContent || ""), null, { timeout: 30000 }).catch(() => {});
    ok("[member data down] presence still reads \"In this Activity now\"", /In this Activity now/.test(await presence(page)), await presence(page));
    const priv = await footClick(page, "Privacy");
    ok("[member data down] the footer link is still intercepted and opened outside", priv.prevented === true && priv.ext.length === 1, JSON.stringify(priv));
    ok("[member data down] the page says it could not load, and shows no member data", await page.evaluate(() => /could not load/i.test(document.body.innerText)));
    await ctx.close();
  }

  { // outside the Activity: no SDK, preview start
    const { ctx, page, errors } = await open(browser, { delay: 0, query: { preview: "1" }, stub: false });
    await page.waitForFunction(() => !document.getElementById("board").hidden, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const priv = await footClick(page, "Privacy");
    ok("[web preview] footer links are not intercepted", priv.prevented === false && priv.ext.length === 0, JSON.stringify(priv));
    ok("[web preview] presence does not claim an Activity", !/In this Activity/.test(await presence(page)));
    ok("[web preview] no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  { // settings row: ?api= points at a local Worker origin so the account row is built (the stub answers /api/)
    const { ctx, page, errors } = await open(browser, { delay: 0, query: { preview: "1", api: "http://127.0.0.1:8787" }, stub: false, quiet: "http://127.0.0.1:8787/**" });
    await page.waitForFunction(() => !document.getElementById("board").hidden, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector("[data-open-settings]").click());
    await page.waitForSelector("#st-acct", { state: "attached", timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    const web = await page.evaluate(() => { const r = document.getElementById("st-acct"); return r ? { hidden: r.hidden, shown: !!(r.offsetWidth || r.offsetHeight) } : null; });
    ok("[settings, web, signed out] the Saved settings row exists but is hidden", !!web && web.hidden && !web.shown, JSON.stringify(web));
    const act = await page.evaluate(() => { window.__sdk = {}; window.dispatchEvent(new Event("board-account")); const r = document.getElementById("st-acct"), b = document.getElementById("st-acct-in"); return { hidden: r.hidden, btnDisabled: b.disabled }; });
    ok("[settings, Activity] the row shows and the sign-in button is enabled", act.hidden === false && act.btnDisabled === false, JSON.stringify(act));
    ok("[settings] no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
