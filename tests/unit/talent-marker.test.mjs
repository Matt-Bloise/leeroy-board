// Loader marker for talent spells (talent=1 in the note) and the composer's use of it. Fictional rows; no client data.
// Run: node --test tests/unit/talent-marker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseNote } from "../../infrastructure/worker/game-facts-lookup.js";
import { composeTableAnswer } from "../../infrastructure/worker/game-facts-compose.js";
import { readGameFacts } from "../../infrastructure/worker/game-facts-read.js";
import { markTalentSpells } from "../../tools/facts-load.mjs";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { loadFacts } from "../helpers/game-facts-fixture.mjs";

const row = (id, kind, subject, claim, value, note = "") => ({ id, kind, subject, claim, value, unit: "", source_table: id.split(":")[0], row_id: id.split(":")[1], note });
const traits = { build: "9.9.9.1", trees: { 1: { nodes: [{ name: "Tide Mastery", spellId: "1" }, { name: "Quiet Mind" }] }, 2: { nodes: [{ name: "Cruelty" }, { name: 7 }, null] }, 3: {} } };

test("markTalentSpells: spell rows named like a trait node get talent=1 (case-insensitive), nothing else changes", () => {
  const rows = [
    row("spelllevels:1", "spell_level", "Tide Mastery", "Tide Mastery requires level 40.", "40"),
    row("spelllevels:2", "spell_level", "cruelty", "cruelty requires level 1.", "1"),
    row("spelllevels:3", "spell_level", "Tide Mastery", "Tide Mastery (Rank 2) requires level 48.", "48", "rank=2;class=Shaman"),
    row("spellcooldowns:4", "spell_cooldown", "Tide Mastery", "Tide Mastery has a cooldown of 60 seconds.", "60"),
    row("spelllevels:5", "spell_level", "Heroic Slash", "Heroic Slash requires level 10.", "10"),
    row("items:6", "item_level_req", "Tide Mastery", "Tide Mastery has a required level of 40.", "40"),
    row("trait_max_ranks:7", "trait_max_ranks", "Tide Mastery", "Tide Mastery is a Shaman talent with 1 rank.", "1"),
  ];
  const { rows: out, marked } = markTalentSpells(rows, traits);
  assert.equal(marked, 4);
  assert.deepEqual(out.map((r) => r.note), ["talent=1", "talent=1", "rank=2;class=Shaman;talent=1", "talent=1", "", "", ""]);
  assert.deepEqual(out.map((r) => r.id), rows.map((r) => r.id));
  assert.equal(markTalentSpells(out, traits).marked, 0, "idempotent");
  assert.equal(markTalentSpells(rows, {}).marked, 0, "no trait file shape, no marks");
  assert.equal(rows[0].note, "", "the input rows are not changed");
});

test("parseNote reads talent=1 next to rank and class", () => {
  assert.deepEqual(parseNote("talent=1"), { talent: true });
  assert.deepEqual(parseNote("rank=2;class=Shaman;talent=1"), { rank: 2, hint: "Shaman", talent: true });
  assert.deepEqual(parseNote("talent=2"), {});
  assert.deepEqual(parseNote(""), {});
});

test("a talent spell with no trait row and a level above 1 declines a level question; its cooldown still composes", async () => {
  const DB = await schemaDb();
  loadFacts(DB, [row("spelllevels:11", "spell_level", "Tide Mastery", "Tide Mastery requires level 40.", "40", "talent=1"), row("spellcooldowns:12", "spell_cooldown", "Tide Mastery", "Tide Mastery has a cooldown of 60 seconds.", "60", "talent=1")]);
  const ask = async (q) => { const gf = await readGameFacts({ DB, GAME_FACTS_READ: "on", GAME_FACTS_COMPOSE: "on" }, q); return gf && gf.res ? composeTableAnswer(q, gf.res) : null; };
  for (const q of ["What level is Tide Mastery?", "At what level does a player learn Tide Mastery?", "When do I learn Tide Mastery?"]) assert.equal(await ask(q), null, q);
  assert.equal((await ask("What is the cooldown of Tide Mastery?")).text, "**Tide Mastery has a cooldown of 60 seconds.** [spellcooldowns:12]");
  const plain = await schemaDb();
  loadFacts(plain, [row("spelllevels:13", "spell_level", "Heroic Slash", "Heroic Slash requires level 40.", "40")]);
  const gf = await readGameFacts({ DB: plain, GAME_FACTS_READ: "on", GAME_FACTS_COMPOSE: "on" }, "What level is Heroic Slash?");
  assert.equal(composeTableAnswer("What level is Heroic Slash?", gf.res).text, "**Heroic Slash requires level 40.** [spelllevels:13]", "an unmarked spell above level 1 composes");
});
