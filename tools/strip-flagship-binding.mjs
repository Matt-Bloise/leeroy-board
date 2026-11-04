// Remove the Flagship binding from a wrangler config used for a PR preview. Node 22, no dependencies.
//
//   node tools/strip-flagship-binding.mjs <wrangler.toml>   rewrites the file in place
//
// Exit 1 (file untouched) when it cannot guarantee the result has no Flagship binding:
//   - a flagship binding is still there after removing every table block it knows how to remove, such as the dotted/inline forms
//     `flagship.binding = ...`, `flagship = [ {...} ]`, `env.NAME.flagship = ...`
//   - wrangler.json or wrangler.jsonc sits next to the toml file (wrangler reads those BEFORE wrangler.toml, so the toml edit would not apply)
// Removed: the table blocks `[[flagship]]`, `[flagship]`, `[flagship.x]`, `[[env.NAME.flagship]]`, `[env.NAME.flagship]` (and sub-tables).
//
// Used by the PR preview deploy: preview Workers are built from the same wrangler.toml as production and must not read the production Flagship app.
// Without the binding the Worker falls back to the legacy [vars] values (infrastructure/worker/flags.js), so previews stay deterministic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = String.raw`(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)`;
const PATH = String.raw`(?:env\s*\.\s*${NAME}\s*\.\s*)?["']?flagship["']?`;
const HEADER = new RegExp(String.raw`^\s*\[\[?\s*${PATH}\s*(?:\.[^\]]*)?\]\]?\s*(?:#.*)?$`, "i");
const TABLE = /^\s*\[/;
const KEY = new RegExp(String.raw`^\s*${PATH}\s*(?:=|\.)`, "i");

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

// True if an uncommented line still declares a flagship binding (table header, dotted key or inline key).
export const hasFlagship = (toml) => toml.split("\n").some((l) => { const c = l.replace(/\r$/, "").replace(/(^|\s)#.*$/, "$1"); return HEADER.test(c) || KEY.test(c); });

// wrangler.json / wrangler.jsonc next to the toml file take precedence over it.
export const siblingJsonConfigs = (file) => ["wrangler.json", "wrangler.jsonc"].filter((n) => fs.existsSync(path.join(path.dirname(path.resolve(file)), n)));

function main(file) {
  if (!file) { process.stderr.write("usage: node tools/strip-flagship-binding.mjs <wrangler.toml>\n"); return 2; }
  const json = siblingJsonConfigs(file);
  if (json.length) { process.stderr.write(`strip-flagship-binding: ${json.join(" and ")} exists next to ${file}; wrangler reads it before wrangler.toml, so the binding cannot be stripped from the toml alone\n`); return 1; }
  const next = stripFlagship(fs.readFileSync(file, "utf8"));
  if (hasFlagship(next)) { process.stderr.write(`strip-flagship-binding: a flagship binding is still present in ${file} (a form this tool cannot remove)\n`); return 1; }
  fs.writeFileSync(file, next, "utf8");
  process.stderr.write(`strip-flagship-binding: ${file} has no flagship binding\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv[2]);
