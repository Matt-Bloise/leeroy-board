// P0 from the first live Self-RAG-lite answer: a friend asked "any better answers to my previous question about what I should train" and was told the Library
// had nothing, then pointed at another member's leatherworking and "patch notes" with chat filler. Two fixes: (1) a follow-up ranks the asker's earlier question
// together with the follow-up and shows it to the model; (2) when nothing relevant is retrieved the answer is written by code (no model, no filler, no other
// person), and says what the Library does cover for the asker's own build. Fictional library and members only.
// Run: node --test tests/unit/ask-followup-abstain.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, buildAnswerInputs, findPreviousQuestion, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { insertAskTurn } from "../../infrastructure/worker/answer-ux.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { isFollowUp, stripFollowUpScaffold, composeAbstain } from "../../infrastructure/worker/self-rag.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("undead"), spec_path: f("retribution"), level: f(12), professions: f(["mining", "smithing"]) }, updated: "x" },
  { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), professions: f(["leatherworking"]), level: f(9) }, updated: "x" },
];
const LIB = [
  { id: "classes/paladin", category: "classes", title: "Paladin", blurb: "Plate healers, tanks and damage", facts: [
    { key: "paladin.role", value: "Paladins can tank, heal or deal damage; Retribution is the damage spec." },
    { key: "paladin.train", value: "A Paladin trains new seals and blessings from the class trainer every two levels." },
  ] },
  { id: "classes/mage", category: "classes", title: "Mage", blurb: "Ranged casters", facts: [{ key: "mage.role", value: "The mage is a ranged caster with area damage." }] },
  { id: "professions/mining", category: "professions", title: "Mining", blurb: "Ore and bars", facts: [{ key: "mining.start", value: "Mining skill is learned from the trainer in the capital." }] },
  { id: "professions/leatherworking", category: "professions", title: "Leatherworking", blurb: "Leather armor", facts: [{ key: "lw.start", value: "Leatherworking is learned from the trainer in the capital." }] },
  { id: "dungeons/sunken-vault", category: "dungeons", title: "Sunken Vault", blurb: "A flooded vault", facts: [{ key: "sv.boss", value: "The first boss of the Sunken Vault is Old Moss." }] },
];
function makeEnv() {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of LIB) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  const modelCalls = [];
  const room = { fetch: async () => new Response("ok") };
  return { DB, USER_SALT: "user-salt-for-tests-0123456789", BOARD_ROOM: { idFromName: () => "r", get: () => room }, AI: { run: async (_m, i) => (modelCalls.push(i.messages), { response: "**Model answer.**" }) }, modelCalls };
}
const FOLLOW = "any better answers to my previous question";
const PREV = "what should I train as a paladin";

// ---- follow-ups ----
test("isFollowUp: explicit references and short openers, not ordinary questions", () => {
  for (const q of [FOLLOW, "any better answers?", "can you try that again", "what about my last question", "and what about the mage", "so how about mining", "once more please", "same question as before"]) assert.equal(isFollowUp(q), true, q);
  for (const q of ["what should I train as a paladin", "who is the first boss of the sunken vault", "and then there were none of those facts in the entire library today please explain in detail", "hello"]) assert.equal(isFollowUp(q), false, q);
});

test("a follow-up retrieves the topic of the asker's previous question and shows that question to the model", async () => {
  const env = makeEnv();
  const alone = await buildAnswerInputs(env, { question: FOLLOW, by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false });
  assert.equal(alone.abstain, true, "on its own the follow-up has no topic");
  const withPrev = await buildAnswerInputs(env, { question: FOLLOW, by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: PREV });
  assert.equal(withPrev.abstain, false);
  assert.equal(withPrev.followUp, true);
  assert.ok(withPrev.hits.some((h) => h.page === "classes/paladin"), withPrev.hits.map((h) => h.page).join(","));
  assert.match(withPrev.userPrompt, /PREVIOUS_QUESTION/);
  assert.ok(withPrev.userPrompt.includes(PREV));
  assert.match(withPrev.userPrompt, /follow-up/);
  assert.equal(withPrev.abstainAnswer, null);
});

test("answerWithAi finds the previous question of the same asker (and only theirs), skipping earlier follow-ups", async () => {
  const env = makeEnv();
  const turn = async (id, by, slug, question, at) => { await insertAskTurn(env, { id, byName: by, question, provider: "workers-ai", share: false, createdAt: at }, { slug }); };
  const iso = (m) => new Date(Date.now() - m * 60000).toISOString();
  await turn("a1", "Red Fox", "red-fox", PREV, iso(30));
  await turn("a2", "Red Fox", "red-fox", "who is the first boss of the sunken vault", iso(20));
  await turn("b1", "Blue Owl", "blue-owl", "what does the mage do", iso(15));
  await turn("a3", "Red Fox", "red-fox", "any better answers?", iso(10));
  await turn("a4", "Red Fox", "red-fox", FOLLOW, iso(0));
  assert.equal(await findPreviousQuestion(env, { intentId: "a4" }), "who is the first boss of the sunken vault", "the latest standalone question of this asker; Blue Owl's is not theirs");
  assert.equal(await findPreviousQuestion(env, { intentId: "b1" }), null, "Blue Owl has no earlier question");
  // end to end: the model sees the earlier question
  await answerWithAi({ env, origin: "https://worker.test", intentId: "a4", by: "Red Fox", memberSlug: "red-fox", question: FOLLOW, provider: "workers-ai", share: false, isMember: true });
  assert.equal(env.modelCalls.length, 1);
  assert.match(env.modelCalls[0][1].content, /who is the first boss of the sunken vault/);
});

test("a visitor has no previous question; a follow-up with no earlier question says so instead of inventing a topic", async () => {
  const env = makeEnv();
  await insertAskTurn(env, { id: "v1", byName: "Visitor", question: PREV, provider: "workers-ai", share: false, createdAt: new Date().toISOString() }, {});
  await insertAskTurn(env, { id: "v2", byName: "Visitor", question: FOLLOW, provider: "workers-ai", share: false, createdAt: new Date().toISOString() }, {});
  assert.equal(await findPreviousQuestion(env, { intentId: "v2" }), null);
  await answerWithAi({ env, origin: "https://worker.test", intentId: "v2", by: "Visitor", memberSlug: "guest", question: FOLLOW, provider: "workers-ai", share: false, isMember: false });
  const row = env.DB.raw.prepare("SELECT answer, status FROM ask_turns WHERE id = 'v2'").get();
  assert.equal(row.status, "answered");
  assert.match(row.answer, /can't tell which question you mean/i);
  assert.equal(env.modelCalls.length, 0);
});

// ---- the abstain answer ----
const FILLER = /well past the point|keeps your notes|worth a look next|patch notes|while you wait|santa|bible boi|street rat|bloise|handsome squidward|leatherworking|blue owl|mulgore/i;

test("an out-of-scope question still abstains honestly, with no model call, no filler, and no other member's build or profession", async () => {
  const env = makeEnv();
  await insertAskTurn(env, { id: "o1", byName: "Red Fox", question: "what is the best pizza topping for a raid night", provider: "workers-ai", share: false, createdAt: new Date().toISOString() }, { slug: "red-fox" });
  await answerWithAi({ env, origin: "https://worker.test", intentId: "o1", by: "Red Fox", memberSlug: "red-fox", question: "what is the best pizza topping for a raid night", provider: "workers-ai", share: false, isMember: true });
  const row = env.DB.raw.prepare("SELECT answer, cites_json, model, status FROM ask_turns WHERE id = 'o1'").get();
  assert.equal(row.status, "answered");
  assert.equal(env.modelCalls.length, 0, "no AI call on the abstain path");
  assert.match(row.model, /abstain/);
  assert.match(row.answer, /does not cover that yet/i);
  assert.match(row.answer, /official Blizzard post|someone in the party/i, "it says what would settle it");
  assert.ok(!FILLER.test(row.answer), row.answer);
  assert.ok(!/pizza|raid night/i.test(row.answer), "the question is not echoed or answered");
});

const GAME_Q = "does the paladin trainer in the capital teach seals and blessings to flamingo wands"; // about the game, but not in the Library

test("the abstain answer lists what the Library DOES cover for the asker's own class, spec and professions", async () => {
  const env = makeEnv();
  const i = await buildAnswerInputs(env, { question: GAME_Q, by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false });
  assert.equal(i.abstain, true);
  const ids = i.abstainPages.map((p) => p.id);
  assert.ok(ids.includes("classes/paladin"), ids.join(","));
  assert.ok(ids.includes("professions/mining"), ids.join(","));
  assert.ok(!ids.includes("professions/leatherworking") && !ids.includes("classes/mage"), "another member's build is never used");
  assert.match(i.abstainAnswer, /For your level 12 Retribution Paladin the Library does have:/);
  assert.match(i.abstainAnswer, /\*\*Paladin\*\*/);
  assert.match(i.abstainAnswer, /-# Sources: .*classes\/paladin/);
  assert.ok(!FILLER.test(i.abstainAnswer), i.abstainAnswer);
  // and it reaches the reader through the real pipeline, with Sources limited to those pages
  const env2 = makeEnv();
  await insertAskTurn(env2, { id: "o2", byName: "Red Fox", question: GAME_Q, provider: "workers-ai", share: false, createdAt: new Date().toISOString() }, { slug: "red-fox" });
  await answerWithAi({ env: env2, origin: "https://worker.test", intentId: "o2", by: "Red Fox", memberSlug: "red-fox", question: GAME_Q, provider: "workers-ai", share: false, isMember: true });
  const row = env2.DB.raw.prepare("SELECT answer, cites_json FROM ask_turns WHERE id = 'o2'").get();
  assert.ok(JSON.parse(row.cites_json).includes("classes/paladin"));
  assert.ok(!FILLER.test(row.answer), row.answer);
  assert.match(row.answer, /Paladin/);
});

test("a question that is not about the game gets the honest line and the subject areas, not a list of the asker's build pages", async () => {
  const env = makeEnv();
  const i = await buildAnswerInputs(env, { question: "what is the best pizza topping for a raid night", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false });
  assert.equal(i.abstain, true);
  assert.deepEqual(i.abstainPages, []);
  assert.match(i.abstainAnswer, /I can answer questions about: .*classes/);
  assert.ok(!/For your/.test(i.abstainAnswer));
});

test("a visitor's abstain answer names the Library's subject areas, not a person", async () => {
  const env = makeEnv();
  const i = await buildAnswerInputs(env, { question: "what is the best pizza topping for a raid night", by: "Visitor", journey: "curious", share: false, isMember: false });
  assert.equal(i.abstain, true);
  assert.match(i.abstainAnswer, /I can answer questions about: .*classes/);
  assert.ok(!FILLER.test(i.abstainAnswer), i.abstainAnswer);
});

test("composeAbstain: the follow-up-without-context wording, no pages, and clipping", () => {
  assert.match(composeAbstain({ followUpWithoutContext: true }), /can't tell which question you mean/);
  const none = composeAbstain({ build: { class: "mage", level: "9" }, pages: [] });
  assert.match(none, /^\*\*The Library does not cover that yet/);
  assert.ok(!/For your/.test(none));
  const many = composeAbstain({ build: { class: "mage", spec: "frost", level: "9" }, pages: Array.from({ length: 6 }, (_, n) => ({ id: `c/p${n}`, title: `Page ${n} ${"x".repeat(300)}`, blurb: "a clipped blurb would be half a claim" })) });
  assert.equal((many.match(/^- \*\*/gm) || []).length, 3, "at most three pages");
  assert.ok(many.split("\n").every((l) => l.length < 200));
  assert.ok(!/clipped blurb/.test(many), "titles only: no blurb text");
});

test("the live phrasing: 'any better answers to my previous question about what I should train' ranks the earlier question, not its own scaffolding", async () => {
  const env = makeEnv();
  const live = "any better answers to my previous question about what I should train?";
  assert.equal(isFollowUp(live), true);
  assert.equal(stripFollowUpScaffold(live), "what I should train?");
  const i = await buildAnswerInputs(env, { question: live, by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: "what should I do next as a paladin" });
  assert.equal(i.abstain, false);
  assert.ok(i.hits.some((h) => h.page === "classes/paladin"));
  assert.equal(stripFollowUpScaffold("and what about the mage?"), "the mage?", "a follow-up can add a topic");
  assert.equal(stripFollowUpScaffold("any better answers to my previous question, thanks"), "");
  const mage = await buildAnswerInputs(env, { question: "and what about the mage?", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: PREV });
  assert.ok(mage.hits.some((h) => h.page === "classes/mage"), mage.hits.map((h) => h.page).join(","));
});
