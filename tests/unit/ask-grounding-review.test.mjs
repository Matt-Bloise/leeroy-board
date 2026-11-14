// Review follow-ups for the /ask grounding change: name check shapes, scope tags against the real library, a suppressed build tags nothing, hand-built CORRECT answers
// that must come through the production tail unchanged, small talk, and a linear trim. Fictional members only. Run: node --test tests/unit/ask-grounding-review.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { scopeOf } from "../../infrastructure/worker/ask-grounding.js";
import { unknownNames } from "../../infrastructure/worker/ask-build.js";
import { buildAnswerInputs, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const FOX = { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(34) }, updated: "x" };
const OWL = { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), race: f("orc"), level: f(28) }, updated: "x" };
const ELK = { slug: "green-elk", name: "Green Elk", fields: { class: f("priest"), race: f("troll"), level: f(31) }, updated: "x" };
const LIB = [{ id: "systems/trainers", category: "systems", title: "Class trainers", blurb: "Where trainers stand", facts: [
  { key: "trainers.horde", value: "the Horde trainers stand in Razor Hill (Durotar: Hunter, Mage) and in Brill (guide roster, tier 2); no Druid trainer in Durotar; Thunder Bluff has three" },
] }];
function makeEnv(sheets) {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets));
  return { DB };
}
const ask = (env, question, by = "Red Fox", slug = "red-fox") => buildAnswerInputs(env, { question, by, memberSlug: slug, journey: "curious", share: true });
const finish = (env, i, rawAnswer, by = "Red Fox") => finishAnswerText(env, { rawAnswer, isCoach: false, parsedPages: i.parsedPages, by, askerIsMember: true, persona: i.persona, intentId: "r1", groundingText: i.groundingText, personalised: false, retrieval: i.retrieval, group: i.group });

test("the name check catches an invented name of the shape 'One to One' and 'General Name'; ordinary prose stays clean", () => {
  const allowed = "stormwind trainers; thunder bluff; the library lists paladins in stormwind";
  for (const t of ["Take Call to Arms today.", "Try Ode for Thunderfury soon.", "Farm Rage in Winterspring now.", "Meet General Vexnar at the gate."]) assert.ok(unknownNames(t, allowed).length > 0, t);
  assert.deepEqual(unknownNames("Trainers in Stormwind teach Paladins.", allowed), []);
  assert.deepEqual(unknownNames("Paladins in Stormwind are listed.", allowed), []);
  assert.deepEqual(unknownNames("Go to Thunder Bluff.", allowed), []);
  assert.deepEqual(unknownNames("Official Blizzard posts say so.", allowed), []);
});

test("scopeOf never calls an official Blizzard source a guide or fan site, checked on the real library", () => {
  const dir = new URL("../../data/library/", import.meta.url);
  let facts = 0, official = 0, wrong = 0, guide = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const j = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    for (const p of Array.isArray(j.pages) ? j.pages : []) for (const fact of Array.isArray(p.facts) ? p.facts : []) {
      facts++;
      const s = scopeOf(fact.key, fact.value);
      if (s.includes("guide or fan site")) guide++;
      if (/\bBlizzard(?:'s)? (?:[\w-]+ ){0,3}(?:posts?|deep dives?|blogs?|announcements?|patch notes)\b|Forever-confirmed/i.test(fact.value)) { official++; if (s.includes("guide or fan site")) wrong++; }
    }
  }
  assert.ok(facts > 100 && official > 10 && guide > 10, `${facts} ${official} ${guide}`);
  assert.equal(wrong, 0);
  assert.deepEqual(scopeOf("x", "the guide roster, tier 2; no Blizzard trainer list"), ["guide or fan site"]);
  assert.deepEqual(scopeOf("x", "listed in the forum, tier 2"), []);
  assert.deepEqual(scopeOf("x", "per the Blizzard Oct 7 deep dive and a guide"), []);
});

test("a suppressed build tags nothing: the asker's faction follows the same decision as the stored build", async () => {
  const env = makeEnv([FOX, OWL, ELK]);
  const on = await ask(env, "where do the Horde trainers stand in Razor Hill and Brill for my class");
  assert.match(on.userPrompt, /Horde fact: not the asker's faction/);
  const off = await ask(env, "I am a hunter, where do the Horde trainers stand in Razor Hill");
  assert.ok(!off.userPrompt.includes("not the asker's faction"));
});

// Correct answers (idioms, quantifiers, supported absences, verdict-like words) must come through unchanged, for a mixed and a single-faction group.
const CORRECT = [
  "There is no need to guess: the Horde trainers stand in Razor Hill and Brill.",
  "Dungeon groups hold no more than five players, and the Horde trainers stand in Razor Hill.",
  "No matter the class, the Horde trainers stand in Razor Hill and Brill.",
  "It is no secret that the Horde trainers stand in Razor Hill and Brill.",
  "You don't have to travel far: the Horde trainers stand in Razor Hill.",
  "Never mind the walk, the Horde trainers stand in Razor Hill and Brill.",
  "Yes and no: the Horde trainers stand in Razor Hill and Brill.",
  "No Druid trainer stands in Durotar; Thunder Bluff has three.",
  "Durotar has no Druid trainer, and Brill trains Mage and Priest.",
  "No one has signed up for the Horde trainers in Razor Hill yet.",
];
for (const mixed of [true, false]) {
  test(`hand-built correct answers survive the production tail unchanged (${mixed ? "mixed" : "single-faction"} group)`, async () => {
    const env = makeEnv(mixed ? [FOX, OWL, ELK] : [OWL, ELK]);
    const by = mixed ? "Red Fox" : "Blue Owl";
    const i = await ask(env, "where do the Horde trainers stand in Razor Hill and Durotar", by, mixed ? "red-fox" : "blue-owl");
    assert.equal(i.group.mixed, mixed);
    for (const body of CORRECT) {
      const out = await finish(env, i, `${body}\n\n-# Sources: systems/trainers`, by);
      assert.equal(out.answer.split("\n\n-#")[0], body, body);
    }
  });
}

test("small talk with no retrieval keeps its words", async () => {
  const env = makeEnv([FOX, OWL, ELK]);
  const i = await ask(env, "thanks");
  assert.equal(i.retrieved, false);
  const out = await finish(env, i, "Anytime, Red Fox, and no problem at all.");
  assert.equal(out.answer, "Anytime, Red Fox, and no problem at all.");
});

test("a very long run of separators does not stall the formatter", async () => {
  const env = makeEnv([FOX, OWL, ELK]);
  const i = await ask(env, "where do the Horde trainers stand in Razor Hill");
  const t0 = Date.now();
  await finish(env, i, `The Horde trainers stand in Razor Hill${",".repeat(200000)}\n\n-# Sources: systems/trainers`);
  assert.ok(Date.now() - t0 < 5000, String(Date.now() - t0));
});
