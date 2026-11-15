// Activity wiring, with a stubbed Discord SDK (no Discord, no network beyond the recorded API snapshot).
//   node activity-wiring.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES)   optional: env PW_CHROMIUM
// 1. Late SDK: sdk.ready() resolving after the 4 s preview start still switches the board to Discord mode, exactly once
//    (presence asks Discord once, and one footer click opens one external link: no second listener). A fast SDK behaves the same.
// 2. Footer links: inside the Activity a click on Privacy / Terms does not navigate the frame; it calls
//    sdk.commands.openExternalLink with an http(s) URL. mailto stays a plain link. Outside the Activity (?preview=1, no SDK) nothing is intercepted.
// 3. Settings: a visitor outside the Activity who is not signed in does not see the "Sign in with Discord" row; inside the Activity it shows.
// The stub SDK module replaces vendor/embedded-app-sdk.mjs by route interception; its ready() resolves after window.__sdkDelay ms.
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
      getInstanceConnectedParticipants: async () => { window.__participantCalls = (window.__participantCalls || 0) + 1; return { participants: [{ username: "ada" }, { username: "bram" }] }; },
      openExternalLink: async (a) => { (window.__ext ||= []).push(a.url); return {}; },
    }; }
  ready() { return new Promise((r) => setTimeout(r, window.__sdkDelay || 0)); }
  async subscribe() {}
}
`;

async function open(browser, { delay, query = {}, stub = true, quiet = null }) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.addInitScript((d) => { window.__sdkDelay = d; window.__ext = []; }, delay || 0);
  if (stub) await ctx.route("**/vendor/embedded-app-sdk.mjs*", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: STUB }));
  /* this suite does not test the Worker: an origin named by ?api= answers 503 so the page uses its own data files */
  if (quiet) await ctx.route(quiet, (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"stub"}' }));
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
const boardShown = (page) => page.evaluate(() => !document.getElementById("board").hidden);
const presence = (page) => page.evaluate(() => (document.getElementById("presence-text") || {}).textContent || "");

const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  for (const [label, delay] of [["late SDK (ready after 5 s)", 5000], ["fast SDK (ready at once)", 0]]) {
    const { ctx, page, errors } = await open(browser, { delay });
    if (delay > 4000) {
      await page.waitForTimeout(4600);
      ok(`[${label}] at 4.6 s the board is already up in preview mode`, await boardShown(page));
      ok(`[${label}] and Discord mode has not started yet`, (await presence(page)).indexOf("In this Activity") < 0);
    }
    await page.waitForFunction(() => /In this Activity now/.test((document.getElementById("presence-text") || {}).textContent || ""), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    ok(`[${label}] Discord mode is on: presence reads "In this Activity now"`, /In this Activity now/.test(await presence(page)), await presence(page));
    const calls = await page.evaluate(() => window.__participantCalls || 0);
    ok(`[${label}] presence asked Discord for participants exactly once at start`, calls === 1, `calls ${calls}`);
    const priv = await footClick(page, "Privacy");
    ok(`[${label}] a footer click is intercepted (default prevented before it reaches the frame)`, priv.prevented === true, JSON.stringify(priv));
    ok(`[${label}] one click, one openExternalLink (no duplicate listener)`, priv.ext.length === 1 && /^https?:\/\/[^/]+\/privacy\/$/.test(priv.ext[0]), JSON.stringify(priv.ext));
    const terms = await footClick(page, "Terms");
    ok(`[${label}] Terms opens outside too, and only that one more`, terms.ext.length === 2 && /\/terms\/$/.test(terms.ext[1]), JSON.stringify(terms.ext));
    const mail = await footClick(page, "Contact");
    ok(`[${label}] mailto is left alone`, mail.prevented === false && mail.ext.length === 2, JSON.stringify(mail));
    ok(`[${label}] no page errors`, errors.length === 0, errors.join(" | "));
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
