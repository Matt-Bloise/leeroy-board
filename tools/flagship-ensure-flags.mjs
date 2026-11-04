// Production deploy helper: make sure every Flagship flag key the Worker reads EXISTS in the production Flagship app, creating the missing ones with wrangler.
// Node 22, no dependencies. Run from the production deploy job only, after `wrangler deploy` (docs/runbooks/flags.md).
//
//   node tools/flagship-ensure-flags.mjs [--keys infrastructure/flagship-flags.txt] [--toml infrastructure/wrangler.toml] [--dry-run]
//
// What it runs, and nothing else (the whole allowlist is in main()):
//   1. wrangler flagship flags list   <APP_ID> --json --all --remote     (read only)
//   2. wrangler flagship flags create <APP_ID> <KEY> --disabled --remote  (only for a key that list did NOT return)
// It never enables, updates, disables, splits or deletes anything, so an existing flag and its on/off state belong to the owner and survive every deploy.
// A flag created here is created DISABLED: it serves its default variation, off. The owner enables it (dashboard, or `wrangler flagship flags enable`).
// If the list cannot be read (command failed, output not recognisable) NOTHING is created and a ::warning:: is printed. Exit 1 on any problem so the step is visibly
// marked; the workflow step is continue-on-error, so a Flagship problem never blocks a code deploy. The API token is never printed (it is redacted from any output).
//
// NOT verified against the real service (see the PR body): the real output of `list --json --all`, what `create` does for a key that already exists,
// and that 4.148.0 accepts `--disabled` together with `--remote` on a real app. The parsing below is deliberately tolerant and isolated in extractFlagKeys().
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const APP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One key per line; blank lines and `#` comments are ignored. Throws on a line that is not a plain key, so a typo never reaches a command line.
export function parseKeyList(text) {
  const keys = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (!KEY_RE.test(line)) throw new Error(`not a flag key: ${JSON.stringify(line)}`);
    if (!keys.includes(line)) keys.push(line);
  }
  return keys;
}

// The app id from the [[flagship]] block of wrangler.toml (the one place it is written down). null when there is no such block or the id is not a UUID.
export function appIdFromToml(toml) {
  const block = String(toml).match(/^\[\[flagship\]\][^\[]*/m);
  const m = block && block[0].match(/^\s*app_id\s*=\s*"([^"]+)"/m);
  return m && APP_RE.test(m[1]) ? m[1] : null;
}

const LIST_FIELDS = ["flags", "result", "results", "data", "items"];
const keyOf = (f) => (f && typeof f === "object" ? [f.key, f.flagKey, f.flag_key].find((k) => typeof k === "string" && k) : undefined);

// The flag keys in the output of `flags list --json --all`, or null when the output cannot be read. Tolerant of: wrangler banner/warning lines before the JSON,
// a bare array of flags, or an object wrapping the array (flags / result / results / data / items, nested), and of `key`, `flagKey` or `flag_key`.
// An empty list is a valid answer (Set of 0). Any flag without a readable key, or no array at all, is NOT readable: null, so the caller creates nothing.
export function extractFlagKeys(output) {
  const text = String(output ?? "");
  let value;
  for (let i = 0; i < text.length && value === undefined; i++) {
    if (text[i] !== "[" && text[i] !== "{") continue;
    try { value = JSON.parse(text.slice(i)); } catch (e) { /* maybe trailing text: try the largest balanced parse below */ }
    if (value === undefined) {
      const close = text[i] === "[" ? "]" : "}";
      for (let j = text.lastIndexOf(close); j > i && value === undefined; j = text.lastIndexOf(close, j - 1)) {
        try { value = JSON.parse(text.slice(i, j + 1)); } catch (e) { /* keep shrinking */ }
      }
    }
  }
  if (value === undefined) return null;
  const find = (v, depth) => {
    if (Array.isArray(v)) return v;
    if (!v || typeof v !== "object" || depth > 3) return null;
    for (const f of LIST_FIELDS) if (f in v) { const r = find(v[f], depth + 1); if (r) return r; }
    return null;
  };
  const arr = find(value, 0);
  if (!arr) return null;
  const keys = new Set();
  for (const f of arr) { const k = keyOf(f); if (!k) return null; keys.add(k); }
  return keys;
}

export const missingKeys = (wanted, existing) => wanted.filter((k) => !existing.has(k));

const redactor = (secrets) => (s) => secrets.filter((x) => x && x.length >= 6).reduce((t, x) => t.split(x).join("***"), String(s ?? ""));

// run(args) -> { status, stdout, stderr }. Default: `npx wrangler <args>` (or FLAGSHIP_WRANGLER=<program> <args>, used by the tests with a fake program), no shell.
function defaultRun(args, env = process.env) {
  const prog = env.FLAGSHIP_WRANGLER;
  const r = prog ? spawnSync(prog, args, { encoding: "utf8", env }) : spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", env });
  return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
}

export function ensureFlags({ keys, appId, run, log = () => {}, warn = () => {}, dryRun = false, redact = (s) => s }) {
  let problems = 0;
  const bad = (m) => { problems++; warn(m); };
  if (!APP_RE.test(appId || "")) { bad("Flagship app id not found in wrangler.toml [[flagship]]: created nothing"); return { problems, created: [], existing: [], missing: [] }; }
  if (!keys.length) { log("flagship-flags: no keys listed, nothing to do"); return { problems, created: [], existing: [], missing: [] }; }
  const listed = run(["flagship", "flags", "list", appId, "--json", "--all", "--remote"]);
  if (listed.status !== 0) { bad(`could not list Flagship flags (wrangler exit ${listed.status}): ${redact(listed.stderr).trim().split("\n").slice(-3).join(" | ")}. Created nothing.`); return { problems, created: [], existing: [], missing: [] }; }
  const existing = extractFlagKeys(listed.stdout);
  if (!existing) { bad("could not read the Flagship flag list (output not recognised). Created nothing."); return { problems, created: [], existing: [], missing: [] }; }
  const missing = missingKeys(keys, existing), created = [];
  for (const k of keys) if (existing.has(k)) log(`flagship-flags: ${k} exists, left as it is`);
  for (const k of missing) {
    if (dryRun) { log(`flagship-flags: would create ${k} (disabled)`); continue; }
    const r = run(["flagship", "flags", "create", appId, k, "--disabled", "--remote"]);
    if (r.status === 0) { created.push(k); log(`flagship-flags: created ${k} (disabled, serves off until the owner enables it)`); }
    else bad(`could not create Flagship flag ${k} (wrangler exit ${r.status}): ${redact(r.stderr).trim().split("\n").slice(-3).join(" | ")}`);
  }
  return { problems, created, existing: [...existing], missing };
}

function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const keysFile = arg("--keys", path.join(here, "../infrastructure/flagship-flags.txt")), tomlFile = arg("--toml", path.join(here, "../infrastructure/wrangler.toml"));
  const redact = redactor([process.env.CLOUDFLARE_API_TOKEN]);
  const warn = (m) => console.log(`::warning title=Flagship flags::${redact(m)}`);
  let keys, appId;
  try { keys = parseKeyList(fs.readFileSync(keysFile, "utf8")); appId = appIdFromToml(fs.readFileSync(tomlFile, "utf8")); }
  catch (e) { warn(`${e.message}. Created nothing.`); return 1; }
  const res = ensureFlags({ keys, appId, run: (a) => defaultRun(a), log: (m) => console.log(redact(m)), warn, dryRun: argv.includes("--dry-run"), redact });
  return res.problems ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
