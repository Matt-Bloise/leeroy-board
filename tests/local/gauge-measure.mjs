// Measures the request gauge against a REAL local Worker (wrangler dev --local, throwaway D1 folder, made-up admin token). Nothing leaves the machine, no AI.
//   node tests/local/gauge-measure.mjs [--port 8801] [--n 1000] [--keep]
// Not part of `node --test tests/unit/*`: it needs infrastructure/node_modules (npm install there) and starts wrangler dev.
// Phase 1: send --n requests, read the gauge, print sent vs counted (the error of an isolate that lives the whole time).
// Phase 2: send 37 more requests, KILL the Worker with SIGKILL (an eviction with no chance to flush), start it again on the same D1 folder and read the gauge:
//          the difference is what an eviction loses (at most FLUSH_EVERY - 1 = 24).
// Prints the numbers used in docs/runbooks/cloudflare-requests.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), INFRA = path.join(ROOT, "infrastructure");
const argv = process.argv.slice(2), arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const port = Number(arg("--port", 8801)), N = Number(arg("--n", 1000)), keep = argv.includes("--keep");
const TOKEN = "gauge-admin-token-0123456789abcdef", SALT = "gauge-salt-0123456789abcdef";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-measure-")), dir = path.join(tmp, "d1");
const api = `http://127.0.0.1:${port}`;
const wr = (args) => { const r = spawnSync("npx", ["wrangler", ...args], { cwd: INFRA, encoding: "utf8" }); if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).split("\n").filter((l) => /error/i.test(l)).slice(0, 2).join(" | ")}`); };

let dev = null, log = "";
async function start() {
  log = "";
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(port), "--persist-to", dir, "--var", `BOARD_ADMIN_TOKEN:${TOKEN}`, "--var", `KEY_SALT:${SALT}`, "--var", `USER_SALT:${SALT}`, "--var", "REQUEST_GAUGE:on"], { cwd: INFRA, stdio: ["ignore", "pipe", "pipe"], detached: true });
  dev.stdout.on("data", (d) => { log += d; }); dev.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 90; i++) { if (/Ready on/.test(log)) return; if (dev.exitCode !== null) throw new Error(`wrangler dev exited: ${log.slice(-300)}`); await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error("wrangler dev did not become ready in 90 seconds");
}
async function stop(sig) {
  if (!dev || !dev.pid) return;
  for (const s of sig === "SIGKILL" ? ["SIGKILL"] : ["SIGTERM", "SIGKILL"]) { try { process.kill(-dev.pid, s); } catch (e) { break; } await new Promise((r) => setTimeout(r, 800)); }
  dev = null;
}
const gaugeNow = async () => (await (await fetch(`${api}/api/admin/requests`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json());
const logged = () => (log.match(/\[wrangler:inf\] (GET|POST|PUT|OPTIONS|HEAD|DELETE) /g) || []).length;
const sendProbes = async (n) => { for (let i = 0; i < n; i++) { const r = await fetch(`${api}/api/probe`, { method: "POST" }); if (r.status !== 200) throw new Error(`probe answered ${r.status}`); } };

let failed = false;
try {
  wr(["d1", "execute", "leeroy-board-db", "--local", "--persist-to", dir, "--file", path.join(INFRA, "schema.sql")]);
  await start();
  const off = await (await fetch(`${api}/api/admin/requests`)).status;
  console.log(`anonymous GET /api/admin/requests: ${off} (expected 401)`);
  const base = await gaugeNow(); // counts itself: this is request 2 of the run (the 401 above was request 1)
  const log0 = logged();
  await sendProbes(N);
  const g1 = await gaugeNow();
  const sent1 = N + 1, counted1 = g1.count - base.count, logDelta = logged() - log0;
  console.log(`\nPHASE 1 (one Worker instance that lives the whole run)`);
  console.log(`  requests sent (probes + the 2nd gauge read) ${sent1}`);
  console.log(`  wrangler log lines counted over the same span ${logDelta}`);
  console.log(`  gauge counted                                 ${counted1}`);
  console.log(`  error                                         ${counted1 - sent1} (${(((counted1 - sent1) / sent1) * 100).toFixed(2)} %)`);
  const afterP1 = g1.count;
  await sendProbes(37);
  await stop("SIGKILL");
  await start();
  const g2 = await gaugeNow(); // the restarted instance counts this read itself
  const sent2 = 37 + 1, counted2 = g2.count - afterP1, lost = 37 - (counted2 - 1);
  console.log(`\nPHASE 2 (37 probes, then SIGKILL of the Worker with no chance to flush, restart on the same database)`);
  console.log(`  requests sent after the last read             ${sent2} (37 probes + the read after restart)`);
  console.log(`  gauge counted                                 ${counted2}`);
  console.log(`  lost to the kill                              ${lost} (limit: 24 = FLUSH_EVERY - 1)`);
  console.log(`  utcDay ${g2.utcDay}, limit ${g2.limit}, pct ${g2.pct}`);
  if (counted1 !== sent1 && Math.abs(counted1 - sent1) > 0) console.log("  NOTE: phase 1 differs from the requests sent");
  if (lost < 0 || lost > 24) throw new Error(`lost ${lost} is outside 0 to 24`);
  console.log("\nMEASURE DONE");
} catch (e) {
  failed = true;
  console.error(`MEASURE FAILED: ${e.message}`);
} finally {
  await stop();
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(`kept ${tmp}`);
  process.exit(failed ? 1 : 0);
}
