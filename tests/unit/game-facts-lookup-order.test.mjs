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

// The five misses of the 2026-11-19 replay, as row SHAPES (synthetic ids and values; the shapes are the real counts).
const ladder = (name, n, kind = "spell_level", base = 5000) => Array.from({ length: n }, (_, i) => row(`${kind === "spell_level" ? "spelllevels" : "spellpower"}:${base + i}`, kind, name, `${name} (Rank ${i + 1}) requires level ${i + 1}.`, String(i + 1), `rank=${i + 1};class=Zed`));
const talent = (name, id, ranks) => [
  row(`trait_max_ranks:${id}`, "trait_max_ranks", name, `${name} is a Zed talent with ${ranks} rank${ranks > 1 ? "s" : ""}.`, String(ranks)),
  row(`trait_points_required:${id}`, "trait_points_required", name, `${name} (Zed talent) needs 30 points spent in its tree before it can be learned.`, "30"),
  row(`trait_prereq:${id}`, "trait_prereq", name, `${name} (Zed talent) has Cinder Skin as its prerequisite talent.`, "Cinder Skin"),
];
const ids = (r) => r.rows.map((x) => x.id);
for (const [name, q, mustHave] of [
  ["Bestial Wrath", "Hunter talent Bestial Wrath: how many ranks does it have?", ["trait_max_ranks:1091-1", "trait_points_required:1091-1", "trait_prereq:1091-1"]],
  ["Unsealed Wrath", "Paladin talent Unsealed Wrath: which talent has to be taken before it?", ["trait_max_ranks:1100-2", "trait_prereq:1100-2"]],
  ["Unbridled Wrath", "How many ranks can you put into the Warrior talent Unbridled Wrath?", ["trait_max_ranks:1117-3"]],
]) {
  test(`replay miss: ${name} keeps its talent rows beside the 30-row ladder of Wrath`, async () => {
    const own = name === "Bestial Wrath" ? talent(name, "1091-1", 1) : name === "Unsealed Wrath" ? talent(name, "1100-2", 1) : talent(name, "1117-3", 5);
    const DB = await schemaDb();
    loadFacts(DB, [...ladder("Wrath", 30), ...own]);
    const r = await lookupGameFactsChecked({ DB }, q, { limit: 8, reader: true });
    for (const id of mustHave) assert.ok(ids(r).includes(id), `${id} in ${ids(r).join(",")}`);
    assert.ok(!ids(r).some((id) => id.startsWith("spelllevels:5")), "no row of the shorter name Wrath");
  });
}

test("replay miss: Fire Nova Totem (1 row) is not crowded out by the 30-row ladder of Fire Nova", async () => {
  const DB = await schemaDb();
  loadFacts(DB, [...ladder("Fire Nova", 30), row("spellpower:9001", "spell_mana_cost", "Fire Nova Totem", "Fire Nova Totem costs 640 mana.", "640")]);
  const r = await lookupGameFactsChecked({ DB }, "How much mana does Fire Nova Totem cost?", { limit: 8, reader: true });
  assert.deepEqual(ids(r), ["spellpower:9001"]);
});

test("replay miss: Shadowburn keeps its rank-less talent row beside 12 ladder rows", async () => {
  const DB = await schemaDb();
  loadFacts(DB, [...ladder("Shadowburn", 6), ...ladder("Shadowburn", 6, "spell_mana_cost", 7000), ...talent("Shadowburn", "1116-4", 1)]);
  const r = await lookupGameFactsChecked({ DB }, "How many ranks can you put into the Warlock talent Shadowburn?", { limit: 8, reader: true });
  assert.ok(ids(r).includes("trait_max_ranks:1116-4"), ids(r).join(","));
  assert.ok(r.rows.length <= READER_PER_NAME);
});
