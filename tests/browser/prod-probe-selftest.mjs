// Proof that the production probe (prod-probe.mjs) fails when it should and passes when it should. Runs in the PR browser job with ZERO Worker requests:
// the probe is pointed at a local fixture server (tests/helpers/probe-fixture-server.mjs: the repository as static files, /api/* from the recorded snapshot with the
// six-member party), never at Cloudflare. It ignores --url. Chromium only (it tests the judging, not the engines).
//   green        six members, flag on                      -> exit 0
//   wrong-count  /api/state lists one member more           -> exit 1, "shows 6 members but ... 7"
//   typed-five   six members, flag party.n off ("the five") -> exit 1, wrong party size
//   junk         a board line says "undefined NaN"          -> exit 1, junk text
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "../helpers/probe-fixture-server.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const CASES = [
  ["green", 0, null],
  ["wrong-count", 1, /the board shows 6 members but \/api\/state partyDoc lists 7/],
  ["typed-five", 1, /copy states the wrong party size: .*five/i],
  ["junk", 1, /junk text, .*undefined/i],
];
for (const [mode, want, re] of CASES) {
  const srv = await startFixtureServer({ mode });
  const env = { ...process.env };
  const child = spawn(process.execPath, [path.join(here, "prod-probe.mjs"), "--url", srv.url, "--engines", "chromium", "--budget", "150"], { env });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  await srv.close();
  const lines = out.split("\n");
  ok(`[${mode}] probe exits ${want}`, code === want, `exit ${code}; ${lines.filter((l) => /^FAIL|Worker requests/.test(l)).slice(0, 4).join(" | ")}`);
  if (re) ok(`[${mode}] the failure names the problem`, re.test(out), lines.filter((l) => /^FAIL/.test(l)).slice(0, 3).join(" | "));
  const m = out.match(/Worker requests this run: (\d+) of 150/);
  ok(`[${mode}] the request count is printed and within the budget`, !!m && Number(m[1]) <= 150, m ? m[0] : "no count line");
  console.log(`INFO [${mode}] ${m ? m[0] : "?"}, local server answered ${srv.seen.api} API requests`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
