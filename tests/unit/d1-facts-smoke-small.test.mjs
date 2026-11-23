// The CI profile of the game-facts smoke (tools/d1-facts-smoke.mjs, SMALL) and the rule that decides when it runs (tools/smoke-scope.mjs).
// Before: every spin-up wrote 2,000 to 3,700 D1 rows (FOOTPRINT 3.3, the account limit is 100,000 rows a day). Now: under SMALL_ROW_BUDGET, and only when the loader, schema or SQL changed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { lookupGameFacts } from "../../infrastructure/worker/game-facts-lookup.js";
import { UPSERT, upsertBinds, finishStatements } from "../../infrastructure/worker/game-facts.js";
import { inlineBinds, measureRows, rankRows, countKinds, estimateRowsWritten, SMALL, FULL, SMALL_ROW_BUDGET, SMALL_ROW_HARD_LIMIT, RANK_LOAD } from "../../tools/d1-facts-smoke.mjs";
import { smokeNeeded, touchesSmoke } from "../../tools/smoke-scope.mjs";

test("the worst-case row estimate: SMALL stays under the budget, FULL reproduces the footprint range of about 3,700", () => {
  const small = estimateRowsWritten(SMALL), full = estimateRowsWritten(FULL);
  assert.ok(small <= SMALL_ROW_BUDGET, `SMALL estimate ${small} is over ${SMALL_ROW_BUDGET}`);
  assert.ok(full >= 3000 && full <= 3800, `FULL estimate ${full} should match the footprint upper figure of about 3,700`);
  assert.equal(SMALL_ROW_HARD_LIMIT, SMALL_ROW_BUDGET * 2);
  assert.ok(full / small > 15, "at least fifteen times fewer rows");
});

test("SMALL rows: the right kinds, exactly the rank-suffixed ones carry a base name, ids are unique, the probe rows are plain cast-time rows", () => {
  const a = measureRows("A", 0, SMALL.facts, SMALL);
  assert.equal(a.length, SMALL.facts);
  assert.deepEqual(countKinds(a), SMALL.kinds);
  assert.equal(a.filter((r) => r.subject_base).length, SMALL.suffixed);
  assert.equal(new Set(a.map((r) => r.id)).size, a.length);
  const probe = measureRows("P", SMALL.probe[0], SMALL.probe[1], SMALL);
  assert.ok(probe.length > 0 && probe.every((r) => r.kind === "spell_cast_time" && !r.subject_base), "plain probe rows measure the per-fact cost without the suffix");
  const keep = SMALL.keep.flatMap(([f, t]) => measureRows("A", f, t, SMALL)), fresh = measureRows("B", 0, SMALL.fresh, SMALL);
  assert.ok(keep.length > 0 && fresh.length > 0);
  const ids = new Set(a.map((r) => r.id));
  assert.ok(keep.every((r) => ids.has(r.id)), "the kept rows are re-sent rows of load A");
});

// The same flow the smoke runs on the preview D1, on SQLite with the SMALL profile: loads, finish, retire, rank ladder and the lookup.
test("the SMALL flow passes its own assertions on SQLite: load A, load B retiring every older row, the rank ladder and the Worker lookup", async () => {
  const db = schemaDb();
  const run = (sql) => db.raw.exec(sql);
  const open = (id) => run(`INSERT INTO game_fact_loads (id, build, manifest_sha256, files_json, kind, status, counts_json, started_at) VALUES ('${id}', '9.9.9.1', '${"a".repeat(64)}', '{}', 'client', 'open', '{}', 'x');`);
  const load = (id, rows) => { for (const r of rows) run(inlineBinds(UPSERT, upsertBinds(r, id, "2026-01-01T00:00:00.000Z"))); };
  const fin = (id, declared, total) => { for (const st of finishStatements(id, declared, { kinds: declared, total, added: 0, changed: 0, unchanged: 0, removed: 0 }, "2026-01-02T00:00:00.000Z")) run(inlineBinds(st.sql, st.binds)); };
  const rowsA = measureRows("A", 0, SMALL.facts, SMALL);
  open("smoke-load-m1"); load("smoke-load-m1", rowsA); fin("smoke-load-m1", SMALL.kinds, SMALL.facts);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE superseded = 0").get().c, SMALL.facts);
  const keep = SMALL.keep.flatMap(([f, t]) => measureRows("A", f, t, SMALL)), fresh = measureRows("B", 0, SMALL.fresh, SMALL);
  open("smoke-load-m2"); load("smoke-load-m2", [...keep, ...fresh]); const declared2 = countKinds([...keep, ...fresh]); fin("smoke-load-m2", declared2, keep.length + fresh.length);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE load_id = 'smoke-load-m1' AND superseded = 1").get().c, SMALL.facts, "every older row is retired");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM game_facts INDEXED BY idx_game_facts_kind_base WHERE subject_base <> '' AND load_id = 'smoke-load-m1'").get().c, SMALL.suffixed);
  const rk = rankRows(SMALL);
  assert.equal(rk.length, SMALL.rankSpells * SMALL.rankRanks);
  open(RANK_LOAD); load(RANK_LOAD, rk); fin(RANK_LOAD, { spell_level: rk.length }, rk.length);
  const one = await lookupGameFacts({ DB: db }, "What level is Test Rankbolt Amber Amber 0 rank 4?", { limit: 10 });
  assert.equal(one.rows.length, 1); assert.equal(one.rows[0].rank, 4); assert.equal(one.rows[0].value, "16");
  const all = await lookupGameFacts({ DB: db }, "when do I get Test Rankbolt Amber Amber 0", { limit: 10 });
  assert.equal(all.rows.map((r) => r.rank).join(), "1,2,3,4,5");
});

test("smoke-scope: runs when the loader, the lookup, the schema, a migration, the smoke or the preview workflow changed; skips everything else; fails open", () => {
  for (const p of ["infrastructure/worker/game-facts.js", "infrastructure/worker/game-facts-lookup.js", "infrastructure/worker/game-facts-name.js", "infrastructure/schema.sql", "infrastructure/migrations/0017_x.sql", "tools/facts-load.mjs", "tools/d1-facts-smoke.mjs", ".github/workflows/pr-preview-cloudflare.yml"]) assert.equal(touchesSmoke(p), true, p);
  for (const p of ["infrastructure/worker/game-facts-compose.js", "infrastructure/worker/game-facts-read.js", "infrastructure/worker/index.js", "data/library/classes.json", "js/board.js", "tests/unit/game-facts.test.mjs", "docs/runbooks/game-facts.md"]) assert.equal(touchesSmoke(p), false, p);
  assert.equal(smokeNeeded(["js/board.js", "data/library/classes.json"]), false);
  assert.equal(smokeNeeded(["js/board.js", "infrastructure/schema.sql"]), true);
  assert.equal(smokeNeeded([]), true, "an empty list could not be classified: run it");
  for (const p of ["/etc/x", "a\\b", "../x", "\"q\"", "a/./b/../c"]) assert.equal(smokeNeeded([p]), true, `unknown shape runs it: ${p}`);
});

test("the workflow runs the smoke only when smoke-scope says so, says why when it skips, and the summary prints the rows written", () => {
  const wf = readFileSync(new URL("../../.github/workflows/pr-preview-cloudflare.yml", import.meta.url), "utf8");
  assert.ok(wf.includes("smoke_needed: ${{ steps.classify.outputs.smoke_needed }}"), "prep exports the answer");
  assert.ok(wf.includes('node tools/smoke-scope.mjs < "$RUNNER_TEMP/paths.txt"'), "prep computes it from the changed paths");
  const at = wf.indexOf("node ../tools/d1-facts-smoke.mjs smoke");
  const step = wf.slice(wf.lastIndexOf("      - name:", at), at);
  assert.ok(step.includes("needs.prep.outputs.smoke_needed != 'false'"), "an empty or missing answer still runs the smoke");
  assert.ok(wf.includes("Game-facts smoke skipped"), "a skipped smoke says so and why");
  const smokeSrc = readFileSync(new URL("../../tools/d1-facts-smoke.mjs", import.meta.url), "utf8");
  assert.ok(smokeSrc.includes("Rows written by this smoke run"), "the summary prints the rows written");
});
