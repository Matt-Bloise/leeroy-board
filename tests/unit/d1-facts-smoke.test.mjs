// tools/d1-facts-smoke.mjs: the pure parts. The SQL it sends to the preview D1 is run here on SQLite (schema.sql, FTS5 included) and the same assertions are applied to what comes back.
//   production refusal   only leeroy-board-db-pr-<number> is accepted; the production name and every look-alike is refused before any wrangler call
//   inlineBinds          values become SQL literals, quotes doubled, a count mismatch throws
//   parseWranglerJson    log lines before the JSON are skipped; a failed statement or a non-array throws
//   checkLookup          passes on the real SQL results, fails when the superseded row, the open-load row or the trigger sync is wrong
// Run: node --test tests/unit/d1-facts-smoke.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { refuseUnlessPreviewDb, PRODUCTION_DB, inlineBinds, parseWranglerJson, rowsOf, checkLookup, lookupSqlFor, CLEANUP_SQL, INSERT_SQL, HOSTILE, firstLine } from "../../tools/d1-facts-smoke.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the production database and every look-alike is refused; only leeroy-board-db-pr-<number> passes", () => {
  assert.equal(PRODUCTION_DB, "leeroy-board-db");
  assert.equal(refuseUnlessPreviewDb("leeroy-board-db-pr-403"), "leeroy-board-db-pr-403");
  for (const bad of ["leeroy-board-db", "leeroy-board-db-pr-", "leeroy-board-db-pr-abc", "leeroy-board-db-pr-1; DROP", "leeroy-board-db-pr-403 ", " leeroy-board-db-pr-403", "leeroy-board-db-pr-403\n", "leeroy-board-db-drill", "prod", "", undefined, null, 5, "xleeroy-board-db-pr-1", "leeroy-board-db-pr-123456789"]) {
    assert.throws(() => refuseUnlessPreviewDb(bad), /refusing|no database name/, String(bad));
  }
  assert.throws(() => refuseUnlessPreviewDb("leeroy-board-db"), /PRODUCTION/);
});

test("the CLI refuses production and a missing name before it runs anything (exit 2, no wrangler call)", () => {
  const run = (env, ...a) => spawnSync(process.execPath, ["--no-warnings", "tools/d1-facts-smoke.mjs", ...a], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  const prod = run({ D1_DATABASE_NAME: "leeroy-board-db" }, "smoke");
  assert.equal(prod.status, 2); assert.match(prod.stderr, /PRODUCTION/);
  const probeProd = run({}, "probe", "--db", "leeroy-board-db");
  assert.equal(probeProd.status, 2);
  assert.equal(run({}, "smoke").status, 2);
  assert.equal(run({ D1_DATABASE_NAME: "leeroy-board-db-pr-1" }, "wat").status, 2);
});

test("inlineBinds quotes strings, doubles single quotes, passes numbers, and refuses a count mismatch or a bad value", () => {
  assert.equal(inlineBinds("a = ? AND b = ? LIMIT ?", ["x'y", "z", 30]), "a = 'x''y' AND b = 'z' LIMIT 30");
  assert.equal(inlineBinds("?", ["'; DROP TABLE t; --"]), "'''; DROP TABLE t; --'");
  assert.throws(() => inlineBinds("? ?", ["a"]), /more placeholders/);
  assert.throws(() => inlineBinds("?", ["a", "b"]), /fewer placeholders/);
  assert.throws(() => inlineBinds("?", [Infinity]), /non-finite/);
  assert.throws(() => inlineBinds("?", [{}]), /unsupported/);
  assert.throws(() => inlineBinds("?", ["a\u0000b"]), /NUL/);
});

test("parseWranglerJson skips log lines, returns the statement results, and throws on failure or other shapes", () => {
  const ok = parseWranglerJson(' wrangler banner\n[{"results":[{"c":4}],"success":true,"meta":{}}]');
  assert.equal(rowsOf(ok, 0)[0].c, 4);
  assert.deepEqual(rowsOf(ok, 5), []);
  assert.throws(() => parseWranglerJson("no json here"), /no JSON/);
  assert.throws(() => parseWranglerJson("[not json"), /did not parse/);
  assert.throws(() => parseWranglerJson('[{"results":[],"success":false}]'), /failure/);
  assert.throws(() => parseWranglerJson('[null]'), /failure/);
  assert.equal(firstLine("\n\n  X [ERROR] boom \nmore"), "X [ERROR] boom");
  assert.equal(firstLine(""), "(no output)");
});

// What the preview run does, against SQLite: the same SQL strings, the same assertions.
async function simulate({ tamper = null } = {}) {
  const db = schemaDb();
  const sql = (text, ...a) => db.raw.prepare(text).all(...a).map((r) => ({ ...r }));
  db.raw.exec(CLEANUP_SQL);
  db.raw.exec(INSERT_SQL);
  if (tamper) tamper(db);
  const lookupRows = sql(lookupSqlFor("Test Frostwhirl level"));
  const hostileRows = sql(lookupSqlFor(HOSTILE));
  assert.equal(sql("SELECT COUNT(*) AS c FROM game_facts WHERE load_id LIKE 'smoke-load-%'")[0].c, 4, "the hostile question changed nothing");
  const ftsCount = sql(`SELECT COUNT(*) AS c FROM game_facts_fts WHERE game_facts_fts MATCH '"frostwhirl"'`)[0].c;
  db.raw.exec("INSERT INTO game_facts_fts(game_facts_fts) VALUES ('integrity-check')");
  db.raw.exec("UPDATE game_facts SET claim = 'Test Frostwhirl requires level 12 and a Zzyzxquux.' WHERE id = 'spelllevels:smoke1'");
  const afterUpdateCount = sql(`SELECT COUNT(*) AS c FROM game_facts_fts WHERE game_facts_fts MATCH '"zzyzxquux"'`)[0].c;
  const inventory = sql("SELECT name FROM sqlite_master WHERE name LIKE 'game_fact%'").map((r) => r.name);
  db.raw.exec(CLEANUP_SQL);
  const afterDeleteCount = sql(`SELECT COUNT(*) AS c FROM game_facts_fts WHERE game_facts_fts MATCH '"frostwhirl"'`)[0].c;
  return checkLookup({ lookupRows, hostileRows, ftsCount, integrityOk: true, afterUpdateCount, afterDeleteCount, inventory });
}

test("the smoke SQL, run on SQLite with the Worker's own lookup builders, passes every assertion", async () => {
  const r = await simulate();
  assert.deepEqual(r.lines.filter((l) => l.startsWith("FAIL")), []);
  assert.equal(r.ok, true);
  assert.ok(r.lines.length >= 15);
});

test("the assertions fail when the exclusions or the trigger sync are wrong", async () => {
  const open = await simulate({ tamper: (db) => db.raw.exec("UPDATE game_fact_loads SET status = 'done', finished_at = '2026-01-03T00:00:00.000Z' WHERE id = 'smoke-load-open'") });
  assert.equal(open.ok, false);
  assert.ok(open.lines.some((l) => /^FAIL the row of a load that is not done is excluded/.test(l)));
  const sup = await simulate({ tamper: (db) => db.raw.exec("UPDATE game_facts SET superseded = 0 WHERE id = 'spelllevels:smoke2'") });
  assert.ok(sup.lines.some((l) => /^FAIL the superseded row is excluded/.test(l)));
  const bad = checkLookup({ lookupRows: [], hostileRows: [], ftsCount: 0, integrityOk: false, afterUpdateCount: 0, afterDeleteCount: 3, inventory: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.lines.filter((l) => l.startsWith("FAIL")).length >= 8);
});

test("the workflow runs the smoke after the seed step and before the Worker deploy, on the PR database, and the probe cannot fail the step", () => {
  const wf = readFileSync(new URL("../../.github/workflows/pr-preview-cloudflare.yml", import.meta.url), "utf8");
  const seed = wf.indexOf("Apply Unified D1 Schema (`schema.sql`), Migrations & Seed Ephemeral Database");
  const smoke = wf.indexOf("tools/d1-facts-smoke.mjs smoke");
  const deploy = wf.indexOf("Deploy Ephemeral PR Worker & Durable Object (Single Deploy)");
  assert.ok(seed > 0 && smoke > seed && deploy > smoke);
  assert.match(wf.slice(smoke - 600, smoke + 400), /d1-facts-smoke\.mjs probe \|\| true[\s\S]*exit "\$SMOKE_CODE"/);
  assert.match(wf, /D1_DATABASE_NAME: leeroy-board-db-pr-\$\{\{ github\.event\.pull_request\.number \}\}/);
});
