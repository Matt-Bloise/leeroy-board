// Advisor round on PR 210: tests that pin the design, not just the happy path. Number spellings must not wipe correct sentences, a number mismatch alone must
// never collapse an answer to the abstain line, chat filler and names must not cause false abstention, the thresholds are pinned from both sides, and the
// retrieved-id set reaches past the first hit. Fictional library and members only. Run: node --test tests/unit/self-rag-design.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswerInputs, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import {
  supportCheck, selectRelevant, cleanQuestion, skipKind, ABSTAIN_LINE, NUMBER_UNCONFIRMED_LINE, BUILD_RULE, SKIP_RULE, ABSTAIN_RULE, FACT_REL_BEST, ABSTAIN_BELOW,
} from "../../infrastructure/worker/self-rag.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

// ---- number spellings (advisor finding 1) ----
const keeps = (answer, allowed) => { const r = supportCheck(answer, allowed); assert.equal(r.ok, true, `${answer} | unsupported: ${r.unsupported}`); assert.equal(r.answer, answer); };
const drops = (answer, allowed) => { const r = supportCheck(answer, allowed); assert.equal(r.ok, false, answer); return r; };

test("a correct sentence is not wiped because the model spelled the number another way", () => {
  const fact = "The Ember Keep raid opens on 2026-12-09 at 20:00, costs 10,000 gold to repair after a wipe, takes 5 to 7 hours and needs level sixty.";
  keeps("**Ember Keep opens on December 9.**", fact);
  keeps("**Ember Keep opens on the 9th.**", fact);
  keeps("**Ember Keep opens on Dec 9 2026.**", fact);
  keeps("**Ember Keep opens on 9 December 2026.**", fact);
  keeps("**It starts at 8 PM.**", fact);
  keeps("**It starts at 20:00.**", "Doors open at 8pm.");
  keeps("**A wipe costs about 10k gold.**", fact);
  keeps("**Repairs run 10,000 gold.**", "A wipe costs 10k gold.");
  keeps("**Plan on about 6 hours.**", fact);
  keeps("**Plan on 5 to 7 hours.**", "It takes about 6 hours.");
  keeps("**You need level 60.**", fact);
  keeps("**You need level sixty.**", "Raid entry is level 60.");
});

test("a wrong number is still removed, and 5 and below are counting words", () => {
  const fact = "The vault opens on 2026-12-09 and needs level 60.";
  const r = drops("**The vault opens on December 9.**\n- It needs level 70.\n- Bring 3 friends.", fact);
  assert.ok(r.answer.includes("December 9") && r.answer.includes("Bring 3 friends"), r.answer);
  assert.ok(!r.answer.includes("70"), r.answer);
  drops("**It drops 7 chests.**\n- Bring a friend.", "The vault is hard.");
  keeps("**It drops 5 chests.**", "The vault is hard.");
  drops("**It opens on December 10.**", fact);
  drops("**It starts at 9 PM.**", "Doors open at 8pm.");
});

test("a number mismatch alone never collapses the answer to the abstain line", () => {
  const r = drops("**It costs 900 gold.**\n- You need level 77 first.\n\n-# Sources: systems/mounts", "mounts cost gold");
  assert.notEqual(r.answer, ABSTAIN_LINE);
  assert.ok(r.answer.startsWith(NUMBER_UNCONFIRMED_LINE));
  assert.ok(r.answer.includes("-# Sources: systems/mounts"), "the Sources line stays");
  assert.ok(!ABSTAIN_LINE.includes("figure") && NUMBER_UNCONFIRMED_LINE.includes("figure"));
});

// ---- false abstention (advisor finding 2) ----
const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), level: f(12) }, updated: "x" }];
const LIB = [
  { id: "raids/ember-keep", category: "raids", title: "Ember Keep", blurb: "A fire raid", facts: [
    { key: "ember.entry", value: "Ember Keep needs level 60 and a raid group of 40." },
    { key: "ember.tanks", value: "Ember Keep is tanked by Protection Warriors and Protection Paladins." },
    { key: "ember.heals", value: "Ember Keep wants Priests and Druids healing." },
  ] },
  ...Array.from({ length: 7 }, (_, n) => ({ id: `zoo/pen-${n + 1}`, category: "zoo", title: `Pen ${n + 1}`, blurb: "Animals", facts: [{ key: `pen${n + 1}.quokka`, value: `The quokka lives in pen ${n + 1}.` }] })),
];
function makeEnv() {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  return { DB };
}
const ask = (env, question, by = "Red Fox") => buildAnswerInputs(env, { question, by, memberSlug: "red-fox", journey: "curious", share: false });

test("messy Discord phrasing about a library topic does not abstain (names, the asker's name and filler are not topics)", async () => {
  const env = makeEnv();
  for (const q of [
    "bro can Bible Boi tank ember keep or nah lol",
    "can Handsome Squidward heal in ember keep",
    "Bloise here, do I need to be lvl 60 for Ember Keep?? asking for Santa",
    "yo Red Fox here, is ember keep tanked by warriors or whatever tbh",
    "ok so who heals ember keep pls",
  ]) {
    const i = await ask(env, q);
    assert.equal(i.abstain, false, q);
    assert.ok(i.hits.some((h) => h.page === "raids/ember-keep"), q);
  }
});

test("a question that is not about the Library abstains: two absent words, or one in a very short question", async () => {
  const env = makeEnv();
  for (const q of ["what is the best pizza topping for a raid night", "bro what is the capital of france lol", "how do I fix my laptop graphics driver"]) {
    const i = await ask(env, q);
    assert.equal(i.abstain, true, q);
    assert.deepEqual(i.hits, []);
    assert.ok(i.userPrompt.includes(ABSTAIN_RULE));
  }
});

test("cleanQuestion: names, the asker, filler and lvl are tidied for ranking, not for the prompt", async () => {
  assert.equal(cleanQuestion("bro can Bible Boi tank onyxia or nah lol", ["Bible Boi"]), "can tank onyxia or");
  assert.equal(cleanQuestion("Red Fox here: lvl 60 for the keep?", ["Red Fox"]), "here: level 60 for the keep?");
  assert.equal(cleanQuestion("Street Rat's build", ["Street Rat"]).includes("Street"), false);
  const i = await ask(makeEnv(), "bro can Bible Boi tank ember keep or nah lol");
  assert.ok(i.userPrompt.includes("bro can Bible Boi tank ember keep or nah lol"), "the question reaches the model exactly as asked");
});

// ---- thresholds pinned from both sides (advisor finding 5) ----
test("the relative fact floor: a fact at about half the best is kept, one at about a third is dropped", () => {
  const hays = ["alpha beta gamma", "alpha x1", "beta x2", "gamma x3", "x4 x5", "x6 x7", "x8 x9", "x10 x11"];
  const mk = (value) => ({ value, score: 5, page: "p/x", key: "k", f: { key: "k", value } });
  const hits = [mk("alpha beta gamma"), mk("alpha beta"), mk("alpha")];
  const r = selectRelevant(hits, ["alpha", "beta", "gamma"], hays);
  assert.equal(r.abstain, false);
  const values = r.hits.map((h) => h.value);
  assert.ok(values.includes("alpha beta gamma") && values.includes("alpha beta"), "about 2/3 of the best is kept");
  assert.ok(!values.includes("alpha"), "about 1/3 of the best is dropped");
  assert.ok(FACT_REL_BEST > 0.34 && FACT_REL_BEST < 0.66);
});

test("coverage counts the fact's key as well as its value", () => {
  const hays = ["zorp cost fifty gold", "other fact", "more text", "another one", "x y z", "p q r"];
  const hit = { value: "fifty gold", score: 5, page: "p/x", key: "zorp.cost", f: { key: "zorp.cost", value: "fifty gold" } };
  const r = selectRelevant([hit], ["zorp", "cost"], hays);
  assert.equal(r.abstain, false);
  assert.equal(r.kept, 1);
  assert.ok(r.best > ABSTAIN_BELOW);
});

test("a source that is only in the facts after the first hit is still retrieved and citable", async () => {
  const env = makeEnv();
  const i = await ask(env, "where does the quokka live");
  const ranked = new Set(i.ranked.map((p) => p.id));
  const onlyInFacts = i.hits.map((h) => h.page).filter((id) => !ranked.has(id));
  assert.ok(onlyInFacts.length >= 1, "seven pages match, five are listed as pages, the rest are only in the facts");
  const id = onlyInFacts[0];
  assert.ok(i.retrieval.ids.includes(id));
  const r = await finishAnswerText(env, { rawAnswer: `**The quokka lives in a pen.**\n\n-# Sources: ${id}`, isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "t1", groundingText: i.groundingText, personalised: i.personalised, retrieval: i.retrieval });
  assert.deepEqual(r.cites, [id]);
});

// ---- the build question (advisor finding 3) ----
test("a question about the asker's own build is answered from YOUR_BUILD: the prompt allows its class, level and spec", async () => {
  const env = makeEnv();
  assert.equal(skipKind("what is my build"), "build");
  assert.equal(skipKind("hello"), "greeting");
  assert.equal(skipKind("who heals ember keep"), null);
  const i = await ask(env, "what is my build");
  assert.ok(i.userPrompt.includes(BUILD_RULE) && !i.userPrompt.includes(SKIP_RULE));
  assert.match(BUILD_RULE, /YOUR_BUILD/);
  assert.ok(!/state no game fact/.test(BUILD_RULE), "it does not forbid stating the build itself");
  const r = await finishAnswerText(env, { rawAnswer: "**You are a level 12 Paladin.**\n- Class: paladin, level 12.", isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "t1", groundingText: i.groundingText, personalised: i.personalised, retrieval: i.retrieval });
  assert.ok(r.answer.includes("level 12") && r.answer !== ABSTAIN_LINE && !r.answer.startsWith(NUMBER_UNCONFIRMED_LINE), r.answer);
});
