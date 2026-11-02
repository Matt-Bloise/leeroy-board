// Runs every browser suite in this folder with the same arguments: live-smoke first, then the rest in name order. Exit 1 when any fails.
// Suites are discovered from the folder, so adding one never edits this file (the old hard-coded list conflicted on every parallel PR).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2);
const helpers = new Set(["run.mjs", "smoke-retry.mjs"]);
const suites = readdirSync(here).filter((f) => f.endsWith(".mjs") && !helpers.has(f)).sort((a, b) => (a === "live-smoke.mjs" ? -1 : b === "live-smoke.mjs" ? 1 : a.localeCompare(b)));
let code = 0;
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(here, f), ...args], { stdio: "inherit" });
  if (r.status !== 0) code = r.status || 1;
}
process.exit(code);
