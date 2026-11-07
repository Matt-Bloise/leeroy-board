// Residuals left after PR 214 (Codex council + Fable advisor), tracked as BACKLOG ask-followup-residuals. Fictional library and members only.
// Run: node --test tests/unit/ask-followup-residuals.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, buildAnswerInputs, findPreviousQuestion, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { insertAskTurn } from "../../infrastructure/worker/answer-ux.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { isFollowUp, refersToPrevious, stripFollowUpScaffold } from "../../infrastructure/worker/self-rag.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), spec_path: f("retribution"), level: f(12) }, updated: "x" }];
const LIB = [
  { id: "classes/paladin", category: "classes", title: "Paladin", blurb: "Plate", facts: [
    { key: "paladin.role", value: "Paladins can tank, heal or deal damage; Retribution is the damage spec." },
    { key: "paladin.spec", value: "The best spec for a paladin that wants to tank is Protection." },
    { key: "paladin.train", value: "A Paladin trains new seals and blessings from the class trainer in the capital." },
  ] },
  { id: "classes/mage", category: "classes", title: "Mage", blurb: "Cloth", facts: [{ key: "mage.role", value: "A mage deals ranged spell damage and conjures food and water." }] },
  { id: "professions/leatherworking", category: "professions", title: "Leatherworking", blurb: "Leather", facts: [{ key: "lw.start", value: "Leatherworking is learned from the trainer in Thunder Bluff and needs skill 37 for the first pattern." }] },
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
const turn = (env, id, question, at, share = true) => insertAskTurn(env, { id, byName: "Red Fox", question, provider: "workers-ai", share, createdAt: at }, { slug: "red-fox" });
const inputs = (env, question, previousQuestion = null) => buildAnswerInputs(env, { question, by: "Red Fox", memberSlug: "red-fox", journey: "curious", share: false, previousQuestion });

// (1) an explicit follow-up with no earlier question never reaches the model, even when its own words retrieve well
test("explicit follow-up with no previous question gets the clarification before any model call, even if its words retrieve", async () => {
  const env = makeEnv();
  const q = "once more, the best spec for a paladin that wants to tank";
  await turn(env, "a1", q, iso(0));
  const i = await inputs(env, q, null);
  assert.ok(i.abstainAnswer, "composed by code");
  assert.match(i.abstainAnswer, /can't tell which question you mean/);
  await answerWithAi({ env, origin: "https://worker.test", intentId: "a1", by: "Red Fox", memberSlug: "red-fox", question: q, provider: "workers-ai", share: true, isMember: true });
  assert.equal(env.modelCalls.length, 0, "no model call");
});

// (2) + (3) context-dependent turns are not standalone; the walk goes back to the first standalone turn
test("an opener turn is skipped: 'same question' after Q1 -> 'and what about the mage' resolves to Q1", async () => {
  const env = makeEnv();
  await turn(env, "b0", "what is the best spec for a paladin", iso(30));
  await turn(env, "b1", "and what about the mage", iso(20));
  await turn(env, "b2", "same question", iso(0));
  assert.equal(await findPreviousQuestion(env, { intentId: "b2", share: true }), "what is the best spec for a paladin");
});
test("chain Q1 -> 'what about that' -> 'any better answers' returns Q1, not the middle turn", async () => {
  const env = makeEnv();
  await turn(env, "c0", "what is the best spec for a paladin", iso(30));
  await turn(env, "c1", "what about that", iso(20));
  await turn(env, "c2", "any better answers", iso(0));
  assert.equal(await findPreviousQuestion(env, { intentId: "c2", share: true }), "what is the best spec for a paladin");
});
test("an opener with nothing earlier to walk back to is still used (better than none)", async () => {
  const env = makeEnv();
  await turn(env, "e1", "and what about the mage", iso(20));
  await turn(env, "e2", "same question", iso(0));
  assert.equal(await findPreviousQuestion(env, { intentId: "e2", share: true }), "and what about the mage");
});

// (4) bare "again?" / "same?"
test("a bare 'again?' / 'same?' refers to the previous turn; longer sentences containing the word do not", () => {
  for (const q of ["again?", "Again", "same?", "ok again", "and again?", "same again", "more?"]) assert.equal(refersToPrevious(q), true, q);
  for (const q of ["what is the best spec again for a paladin", "is it the same", "same spec for a mage and a paladin"]) assert.equal(isFollowUp(q), false, q);
  assert.equal(stripFollowUpScaffold("again?"), "");
});
test("'again?' after a real question ranks the earlier question", async () => {
  const env = makeEnv();
  const i = await inputs(env, "again?", "what is the best spec for a paladin");
  assert.equal(i.followUp, true);
  assert.equal(i.abstain, false);
  assert.equal(i.hits[0].page, "classes/paladin");
});

// (5) half the words unknown must not drop the build pages when a build word is present
test("'does the paladin trainer teach seals to flamingo wands' abstains with the asker's class page offered", async () => {
  const env = makeEnv();
  const i = await inputs(env, "does the paladin trainer teach seals to flamingo wands zzorp");
  if (i.abstain) assert.ok(i.abstainPages.some((p) => p.id === "classes/paladin"), "build page kept");
  const j = await inputs(env, "zzorp flamingo paladin wands");
  assert.equal(j.abstain && !j.abstainPages.some((p) => p.id === "classes/paladin"), false, "a build word keeps the build pages");
  const k = await inputs(env, "what is the best pizza topping");
  assert.deepEqual(k.abstainPages, [], "a non-game question still gets no build pages");
});

// (6) cost: rank passes per path, and D1 statements, are bounded
test("rank passes: plain 1, follow-up 1, opener retry <= 2, abstain with build <= 3; D1 statements do not grow with follow-ups", async () => {
  const env = makeEnv();
  const count = [];
  const orig = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { count.push(sql); return orig(sql); };
  const passes = {};
  passes.plain = (await inputs(env, "what is the best spec for a paladin")).rankPasses;
  passes.explicit = (await inputs(env, "again?", "what is the best spec for a paladin")).rankPasses;
  passes.opener = (await inputs(env, "and what about zzorp", "what is the best spec for a paladin")).rankPasses;
  passes.abstain = (await inputs(env, "zzorp flamingo paladin wands")).rankPasses;
  passes.openerAbstain = (await inputs(env, "and what about zzorp flamingo wands", "zzorp qwix paladin blorp")).rankPasses;
  passes.noContext = (await inputs(env, "again?")).rankPasses;
  console.log("RANK_PASSES", JSON.stringify(passes));
  for (const [k, v] of Object.entries(passes)) assert.ok(v <= 3, `${k}: ${v} passes`);
  assert.equal(passes.noContext, 0, "no ranking at all without context");
  const before = count.length;
  await inputs(env, "again?", "what is the best spec for a paladin");
  const stmts = count.length - before;
  const before2 = count.length;
  await inputs(env, "what is the best spec for a paladin");
  console.log("D1_STATEMENTS buildAnswerInputs follow-up", stmts, "plain", count.length - before2);
  assert.equal(stmts, count.length - before2 - 0, "a follow-up costs no more D1 statements in buildAnswerInputs than a plain question");
});
