// Proof that the production probe (prod-probe.mjs) fails when it should and passes when it should. Runs in the PR browser job with ZERO Worker requests:
// the probe is pointed at a local fixture server (tests/helpers/probe-fixture-server.mjs: the repository as static files, /api/* from the recorded snapshot with the
// six-member party), never at Cloudflare. It ignores --url. Chromium only (it tests the judging, not the engines). Optional: --only green,budget (case names).
// The probe cases run three at a time because they only talk to local servers; the PRODUCTION probe never runs in parallel with itself.
//   green            six members, flag on                                  -> exit 0 (both viewports)
//   wrong-count      /api/state lists one member more than the board shows  -> exit 1
//   typed-five       six members, flag party.n off ("the five")             -> exit 1
//   junk             a race says "undefined"                                -> exit 1
//   no-panel         #panel-ledger is gone 2.5 s after load                 -> exit 1, and the failure must NAME the missing panel (later scenes fail too: the board's scene machinery needs its panels)
//   ignored-hash     member routes never land on the member's card          -> exit 1 ("did not land")
//   csp-enforced     an enforced CSP violation in the console              -> exit 1
//   csp-report-only  a "[Report Only]" CSP message                         -> exit 0
//   state-redirect   the reference /api/state answers a redirect                -> exit 1, not followed, no browser launched
//   beacon-webkit    a beacon request fails, then WebKit's two URL-less/Beacon CORS lines follow within 2 s -> exit 0 with one WARN line (2 ignored)
//   beacon-own-error / beacon-other-host / beacon-no-failure   an own-origin error after a beacon failure / the Beacon line naming another host / the CORS line with no beacon failure before it -> exit 1
//   cf-text          a console error that only mentions cloudflareinsights.com -> exit 1 (the exemption is by location, not by text)
//   budget-spent     --budget 20 with two engines                           -> exit 1, one budget failure, no scene noise, the second engine never started, server saw <= 20
//   delayed-render   the sixth name chip appears 5 s after load                   -> exit 0 (the probe waits for the chips; fails without the settle wait)
//   csp-advisory     WebKit's "The Content Security Policy ... report-only" error -> exit 0 (exempt)
//   csp-nonadvisory  "The Content Security Policy ... blocked the resource" error  -> exit 1 (not the advisory)
//   hidden-five      hidden text says five with six members              -> exit 0 and listed as information; visible-five -> exit 1
//   csp-firefox      Firefox's (Report-Only policy) eval message          -> exit 0 and listed; csp-mention / csp-mention-firefox (enforced block that mentions report-only) -> exit 1
//   state-fail       the reference /api/state answers 500                   -> exit 1, no browser launched, at most 1 API request
//   budget           a page that reconnects a socket and refetches 20 times with a budget of 5 -> the server sees at most 5 Worker requests
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "../helpers/probe-fixture-server.mjs";
import { createBudget, guardContext } from "../helpers/probe-budget.mjs";
import { DEFAULT_CLOCK } from "../helpers/clock-arg.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm ci in tests/"); process.exit(2); });
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
let pass = 0, fail = 0;
// A rejection nobody awaits must never be silent and must never be a surprise: the default is a Node stack trace, exit 1 and no FAIL line, so a real failure looks like a crash and a
// harmless one ends the run before the summary. Here every one prints a FAIL line and ends the run with exit 1, EXCEPT one narrow case: a closed-target error (TargetClosedError) that
// arrives while a browser is being closed on purpose (`tearingDown`), from a call that was still in flight when it closed. That one is logged as INFO and the run goes on.
let tearingDown = false, ignoredAtTeardown = 0;
const why = (e) => String((e && (e.stack || e.message)) || e).split("\n").slice(0, 3).join(" | ");
const isClosedTarget = (e) => /TargetClosedError|Target page, context or browser has been closed/.test(String((e && (e.name + " " + e.message)) || e));
const die = (what, e) => { fail++; console.log(`FAIL ${what}: ${why(e)}`); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); };
process.on("unhandledRejection", (e) => {
  if (tearingDown && isClosedTarget(e)) { ignoredAtTeardown++; console.log(`INFO [teardown] ignored a closed-target rejection from a call still in flight when the browser was closed on purpose: ${why(e)}`); return; }
  die(`unhandled rejection${tearingDown ? " during teardown" : ""}`, e);
});
process.on("uncaughtException", (e) => die("uncaught exception", e));
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
// Close a case's browser in order, after everything that could still be answering it has stopped: the page's reconnect loops (window.__stopSockets), then a short settle for
// in-flight route and WebSocket handlers, then the routes themselves (waiting for any handler still running), then page, context, browser and the fixture server. Nothing here is skipped
// on an error, and `tearingDown` is what lets the rejection handler above tell a late closed-target error of this close from a real failure.
async function tearDown(page, ctx, browser, srv) {
  tearingDown = true;
  await page.evaluate(() => { window.__stopSockets = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await ctx.unrouteAll({ behavior: "wait" }).catch(() => {});
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  await srv.close();
  await new Promise((r) => setTimeout(r, 200)); // anything that rejects late still lands while `tearingDown` is set
}
// Engines under test: chromium by default (the only one installed in most places); `--engines chromium,firefox,webkit` runs every probe case in each engine that is installed here
// (an engine that is not installed is skipped by the probe with a WARN), so the hidden-versus-visible and wording cases can be run under every engine the machine has.
const ENGINES = argv.includes("--engines") ? argv[argv.indexOf("--engines") + 1] : "chromium";
const L = ["--viewports", "laptop"];
const CASES = [
  ["green", 0, null, []],
  ["wrong-count", 1, /the board shows 6 members but \/api\/state partyDoc lists 7/, L, null, [["says what it counted in the DOM", /\[DOM: selector "\.tn-name": \d+ elements, \d+ with a box; names: [^\]]+\(wanted 7\)\]/]]],
  ["typed-five", 1, /copy states the wrong party size: .*five/i, L],
  ["junk", 1, /junk text, .*undefined/i, L],
  ["no-panel", 1, /scene #ledger did not open: there is no #panel-ledger in the page/, L],
  ["ignored-hash", 1, /did not open: the route did not land on .*'s card/, L],
  ["csp-enforced", 1, /console error: Refused to load the image .*Content Security Policy/, L],
  ["csp-report-only", 0, null, L],
  ["delayed-render", 0, null, L],
  ["csp-advisory", 0, null, L, null, [["lists the exempted advisory as information", /INFO exempted report-only CSP advisories[^\n]*\n\s+- \w+: The Content Security Policy/]]],
  ["csp-firefox", 0, null, L, null, [["lists the Firefox advisory as information", /INFO exempted report-only CSP advisories[^\n]*\n\s+- \w+: Content-Security-Policy: \(Report-Only policy\)/]]],
  ["csp-mention", 1, /console error: The Content Security Policy .*blocked the resource https:\/\/evil\.example\/report-only\.js/, L],
  ["csp-mention-firefox", 1, /console error: Content-Security-Policy: The page's settings blocked/, L],
  ["hidden-five", 0, null, L, null, [["lists the hidden copy as information, not a failure", /INFO hidden copy that still says the wrong party size[^\n]*\n(?:\s+- [^\n]*\n)*\s+- "?All five have picked a spec\./], ["lists the template text too", /- "?Where each of the five starts/], ["lists the display:none text too", /- "?Buff links between the five/], ["lists the visibility:hidden text", /- "?Open the five/], ["lists the closed <details> text", /- "?Where the five start/], ["lists the zero-size text", /- "?Swipe sideways for all five\./], ["lists the content-visibility:hidden text", /- "?The five of us\b[^(]/], ["lists the opacity:0 text", /- "?The five \(opacity\)/], ["lists the aria-hidden text", /- "?The five \(aria-hidden\)/], ["lists the inert text", /- "?The five \(inert\)/]]],
  ["cards-never", 1, /scene #five\.\S+ did not open: \S+ has no card in #panel-five \[selector `#panel-five \.card\[data-slug\]`: 0 of 6 found/, L],
  ["csp-advisory-long", 0, null, L, null, [["lists the long advisory as information", /INFO exempted report-only CSP advisories[^\n]*\n\s+- \w+: The Content Security Policy/]]],
  ["delayed-copy", 0, null, L],
  ["late-cards", 0, null, L],
  ["late-look", 0, null, L],
  ["green", 0, null, L, "api-route-fetch", [["says it is the older comparison mode", /WARN PROBE_API_ROUTE=fetch: the probe sends \/api requests itself/], ["still counts every request", /Worker requests this run: \d+ of 200/]], { PROBE_API_ROUTE: "fetch" }],
  ["redirect-api", 1, /the API answered with a redirect \(counted hop by hop; the probe fails on any\): GET \S+\/api\/bootstrap -> \S+\/api\/bootstrap/, L, null, [["is the default (browser) mode, not the older fetch mode", /^(?![\s\S]*PROBE_API_ROUTE=fetch)/]]],
  ["green", 0, null, L, "cross-origin", [["reached the API on its own origin", /Worker requests this run: \d+ of 200/]], null, { crossOrigin: true }],
  ["stale-first-load", 0, null, L, null, [["reloads once and says so", /WARN chromium laptop 1366x768: the board shows 5 members, the party has 6; reloading once/]]],
  ["members-never", 1, /the board shows 5 members but \/api\/state partyDoc lists 6 \[DOM: selector "\.tn-name": 5 elements/, L, null, [["says the scenes and copy were not judged", /INFO chromium laptop 1366x768: the scenes were not stepped through and no copy was judged/], ["no scene or copy failure follows the count failure", /^(?![\s\S]*FAIL [^\n]*(did not open|wrong party size))/]]],
  ["csp-firefox-js-error", 0, null, L, null, [["lists the wrapped Firefox advisory as information", /INFO exempted report-only CSP advisories[^\n]*\n(?:\s+- [^\n]*\n)*\s+- \w+: \[JavaScript Error: "Content-Security-Policy: \(Report-Only policy\)/]]],
  ["csp-firefox-js-mention", 1, /console error: \[JavaScript Error: "Content-Security-Policy: The page's settings blocked/, L],
  ["visible-five", 1, /copy states the wrong party size: "Which of the five are you\?"/, L, null, [["says why this engine counts the string as visible", /DIAG chromium laptop[^\n]*"Which of the five are you\?" in p[^\n]*display block[^\n]*checkVisibility true[^\n]*ancestors flagged: none/]]],
  ["csp-nonadvisory", 1, /console error: The Content Security Policy .*blocked the resource/, L],
  ["state-fail", 1, /Aborting before any browser is launched/, L],
  ["green", 1, /budget: more than 20 Worker requests/, ["--viewports", "laptop,phone", "--budget", "20", "--engines", "chromium,firefox"], "budget-spent"],
  ["state-redirect", 1, /Aborting before any browser is launched/, L],
  ["cf-text", 1, /console error: TypeError: cannot read properties of undefined .*cloudflareinsights/, L],
  ["beacon-webkit", 0, null, L, null, [["prints one non-failing WARN line per run", /WARN third-party analytics beacon error ignored \(2\), see \/privacy/]]],
  ["beacon-own-error", 1, /console error: TypeError: boom in board\.js/, L, null, [["prints no WARN line when nothing was ignored", /^(?![\s\S]*WARN third-party analytics beacon error ignored)/]]],
  ["beacon-other-host", 1, /console error: Beacon API cannot load https:\/\/evil\.example\//, L],
  ["beacon-no-failure", 1, /console error: Origin \S+ is not allowed by Access-Control-Allow-Origin\. Status code: 404/, L],
].filter(([m, , , , label]) => !only || only.includes(label || m));

async function runCase([mode, want, re, extra, label, musts, env, opts]) {
  const srv = await startFixtureServer({ mode, ...(opts || {}) });
  const child = spawn(process.execPath, [path.join(here, "prod-probe.mjs"), "--url", srv.url, ...(opts && opts.crossOrigin ? ["--api", srv.apiOrigin] : []), ...(extra.includes("--engines") ? [] : ["--engines", ENGINES]), ...(extra.includes("--budget") ? [] : ["--budget", "200"]), ...(extra.includes("--clock") ? [] : ["--clock", DEFAULT_CLOCK]), ...extra], { env: { ...process.env, ...(env || {}) } });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  await srv.close();
  const lines = out.split("\n");
  const m = out.match(/Worker requests this run: (\d+) of (\d+)/);
  return { mode: label || mode, want, re, code, out, lines, m, srv, musts };
}
const results = [];
for (let i = 0; i < CASES.length; i += 3) results.push(...(await Promise.all(CASES.slice(i, i + 3).map(runCase))));
for (const { mode, want, re, code, out, lines, m, srv, musts } of results) {
  ok(`[${mode}] probe exits ${want}`, code === want, `exit ${code}; ${lines.filter((l) => /^FAIL|Worker requests/.test(l)).slice(0, 4).join(" | ")}`);
  if (re) ok(`[${mode}] the failure names the problem`, re.test(out), lines.filter((l) => /^FAIL|Aborting/.test(l)).slice(0, 3).join(" | "));
  for (const [what, rx] of musts || []) ok(`[${mode}] ${what}`, rx.test(out), lines.filter((l) => /^INFO|^  - /.test(l)).slice(0, 5).join(" | "));
  ok(`[${mode}] the request count is printed and within the budget`, !!m && Number(m[1]) <= Number(m[2]), m ? m[0] : "no count line");
  if (mode === "budget-spent") {
    ok("[budget-spent] nothing else started: exactly one FAIL line (the budget), no scene or member-count noise, the second engine never launched", lines.filter((l) => /^FAIL/.test(l)).length === 1 && !/engine firefox is not available/.test(out) && /firefox not run \(budget spent\)/.test(out), lines.filter((l) => /^FAIL|Engines/.test(l)).slice(0, 4).join(" | "));
    ok("[budget-spent] the server saw at most 20 Worker requests", srv.seen.api + srv.seen.ws <= 20, `api ${srv.seen.api}, ws ${srv.seen.ws}`);
  }
  if (mode === "state-redirect") ok("[state-redirect] the redirect was not followed: the local server saw exactly 1 API request and no socket", srv.seen.api === 1 && srv.seen.ws === 0, `api ${srv.seen.api}, ws ${srv.seen.ws}`);
  if (mode === "state-fail") ok("[state-fail] no browser launched: the local server saw at most 1 API request and no socket", srv.seen.api <= 1 && srv.seen.ws === 0, `api ${srv.seen.api}, ws ${srv.seen.ws}`);
  console.log(`INFO [${mode}] ${m ? m[0] : "?"}, local server answered ${srv.seen.api} API requests, ${srv.seen.preflight} CORS preflight(s) and ${srv.seen.ws} socket upgrade(s)`);
}

for (const mode of ["browser", "fetch"]) {
  if (only && !only.includes("redirect")) break;
  // a 12-hop redirect chain answered by the API. Default mode "browser": the browser follows it, every hop is COUNTED and RECORDED (the probe fails on any redirect) and the count is
  // honest. Older mode "fetch": the probe refuses the 3xx before the page sees it, so the server sees exactly one request.
  const srv = await startFixtureServer({ mode: "green" });
  const browser = await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  tearingDown = false;
  const budget = createBudget(40), ctx = await browser.newContext();
  await guardContext(ctx, budget, { mode });
  const page = await ctx.newPage();
  await page.goto(`${srv.origin}/robots.txt`);
  const before = srv.seen.api;
  const result = await page.evaluate(() => fetch("/api/hop").then((r) => `status ${r.status}`, (e) => `failed: ${e.message}`));
  await page.waitForTimeout(800);
  const hops = srv.seen.api - before;
  if (mode === "browser") {
    ok("[redirect] browser mode: the chain is followed by the browser (13 requests reach the server)", /status 200/.test(result) && hops === 13, `${result}; the server saw ${hops}`);
    ok("[redirect] browser mode: every hop is counted (1 routed + 12 hops) and recorded", budget.used === 13 && budget.redirects.length === 12 && /GET .*\/api\/hop -> .*\/api\/hop$/.test(budget.redirects[0]), `used ${budget.used}, recorded ${budget.redirects.length}: ${JSON.stringify(budget.redirects.slice(0, 2))}`);
  } else {
    ok("[redirect] fetch mode: the page's request was refused, not answered through the chain", /failed/.test(result), result);
    ok("[redirect] fetch mode: the server saw exactly 1 request for the chain (not 13)", hops === 1, `the server saw ${hops}`);
    ok("[redirect] fetch mode: the redirect was recorded for the probe to fail on", budget.redirects.length === 1 && /302 GET .*\/api\/hop/.test(budget.redirects[0]), JSON.stringify(budget.redirects));
  }
  console.log(`INFO [redirect ${mode}] counted ${budget.used}, redirects recorded ${budget.redirects.length}, server hits ${hops}`);
  await tearDown(page, ctx, browser, srv);
}

if (!only || only.includes("budget")) {
  const srv = await startFixtureServer({ mode: "green" });
  const browser = await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  tearingDown = false;
  const budget = createBudget(5), ctx = await browser.newContext();
  await guardContext(ctx, budget);
  const page = await ctx.newPage();
  await page.goto(`${srv.origin}/robots.txt`);
  await page.evaluate(async ({ origin }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // a page that will not take no for an answer: 20 sockets (each reconnects on close) and 20 fetches
    for (let i = 0; i < 20; i++) {
      const open = () => { const w = new WebSocket(`${origin.replace(/^http/, "ws")}/api/live`); w.onclose = () => { if (!window.__stopSockets) setTimeout(open, 20); }; };
      open();
      fetch("/api/health").catch(() => {});
      await wait(20);
    }
    await wait(1500);
  }, { origin: srv.origin });
  const reached = srv.seen.api + srv.seen.ws;
  ok("[budget] the budget object counted at most its limit", budget.used <= 5 && budget.exceeded, `used ${budget.used}, exceeded ${budget.exceeded}`);
  ok("[budget] reconnecting sockets and refetches reached the server at most 5 times", reached <= 5, `the server saw ${srv.seen.api} HTTP and ${srv.seen.ws} socket upgrades`);
  console.log(`INFO [budget] limit 5, counted ${budget.used}, refused ${budget.refused}, the server saw ${reached}`);
  await tearDown(page, ctx, browser, srv);
}
if (ignoredAtTeardown) console.log(`INFO [teardown] ${ignoredAtTeardown} closed-target rejection(s) from calls still in flight were ignored while a browser was closed on purpose`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
