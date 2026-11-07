// Advisor review of PR 214 (follow-ups and the code-written abstain answer). Each test fails on the first head (511a51d). Fictional library and members only.
// Run: node --test tests/unit/ask-followup-review.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, buildAnswerInputs, finishAnswerText, findPreviousQuestion, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { insertAskTurn } from "../../infrastructure/worker/answer-ux.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { isFollowUp, refersToPrevious, FOLLOWUP_RULE } from "../../infrastructure/worker/self-rag.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), spec_path: f("retribution"), level: f(12) }, updated: "x" }];
const LIB = [
  { id: "classes/paladin", category: "classes", title: "Paladin", blurb: "Plate", facts: [
    { key: "paladin.role", value: "Paladins can tank, heal or deal damage; Retribution is the damage spec." },
    { key: "paladin.spec", value: "The best spec for a paladin that wants to tank is Protection." },
    { key: "paladin.train", value: "A Paladin trains new seals and blessings from the class trainer in the capital." },
  ] },
  { id: "professions/leatherworking", category: "professions", title: "Leatherworking", blurb: "Leather", facts: [{ key: "lw.start", value: "Leatherworking is learned from the trainer in Thunder Bluff and needs skill 37 for the first pattern." }] },
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
const iso = (m) => new Date(Date.now() - m * 60000).toISOString();
const turn = (env, id, question, at, share, who = { slug: "red-fox" }) => insertAskTurn(env, { id, byName: "Red Fox", question, provider: "workers-ai", share, createdAt: at }, who);

// ---- 1. privacy: a private earlier question never reaches a public follow-up ----
test("a PRIVATE earlier question is not used by a PUBLIC follow-up, but is by a private one", async () => {
  const env = makeEnv();
  await turn(env, "p1", "PRIVATE-TOPIC-7 what should I train as a paladin", iso(30), false);
  await turn(env, "p2", "any better answers to my previous question", iso(1), true);
  await turn(env, "p3", "any better answers to my previous question", iso(0), false);
  assert.equal(await findPreviousQuestion(env, { intentId: "p2", share: true }), null, "public follow-up: the private question is invisible");
  assert.match(await findPreviousQuestion(env, { intentId: "p3", share: false }), /PRIVATE-TOPIC-7/, "private follow-up: the asker's own private question is fine");
  await turn(env, "p4", "what is the best spec for a paladin", iso(20), true);
  await turn(env, "p5", "any better answers to my previous question", iso(0), true);
  assert.equal(await findPreviousQuestion(env, { intentId: "p5", share: true }), "what is the best spec for a paladin", "a public earlier question is used");
  // end to end: the model prompt of a public follow-up never carries the private text
  await answerWithAi({ env, origin: "https://worker.test", intentId: "p2", by: "Red Fox", memberSlug: "red-fox", question: "any better answers to my previous question", provider: "workers-ai", share: true, isMember: true });
  assert.ok(!JSON.stringify(env.modelCalls).includes("PRIVATE-TOPIC-7"));
  assert.ok(!JSON.stringify(env.DB.raw.prepare("SELECT answer FROM ask_turns WHERE id = 'p2'").all()).includes("PRIVATE-TOPIC-7"));
});

// ---- 2. a Discord member has two asker hashes: DISTINCT ----
test("with two asker hashes per turn, four follow-ups later the standalone question is still found", async () => {
  const env = makeEnv();
  const who = { slug: "red-fox", discordId: "100000000000000050" }; // two hashes
  await turn(env, "d0", "what is the best spec for a paladin", iso(60), true, who);
  for (let n = 1; n <= 4; n++) await turn(env, `d${n}`, n % 2 ? "any better answers to my previous question" : "try that again", iso(50 - n), true, who);
  await turn(env, "d5", "any better answers to my previous question", iso(0), true, who);
  assert.equal(await findPreviousQuestion(env, { intentId: "d5", share: true }), "what is the best spec for a paladin");
});

// ---- 3. false positives ----
test("a new question that merely starts 'so' or 'ok so', or contains 'a better option', is not a follow-up", async () => {
  for (const q of ["So what is the best spec for a paladin", "ok so what is the best gear", "and the best spec for a paladin is what", "I want a better option for tanking", "what is the first one dungeon", "I have a follow up about mining", "can you do the same thing for mages"]) {
    assert.equal(isFollowUp(q), false, q);
  }
  for (const q of ["any better answers to my previous question", "and what about the mage", "so how about mining", "try that again"]) assert.equal(isFollowUp(q), true, q);
  assert.equal(refersToPrevious("and what about the mage"), false, "an opener is not an explicit reference");
  assert.equal(refersToPrevious("any better answers"), true);
});

test("'So what is the best spec for a paladin' after a leatherworking question gets paladin facts and no follow-up prompt", async () => {
  const env = makeEnv();
  const i = await buildAnswerInputs(env, { question: "So what is the best spec for a paladin", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: "how do I learn leatherworking" });
  assert.equal(i.abstain, false);
  assert.equal(i.followUp, false);
  assert.ok(!i.userPrompt.includes("PREVIOUS_QUESTION") && !i.userPrompt.includes(FOLLOWUP_RULE));
  assert.equal(i.hits[0].page, "classes/paladin");
  assert.ok(!i.hits.some((h) => h.page === "professions/leatherworking"));
});

test("'what about the mage' with nothing of its own to retrieve uses the earlier question, and one with a strong topic of its own does not", async () => {
  const env = makeEnv();
  const weak = await buildAnswerInputs(env, { question: "and what about that", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: "how do I learn leatherworking" });
  assert.equal(weak.followUp, true);
  assert.equal(weak.hits[0].page, "professions/leatherworking");
  const strong = await buildAnswerInputs(env, { question: "what about the paladin spec", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: "how do I learn leatherworking" });
  assert.equal(strong.followUp, false, "its own retrieval is strong");
  assert.equal(strong.hits[0].page, "classes/paladin");
});

test("an earlier REAL question that starts 'ok so' is a usable previous question", async () => {
  const env = makeEnv();
  await turn(env, "r1", "ok so what is the best spec for a paladin", iso(20), true);
  await turn(env, "r2", "any better answers to my previous question", iso(0), true);
  assert.equal(await findPreviousQuestion(env, { intentId: "r2", share: true }), "ok so what is the best spec for a paladin");
});

// ---- 4. a name or number that only the earlier question holds ----
test("a name and a number that exist only in PREVIOUS_QUESTION may be repeated by the answer", async () => {
  const env = makeEnv();
  const prev = "my paladin heard Thunder Bluff has a trainer at skill 37 for leatherworking, is that true";
  const i = await buildAnswerInputs(env, { question: "any better answers to my previous question", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: prev });
  assert.equal(i.followUp, true);
  const raw = "**The Library does list that trainer.**\n- The trainer is in Thunder Bluff.\n- The first pattern needs skill 37.\n\n-# Sources: professions/leatherworking";
  const r = await finishAnswerText(env, { rawAnswer: raw, isCoach: false, parsedPages: i.parsedPages, by: "Red Fox", askerIsMember: true, persona: i.persona, intentId: "t1", groundingText: i.groundingText, personalised: i.personalised, retrieval: i.retrieval });
  assert.ok(r.answer.includes("Thunder Bluff") && r.answer.includes("37"), r.answer);
});

// ---- 7. the follow-up rule is outside the data fence ----
test("the follow-up rule sits outside every data fence", async () => {
  const env = makeEnv();
  const i = await buildAnswerInputs(env, { question: "any better answers to my previous question", by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion: "what is the best spec for a paladin" });
  const at = i.userPrompt.indexOf(FOLLOWUP_RULE);
  assert.ok(at > 0);
  const opens = [...i.userPrompt.slice(0, at).matchAll(/<<<([A-Z_]+)/g)].map((m) => m[1]);
  const closes = [...i.userPrompt.slice(0, at).matchAll(/([A-Z_]+)>>>/g)].map((m) => m[1]);
  assert.deepEqual(opens.sort(), closes.sort(), "every fence opened before the rule is closed before it");
});

// ---- 8. the reader's text, after repair ----
test("the abstain answer the reader gets (after repair) lists the asker's class page and nothing else of the build", async () => {
  const env = makeEnv();
  await turn(env, "o1", "does the paladin trainer in the capital teach seals and blessings to flamingo wands", iso(0), false);
  await answerWithAi({ env, origin: "https://worker.test", intentId: "o1", by: "Red Fox", memberSlug: "red-fox", question: "does the paladin trainer in the capital teach seals and blessings to flamingo wands", provider: "workers-ai", share: false, isMember: true });
  const row = env.DB.raw.prepare("SELECT answer, cites_json FROM ask_turns WHERE id = 'o1'").get();
  assert.match(row.answer, /^- Paladin$/m, row.answer);
  assert.match(row.answer, /For your level 12 Retribution Paladin the Library does have:/);
  assert.match(row.answer, /-# Sources: \[Paladin\]/);
  assert.deepEqual(JSON.parse(row.cites_json), ["classes/paladin"]);
  assert.equal(env.modelCalls.length, 0);
});
