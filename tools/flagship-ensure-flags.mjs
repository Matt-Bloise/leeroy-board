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
const PAGE_KEYS = new Set(["cursor", "next", "next_cursor", "nextCursor", "next_page", "nextPage"]);
const MORE_KEYS = new Set(["has_more", "hasMore"]);
const keyOf = (f) => (f && typeof f === "object" ? [f.key, f.flagKey, f.flag_key].find((k) => typeof k === "string" && k) : undefined);
const nonEmpty = (v) => v !== null && v !== undefined && v !== "" && v !== false;

// True when a wrapper object (not a flag) says there is more: a non-empty cursor / next, or has_more true. Arrays (the flags themselves) are not scanned.
function morePages(v, depth = 0) {
  if (!v || typeof v !== "object" || Array.isArray(v) || depth > 3) return false;
  for (const [k, val] of Object.entries(v)) {
    if (PAGE_KEYS.has(k) && nonEmpty(val)) return true;
    if (MORE_KEYS.has(k) && val === true) return true;
    if (val && typeof val === "object" && !Array.isArray(val) && morePages(val, depth + 1)) return true;
  }
  return false;
}

// The JSON value in the wrangler output, or undefined. Parsing starts only at a line whose FIRST character is [ or { (a banner or warning line that merely
// contains [] or {} somewhere cannot start it), and ends at a later line that closes it ("]" / "}" first, or the same line for minified JSON). If more than one
// separate JSON block parses (for example a banner line that is itself "[]" followed by the real list) the output is ambiguous: undefined, never a guess.
function jsonBlock(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const found = [];
  for (let s = 0; s < lines.length; s++) {
    if (lines[s][0] !== "[" && lines[s][0] !== "{") continue;
    for (let e = lines.length - 1; e >= s; e--) {
      const last = e === s ? lines[e].trimEnd() : lines[e];
      if (e === s ? !/[\]}]$/.test(last) : !/^[\]}]/.test(last)) continue;
      try { found.push(JSON.parse(lines.slice(s, e + 1).join("\n"))); break; } catch (err) { /* try a shorter block */ }
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

// The flag keys in the output of `flags list --json --all`, or null when the output cannot be trusted as the COMPLETE list. Tolerant of: wrangler banner/warning
// lines around the JSON, a bare array of flags, or an object wrapping the array (flags / result / results / data / items, nested), and of `key`, `flagKey` or `flag_key`.
// An empty list is a valid answer (Set of 0). null (so the caller creates nothing) for: no JSON, an ambiguous output, no array, a flag without a readable key,
// and ANY sign of a further page (non-null cursor / next / next_cursor, has_more true): a partial first page must never look like the whole list.
export function extractFlagKeys(output) {
  const value = jsonBlock(output);
  if (value === undefined) return null;
  if (morePages(value)) return null;
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

// run(args) -> { status, stdout, stderr }. Default: `npx wrangler <args>` (or FLAGSHIP_WRANGLER=<program> <args>, used by the tests with a fake program; a .js/.mjs
// program is run with this node), no shell. Every call has a timeout (60 s; FLAGSHIP_TIMEOUT_MS overrides it for the tests) so a hung wrangler cannot hold up the deploy:
// a timed-out call is a failure like any other (status 1, a message in stderr), so nothing more is created after it.
export const CALL_TIMEOUT_MS = 60000;
function defaultRun(args, env = process.env) {
  const timeout = Number(env.FLAGSHIP_TIMEOUT_MS) > 0 ? Number(env.FLAGSHIP_TIMEOUT_MS) : CALL_TIMEOUT_MS, prog = env.FLAGSHIP_WRANGLER;
  const opts = { encoding: "utf8", env, timeout, killSignal: "SIGKILL" };
  const r = !prog ? spawnSync("npx", ["wrangler", ...args], opts) : /\.m?js$/.test(prog) ? spawnSync(process.execPath, [prog, ...args], opts) : spawnSync(prog, args, opts);
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  return { status: timedOut ? 1 : (r.status ?? 1), stdout: r.stdout || "", stderr: timedOut ? `timed out after ${timeout} ms` : (r.stderr || (r.error ? String(r.error.message) : "")) };
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
