// Proves migration 0016 (game_facts, game_fact_loads, the FTS5 index and its triggers) on a REAL, ephemeral D1: the PR preview database. Node 22, no dependencies.
//   node tools/d1-facts-smoke.mjs smoke   [--db <name>]    synthetic rows in, the SAME lookup SQL as worker/game-facts-lookup.js through wrangler d1 execute --remote --json, assertions, rows out. Exit 1 on any failed assertion.
//   node tools/d1-facts-smoke.mjs probe   [--db <name>]    backup probe: plain `wrangler d1 export`, then `--compatibility sqlite3_cli_only` if the installed wrangler has it, and the Worker-side owned export (in process). Never exits 1.
// Run from infrastructure/ (where wrangler.toml and node_modules are), like the neighbouring workflow steps. The database name is $D1_DATABASE_NAME unless --db is given.
// NEVER touches production: refuseUnlessPreviewDb() accepts only leeroy-board-db-pr-<number> and refuses the production name leeroy-board-db (and anything else) before any wrangler call.
// Everything written is fictional ('Test Frostwhirl ...') under load ids that start with 'smoke-', and is deleted again (also when an assertion fails).
// Markdown result lines go to stdout and, when set, to $GITHUB_STEP_SUMMARY.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTokens, buildMatch, buildFtsSql, pickRows } from "../infrastructure/worker/game-facts-lookup.js";

export const PRODUCTION_DB = "leeroy-board-db";
const PREVIEW_DB_RE = /^leeroy-board-db-pr-[0-9]{1,8}$/;
export const SMOKE_LOAD_DONE = "smoke-load-done";
export const SMOKE_LOAD_OPEN = "smoke-load-open";

// -> the name, or throws. The only accepted shape is the per-PR ephemeral database.
export function refuseUnlessPreviewDb(name) {
  if (typeof name !== "string" || !name) throw new Error("no database name: set D1_DATABASE_NAME or pass --db");
  if (name === PRODUCTION_DB) throw new Error(`refusing: '${name}' is the PRODUCTION database`);
  if (!PREVIEW_DB_RE.test(name)) throw new Error(`refusing: '${name}' is not a PR preview database (leeroy-board-db-pr-<number>)`);
  return name;
}

// wrangler d1 --command/--file takes no bound values, so the lookup's `?` placeholders are replaced by SQL literals here. Strings are single-quoted with '' doubling, numbers must be finite.
export function inlineBinds(sql, binds) {
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    if (i >= binds.length) throw new Error("more placeholders than values");
    const v = binds[i++];
    if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite number"); return String(v); }
    if (typeof v === "string") { if (/\u0000/.test(v)) throw new Error("NUL in a value"); return `'${v.replace(/'/g, "''")}'`; }
    throw new Error("unsupported value type");
  });
  if (i !== binds.length) throw new Error("fewer placeholders than values");
  return out;
}

// The JSON of `wrangler d1 execute --json` (it may be preceded by log lines). -> array of statement results, each { results: [...], success }. Throws on anything else.
export function parseWranglerJson(text) {
  const s = String(text || "");
  const i = s.search(/^\[/m);
  if (i < 0) throw new Error("wrangler printed no JSON");
  let arr;
  try { arr = JSON.parse(s.slice(i)); } catch { throw new Error("wrangler JSON did not parse"); }
  if (!Array.isArray(arr)) throw new Error("wrangler JSON is not an array");
  for (const r of arr) if (!r || typeof r !== "object" || r.success === false) throw new Error("a statement reported failure");
  return arr;
}
export const rowsOf = (res, n = 0) => (res[n] && Array.isArray(res[n].results) ? res[n].results : []);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ROW_COLS = "(id, kind, subject, subject_norm, claim, value, unit, source_table, row_id, build, load_id, verdict, source_class, note, superseded, updated_at)";
const factRow = (id, loadId, subject, claim, value, verdict, superseded) =>
  `INSERT INTO game_facts ${ROW_COLS} VALUES (${q(id)}, 'spell_level', ${q(subject)}, ${q(subject.toLowerCase())}, ${q(claim)}, ${q(value)}, 'level', 'spelllevels', ${q(id.split(":")[1])}, '9.9.9.1', ${q(loadId)}, ${q(verdict)}, 'client-db2', '', ${superseded}, '2026-01-01T00:00:00.000Z');`;

export const CLEANUP_SQL = [
  `DELETE FROM game_facts WHERE load_id LIKE 'smoke-load-%';`,
  `DELETE FROM game_fact_loads WHERE id LIKE 'smoke-load-%';`,
].join("\n");

// The rows the smoke writes: a done load with a live row, a superseded row and a wrong row; an OPEN load with a row that must never be served.
export const INSERT_SQL = [
  `INSERT INTO game_fact_loads (id, build, manifest_sha256, files_json, kind, status, counts_json, started_at, finished_at) VALUES (${q(SMOKE_LOAD_DONE)}, '9.9.9.1', '${"a".repeat(64)}', '{}', 'client', 'done', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');`,
  `INSERT INTO game_fact_loads (id, build, manifest_sha256, files_json, kind, status, counts_json, started_at, finished_at) VALUES (${q(SMOKE_LOAD_OPEN)}, '9.9.9.2', '${"b".repeat(64)}', '{}', 'client', 'open', '{}', '2026-01-02T00:00:00.000Z', NULL);`,
  factRow("spelllevels:smoke1", SMOKE_LOAD_DONE, "Test Frostwhirl", "Test Frostwhirl requires level 12.", "12", "holds", 0),
  factRow("spelllevels:smoke2", SMOKE_LOAD_DONE, "Test Frostwhirl Superseded", "Test Frostwhirl Superseded requires level 20.", "20", "holds", 1),
  factRow("spelllevels:smoke3", SMOKE_LOAD_OPEN, "Test Frostwhirl Open", "Test Frostwhirl Open requires level 30.", "30", "holds", 0),
  factRow("spelllevels:smoke4", SMOKE_LOAD_DONE, "Test Frostwhirl Wrong", "Test Frostwhirl Wrong requires level 40.", "40", "wrong", 0),
].join("\n");

export const HOSTILE = `Frostwhirl" OR * NEAR(a b, 2) ^x subject:y {claim}: z '; DROP TABLE game_facts; -- "unbalanced`;

// The lookup SQL, built by the Worker's own builders (imported, not copied), with the values inlined for the CLI.
export function lookupSqlFor(question, fetch = 30) {
  const tokens = extractTokens(question);
  const match = buildMatch(tokens, "wide");
  if (!match) throw new Error("the question has no usable token");
  const { sql, binds } = buildFtsSql(match, fetch);
  return inlineBinds(sql, binds);
}

// Pure: the assertions over what the real D1 answered. -> { ok, lines: [string] }.
export function checkLookup({ lookupRows, hostileRows, ftsCount, integrityOk, afterUpdateCount, afterDeleteCount, inventory }) {
  const lines = [];
  let ok = true;
  const check = (cond, msg) => { lines.push(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) ok = false; };
  const picked = pickRows(lookupRows, 10);
  const ids = picked.rows.map((r) => r.id).sort();
  check(JSON.stringify(ids) === JSON.stringify(["spelllevels:smoke1"]), `FTS MATCH through the Worker's lookup SQL returns exactly the live row of the done load (got ${ids.join(",") || "none"})`);
  check(!lookupRows.some((r) => r.id === "spelllevels:smoke2"), "the superseded row is excluded");
  check(!lookupRows.some((r) => r.id === "spelllevels:smoke3"), "the row of a load that is not done is excluded");
  check(picked.doNotSay.map((r) => r.id).join() === "spelllevels:smoke4", "the wrong row comes back separately as doNotSay");
  check(ftsCount === 4, `the triggers populated the FTS5 index: 4 rows inserted, ${ftsCount} indexed`);
  check(integrityOk === true, "FTS5 integrity-check passes");
  check(Array.isArray(hostileRows), "a hostile question string runs as plain quoted tokens, no error");
  check(afterUpdateCount === 1, `the update trigger re-indexed a changed claim (new word found ${afterUpdateCount} times)`);
  check(afterDeleteCount === 0, `the delete trigger removed the smoke rows from the index (${afterDeleteCount} left)`);
  for (const need of ["game_facts", "game_fact_loads", "game_facts_fts", "game_facts_ai", "game_facts_ad", "game_facts_au"]) check(inventory.includes(need), `${need} exists on the preview D1`);
  return { ok, lines };
}

// ---- running wrangler ------------------------------------------------------------------------------------------------------------------------------
function wrangler(args, { allowFail = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
  if (r.status !== 0 && !allowFail) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (exit ${r.status}): ${firstLine(r.stderr || r.stdout)}`);
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}
export const firstLine = (t) => String(t || "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).find((l) => l && !/^[-=]+$/.test(l)) || "(no output)";
// SELECTs go through --command: on a remote D1, --file is an import and returns no rows. Writes (several statements) go through --file.
function query(db, sql) {
  return parseWranglerJson(wrangler(["d1", "execute", db, "--remote", "--json", "--command", sql]).stdout);
}
function execSql(db, sql) {
  const dir = mkdtempSync(path.join(tmpdir(), "d1-smoke-"));
  const f = path.join(dir, "q.sql");
  try { writeFileSync(f, sql + "\n"); return parseWranglerJson(wrangler(["d1", "execute", db, "--remote", "--json", `--file=${f}`]).stdout); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const summary = (text) => { process.stdout.write(text + "\n"); if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n"); } catch { /* summary is best effort */ } } };

export async function runSmoke(db) {
  refuseUnlessPreviewDb(db);
  let outcome;
  try {
    execSql(db, CLEANUP_SQL); // a leftover of an earlier attempt
    execSql(db, INSERT_SQL);
    const lookupRows = rowsOf(query(db, lookupSqlFor("Test Frostwhirl level")), 0);
    const hostileRows = rowsOf(query(db, lookupSqlFor(HOSTILE)), 0);
    const still = rowsOf(query(db, "SELECT COUNT(*) AS c FROM game_facts WHERE load_id LIKE 'smoke-load-%';"), 0)[0];
    if (!still || still.c !== 4) throw new Error(`the hostile question changed the table (smoke rows now: ${JSON.stringify(still)})`);
    const ftsCount = rowsOf(query(db, `SELECT COUNT(*) AS c FROM game_facts_fts WHERE game_facts_fts MATCH '"frostwhirl"';`), 0)[0].c;
    let integrityOk = false;
    try { query(db, "INSERT INTO game_facts_fts(game_facts_fts) VALUES ('integrity-check');"); integrityOk = true; } catch { integrityOk = false; }
    execSql(db, "UPDATE game_facts SET claim = 'Test Frostwhirl requires level 12 and a Zzyzxquux.' WHERE id = 'spelllevels:smoke1';");
    const afterUpdateCount = rowsOf(query(db, `SELECT COUNT(*) AS c FROM game_facts_fts WHERE game_facts_fts MATCH '"zzyzxquux"';`), 0)[0].c;
    const inv = rowsOf(query(db, "SELECT name FROM sqlite_master WHERE name LIKE 'game_fact%';"), 0).map((r) => r.name);
    execSql(db, CLEANUP_SQL);
    const afterDeleteCount = rowsOf(query(db, `SELECT COUNT(*) AS c FROM game_facts_fts WHERE game_facts_fts MATCH '"frostwhirl"';`), 0)[0].c;
    outcome = checkLookup({ lookupRows, hostileRows, ftsCount, integrityOk, afterUpdateCount, afterDeleteCount, inventory: inv });
  } catch (e) {
    outcome = { ok: false, lines: [`FAIL smoke could not complete: ${e.message}`] };
  } finally {
    try { execSql(db, CLEANUP_SQL); } catch { /* the preview database is deleted with the PR anyway */ }
  }
  summary(["### Game facts on the real preview D1 (migration 0016)", "", `Database: \`${db}\``, "", ...outcome.lines.map((l) => `- ${l}`)].join("\n"));
  return outcome.ok;
}

// ---- the backup probe ------------------------------------------------------------------------------------------------------------------------------
async function ownedExportListsNewTables() {
  try {
    const { schemaDb } = await import("../tests/helpers/sqlite-d1.mjs");
    const { default: worker } = await import("../infrastructure/worker/index.js");
    const db = schemaDb();
    const res = await worker.fetch(new Request("https://probe.test/api/admin/export", { headers: { Authorization: "Bearer probe-token" } }), { DB: db, BOARD_ADMIN_TOKEN: "probe-token", ALLOWED_ORIGINS: "" }, { waitUntil() {}, passThroughOnException() {} });
    const names = (await res.text()).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).filter((o) => o.t === "table").map((o) => o.table);
    const hasBoth = names.includes("game_facts") && names.includes("game_fact_loads");
    const hasFts = names.some((n) => n.startsWith("game_facts_fts"));
    return `${hasBoth && !hasFts ? "yes" : "NO"}: game_facts and game_fact_loads listed, no FTS table listed (${names.length} tables; in-process SQLite from schema.sql, NOT the preview D1)`;
  } catch (e) { return `not testable (${firstLine(e.message)})`; }
}

export async function runProbe(db) {
  refuseUnlessPreviewDb(db);
  const dir = mkdtempSync(path.join(tmpdir(), "d1-export-"));
  const rows = [];
  try {
    const help = wrangler(["d1", "export", "--help"], { allowFail: true });
    const helpText = (help.stdout + help.stderr).trim();
    process.stdout.write(`--- wrangler d1 export --help ---\n${helpText}\n---\n`);
    const hasFlag = /--compatibility/.test(helpText);
    const attempt = (label, extra) => {
      const out = path.join(dir, `${label}.sql`);
      const r = wrangler(["d1", "export", db, "--remote", `--output=${out}`, ...extra], { allowFail: true });
      const size = existsSync(out) ? statSync(out).size : 0;
      const body = existsSync(out) ? readFileSync(out, "utf8") : "";
      const note = r.status === 0 ? `ok (${size} bytes; mentions game_facts_fts: ${/game_facts_fts/.test(body) ? "yes" : "no"})` : `failed: ${firstLine(r.stderr || r.stdout)}`;
      return note;
    };
    rows.push(["plain `wrangler d1 export --remote`", attempt("plain", [])]);
    rows.push(["`--compatibility sqlite3_cli_only`", hasFlag ? attempt("cli", ["--compatibility", "sqlite3_cli_only"]) : "not attempted: the installed wrangler has no --compatibility flag"]);
  } catch (e) { rows.push(["probe", `could not run (${firstLine(e.message)})`]); } finally { rmSync(dir, { recursive: true, force: true }); }
  rows.push(["Worker-side owned export lists the new tables", await ownedExportListsNewTables()]);
  summary(["### Backup probe (informational, never fails the deploy)", "", "| probe | result |", "| --- | --- |", ...rows.map(([a, b]) => `| ${a} | ${String(b).replace(/\|/g, "/")} |`)].join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const i = rest.indexOf("--db");
  const db = i >= 0 ? rest[i + 1] : process.env.D1_DATABASE_NAME;
  try { refuseUnlessPreviewDb(db); } catch (e) { console.error(e.message); process.exit(2); }
  if (mode === "smoke") process.exit((await runSmoke(db)) ? 0 : 1);
  else if (mode === "probe") { try { await runProbe(db); } catch (e) { console.log(`probe error: ${e.message}`); } process.exit(0); }
  else { console.error("usage: node tools/d1-facts-smoke.mjs smoke|probe [--db <name>]"); process.exit(2); }
}
