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
//   cf-text          a console error that only mentions cloudflareinsights.com -> exit 1 (the exemption is by location, not by text)
//   budget-spent     --budget 20 with two engines                           -> exit 1, one budget failure, no scene noise, the second engine never started, server saw <= 20
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
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const L = ["--viewports", "laptop"];
const CASES = [
  ["green", 0, null, []],
  ["wrong-count", 1, /the board shows 6 members but \/api\/state partyDoc lists 7/, L],
  ["typed-five", 1, /copy states the wrong party size: .*five/i, L],
  ["junk", 1, /junk text, .*undefined/i, L],
  ["no-panel", 1, /scene #ledger did not open: there is no #panel-ledger in the page/, L],
  ["ignored-hash", 1, /did not open: the route did not land on .*'s card/, L],
  ["csp-enforced", 1, /console error: Refused to load the image .*Content Security Policy/, L],
  ["csp-report-only", 0, null, L],
  ["state-fail", 1, /Aborting before any browser is launched/, L],
  ["green", 1, /budget: more than 20 Worker requests/, ["--viewports", "laptop,phone", "--budget", "20", "--engines", "chromium,firefox"], "budget-spent"],
  ["state-redirect", 1, /Aborting before any browser is launched/, L],
  ["cf-text", 1, /console error: TypeError: cannot read properties of undefined .*cloudflareinsights/, L],
].filter(([m, , , , label]) => !only || only.includes(label || m));

async function runCase([mode, want, re, extra, label]) {
  const srv = await startFixtureServer({ mode });
  const child = spawn(process.execPath, [path.join(here, "prod-probe.mjs"), "--url", srv.url, ...(extra.includes("--engines") ? [] : ["--engines", "chromium"]), ...(extra.includes("--budget") ? [] : ["--budget", "200"]), ...(extra.includes("--clock") ? [] : ["--clock", DEFAULT_CLOCK]), ...extra], { env: { ...process.env } });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  await srv.close();
  const lines = out.split("\n");
  const m = out.match(/Worker requests this run: (\d+) of (\d+)/);
  return { mode: label || mode, want, re, code, out, lines, m, srv };
}
const results = [];
for (let i = 0; i < CASES.length; i += 3) results.push(...(await Promise.all(CASES.slice(i, i + 3).map(runCase))));
for (const { mode, want, re, code, out, lines, m, srv } of results) {
  ok(`[${mode}] probe exits ${want}`, code === want, `exit ${code}; ${lines.filter((l) => /^FAIL|Worker requests/.test(l)).slice(0, 4).join(" | ")}`);
  if (re) ok(`[${mode}] the failure names the problem`, re.test(out), lines.filter((l) => /^FAIL|Aborting/.test(l)).slice(0, 3).join(" | "));
  ok(`[${mode}] the request count is printed and within the budget`, !!m && Number(m[1]) <= Number(m[2]), m ? m[0] : "no count line");
  if (mode === "budget-spent") {
    ok("[budget-spent] nothing else started: exactly one FAIL line (the budget), no scene or member-count noise, the second engine never launched", lines.filter((l) => /^FAIL/.test(l)).length === 1 && !/engine firefox is not available/.test(out) && /firefox not run \(budget spent\)/.test(out), lines.filter((l) => /^FAIL|Engines/.test(l)).slice(0, 4).join(" | "));
    ok("[budget-spent] the server saw at most 20 Worker requests", srv.seen.api + srv.seen.ws <= 20, `api ${srv.seen.api}, ws ${srv.seen.ws}`);
  }
  if (mode === "state-redirect") ok("[state-redirect] the redirect was not followed: the local server saw exactly 1 API request and no socket", srv.seen.api === 1 && srv.seen.ws === 0, `api ${srv.seen.api}, ws ${srv.seen.ws}`);
  if (mode === "state-fail") ok("[state-fail] no browser launched: the local server saw at most 1 API request and no socket", srv.seen.api <= 1 && srv.seen.ws === 0, `api ${srv.seen.api}, ws ${srv.seen.ws}`);
  console.log(`INFO [${mode}] ${m ? m[0] : "?"}, local server answered ${srv.seen.api} API requests and ${srv.seen.ws} socket upgrade(s)`);
}

if (!only || only.includes("redirect")) {
  // a 12-hop redirect chain answered by the API: one counted request must not become many Worker requests
  const srv = await startFixtureServer({ mode: "green" });
  const browser = await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const budget = createBudget(5), ctx = await browser.newContext();
  await guardContext(ctx, budget);
  const page = await ctx.newPage();
  await page.goto(`${srv.origin}/robots.txt`);
  const before = srv.seen.api;
  const result = await page.evaluate(() => fetch("/api/hop").then((r) => `status ${r.status}`, (e) => `failed: ${e.message}`));
  await page.waitForTimeout(800);
  const hops = srv.seen.api - before;
  ok("[redirect] the page's request was refused, not answered through the chain", /failed/.test(result), result);
  ok("[redirect] the server saw exactly 1 request for the chain (not 13)", hops === 1, `the server saw ${hops}`);
  ok("[redirect] the redirect was recorded for the probe to fail on", budget.redirects.length === 1 && /302 GET .*\/api\/hop/.test(budget.redirects[0]), JSON.stringify(budget.redirects));
  console.log(`INFO [redirect] counted ${budget.used}, redirects recorded ${budget.redirects.length}, server hits ${hops}`);
  await browser.close(); await srv.close();
}

if (!only || only.includes("budget")) {
  const srv = await startFixtureServer({ mode: "green" });
  const browser = await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const budget = createBudget(5), ctx = await browser.newContext();
  await guardContext(ctx, budget);
  const page = await ctx.newPage();
  await page.goto(`${srv.origin}/robots.txt`);
  await page.evaluate(async ({ origin }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // a page that will not take no for an answer: 20 sockets (each reconnects on close) and 20 fetches
    for (let i = 0; i < 20; i++) {
      const open = () => { const w = new WebSocket(`${origin.replace(/^http/, "ws")}/api/live`); w.onclose = () => setTimeout(open, 20); };
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
  await browser.close(); await srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
