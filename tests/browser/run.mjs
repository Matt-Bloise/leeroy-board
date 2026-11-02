// Runs every browser suite in this folder with the same arguments: live-smoke first, then the rest in name order. Exit 1 when any fails.
// Suites are discovered from the folder, so adding one never edits this file (the old hard-coded list conflicted on every parallel PR).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2);
const helpers = new Set(["run.mjs", "smoke-retry.mjs"]);
const suites = readdirSync(here).filter((f) => f.endsWith(".mjs") && !helpers.has(f)).sort((a, b) => (a === "live-smoke.mjs" ? -1 : b === "live-smoke.mjs" ? 1 : a.localeCompare(b)));
// Per PR, degraded-modes.mjs runs only three conditions (API aborted, API answering 500, JavaScript off). The whole suite (144 checks, with the 12 s API hold and
// the slow-network runs that are timing-sensitive on a busy preview) runs nightly against production: .github/workflows/nightly-production.yml. DEGRADED_FULL=1 runs it all here.
// The conditions are Playwright route interception and context options inside the browser (failReq, ctx.route), not server-side flags.
const perSuiteArgs = { "degraded-modes.mjs": process.env.DEGRADED_FULL === "1" ? [] : ["--only", "api-abort,api-500,no-js"] };
let code = 0;
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(here, f), ...args, ...(perSuiteArgs[f] || [])], { stdio: "inherit" });
  if (r.status !== 0) code = r.status || 1;
}
process.exit(code);
