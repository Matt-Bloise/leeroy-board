// Remove the Workers AI binding from a wrangler config used for a PR preview. Node 22, no dependencies.
//
//   node tools/strip-ai-binding.mjs <wrangler.toml>   rewrites the file in place
//
// A preview Worker is built from the same wrangler.toml as production and so carries the `[ai]` binding; a preview that can run a model spends the account's 10,000 Workers AI neurons a day
// (the steward's RULES.md rule 6). The Worker code already refuses to call the binding in a preview (worker/ai-models.js workersAiRun answers a fixed placeholder), and this removes the binding
// as well, so a bug in that code would still find nothing to call. Same shape as tools/strip-flagship-binding.mjs.
//
// Exit 1 (file untouched) when it cannot guarantee the result has no AI binding:
//   - a binding is still there after removing every table block it knows how to remove, such as the dotted or inline forms `ai.binding = ...`, `ai = { binding = ... }`, `env.NAME.ai = ...`
//   - wrangler.json or wrangler.jsonc sits next to the toml file (wrangler reads those BEFORE wrangler.toml, so the toml edit would not apply)
// Removed: the table blocks `[ai]`, `[[ai]]`, `[ai.x]`, `[env.NAME.ai]` (and sub-tables). `[ai_gateway]`-like names and keys that merely contain "ai" are not touched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = String.raw`(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)`;
const PATH = String.raw`(?:env\s*\.\s*${NAME}\s*\.\s*)?["']?ai["']?`;
const HEADER = new RegExp(String.raw`^\s*\[\[?\s*${PATH}\s*(?:\.[^\]]*)?\]\]?\s*(?:#.*)?$`, "i");
const TABLE = /^\s*\[/;
const KEY = new RegExp(String.raw`^\s*${PATH}\s*(?:=|\.)`, "i");

export function stripAi(toml) {
  const out = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (HEADER.test(bare)) { skipping = true; continue; }
    if (skipping && TABLE.test(bare)) skipping = false;
    if (skipping && bare.trim() !== "" && !bare.trim().startsWith("#")) continue; // the table's own keys go; blank lines and comments after it stay (they usually belong to the next section)
    out.push(line);
  }
  return out.join("\n");
}

// True if an uncommented line still declares an AI binding (table header, dotted key or inline key).
export const hasAi = (toml) => toml.split("\n").some((l) => { const c = l.replace(/\r$/, "").replace(/(^|\s)#.*$/, "$1"); return HEADER.test(c) || KEY.test(c); });

// wrangler.json / wrangler.jsonc next to the toml file take precedence over it.
export const siblingJsonConfigs = (file) => ["wrangler.json", "wrangler.jsonc"].filter((n) => fs.existsSync(path.join(path.dirname(path.resolve(file)), n)));

function main(file) {
  if (!file) { process.stderr.write("usage: node tools/strip-ai-binding.mjs <wrangler.toml>\n"); return 2; }
  const json = siblingJsonConfigs(file);
  if (json.length) { process.stderr.write(`strip-ai-binding: ${json.join(" and ")} exists next to ${file}; wrangler reads it before wrangler.toml, so the binding cannot be removed here\n`); return 1; }
  const before = fs.readFileSync(file, "utf8");
  const next = stripAi(before);
  if (hasAi(next)) { process.stderr.write(`strip-ai-binding: an AI binding is still present in ${file} (a form this tool cannot remove)\n`); return 1; }
  if (next === before) { process.stderr.write(`strip-ai-binding: ${file} has no [ai] binding to remove; the layout changed, so this step fails rather than assume previews are safe\n`); return 1; }
  fs.writeFileSync(file, next, "utf8");
  process.stderr.write(`strip-ai-binding: ${file} has no AI binding\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv[2]);
