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
//   state-fail       the reference /api/state answers 500                   -> exit 1, no browser launched, at most 1 API request
//   budget           a page that reconnects a socket and refetches 20 times with a budget of 5 -> the server sees at most 5 Worker requests
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "../helpers/probe-fixture-server.mjs";
import { createBudget, guardContext } from "../helpers/probe-budget.mjs";
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
].filter(([m]) => !only || only.includes(m));

async function runCase([mode, want, re, extra]) {
  const srv = await startFixtureServer({ mode });
  const child = spawn(process.execPath, [path.join(here, "prod-probe.mjs"), "--url", srv.url, "--engines", "chromium", "--budget", "200", ...extra], { env: { ...process.env } });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  await srv.close();
  const lines = out.split("\n");
  const m = out.match(/Worker requests this run: (\d+) of 200/);
  return { mode, want, re, code, out, lines, m, srv };
}
const results = [];
for (let i = 0; i < CASES.length; i += 3) results.push(...(await Promise.all(CASES.slice(i, i + 3).map(runCase))));
for (const { mode, want, re, code, out, lines, m, srv } of results) {
  ok(`[${mode}] probe exits ${want}`, code === want, `exit ${code}; ${lines.filter((l) => /^FAIL|Worker requests/.test(l)).slice(0, 4).join(" | ")}`);
  if (re) ok(`[${mode}] the failure names the problem`, re.test(out), lines.filter((l) => /^FAIL|Aborting/.test(l)).slice(0, 3).join(" | "));
  ok(`[${mode}] the request count is printed and within the budget`, !!m && Number(m[1]) <= 200, m ? m[0] : "no count line");
  if (mode === "state-fail") ok("[state-fail] no browser launched: the local server saw at most 1 API request and no socket", srv.seen.api <= 1 && srv.seen.ws === 0, `api ${srv.seen.api}, ws ${srv.seen.ws}`);
  console.log(`INFO [${mode}] ${m ? m[0] : "?"}, local server answered ${srv.seen.api} API requests and ${srv.seen.ws} socket upgrade(s)`);
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
