// Runs the browser suites in order with the same arguments: live-smoke first, then the votes card check, then axe. Exit 1 when either fails.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2);
let code = 0;
for (const f of ["live-smoke.mjs", "votes-card.mjs", "axe.mjs", "sample-sheet.mjs"]) {
  const r = spawnSync(process.execPath, [path.join(here, f), ...args], { stdio: "inherit" });
  if (r.status !== 0) code = r.status || 1;
}
process.exit(code);
