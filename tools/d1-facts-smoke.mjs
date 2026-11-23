// Proves the game-facts store (migration 0016: game_fact_loads, game_facts and two indexes, no virtual table, no trigger) on a REAL, ephemeral D1: the PR preview database. Node 22, no dependencies.
//   node tools/d1-facts-smoke.mjs smoke [--db <name>]        the CI profile: a few dozen fictional facts, under SMALL_ROW_BUDGET (200) rows written in all, cleanup included
//   node tools/d1-facts-smoke.mjs smoke-full [--db <name>]   the measuring profile (300 facts, 770 rows kept for the export): about 2,000 to 3,700 rows written. NOT run in CI (it spent a quarter of the D1 free daily write limit on every spin-up); run it by hand against a preview database when the loader's write cost changes.
// Run from infrastructure/ (where wrangler.toml and node_modules are), like the neighbouring workflow steps. The database name is $D1_DATABASE_NAME unless --db is given.
// NEVER touches production: refuseUnlessPreviewDb() accepts only leeroy-board-db-pr-<number> and refuses the production name leeroy-board-db (and anything else) before any wrangler call.
// What it does, in order (any failed assertion exits 1; everything written is fictional and under load ids that start with 'smoke-', and is deleted again, also on failure):
//   1. lookup: a done load, a superseded row, a not-done load's row, a wrong row, an ambiguous name and rank-suffixed names go in; the Worker's OWN lookupGameFacts runs against the real D1 (its SQL goes through
//      `wrangler d1 execute --remote --json`) and the results are asserted, including a hostile question string.
//   2. writes: a few hundred fictional facts are loaded with the SAME statements the loader sends (UPSERT and finishStatements, exported by worker/game-facts.js), in batches, and meta.rows_written is summed from the D1
//      responses: writes per fact, per rank-suffixed fact, per call, finish, and per retired row, with the projection for the real client and curated loads against the D1 Free limit of 100,000 rows written a day.
//   3. export: a plain `wrangler d1 export --remote` of the preview database MUST succeed (the point of having no virtual table) and the dump MUST contain the smoke rows; the dump is then applied to an in-memory SQLite,
//      and the restore drill (tools/restore-drill.mjs, in process on schema.sql: it has no remote-dump interface) must pass.
// Markdown result lines go to stdout and, when set, to $GITHUB_STEP_SUMMARY.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupGameFacts } from "../infrastructure/worker/game-facts-lookup.js";
import { validateRow, UPSERT, upsertBinds, finishStatements } from "../infrastructure/worker/game-facts.js";
import { WRITES_PER_FACT, WRITES_PER_SUFFIXED_FACT, WRITES_PER_CALL, WRITES_PER_RETIRED_FACT } from "./facts-load.mjs";

export const PRODUCTION_DB = "leeroy-board-db";
const PREVIEW_DB_RE = /^leeroy-board-db-pr-[0-9]{1,8}$/;
export const FREE_ROWS_WRITTEN_PER_DAY = 100000; // https://developers.cloudflare.com/d1/platform/pricing/ (Free plan: 100,000 rows written per day, 5 million rows read per day)
// From the real-table dry run of tools/facts-load.mjs (counts only). REAL_RANK_ROWS are the player-facing shared-name spell rows (deriveRankRows, one fact per spell id and kind) and are INCLUDED in REAL_CLIENT_FACTS;
// REAL_BEFORE_* are the PR 403 numbers without them (18,752 facts, 754 rank-suffixed, 96 calls: 38,742 rows written together with the curated load).
export const REAL_CLIENT_FACTS = 22520, REAL_CLIENT_SUFFIXED = 794, REAL_CLIENT_CALLS = 115, REAL_CURATED_FACTS = 142, REAL_CURATED_CALLS = 3, REAL_RANK_ROWS = 3768;
export const REAL_BEFORE_CLIENT_FACTS = 18752, REAL_BEFORE_CLIENT_SUFFIXED = 754, REAL_BEFORE_CLIENT_CALLS = 96;
export const DEFAULT_RUN_BUDGET = 60000; // tools/facts-load.mjs DEFAULT_ROW_BUDGET
const NOW = "2026-01-01T00:00:00.000Z";

// The sample sizes. FULL is the original measurement (the constants below, which tests/unit/d1-facts-smoke.test.mjs pins). SMALL is what CI runs on every spin-up that needs the smoke: the same
// statements, the same assertions (lookups, writes per fact from D1's own meta, finish and retire, rank rows, plain export, restore drill), on a few dozen rows, so the run writes under
// SMALL_ROW_BUDGET rows even if D1 counts every delete as two (2,000 to 3,700 before). The small loads still go in several batches (batch 4 against 50: 10 facts are three calls, so the batching loop and the
// multi-statement call are exercised), but never a call of 50 statements: a limit that bites only at that size is the one thing the full profile shows and this does not (run smoke-full by hand when the loader's batching changes). The projections to the real client load use the per-row costs measured here, which do not depend on the sample size.
export const SMALL_ROW_BUDGET = 200; // the target: over it the step prints a warning
export const SMALL_ROW_HARD_LIMIT = 400; // twice the target: over it the step FAILS (a runaway, or D1 counting far more than the estimate)
export const FULL = Object.freeze({ name: "full", facts: 300, suffixed: 30, kinds: Object.freeze({ spell_cooldown: 200, spell_cast_time: 100 }), batch: 50, probe: [200, 260], keep: [[0, 100], [200, 250]], fresh: 20, rankSpells: 60, rankRanks: 5, rowBudget: null, hardRowLimit: null });
export const SMALL = Object.freeze({ name: "small", facts: 10, suffixed: 2, kinds: Object.freeze({ spell_cooldown: 6, spell_cast_time: 4 }), batch: 4, probe: [6, 10], keep: [[0, 3], [6, 8]], fresh: 2, rankSpells: 1, rankRanks: 5, rowBudget: SMALL_ROW_BUDGET, hardRowLimit: SMALL_ROW_HARD_LIMIT });

// -> the name, or throws. The only accepted shape is the per-PR ephemeral database.
export function refuseUnlessPreviewDb(name) {
  if (typeof name !== "string" || !name) throw new Error("no database name: set D1_DATABASE_NAME or pass --db");
  if (name === PRODUCTION_DB) throw new Error(`refusing: '${name}' is the PRODUCTION database`);
  if (!PREVIEW_DB_RE.test(name)) throw new Error(`refusing: '${name}' is not a PR preview database (leeroy-board-db-pr-<number>)`);
  return name;
}

// wrangler d1 --command takes no bound values, so the statements' `?` placeholders are replaced by SQL literals here. Strings are single-quoted with '' doubling, numbers must be finite.
export function inlineBinds(sql, binds) {
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    if (i >= binds.length) throw new Error("more placeholders than values");
    const v = binds[i++];
    if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite number"); return String(v); }
    if (typeof v === "string") { if (/\u0000/.test(v)) throw new Error("NUL in a value"); return `'${v.replace(/'/g, "''")}'`; }
    if (v === null) return "NULL";
    throw new Error("unsupported value type");
  });
  if (i !== binds.length) throw new Error("fewer placeholders than values");
  return out;
}

// The JSON of `wrangler d1 execute --json` (it may be preceded by log lines). -> array of statement results, each { results: [...], success, meta }. Throws on anything else.
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
// Sum of meta.<field> over every statement result. Throws when a result has no numeric meta field: a measurement must never silently read as 0.
export function sumMeta(res, field) {
  let total = 0;
  for (const r of res) {
    const v = r && r.meta ? r.meta[field] : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`a D1 response has no numeric meta.${field}`);
    total += v;
  }
  return total;
}
export const firstLine = (t) => String(t || "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).find((l) => l && !/^[-=]+$/.test(l)) || "(no output)";

// ---- the rows ------------------------------------------------------------------------------------------------------------------------------------------
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const factRow = (id, kind, loadId, subject, claim, value, verdict, superseded) => {
  const v = validateRow({ id, kind, subject, claim, value, unit: "level", source_table: "spelllevels", row_id: id.split(":")[1], build: "9.9.9.1", verdict, source_class: "client-db2", note: "" }, "client");
  if (!v.row) throw new Error(`bad smoke row ${id}: ${v.error}`);
  const r = v.row;
  return `INSERT INTO game_facts (id, load_id, kind, subject, subject_norm, subject_base, claim, value, unit, source_table, row_id, build, verdict, source_class, note, superseded, updated_at) VALUES (${[r.id, loadId, r.kind, r.subject, r.subject_norm, r.subject_base, r.claim, r.value, r.unit, r.source_table, r.row_id, r.build, r.verdict, r.source_class, r.note].map(q).join(", ")}, ${superseded}, ${q(NOW)});`;
};
const loadRow = (id, status, finished) => `INSERT INTO game_fact_loads (id, build, manifest_sha256, files_json, kind, status, counts_json, started_at, finished_at) VALUES (${q(id)}, '9.9.9.1', '${"a".repeat(64)}', '{}', 'client', ${q(status)}, '{}', '2026-01-01T00:00:00.000Z', ${finished ? q(finished) : "NULL"});`;

export const SMOKE_LOAD_DONE = "smoke-load-done";
export const SMOKE_LOAD_OPEN = "smoke-load-open";
export const CLEANUP_SQL = [
  `DELETE FROM game_facts WHERE load_id LIKE 'smoke-load-%';`,
  `DELETE FROM game_fact_loads WHERE id LIKE 'smoke-load-%';`,
  `DELETE FROM kv_state WHERE key = 'smoke_facts_state';`,
].join("\n");

// The rows of part 1: a done load with a live row, a superseded row, a wrong row, an ambiguous name (two rows of one kind), a rank-suffixed name and its base; an OPEN load with a row that must never be served.
export const INSERT_SQL = [
  loadRow(SMOKE_LOAD_DONE, "done", "2026-01-01T00:01:00.000Z"),
  loadRow(SMOKE_LOAD_OPEN, "open", null),
  factRow("spelllevels:s1", "spell_level", SMOKE_LOAD_DONE, "Test Frostwhirl", "Test Frostwhirl requires level 12.", "12", "holds", 0),
  factRow("spelllevels:s2", "spell_level", SMOKE_LOAD_DONE, "Test Frostwhirl Superseded", "Test Frostwhirl Superseded requires level 20.", "20", "holds", 1),
  factRow("spelllevels:s3", "spell_level", SMOKE_LOAD_OPEN, "Test Frostwhirl Open", "Test Frostwhirl Open requires level 30.", "30", "holds", 0),
  factRow("spelllevels:s4", "spell_level", SMOKE_LOAD_DONE, "Test Frostwhirl Wrong", "Test Frostwhirl Wrong requires level 40.", "40", "wrong", 0),
  factRow("spelllevels:s5", "spell_level", SMOKE_LOAD_DONE, "Test Twinbolt", "Test Twinbolt requires level 5.", "5", "holds", 0),
  factRow("spelllevels:s6", "spell_level", SMOKE_LOAD_DONE, "Test Twinbolt", "Test Twinbolt requires level 9.", "9", "holds", 0),
  factRow("spelllevels:s7", "spell_level", SMOKE_LOAD_DONE, "Test Spiritwave III", "Test Spiritwave III requires level 33.", "33", "holds", 0),
  factRow("spelllevels:s8", "spell_level", SMOKE_LOAD_DONE, "Test Ripplestrike", "Test Ripplestrike requires level 7.", "7", "holds", 0),
].join("\n");

export const HOSTILE = `Frostwhirl" OR * NEAR(a b, 2) ^x subject:y {claim}: z '; DROP TABLE game_facts; -- "unbalanced`;

// A `DB` for lookupGameFacts that runs each prepared statement on the REAL D1 through wrangler. The statement text is the Worker's own; only the bound values are inlined.
export function remoteDb(run) {
  return { prepare: (sql) => ({ bind: (...binds) => ({ all: async () => ({ results: rowsOf(run(inlineBinds(sql, binds)), 0) }) }) }) };
}

// Pure: the assertions of part 1 over what lookupGameFacts answered. look(name) -> the answer for the question the smoke asked.
export function checkLookups(a) {
  const lines = [];
  let ok = true;
  const check = (cond, msg) => { lines.push(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) ok = false; };
  const ids = (x) => x.rows.map((r) => r.id).sort().join(",");
  check(ids(a.live) === "spelllevels:s1" && a.live.via === "names", `the live row of a done load is found by name through the (kind, subject_norm) index (got ${ids(a.live) || "none"})`);
  check(!ids(a.superseded).includes("s2"), "a superseded row is excluded");
  check(!ids(a.open).includes("s3"), "the row of a load that is not done is excluded");
  check(a.wrong.doNotSay.map((r) => r.id).join() === "spelllevels:s4" && !ids(a.wrong).includes("s4"), "a wrong row comes back separately as doNotSay");
  check(a.twin.ambiguous === true && ids(a.twin) === "spelllevels:s5,spelllevels:s6", `a name with two rows returns both ids and ambiguous=true (got ${ids(a.twin) || "none"}, ambiguous ${a.twin.ambiguous})`);
  check(ids(a.baseDirection) === "spelllevels:s7", `the base name "Test Spiritwave" finds "Test Spiritwave III" through the partial (kind, subject_base) index (got ${ids(a.baseDirection) || "none"})`);
  check(ids(a.fullDirection) === "spelllevels:s7", `the full name "Test Spiritwave III" finds its own row (got ${ids(a.fullDirection) || "none"})`);
  check(ids(a.rankQuestion) === "spelllevels:s8", `a question "Test Ripplestrike Rank 4" finds the name without its rank (got ${ids(a.rankQuestion) || "none"})`);
  check(a.hostile.via === "names" && a.hostile.rows.every((r) => r.id.startsWith("spelllevels:s")), "a hostile question string runs as bound values, no error, and returns only smoke rows");
  check(a.tableIntact === true, "the hostile question changed nothing");
  return { ok, lines };
}

// ---- the write measurement ---------------------------------------------------------------------------------------------------------------------------
export const MEASURE_FACTS = 300, MEASURE_SUFFIXED = 30, MEASURE_BATCH = 50;
export const MEASURE_KINDS = Object.freeze({ spell_cooldown: 200, spell_cast_time: 100 });
const WORDS = ["Amber", "Brisk", "Cinder", "Dusk", "Ember", "Frost", "Gale", "Hollow", "Iron", "Jade"];
// n fictional facts: 200 spell_cooldown and 100 spell_cast_time, the last MEASURE_SUFFIXED of the cooldowns with a rank suffix. Built through validateRow, the loader's own validation.
export function measureRows(prefix, from = 0, to = MEASURE_FACTS, profile = FULL) {
  const out = [];
  for (let i = from; i < to; i++) {
    const kind = i < profile.kinds.spell_cooldown ? "spell_cooldown" : "spell_cast_time";
    const suffixed = i >= profile.kinds.spell_cooldown - profile.suffixed && i < profile.kinds.spell_cooldown;
    const subject = `Test ${prefix} ${WORDS[i % 10]} ${WORDS[Math.floor(i / 10) % 10]} ${i}${suffixed ? " Rank 3" : ""}`;
    const v = validateRow({ id: `${kind === "spell_cooldown" ? "spellcooldowns" : "spellmisc"}:${prefix}${i}`, kind, subject, claim: `${subject} has a cooldown of ${i + 1} seconds.`, value: String(i + 1), unit: "seconds", source_table: kind === "spell_cooldown" ? "spellcooldowns" : "spellmisc", row_id: `${prefix}${i}`, build: "9.9.9.1", verdict: "holds", source_class: "client-db2", note: "" }, "client");
    if (!v.row) throw new Error(`bad measure row ${i}: ${v.error}`);
    out.push(v.row);
  }
  return out;
}
// RANK_FACTS fictional rank rows: RANK_SPELLS names with ranks 1..RANK_RANKS each, spell_level, with the note the loader writes ('rank=<n>;class=Test Mage'), ids keyed by a table row id. Built through validateRow.
export const RANK_SPELLS = 60, RANK_RANKS = 5, RANK_FACTS = RANK_SPELLS * RANK_RANKS;
export const RANK_LOAD = "smoke-load-m3";
export function rankRows(profile = FULL) {
  const out = [];
  for (let n = 0; n < profile.rankSpells; n++) {
    const name = `Test Rankbolt ${WORDS[n % 10]} ${WORDS[Math.floor(n / 10) % 10]} ${n}`;
    for (let k = 1; k <= profile.rankRanks; k++) {
      const v = validateRow({ id: `spelllevels:R${n}x${k}`, kind: "spell_level", subject: name, claim: `${name} (Rank ${k}) requires level ${k * 4}.`, value: String(k * 4), unit: "level", source_table: "spelllevels", row_id: `R${n}x${k}`, build: "9.9.9.1", verdict: "holds", source_class: "client-db2", note: `rank=${k};class=Test Mage` }, "client");
      if (!v.row) throw new Error(`bad rank row ${n}/${k}: ${v.error}`);
      out.push(v.row);
    }
  }
  return out;
}
// Pure: an UPPER estimate of the rows one run of the profile writes, counting every delete as a write at the insert price (D1 delete accounting is not verified, so this is the worst case): the lookup
// rows and their cleanup, the two measured loads and the rank load, the probe and its deletion, the kv_state rows, the finishes and the final cleanup of everything that is still in the table.
// tests/unit/d1-facts-smoke.test.mjs holds SMALL under SMALL_ROW_BUDGET with it; the real run counts meta.rows_written and fails when it exceeds the budget.
export function estimateRowsWritten(profile) {
  const rows = (n, suffixed = 0) => n * WRITES_PER_FACT + suffixed * WRITES_PER_SUFFIXED_FACT;
  const loadRow = 2; // a game_fact_loads row: text primary key + its row
  const part1 = (10 - 2) * WRITES_PER_FACT + 2 * loadRow; // INSERT_SQL: 8 facts, 2 load rows
  const part1Cleanup = part1; // deleted again before part 2
  const probe = rows(profile.probe[1] - profile.probe[0]);
  const keep = profile.keep.reduce((n, [a, b]) => n + (b - a), 0);
  const loadB = rows(keep + profile.fresh);
  const rank = rows(profile.rankSpells * profile.rankRanks);
  const kv = 2 + 1 + 1; // smoke_facts_state insert, two updates
  const calls = 2; // the counters updates
  const finishes = 3 + (profile.facts * WRITES_PER_RETIRED_FACT); // three finish statements, and the retired rows of load A
  const opens = 3 * loadRow + loadRow; // m1, m2, ranks, and the probe load
  const loadA = rows(profile.facts, profile.suffixed);
  const writes = part1 + part1Cleanup + opens + loadA + probe + probe + loadRow + loadB + rank + kv + calls + finishes;
  const finalCleanup = rows(profile.facts + keep + profile.fresh + profile.rankSpells * profile.rankRanks) + 3 * loadRow + 2; // what is still in the table when the run ends
  return writes + finalCleanup;
}
export const countKinds = (rows) => rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});

// Pure: the projection from the measured numbers. m: { perFact, perSuffixedExtra, perCall, finishFixed, perRetired }.
export function project(m) {
  const first = (facts, suffixed, calls) => Math.ceil(facts * m.perFact + suffixed * m.perSuffixedExtra + calls * m.perCall + m.finishFixed);
  const client = first(REAL_CLIENT_FACTS, REAL_CLIENT_SUFFIXED, REAL_CLIENT_CALLS);
  const clientBefore = first(REAL_BEFORE_CLIENT_FACTS, REAL_BEFORE_CLIENT_SUFFIXED, REAL_BEFORE_CLIENT_CALLS);
  const rankRowsWritten = Math.ceil(REAL_RANK_ROWS * (m.perRankRow === undefined ? m.perFact : m.perRankRow));
  const curated = first(REAL_CURATED_FACTS, 0, REAL_CURATED_CALLS);
  const rebuild = client + Math.ceil(REAL_CLIENT_FACTS * m.perRetired); // a second load of a new build: every new row written and every old row retired
  const total = client + curated;
  return { client, clientBefore, beforeTotal: clientBefore + curated, rankRowsWritten, curated, firstLoadTotal: total, daysAtLimit: Math.ceil(total / FREE_ROWS_WRITTEN_PER_DAY), runsAtDefaultBudget: Math.ceil(total / DEFAULT_RUN_BUDGET), rebuild, pctFirst: ((client + curated) / FREE_ROWS_WRITTEN_PER_DAY) * 100, pctRebuild: (rebuild / FREE_ROWS_WRITTEN_PER_DAY) * 100 };
}
const r2 = (n) => Math.round(n * 100) / 100;

// Pure: the checks of part 2 and 3 over the measurements. -> { ok, lines }.
export function checkMeasurements(m, exp) {
  const lines = [];
  let ok = true;
  const check = (cond, msg) => { lines.push(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) ok = false; };
  check(m.perFact <= WRITES_PER_FACT + 0.001, `measured writes per fact ${r2(m.perFact)} are within the tool's constant WRITES_PER_FACT = ${WRITES_PER_FACT}`);
  check(m.perSuffixedExtra <= WRITES_PER_SUFFIXED_FACT + 0.001, `measured extra writes per rank-suffixed fact ${r2(m.perSuffixedExtra)} are within WRITES_PER_SUFFIXED_FACT = ${WRITES_PER_SUFFIXED_FACT}`);
  check(m.perRankRow !== undefined && m.perRankRow <= WRITES_PER_FACT + 0.001, `measured writes per rank row (note and rank in the claim, no suffix) ${m.perRankRow === undefined ? "missing" : r2(m.perRankRow)} are within WRITES_PER_FACT = ${WRITES_PER_FACT}`);
  check(exp.rankLookupOk === true, "on the real D1 a question 'Test Rankbolt ... rank 4' returns exactly the rank-4 row with rank 4 and the class hint, and a question without a rank returns all five ranks in order");
  check(m.perCall <= WRITES_PER_CALL + 0.001, `measured writes per call ${r2(m.perCall)} are within WRITES_PER_CALL = ${WRITES_PER_CALL}`);
  check(m.perRetired <= WRITES_PER_RETIRED_FACT + 0.001, `measured writes per retired fact ${r2(m.perRetired)} are within WRITES_PER_RETIRED_FACT = ${WRITES_PER_RETIRED_FACT}`);
  check(m.retired === exp.retired, `finish retired all ${exp.retired} rows of the previous load: the re-sent ones are replaced by the new load's rows, the rest are gone from the new build (${m.retired})`);
  check(exp.exportOk === true, `plain \`wrangler d1 export --remote\` succeeded on the preview D1${exp.exportError ? ` (${exp.exportError})` : ""}`);
  check(exp.dumpHasRows === true, "the dump contains the game_facts rows loaded by the smoke");
  check(exp.drillOk === true, "the restore drill passes (in process on schema.sql; it has no remote-dump interface)");
  return { ok, lines };
}

// ---- running wrangler ------------------------------------------------------------------------------------------------------------------------------
function wrangler(args, { allowFail = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300000 });
  if (r.status !== 0 && !allowFail) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (exit ${r.status}): ${firstLine(r.stderr || r.stdout)}`);
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}
// One or several statements through --command (a remote --file is an import and returns no rows or meta).
// Every statement result carries meta.rows_written: the run adds them all up (lookups, measurements, cleanup), so the job summary states what the smoke really wrote.
let rowsWrittenTotal = 0;
const command = (db, sql) => {
  const res = parseWranglerJson(wrangler(["d1", "execute", db, "--remote", "--json", "--command", sql]).stdout);
  for (const r of res) if (r && r.meta && typeof r.meta.rows_written === "number" && Number.isFinite(r.meta.rows_written)) rowsWrittenTotal += r.meta.rows_written;
  return res;
};
const summary = (text) => { process.stdout.write(text + "\n"); if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n"); } catch { /* summary is best effort */ } } };

// Loads `rows` like the loader does: the UPSERT statement of the Worker, MEASURE_BATCH at a time. -> total rows_written, and rows_written of the rows with a base name.
function upsertAll(db, loadId, rows, batch = MEASURE_BATCH) {
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const stmts = rows.slice(i, i + batch).map((r) => inlineBinds(UPSERT, upsertBinds(r, loadId, NOW)));
    written += sumMeta(command(db, stmts.join(";\n")), "rows_written");
  }
  return written;
}
const finishOn = (db, loadId, declared, total) => {
  const stmts = finishStatements(loadId, declared, { kinds: declared, total, added: 0, changed: 0, unchanged: 0, removed: 0 }, "2026-01-02T00:00:00.000Z").map((s) => inlineBinds(s.sql, s.binds));
  const res = command(db, stmts.join(";\n"));
  return { written: sumMeta(res, "rows_written"), read: sumMeta(res, "rows_read") };
};
const openLoad = (db, id) => sumMeta(command(db, loadRow(id, "open", null)), "rows_written");

export async function runSmoke(db, { profile = SMALL } = {}) {
  refuseUnlessPreviewDb(db);
  const P = profile;
  rowsWrittenTotal = 0;
  const tmp = mkdtempSync(path.join(tmpdir(), "d1-smoke-"));
  const out = [];
  let ok = true;
  const add = (r) => { out.push(...r.lines.map((l) => `- ${l}`)); if (!r.ok) ok = false; };
  try {
    command(db, CLEANUP_SQL);
    // ---- 1. lookups on the real D1
    command(db, INSERT_SQL);
    const env = { DB: remoteDb((sql) => command(db, sql)) };
    const ask = (question) => lookupGameFacts(env, question, { limit: 10 });
    const a = {
      live: await ask("What level is Test Frostwhirl?"), superseded: await ask("Test Frostwhirl Superseded"), open: await ask("Test Frostwhirl Open"), wrong: await ask("Test Frostwhirl Wrong"),
      twin: await ask("What level is Test Twinbolt?"), baseDirection: await ask("What level is Test Spiritwave?"), fullDirection: await ask("What level is Test Spiritwave III?"),
      rankQuestion: await ask("What level is Test Ripplestrike Rank 4?"), hostile: await ask(HOSTILE),
    };
    a.tableIntact = rowsOf(command(db, "SELECT COUNT(*) AS c FROM game_facts WHERE load_id LIKE 'smoke-load-%';"), 0)[0].c === 8;
    add(checkLookups(a));

    // ---- 2. rows written
    command(db, CLEANUP_SQL);
    const m1 = "smoke-load-m1", m2 = "smoke-load-m2";
    const rowsA = measureRows("A", 0, P.facts, P);
    const beginWrites = openLoad(db, m1);
    const wA = upsertAll(db, m1, rowsA, P.batch);
    const suffixed = rowsA.filter((r) => r.subject_base);
    // per fact: a separate small load of plain-named rows, so the suffix cost is measured apart
    const probeId = "smoke-load-m0";
    openLoad(db, probeId);
    const plainProbe = measureRows("P", P.probe[0], P.probe[1], P); // spell_cast_time rows, no suffix
    const wPlain = upsertAll(db, probeId, plainProbe, P.batch);
    command(db, "DELETE FROM game_facts WHERE load_id = 'smoke-load-m0';\nDELETE FROM game_fact_loads WHERE id = 'smoke-load-m0';"); // the probe rows must not be retired by the finish below
    const kvW = sumMeta(command(db, `INSERT INTO kv_state (key, json, updated_at) VALUES ('smoke_facts_state', '{"last_ts":1,"hits":[1]}', 'x');\nUPDATE kv_state SET json = '{"last_ts":2,"hits":[1,2]}', updated_at = 'y' WHERE key = 'smoke_facts_state' AND json = '{"last_ts":1,"hits":[1]}';`), "rows_written");
    const kvUpdateW = sumMeta(command(db, `UPDATE kv_state SET json = '{"last_ts":3,"hits":[1,2,3]}', updated_at = 'z' WHERE key = 'smoke_facts_state' AND json = '{"last_ts":2,"hits":[1,2]}';`), "rows_written");
    const countsW = sumMeta(command(db, `UPDATE game_fact_loads SET counts_json = '{"kinds":{},"added":300,"changed":0}' WHERE id = ${q(m1)} AND status = 'open';`), "rows_written");
    const finA = finishOn(db, m1, P.kinds, P.facts);
    // second load: re-sends 150 of the 300 (the first 100 cooldowns and the first 50 cast times), plus 20 new ones; finish retires ALL 300 older rows (150 replaced, 150 gone)
    openLoad(db, m2);
    const keep = P.keep.flatMap(([from, to]) => measureRows("A", from, to, P));
    const fresh = measureRows("B", 0, P.fresh, P);
    upsertAll(db, m2, [...keep, ...fresh], P.batch);
    const declared2 = countKinds([...keep, ...fresh]);
    const finB = finishOn(db, m2, declared2, keep.length + fresh.length);
    const retired = rowsOf(command(db, "SELECT COUNT(*) AS c FROM game_facts WHERE load_id = 'smoke-load-m1' AND superseded = 1;"), 0)[0].c;
    // ranks: a few hundred synthetic rank rows (the shape deriveRankRows writes), their writes per row from D1's own meta, then the Worker's lookup on the real D1
    const rk = rankRows(P);
    openLoad(db, RANK_LOAD);
    const wRank = upsertAll(db, RANK_LOAD, rk, P.batch);
    finishOn(db, RANK_LOAD, { spell_level: rk.length }, rk.length);
    const rl = await lookupGameFacts({ DB: remoteDb((sql) => command(db, sql)) }, "What level is Test Rankbolt Amber Amber 0 rank 4?", { limit: 10 });
    const rlAll = await lookupGameFacts({ DB: remoteDb((sql) => command(db, sql)) }, "when do I get Test Rankbolt Amber Amber 0", { limit: 10 });
    const rankLookupOk = rl.rows.length === 1 && rl.rows[0].rank === 4 && rl.rows[0].value === "16" && rl.rows[0].hint === "Test Mage" && rlAll.rows.map((r) => r.rank).join() === "1,2,3,4,5";
    const measured = {
      perFact: wPlain / plainProbe.length,
      perSuffixedExtra: Math.max(0, (wA - rowsA.length * (wPlain / plainProbe.length)) / suffixed.length), // what a rank-suffixed fact costs ABOVE a plain one
      perCall: kvUpdateW + countsW,
      finishFixed: finA.written,
      perRetired: retired ? Math.max(0, (finB.written - finA.written) / retired) : 0,
      retired,
      perRankRow: wRank / rk.length,
    };
    const proj = project(measured);
    out.push("", "| measured on the preview D1 (rows written, from D1 meta.rows_written) | value |", "| --- | --- |",
      `| facts loaded (load A ${rowsA.length} + probe ${plainProbe.length} + load B ${keep.length + fresh.length}) | ${rowsA.length + plainProbe.length + keep.length + fresh.length} |`,
      `| rows written, load A (${rowsA.length} facts, ${suffixed.length} rank-suffixed) | ${wA} |`,
      `| **writes per fact** (plain name, ${plainProbe.length} facts: ${wPlain} rows) | **${r2(measured.perFact)}** |`,
      `| extra writes per rank-suffixed fact (partial base index) | ${r2(measured.perSuffixedExtra)} |`,
      `| writes per signed call: kv_state update ${kvUpdateW} + load counters update ${countsW} | ${r2(measured.perCall)} |`,
      `| begin (insert of the load row) | ${beginWrites} |`,
      `| finish with nothing to retire (rows written / rows read) | ${finA.written} / ${finA.read} |`,
      `| finish retiring ${retired} rows (rows written / rows read) | ${finB.written} / ${finB.read} |`,
      `| **writes per rank row** (${rk.length} synthetic rows, ${P.rankSpells} names x ${P.rankRanks} ranks, rank and class in the note: ${wRank} rows) | **${r2(measured.perRankRow)}** |`,
      `| writes per retired fact | ${r2(measured.perRetired)} |`,
      `| kv_state insert + update in one call (not used for the constants) | ${kvW} |`,
      "", "| projection from the measured numbers | rows written | of the D1 Free limit (100,000 a day) |", "| --- | --- | --- |",
      `| client load, ${REAL_CLIENT_FACTS} facts (${REAL_CLIENT_SUFFIXED} rank-suffixed), ${REAL_CLIENT_CALLS} calls | ${proj.client} | ${r2((proj.client / FREE_ROWS_WRITTEN_PER_DAY) * 100)}% |`,
      `| curated load, ${REAL_CURATED_FACTS} rows, ${REAL_CURATED_CALLS} calls | ${proj.curated} | ${r2((proj.curated / FREE_ROWS_WRITTEN_PER_DAY) * 100)}% |`,
      `| of which the ${REAL_RANK_ROWS} shared-name rank rows | ${proj.rankRowsWritten} | ${r2((proj.rankRowsWritten / FREE_ROWS_WRITTEN_PER_DAY) * 100)}% |`,
      `| first load of both (before the rank rows: ${proj.beforeTotal}) | ${proj.firstLoadTotal} | ${r2(proj.pctFirst)}% |`,
      `| days for the whole first load at the 100,000 limit / runs at the default ${DEFAULT_RUN_BUDGET} budget | ${proj.daysAtLimit} day(s) / ${proj.runsAtDefaultBudget} run(s) | |`,
      `| rebuild of the client load for a new build (all new rows written, all old rows retired) | ${proj.rebuild} | ${r2(proj.pctRebuild)}% |`, "");

    // ---- 3. plain export of the preview database, with the smoke rows still in it
    const dump = path.join(tmp, "dump.sql");
    const ex = wrangler(["d1", "export", db, "--remote", `--output=${dump}`], { allowFail: true });
    const dumpText = existsSync(dump) ? readFileSync(dump, "utf8") : "";
    const exportOk = ex.status === 0 && dumpText.length > 0;
    const dumpHasRows = dumpText.includes("game_facts") && dumpText.includes("Test A Amber Amber 0") && dumpText.includes("smoke-load-m1");
    let dumpApplies = "not attempted";
    if (exportOk) {
      try { const { DatabaseSync } = await import("node:sqlite"); const sq = new DatabaseSync(":memory:"); sq.exec(dumpText); dumpApplies = `yes (${sq.prepare("SELECT COUNT(*) AS c FROM game_facts").get().c} game_facts rows restored into an in-memory SQLite)`; } catch (e) { dumpApplies = `no (${firstLine(e.message)})`; }
    }
    const drill = spawnSync(process.execPath, ["--no-warnings", path.join(path.dirname(fileURLToPath(import.meta.url)), "restore-drill.mjs"), "--backend", "sqlite"], { encoding: "utf8" });
    out.push(`| export / restore | result |`, `| --- | --- |`,
      `| plain \`wrangler d1 export --remote\` on the preview D1 | ${exportOk ? `ok (${dumpText.length} bytes)` : `FAILED: ${firstLine(ex.stderr || ex.stdout)}`} |`,
      `| dump applied to an in-memory SQLite (informational) | ${dumpApplies} |`,
      `| restore drill, in process on schema.sql | ${drill.status === 0 ? "passed" : `FAILED (exit ${drill.status})`} |`, "");
    add(checkMeasurements(measured, { retired: P.facts, exportOk, exportError: exportOk ? "" : firstLine(ex.stderr || ex.stdout), dumpHasRows, rankLookupOk, drillOk: drill.status === 0 }));
  } catch (e) {
    ok = false;
    out.push(`- FAIL smoke could not complete: ${firstLine(e.message)}`);
  } finally {
    try { command(db, CLEANUP_SQL); } catch { /* the preview database is deleted with the PR anyway */ }
    rmSync(tmp, { recursive: true, force: true });
  }
  const budgetOk = P.rowBudget === null || rowsWrittenTotal <= P.rowBudget;
  if (!budgetOk) console.log(`::warning title=Smoke wrote more rows than its budget::${rowsWrittenTotal} rows written, budget ${P.rowBudget}`);
  if (P.hardRowLimit !== null && rowsWrittenTotal > P.hardRowLimit) ok = false;
  summary(["### Game facts on the real preview D1 (migration 0016, no virtual table)", "", `Database: \`${db}\``, "", `**Rows written by this smoke run (every statement, cleanup included): ${rowsWrittenTotal}** (profile ${P.name}${P.rowBudget === null ? ", no budget" : `, budget ${P.rowBudget}: ${budgetOk ? "within" : rowsWrittenTotal > P.hardRowLimit ? `EXCEEDED the hard limit ${P.hardRowLimit}, the step fails` : "over the budget (warning)"}`}; D1 free limit 100,000 a day for the whole account)`, "", ...out].join("\n"));
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const i = rest.indexOf("--db");
  const db = i >= 0 ? rest[i + 1] : process.env.D1_DATABASE_NAME;
  try { refuseUnlessPreviewDb(db); } catch (e) { console.error(e.message); process.exit(2); }
  if (mode === "smoke") process.exit((await runSmoke(db, { profile: SMALL })) ? 0 : 1);
  else if (mode === "smoke-full") process.exit((await runSmoke(db, { profile: FULL })) ? 0 : 1);
  else { console.error("usage: node tools/d1-facts-smoke.mjs smoke|smoke-full [--db <name>]"); process.exit(2); }
}
