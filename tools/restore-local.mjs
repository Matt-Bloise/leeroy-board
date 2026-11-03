#!/usr/bin/env node
// Load an export made by tools/pull-export.mjs (GET /api/admin/export) into a LOCAL D1 and check the row counts. Local only: there is no
// --remote option and the wrangler command is always run with --local. This is the restore drill: prove a backup restores before you need it.
//
//   node tools/restore-local.mjs --in <export.ndjson> --persist-to <new folder> [--db leeroy-board-db] [--dry-run] [--reuse]
//
//   --in <file>         The NDJSON export.
//   --persist-to <dir>  Where the local database lives. Must not exist or be empty (a fresh database), unless --reuse. Never the folder of
//                       your everyday `wrangler dev` data (.wrangler/state) unless you really mean it and pass --reuse.
//   --db <name>         D1 binding database name in infrastructure/wrangler.toml. Default leeroy-board-db.
//   --dry-run           Read and check the file, print what would be loaded, run nothing (not even wrangler).
//   --reuse             Allow --persist-to to hold an existing local database (rows are added; duplicates make the run fail).
//   --wrangler <cmd>    Default "npx wrangler", run inside infrastructure/.
//
// What it does: (1) reads the file and refuses anything unexpected: a table that is never exported, a row whose columns differ from its
// page, a page whose end line disagrees with the rows, a table whose last page says more is coming (a partial export), (2) builds the
// schema from infrastructure/schema.sql, (3) inserts every row in table-creation order, (4) counts every table in the new database and
// compares with the file. Exit 0 only when every count matches.
// Secrets: the export holds none, so members come back WITHOUT a working key: each gets a placeholder hash nobody can match. Re-issue keys with
// infrastructure/scripts/hash-key.mjs. Sessions, OAuth tokens and rate-limit counters are not in the export, so signed-in people sign in again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXCLUDED_TABLES, EXCLUDED_COLUMNS } from "../infrastructure/worker/export.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// ---- parsing
// -> { tables: Map(name -> { columns, rows: [obj], complete, pages }), order: [names in manifest order], problems: [string], excluded: [names] }
export function parseExport(text) {
  const problems = [], tables = new Map(), order = [], excluded = [];
  const lines = String(text).split("\n").filter((l) => l.trim());
  let page = null, sawManifest = false, n = 0;
  for (const raw of lines) {
    n++;
    let l;
    try { l = JSON.parse(raw); } catch (e) { problems.push(`line ${n}: not JSON`); continue; }
    if (!l || typeof l !== "object" || typeof l.t !== "string") { problems.push(`line ${n}: no type`); continue; }
    if (l.t === "manifest") { sawManifest = true; continue; }
    if (l.t === "excluded_table") { excluded.push(l.table); continue; }
    if (l.t === "table") {
      if (!IDENT.test(l.table || "") || !Array.isArray(l.columns) || !l.columns.every((c) => IDENT.test(c))) { problems.push(`line ${n}: bad table line`); continue; }
      if (Object.prototype.hasOwnProperty.call(EXCLUDED_TABLES, l.table)) { problems.push(`line ${n}: table ${l.table} is never exported`); continue; }
      if (!tables.has(l.table)) { tables.set(l.table, { columns: l.columns, rows: [], complete: false, pages: 0, expectedColumns: l.columns }); order.push(l.table); }
      continue;
    }
    if (l.t === "page") {
      const t = tables.get(l.table);
      if (!t) { problems.push(`line ${n}: page for a table the manifest did not list: ${l.table}`); page = null; continue; }
      if (JSON.stringify(l.columns) !== JSON.stringify(t.expectedColumns)) problems.push(`line ${n}: page columns of ${l.table} differ from the manifest`);
      page = { table: l.table, rows: 0, columns: l.columns };
      t.pages++;
      continue;
    }
    if (l.t === "row") {
      if (!page || page.table !== l.table) { problems.push(`line ${n}: row outside a page`); continue; }
      const t = tables.get(l.table);
      if (!l.r || typeof l.r !== "object" || JSON.stringify(Object.keys(l.r)) !== JSON.stringify(page.columns)) { problems.push(`line ${n}: row columns differ from the page`); continue; }
      t.rows.push(l.r); page.rows++;
      continue;
    }
    if (l.t === "end") {
      if (!page || page.table !== l.table) { problems.push(`line ${n}: end line outside a page`); continue; }
      if (l.rows !== page.rows) problems.push(`line ${n}: end line of ${l.table} says ${l.rows} rows, the page has ${page.rows}`);
      if (l.next === null) tables.get(l.table).complete = true;
      else tables.get(l.table).complete = false;
      page = null;
      continue;
    }
    problems.push(`line ${n}: unknown line type ${l.t}`);
  }
  if (!sawManifest) problems.push("no manifest line: this is not an export from /api/admin/export");
  if (page) problems.push(`the file ends inside a page of ${page.table}`);
  for (const [name, t] of tables) if (!t.complete) problems.push(`table ${name} is incomplete: its last page says more rows follow`);
  return { tables, order, problems, excluded };
}

// ---- SQL
export function sqlLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite number"); return String(v); }
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`cannot restore a ${typeof v} value`);
}
// A hash nobody can match: no key hashes to it, and it differs per slug (members.key_hash is UNIQUE and 64 characters).
export const placeholderKeyHash = (slug) => createHash("sha256").update(`restored-without-key:${slug}`).digest("hex");

// -> array of statements, parents first (the manifest lists tables in creation order). Members get placeholder hashes.
export function buildSql(parsed) {
  const out = [];
  for (const name of parsed.order) {
    const t = parsed.tables.get(name);
    const excludedCols = EXCLUDED_COLUMNS[name] ? Object.keys(EXCLUDED_COLUMNS[name]) : [];
    for (const row of t.rows) {
      const cols = [...t.columns], vals = cols.map((c) => sqlLiteral(row[c]));
      for (const c of excludedCols) { cols.push(c); vals.push(sqlLiteral(c === "key_hash" && name === "members" ? placeholderKeyHash(row.slug) : null)); }
      out.push(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.join(", ")});`);
    }
  }
  return out;
}

export const expectedCounts = (parsed) => Object.fromEntries(parsed.order.map((n) => [n, parsed.tables.get(n).rows.length]));
// One row, one column per table (scalar subqueries): D1 limits compound SELECTs, so no UNION ALL over 30+ tables.
export const countSql = (names) => `SELECT ${names.map((n) => `(SELECT COUNT(*) FROM "${n}") AS "${n}"`).join(", ")}`;
// kv_state rows the export leaves out are not in the file, so a fresh database has exactly the exported rows.
export function compareCounts(expected, actualRow) {
  const actual = actualRow || {};
  const rows = Object.keys(expected).map((t) => ({ table: t, expected: expected[t], restored: actual[t] === undefined ? null : Number(actual[t]), ok: Number(actual[t]) === expected[t] }));
  return { ok: rows.every((r) => r.ok), rows };
}

// ---- wrangler (local only)
function wrangler(cmd, args, cwd) {
  const parts = cmd.split(/\s+/).filter(Boolean);
  const r = spawnSync(parts[0], [...parts.slice(1), ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`wrangler failed (${r.status}): ${String(r.stderr || r.stdout).split("\n").filter((l) => /error|failed|SQLITE/i.test(l)).slice(0, 3).join(" | ") || "see wrangler output"}`);
  return r.stdout;
}
function jsonOf(stdout) {
  const i = stdout.search(/^\[/m);
  if (i < 0) throw new Error("wrangler printed no JSON");
  return JSON.parse(stdout.slice(i));
}

export function parseArgv(argv) {
  const o = {}, flags = new Set(["dry-run", "reuse", "help"]), known = new Set(["in", "persist-to", "db", "wrangler", ...flags]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (!known.has(k)) throw new Error(`unknown option --${k}${k === "remote" ? " (this tool is local only)" : ""}`);
    if (flags.has(k)) o[k] = true;
    else { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}

export function restore({ file, persistTo, db = "leeroy-board-db", wranglerCmd = "npx wrangler", reuse = false, log = () => {} }) {
  const parsed = parseExport(fs.readFileSync(file, "utf8"));
  if (parsed.problems.length) return { ok: false, stage: "read", problems: parsed.problems };
  const dir = path.resolve(persistTo);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !reuse) return { ok: false, stage: "target", problems: [`${dir} already holds data; pass a new folder or --reuse`] };
  const infra = path.join(ROOT, "infrastructure"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-sql-")), sqlFile = path.join(tmp, "restore.sql");
  try {
    const stmts = buildSql(parsed);
    fs.writeFileSync(sqlFile, ["PRAGMA defer_foreign_keys = true;", ...stmts].join("\n") + "\n", { mode: 0o600 });
    log(`schema: infrastructure/schema.sql`);
    wrangler(wranglerCmd, ["d1", "execute", db, "--local", "--persist-to", dir, "--file", path.join(infra, "schema.sql")], infra);
    log(`loading ${stmts.length} rows into ${parsed.order.length} tables`);
    wrangler(wranglerCmd, ["d1", "execute", db, "--local", "--persist-to", dir, "--file", sqlFile], infra);
    log("counting");
    const out = jsonOf(wrangler(wranglerCmd, ["d1", "execute", db, "--local", "--persist-to", dir, "--json", "--command", countSql(parsed.order)], infra));
    const cmp = compareCounts(expectedCounts(parsed), (out[0] && out[0].results && out[0].results[0]) || {});
    return { ok: cmp.ok, stage: "verify", counts: cmp.rows, members: parsed.tables.has("members") ? parsed.tables.get("members").rows.length : 0 };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  let o;
  try { o = parseArgv(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); return; }
  if (!o.in) { console.error("error: --in is required"); process.exit(2); }
  if (o["dry-run"]) {
    let parsed;
    try { parsed = parseExport(fs.readFileSync(o.in, "utf8")); } catch (e) { console.error(`error: cannot read --in: ${e.message}`); process.exit(2); }
    console.log("DRY RUN: nothing is loaded. Remove --dry-run to restore into a local database.");
    for (const [t, n] of Object.entries(expectedCounts(parsed))) console.log(`  ${t.padEnd(24)} ${String(n).padStart(7)} rows`);
    if (parsed.excluded.length) console.log(`  not in the export (by design): ${parsed.excluded.join(", ")}`);
    if (parsed.problems.length) { console.error("problems:"); for (const p of parsed.problems) console.error(`  ${p}`); process.exit(1); }
    return;
  }
  if (!o["persist-to"]) { console.error("error: --persist-to is required (a new folder for the local database)"); process.exit(2); }
  let res;
  try { res = restore({ file: o.in, persistTo: o["persist-to"], db: o.db, wranglerCmd: o.wrangler, reuse: !!o.reuse, log: (m) => console.log(m) }); }
  catch (e) { console.error(`stopped: ${e.message}`); process.exit(1); }
  if (res.problems) { console.error(`refused (${res.stage}):`); for (const p of res.problems) console.error(`  ${p}`); process.exit(1); }
  for (const r of res.counts) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.table.padEnd(24)} exported ${String(r.expected).padStart(6)}  restored ${String(r.restored).padStart(6)}`);
  if (res.members) console.log(`\n${res.members} member(s) were restored WITHOUT a working key. Re-issue keys: infrastructure/scripts/hash-key.mjs.`);
  console.log(res.ok ? "\nrestore verified: every table count matches" : "\nrestore NOT verified: see FAIL lines");
  process.exit(res.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
