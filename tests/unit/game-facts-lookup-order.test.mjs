// The reader's lookup (reader: true): the SQL LIMIT keeps the LONGEST matched names, and the per-name cap keeps one row of every kind.
// Found in the 2026-11-19 replay: "Bestial Wrath" lost its talent rows to the 24 rows of the one-word name "Wrath"; "Shadowburn" lost its rank-less talent rows to its 12 rank rows. Fictional rows only.
// Run: node --test tests/unit/game-facts-lookup-order.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { lookupGameFactsChecked, buildNameSql, capPerName, READER_PER_NAME, READER_ROW_LIMIT } from "../../infrastructure/worker/game-facts-lookup.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { loadFacts } from "../helpers/game-facts-fixture.mjs";

const row = (id, kind, subject, claim, value, note = "") => ({ id, kind, subject, claim, value, unit: "", source_table: id.split(":")[0], row_id: id.split(":")[1], note });
const wrathLadder = Array.from({ length: READER_ROW_LIMIT + 6 }, (_, i) => row(`spelllevels:${1000 + i}`, "spell_level", "Wrath", `Wrath (Rank ${i + 1}) requires level ${i + 1}.`, String(i + 1), `rank=${i + 1};class=Zed`));
const fiery = [
  row("trait_max_ranks:9-1", "trait_max_ranks", "Fiery Wrath", "Fiery Wrath is a Zed talent with 3 ranks.", "3"),
  row("trait_points_required:9-1", "trait_points_required", "Fiery Wrath", "Fiery Wrath (Zed talent) needs 10 points spent in its tree before it can be learned.", "10"),
  row("trait_prereq:9-1", "trait_prereq", "Fiery Wrath", "Fiery Wrath (Zed talent) has Cinder Skin as its prerequisite talent.", "Cinder Skin"),
];
const ladder12 = Array.from({ length: 12 }, (_, i) => row(`spelllevels:${2000 + i}`, "spell_level", "Cinderbrand", `Cinderbrand (Rank ${(i % 6) + 1}) requires level ${(i % 6) * 8 + 4}.`, String((i % 6) * 8 + 4), `rank=${(i % 6) + 1};class=Zed`));
const brandTalent = [row("trait_max_ranks:9-2", "trait_max_ranks", "Cinderbrand", "Cinderbrand is a Zed talent with 1 rank.", "1")];

test("the longest matched name wins the SQL LIMIT: Fiery Wrath keeps its three rows beside the 30 rows of Wrath", async () => {
  const DB = await schemaDb();
  loadFacts(DB, [...wrathLadder, ...fiery]);
  const r = await lookupGameFactsChecked({ DB }, "Zed talent Fiery Wrath: how many ranks does it have?", { limit: 8, reader: true });
  assert.deepEqual(r.rows.map((x) => x.id).sort(), fiery.map((x) => x.id).sort());
});

test("without reader mode nothing changes: no ORDER BY in the statement, the 400-row fetch is as before", () => {
  assert.ok(!/ORDER BY/.test(buildNameSql(["wrath"], "subject_norm", 400).sql));
  assert.match(buildNameSql(["wrath"], "subject_norm", 24, undefined, true).sql, /ORDER BY LENGTH\(g\.subject_norm\) DESC, g\.id LIMIT \?/);
});

test("the per-name cap keeps one row of every kind before it fills in order, and leaves a short list alone", async () => {
  const rows = [...ladder12, ...brandTalent].map((r) => ({ ...r, kind: r.kind }));
  const capped = capPerName(rows, READER_PER_NAME);
  assert.equal(capped.length, READER_PER_NAME);
  assert.ok(capped.some((r) => r.kind === "trait_max_ranks"), "the rank-less talent row is kept");
  assert.deepEqual(capPerName(rows.slice(0, 5), READER_PER_NAME), rows.slice(0, 5));
  const DB = await schemaDb();
  loadFacts(DB, [...ladder12, ...brandTalent]);
  const r = await lookupGameFactsChecked({ DB }, "How many ranks can you put into the Zed talent Cinderbrand?", { limit: 8, reader: true });
  assert.ok(r.rows.some((x) => x.id === "trait_max_ranks:9-2"));
  assert.ok(r.rows.length <= READER_PER_NAME);
});
