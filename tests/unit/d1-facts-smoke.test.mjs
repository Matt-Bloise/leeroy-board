// tools/d1-facts-smoke.mjs: the pure parts, and the SQL it sends to the preview D1 run here on SQLite (schema.sql) with the same assertions.
//   production refusal   only leeroy-board-db-pr-<number> is accepted; the production name and every look-alike is refused before any wrangler call
//   helpers              inlineBinds, parseWranglerJson, sumMeta (a missing meta never reads as 0), project()
//   the smoke SQL        the lookups of part 1 and the load/finish statements of part 2 on SQLite: the assertions pass, and fail when an exclusion or a count is wrong
//   the workflow         the smoke runs after the seed step and before the Worker deploy, on the PR database, and nothing in it can pass over a failure
// Run: node --test tests/unit/d1-facts-smoke.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { lookupGameFacts } from "../../infrastructure/worker/game-facts-lookup.js";
import { UPSERT, upsertBinds, finishStatements } from "../../infrastructure/worker/game-facts.js";
import {
  refuseUnlessPreviewDb, PRODUCTION_DB, inlineBinds, parseWranglerJson, rowsOf, sumMeta, firstLine, checkLookups, checkMeasurements, project, measureRows, countKinds, MEASURE_FACTS, MEASURE_SUFFIXED, MEASURE_KINDS,
  CLEANUP_SQL, INSERT_SQL, HOSTILE, remoteDb, FREE_ROWS_WRITTEN_PER_DAY,
} from "../../tools/d1-facts-smoke.mjs";
import { WRITES_PER_FACT, WRITES_PER_SUFFIXED_FACT, WRITES_PER_CALL, WRITES_PER_RETIRED_FACT } from "../../tools/facts-load.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the production database and every look-alike is refused; only leeroy-board-db-pr-<number> passes", () => {
  assert.equal(PRODUCTION_DB, "leeroy-board-db");
  assert.equal(refuseUnlessPreviewDb("leeroy-board-db-pr-403"), "leeroy-board-db-pr-403");
  for (const bad of ["leeroy-board-db", "leeroy-board-db-pr-", "leeroy-board-db-pr-abc", "leeroy-board-db-pr-1; DROP", "leeroy-board-db-pr-403 ", " leeroy-board-db-pr-403", "leeroy-board-db-pr-403\n", "leeroy-board-db-drill", "prod", "", undefined, null, 5, "xleeroy-board-db-pr-1", "leeroy-board-db-pr-123456789"]) {
    assert.throws(() => refuseUnlessPreviewDb(bad), /refusing|no database name/, String(bad));
  }
  assert.throws(() => refuseUnlessPreviewDb("leeroy-board-db"), /PRODUCTION/);
});

test("the CLI refuses production, a missing name and an unknown mode before it runs anything (exit 2, no wrangler call)", () => {
  const run = (env, ...a) => spawnSync(process.execPath, ["--no-warnings", "tools/d1-facts-smoke.mjs", ...a], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  const prod = run({ D1_DATABASE_NAME: "leeroy-board-db" }, "smoke");
  assert.equal(prod.status, 2); assert.match(prod.stderr, /PRODUCTION/);
  assert.equal(run({}, "smoke", "--db", "leeroy-board-db").status, 2);
  assert.equal(run({}, "smoke").status, 2);
  assert.equal(run({ D1_DATABASE_NAME: "leeroy-board-db-pr-1" }, "wat").status, 2);
  assert.equal(run({ D1_DATABASE_NAME: "leeroy-board-db-pr-1" }, "probe").status, 2, "the old probe mode is gone");
});

test("inlineBinds quotes strings, doubles single quotes, passes numbers and NULL, and refuses a count mismatch or a bad value", () => {
  assert.equal(inlineBinds("a = ? AND b = ? LIMIT ?", ["x'y", "z", 30]), "a = 'x''y' AND b = 'z' LIMIT 30");
  assert.equal(inlineBinds("?", ["'; DROP TABLE t; --"]), "'''; DROP TABLE t; --'");
  assert.equal(inlineBinds("?, ?", [null, 1]), "NULL, 1");
  assert.throws(() => inlineBinds("? ?", ["a"]), /more placeholders/);
  assert.throws(() => inlineBinds("?", ["a", "b"]), /fewer placeholders/);
  assert.throws(() => inlineBinds("?", [Infinity]), /non-finite/);
  assert.throws(() => inlineBinds("?", [{}]), /unsupported/);
  assert.throws(() => inlineBinds("?", ["a\u0000b"]), /NUL/);
});

test("parseWranglerJson skips log lines; sumMeta adds meta fields and throws instead of reading a missing one as 0", () => {
  const ok = parseWranglerJson(' wrangler banner\n[{"results":[{"c":4}],"success":true,"meta":{"rows_written":7,"rows_read":3}},{"results":[],"success":true,"meta":{"rows_written":5,"rows_read":1}}]');
  assert.equal(rowsOf(ok, 0)[0].c, 4);
  assert.deepEqual(rowsOf(ok, 5), []);
  assert.equal(sumMeta(ok, "rows_written"), 12); assert.equal(sumMeta(ok, "rows_read"), 4);
  assert.throws(() => sumMeta([{ meta: {} }], "rows_written"), /no numeric meta\.rows_written/);
  assert.throws(() => sumMeta([{}], "rows_written"), /no numeric/);
  assert.throws(() => sumMeta([{ meta: { rows_written: "7" } }], "rows_written"), /no numeric/);
  assert.throws(() => parseWranglerJson("no json here"), /no JSON/);
  assert.throws(() => parseWranglerJson("[not json"), /did not parse/);
  assert.throws(() => parseWranglerJson('[{"results":[],"success":false}]'), /failure/);
  assert.equal(firstLine("\u001b[31mX [ERROR] boom\u001b[0m\nmore"), "X [ERROR] boom");
  assert.equal(firstLine(""), "(no output)");
});

// Part 1 on SQLite: the same INSERT_SQL, and the Worker's own lookupGameFacts through remoteDb with the statements run on SQLite.
async function part1(tamper) {
  const db = schemaDb();
  db.raw.exec(CLEANUP_SQL); db.raw.exec(INSERT_SQL);
  if (tamper) tamper(db);
  const env = { DB: remoteDb((sql) => [{ results: db.raw.prepare(sql).all().map((r) => ({ ...r })) }]) };
  const ask = (q) => lookupGameFacts(env, q, { limit: 10 });
  const a = {
    live: await ask("What level is Test Frostwhirl?"), superseded: await ask("Test Frostwhirl Superseded"), open: await ask("Test Frostwhirl Open"), wrong: await ask("Test Frostwhirl Wrong"),
    twin: await ask("What level is Test Twinbolt?"), baseDirection: await ask("What level is Test Spiritwave?"), fullDirection: await ask("What level is Test Spiritwave III?"),
    rankQuestion: await ask("What level is Test Ripplestrike Rank 4?"), hostile: await ask(HOSTILE),
  };
  a.tableIntact = db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE load_id LIKE 'smoke-load-%'").get().c === 8;
  return checkLookups(a);
}

test("part 1: the smoke rows and the Worker's lookup pass every assertion on SQLite", async () => {
  const r = await part1();
  assert.deepEqual(r.lines.filter((l) => l.startsWith("FAIL")), []);
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 10);
});

test("part 1 fails when an exclusion or the ambiguity is wrong", async () => {
  const open = await part1((db) => db.raw.exec("UPDATE game_fact_loads SET status = 'done', finished_at = '2026-01-03T00:00:00.000Z' WHERE id = 'smoke-load-open'"));
  assert.ok(open.lines.some((l) => /^FAIL the row of a load that is not done is excluded/.test(l)));
  const sup = await part1((db) => db.raw.exec("UPDATE game_facts SET superseded = 0 WHERE id = 'spelllevels:s2'"));
  assert.ok(sup.lines.some((l) => /^FAIL a superseded row is excluded/.test(l)));
  const twin = await part1((db) => db.raw.exec("DELETE FROM game_facts WHERE id = 'spelllevels:s6'"));
  assert.ok(twin.lines.some((l) => /^FAIL a name with two rows/.test(l)));
  const base = await part1((db) => db.raw.exec("UPDATE game_facts SET subject_base = '' WHERE id = 'spelllevels:s7'"));
  assert.ok(base.lines.some((l) => /^FAIL the base name/.test(l)));
});

// Part 2 on SQLite: the same statements the smoke sends, so a syntax or shape error shows here and not first in CI.
test("part 2: the measured load statements are valid, the finish retires every older row of the declared kinds", () => {
  const db = schemaDb();
  const run = (sql) => db.raw.exec(sql);
  const rowsA = measureRows("A");
  assert.equal(rowsA.length, MEASURE_FACTS);
  assert.deepEqual(countKinds(rowsA), MEASURE_KINDS);
  assert.equal(rowsA.filter((r) => r.subject_base).length, MEASURE_SUFFIXED, "exactly the rank-suffixed facts carry a base name");
  assert.equal(new Set(rowsA.map((r) => r.id)).size, rowsA.length);
  const open = (id) => run(`INSERT INTO game_fact_loads (id, build, manifest_sha256, files_json, kind, status, counts_json, started_at) VALUES ('${id}', '9.9.9.1', '${"a".repeat(64)}', '{}', 'client', 'open', '{}', 'x');`);
  const load = (id, rows) => { for (const r of rows) run(inlineBinds(UPSERT, upsertBinds(r, id, "2026-01-01T00:00:00.000Z"))); };
  const fin = (id, rows) => { const declared = countKinds(rows); for (const st of finishStatements(id, declared, { kinds: declared, total: rows.length, added: 0, changed: 0, unchanged: 0, removed: 0 }, "2026-01-02T00:00:00.000Z")) run(inlineBinds(st.sql, st.binds)); };
  open("smoke-load-m1"); load("smoke-load-m1", rowsA); fin("smoke-load-m1", rowsA);
  assert.equal(db.raw.prepare("SELECT status FROM game_fact_loads WHERE id = 'smoke-load-m1'").get().status, "done");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE superseded = 0").get().c, MEASURE_FACTS);
  const keep = [...measureRows("A", 0, 100), ...measureRows("A", 200, 250)], fresh = measureRows("B", 0, 20);
  open("smoke-load-m2"); load("smoke-load-m2", [...keep, ...fresh]); fin("smoke-load-m2", [...keep, ...fresh]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE load_id = 'smoke-load-m1' AND superseded = 1").get().c, MEASURE_FACTS, "all 300 older rows are retired: 150 replaced by the new load's rows, 150 gone");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE superseded = 0").get().c, keep.length + fresh.length);
  // the partial index holds only the suffixed rows
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts INDEXED BY idx_game_facts_kind_base WHERE subject_base <> '' AND load_id = 'smoke-load-m1'").get().c, MEASURE_SUFFIXED);
});

test("project(): the arithmetic against the Free limit, from measured numbers", () => {
  const m = { perFact: 2, perSuffixedExtra: 1, perCall: 3, finishFixed: 4, perRetired: 1, retired: 150 };
  const p = project(m);
  assert.equal(p.client, Math.ceil(18752 * 2 + 754 * 1 + 96 * 3 + 4));
  assert.equal(p.curated, Math.ceil(142 * 2 + 0 + 3 * 3 + 4));
  assert.equal(p.firstLoadTotal, p.client + p.curated);
  assert.equal(p.rebuild, p.client + 18752);
  assert.equal(Math.round(p.pctFirst * 100), Math.round(((p.client + p.curated) / FREE_ROWS_WRITTEN_PER_DAY) * 10000));
  assert.equal(FREE_ROWS_WRITTEN_PER_DAY, 100000);
});

test("checkMeasurements fails on a constant that is too low, a wrong retire count, a failed export, a dump without the rows, a failed drill", () => {
  const good = { perFact: WRITES_PER_FACT, perSuffixedExtra: WRITES_PER_SUFFIXED_FACT, perCall: WRITES_PER_CALL, perRetired: WRITES_PER_RETIRED_FACT, retired: 300 };
  const exp = { retired: 300, exportOk: true, dumpHasRows: true, drillOk: true };
  assert.equal(checkMeasurements(good, exp).ok, true);
  assert.equal(checkMeasurements({ ...good, perFact: WRITES_PER_FACT + 0.5 }, exp).ok, false);
  assert.equal(checkMeasurements({ ...good, perCall: WRITES_PER_CALL + 1 }, exp).ok, false);
  assert.equal(checkMeasurements({ ...good, retired: 299 }, exp).ok, false);
  for (const bad of [{ exportOk: false, exportError: "cannot export databases with virtual tables" }, { dumpHasRows: false }, { drillOk: false }]) assert.equal(checkMeasurements(good, { ...exp, ...bad }).ok, false, JSON.stringify(bad));
});

test("the workflow runs the smoke after the seed step and before the Worker deploy, on the PR database, with no way to pass over a failure", () => {
  const wf = readFileSync(new URL("../../.github/workflows/pr-preview-cloudflare.yml", import.meta.url), "utf8");
  const seed = wf.indexOf("Apply Unified D1 Schema (`schema.sql`), Migrations & Seed Ephemeral Database");
  const smoke = wf.indexOf("node ../tools/d1-facts-smoke.mjs smoke");
  const deploy = wf.indexOf("Deploy Ephemeral PR Worker & Durable Object (Single Deploy)");
  assert.ok(seed > 0 && smoke > seed && deploy > smoke);
  const step = wf.slice(wf.lastIndexOf("      - name:", smoke), deploy);
  assert.ok(!/continue-on-error|\|\| true|set \+e/.test(step), "the step can fail");
  assert.match(step, /working-directory: infrastructure/);
  assert.match(wf, /D1_DATABASE_NAME: leeroy-board-db-pr-\$\{\{ github\.event\.pull_request\.number \}\}/);
});
