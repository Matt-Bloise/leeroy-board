// Self-RAG-lite for /ask (self-rag.js): Retrieve? (greetings and pure build questions skip the library), IsRel (a coverage floor on retrieved facts),
// Abstain (the library has nothing: say so, invent nothing, keep the asker's build), IsSup (cited ids must have been retrieved; numbers must be in the
// retrieved text, the build or the question). Fictional library and members only. Run: node --test tests/unit/self-rag.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswerInputs, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { NOT_PUBLISHED_LINE } from "../../infrastructure/worker/ask-build.js";
import {
  needsRetrieval, selectRelevant, supportCheck, stripUnretrievedCites, retrievedFromGrounding, groundingWithIds,
  ABSTAIN_LINE, ABSTAIN_RULE, SKIP_RULE, ABSTAIN_BELOW,
} from "../../infrastructure/worker/self-rag.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), spec_path: f("protection"), level: f(12), professions: f(["mining", "smithing"]) }, updated: "x" },
];
const LIB = [
  { id: "classes/paladin-protection", category: "classes", title: "Protection Paladin", blurb: "Tank basics", facts: [
    { key: "pp.tank", value: "Protection Paladins tank with Holy Shield." },
    { key: "pp.armor", value: "Protection Paladins wear plate armor from level 40." },
  ] },
  { id: "dungeons/sunken-vault", category: "dungeons", title: "Sunken Vault", blurb: "A flooded vault", facts: [
    { key: "sv.boss", value: "The first boss of the Sunken Vault is Old Moss." },
    { key: "sv.level", value: "The Sunken Vault is meant for levels 18 to 24." },
  ] },
  { id: "systems/mounts", category: "systems", title: "Mounts", blurb: "Riding", facts: [{ key: "mounts.cost", value: "A mount costs 100 gold at level 40." }] },
];

function makeEnv() {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  return { DB };
}
const ask = (env, question) => buildAnswerInputs(env, { question, by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false });
const finish = (env, i, rawAnswer) => finishAnswerText(env, { rawAnswer, isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "t1", groundingText: i.groundingText, personalised: i.personalised });

// ---- Retrieve? ----
test("Retrieve?: greetings, thanks and pure build questions skip the library; any question with game words retrieves", () => {
  for (const q of ["hi", "Hello there!", "hey leeroy", "thanks", "thank you so much!", "ok", "good morning", "what is my build", "show me my sheet?", "how's my character", "who am I", "what am i playing"]) assert.equal(needsRetrieval(q), false, q);
  for (const q of ["hi, who is the first boss of the sunken vault", "what gear should my paladin get", "what's my build for tanking the vault", "thanks, what level is the vault", "when does the vault open", "", "x"]) assert.equal(needsRetrieval(q), true, q);
});

test("Retrieve?: a skipped message carries no library facts, tells the model so, and cites nothing", async () => {
  const env = makeEnv();
  for (const q of ["hello there", "what is my build"]) {
    const i = await ask(env, q);
    assert.equal(i.retrieved, false, q);
    assert.deepEqual(i.hits, []);
    assert.deepEqual(i.ranked, []);
    assert.match(i.userPrompt, /not needed for this message/);
    assert.ok(i.userPrompt.includes(SKIP_RULE));
    assert.ok(!/Holy Shield|Old Moss/.test(i.userPrompt), "no library fact in the prompt");
    assert.deepEqual(retrievedFromGrounding(i.groundingText).ids.size, 0);
  }
  const mine = await ask(env, "what is my build");
  assert.match(mine.userPrompt, /class: paladin/, "the asker's build is still in the prompt");
});

// ---- IsRel + Abstain ----
test("IsRel: a game question retrieves the facts that cover it and the pages they sit on, not zero-score filler", async () => {
  const i = await ask(makeEnv(), "who is the first boss of the sunken vault");
  assert.equal(i.retrieved, true);
  assert.equal(i.abstain, false);
  assert.match(i.userPrompt, /Old Moss/);
  assert.ok(i.ranked.every((p) => p.id === "dungeons/sunken-vault" || /vault|boss/i.test(`${p.title} ${p.blurb}`)), i.ranked.map((p) => p.id).join(","));
  assert.ok(i.ranked.length >= 1 && i.ranked.length < LIB.length + 1);
  assert.ok(retrievedFromGrounding(i.groundingText).ids.has("dungeons/sunken-vault"));
  assert.ok(!retrievedFromGrounding(i.groundingText).ids.has("systems/mounts"), "a page nothing matched is not retrieved");
});

test("Abstain: nothing relevant retrieved, so the prompt says the library has nothing, keeps the build, and no fact is offered", async () => {
  const i = await ask(makeEnv(), "what is the capital of france and its best pizza topping");
  assert.equal(i.abstain, true);
  assert.deepEqual(i.hits, []);
  assert.deepEqual(i.ranked, []);
  assert.match(i.userPrompt, /no library fact matches this question/);
  assert.ok(i.userPrompt.includes(ABSTAIN_RULE));
  assert.match(i.userPrompt, /class: paladin/, "the asker's build lines are kept");
  assert.ok(!/Holy Shield|Old Moss|plate armor/.test(i.userPrompt), "no library fact leaks into an abstaining prompt");
  assert.ok(retrievedFromGrounding(i.groundingText).abstain);
});

test("IsRel unit: coverage floor drops weak facts and abstains below ABSTAIN_BELOW", () => {
  const hays = ["boss vault moss", "tank shield", "mount cost gold", "plate armor level", "gold price level"];
  const mk = (value, score) => ({ value, score, page: "p/x", key: "k", f: { key: "k", value } });
  const words = ["boss", "vault"];
  const strong = selectRelevant([mk("boss of the vault is moss", 9), mk("a vault", 6), mk("gold price level", 5)], words, hays);
  assert.equal(strong.abstain, false);
  assert.ok(strong.hits.some((h) => /moss/.test(h.value)));
  assert.ok(!strong.hits.some((h) => /gold/.test(h.value)), "a fact that shares no question word is dropped");
  const none = selectRelevant([mk("gold price level", 6)], ["pizza", "topping"], hays);
  assert.equal(none.abstain, true);
  assert.deepEqual(none.hits, []);
  assert.ok(none.best < ABSTAIN_BELOW);
  assert.equal(selectRelevant([], ["boss"], hays).abstain, true);
  assert.equal(selectRelevant([mk("x", 1)], [], hays).abstain, true);
});

// ---- IsSup ----
test("IsSup: a number the library, the build and the question never gave is stripped; supported numbers stay (leaked-fact case)", async () => {
  const env = makeEnv();
  const i = await ask(env, "who is the first boss of the sunken vault");
  const r = await finish(env, i, "**The first boss of the Sunken Vault is Old Moss.**\n- It drops 7 boots and 450 gold.\n- The vault is meant for levels 18 to 24.\n\n-# Sources: dungeons/sunken-vault");
  assert.ok(r.answer.includes("Old Moss"));
  assert.ok(r.answer.includes("18 to 24"), "a number from the retrieved fact stays");
  assert.ok(!r.answer.includes("450") && !r.answer.includes("boots"), "an invented number takes its sentence with it");
  assert.deepEqual(r.cites, ["dungeons/sunken-vault"]);
});

test("IsSup: a sentence number that is the asker's own level or in the question is supported", async () => {
  const env = makeEnv();
  const i = await ask(env, "is the vault fine for my level 12 paladin");
  const r = await finish(env, i, "**At level 12 you can try the Sunken Vault.**\n- The vault is meant for levels 18 to 24.\n\n-# Sources: dungeons/sunken-vault");
  assert.ok(r.answer.includes("level 12"));
  assert.ok(r.answer.includes("18 to 24"));
});

test("IsSup: a source that exists in the library but was not retrieved is not cited", async () => {
  const env = makeEnv();
  const i = await ask(env, "who is the first boss of the sunken vault");
  const r = await finish(env, i, "**The first boss of the Sunken Vault is Old Moss.**\n\n-# Sources: dungeons/sunken-vault, systems/mounts, nope/unknown");
  assert.deepEqual(r.cites, ["dungeons/sunken-vault"]);
  assert.ok(!/mounts/i.test(r.answer), r.answer);
  const bracket = stripUnretrievedCites("**Old Moss.** [systems/mounts~mounts.cost] and [dungeons/sunken-vault~sv.boss]\n-# Sources: systems/mounts", new Set(["dungeons/sunken-vault"]));
  assert.deepEqual(bracket.removed.sort(), ["systems/mounts", "systems/mounts"]);
  assert.ok(!bracket.answer.includes("Sources"), "a Sources line with nothing retrieved left is dropped");
});

test("IsSup: when every substantive sentence was unsupported the answer falls back to the abstain wording", () => {
  const r = supportCheck("**It costs 900 gold.**\n- You need level 77 first.\n\n-# Sources: systems/mounts", "mounts cost gold");
  assert.equal(r.ok, false);
  assert.equal(r.answer, ABSTAIN_LINE);
  assert.ok(ABSTAIN_LINE.startsWith("The Library does not cover that"));
});

test("IsSup: counting words and small numbers (0 to 5) are not checked, prose is untouched when supported", () => {
  const a = "**Two options work.**\n- Pick 3 spells and 5 talents.\n- Costs 100 gold at level 40.";
  const r = supportCheck(a, "A mount costs 100 gold at level 40.");
  assert.equal(r.ok, true);
  assert.equal(r.answer, a);
});

test("regression (PR 200): possessives of grounded names and a build level survive the whole pipeline untouched", async () => {
  const env = makeEnv();
  const i = await ask(env, "how do I tank as a protection paladin");
  const text = "**As Red Fox you tank with Holy Shield.**\n- Red Fox's Holy Shield is the tank spell in the library.\n- Protection Paladins wear plate armor from level 40.\n\n-# Sources: classes/paladin-protection";
  const r = await finish(env, i, text);
  assert.ok(!r.answer.includes(NOT_PUBLISHED_LINE) && r.answer !== ABSTAIN_LINE, r.answer);
  assert.ok(r.answer.includes("Red Fox's Holy Shield"));
  assert.ok(r.answer.includes("level 40"));
  assert.deepEqual(r.cites, ["classes/paladin-protection"]);
});

test("a caller with no retrieval marker (older code, other tools) keeps the previous behaviour: no citation filter, no number check", async () => {
  const env = makeEnv();
  const i = await ask(env, "who is the first boss of the sunken vault");
  const r = await finishAnswerText(env, { rawAnswer: "**Old Moss guards it.**\n- 450 gold.\n\n-# Sources: dungeons/sunken-vault, systems/mounts", isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "t2", groundingText: "Old Moss 450 gold", personalised: false });
  assert.deepEqual(r.cites.sort(), ["dungeons/sunken-vault", "systems/mounts"]);
  assert.ok(r.answer.includes("450"));
  assert.equal(retrievedFromGrounding("plain text"), null);
  assert.deepEqual([...retrievedFromGrounding(groundingWithIds("t", ["a/b", "c/d"], true)).ids], ["a/b", "c/d"]);
});
