// Remove the [[flagship]] binding from a wrangler.toml. Node 22, no dependencies.
//
//   node tools/strip-flagship-binding.mjs <wrangler.toml>   rewrites the file in place; exit 1 if a flagship binding is still present
//
// Used by the PR preview deploy: preview Workers are built from the same wrangler.toml as production, and must not read the production Flagship app.
// Without the binding the Worker falls back to the legacy [vars] values (infrastructure/worker/flags.js), so previews stay deterministic.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HEADER = /^\s*\[\[?\s*flagship\s*\]\]?\s*(#.*)?$/i;
const TABLE = /^\s*\[/;
const KEY = /^\s*flagship\s*=/i;

export function stripFlagship(toml) {
  const out = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (HEADER.test(bare)) { skipping = true; continue; }
    if (skipping && TABLE.test(bare)) skipping = false;
    if (skipping) continue;
    out.push(line);
  }
  return out.join("\n");
}

// True if an uncommented line still declares a flagship binding (table header or inline key).
export const hasFlagship = (toml) => toml.split("\n").some((l) => { const c = l.replace(/\r$/, "").replace(/(^|\s)#.*$/, "$1"); return HEADER.test(c) || KEY.test(c); });

function main(file) {
  if (!file) { process.stderr.write("usage: node tools/strip-flagship-binding.mjs <wrangler.toml>\n"); return 2; }
  const next = stripFlagship(fs.readFileSync(file, "utf8"));
  if (hasFlagship(next)) { process.stderr.write(`strip-flagship-binding: a flagship binding is still present in ${file}\n`); return 1; }
  fs.writeFileSync(file, next, "utf8");
  process.stderr.write(`strip-flagship-binding: ${file} has no flagship binding\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv[2]);
