// Runs every browser suite in this folder with the same arguments: live-smoke first, then the rest in name order. Exit 1 when any fails.
// Suites are discovered from the folder, so adding one never edits this file (the old hard-coded list conflicted on every parallel PR).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orderedSuites, parseShard, shardOf, withoutShard } from "../helpers/shard.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)), rawArgs = process.argv.slice(2);
let shard = null;
try { shard = parseShard(rawArgs); } catch (e) { console.error(e.message); process.exit(2); }
const args = withoutShard(rawArgs).filter((a) => a !== "--list");
// prod-probe.mjs is the production probe (B53): it spends real Worker requests, so only its own workflows run it (deploy-cloudflare.yml, prod-probe-daily.yml). Its selftest (prod-probe-selftest.mjs) is NOT in this list any more: it takes about 17 minutes on its own, so the CI job `browser` runs it as its own matrix legs (--shard i/n), in preview-tests.yml and nightly-production.yml.
const helpers = new Set(["run.mjs", "smoke-retry.mjs", "prod-probe.mjs", "prod-probe-selftest.mjs"]);
// --shard i/n: this job runs every n-th suite of the ordered list (live-smoke stays first, in shard 0); the shards together are the whole list (tests/unit/browser-shards.test.mjs). --list prints the suites of this shard and exits.
const all = orderedSuites(readdirSync(here).filter((f) => f.endsWith(".mjs") && !helpers.has(f)));
const suites = shard ? shardOf(all, shard.index, shard.count) : all;
if (rawArgs.includes("--list")) { for (const f of suites) console.log(f); process.exit(0); }
if (shard) console.log(`browser shard ${shard.index}/${shard.count}: ${suites.length} of ${all.length} suites`);
// Per PR, degraded-modes.mjs runs only three conditions (API aborted, API answering 500, JavaScript off). The whole suite (144 checks, with the 12 s API hold and
// the slow-network runs that are timing-sensitive on a busy preview) runs nightly against production: .github/workflows/nightly-production.yml. DEGRADED_FULL=1 runs it all here.
// The conditions are Playwright route interception and context options inside the browser (failReq, ctx.route), not server-side flags.
const perSuiteArgs = { "degraded-modes.mjs": process.env.DEGRADED_FULL === "1" ? [] : ["--only", "api-abort,api-500,no-js"] };
let code = 0;
for (const f of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, f), ...args, ...(perSuiteArgs[f] || [])], { stdio: "inherit" });
  console.log(`INFO suite ${f} finished in ${Math.round((Date.now() - t0) / 1000)} s, exit ${r.status}`); // a progress line per suite, and the time each one takes
  if (r.status !== 0) code = r.status || 1;
}
process.exit(code);
