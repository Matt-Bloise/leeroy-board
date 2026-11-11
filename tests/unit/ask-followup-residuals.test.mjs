// Residuals left after PR 214 (Codex council + Fable advisor), tracked as BACKLOG ask-followup-residuals. Fictional library and members only.
// Run: node --test tests/unit/ask-followup-residuals.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, buildAnswerInputs, findPreviousQuestion, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { insertAskTurn } from "../../infrastructure/worker/answer-ux.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { isFollowUp, refersToPrevious, stripFollowUpScaffold, skipKind } from "../../infrastructure/worker/self-rag.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), spec_path: f("retribution"), level: f(12) }, updated: "x" },
  { slug: "gray-wolf", name: "Gray Wolf", fields: { class: f("paladin"), spec_path: f("retribution"), level: f(20), professions: f(["leatherworking", "mining"]) }, updated: "x" }];
const LIB = [
  { id: "classes/paladin", category: "classes", title: "Paladin", blurb: "Plate", facts: [
    { key: "paladin.role", value: "Paladins can tank, heal or deal damage; Retribution is the damage spec." },
    { key: "paladin.spec", value: "The best spec for a paladin that wants to tank is Protection." },
    { key: "paladin.train", value: "A Paladin trains new seals and blessings from the class trainer in the capital." },
  ] },
  { id: "classes/mage", category: "classes", title: "Mage", blurb: "Cloth", facts: [{ key: "mage.role", value: "A mage deals ranged spell damage and conjures food and water." }] },
  { id: "professions/mining", category: "professions", title: "Mining", blurb: "Ore", facts: [{ key: "mining.start", value: "Mining is learned from the miner trainer in Orgrimmar." }] },
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
test("topic drift: Q1 -> 'and what about the mage' -> 'same question' resolves to the mage turn, never Q1", async () => {
  const env = makeEnv();
  await turn(env, "b0", "what is the best spec for a paladin", iso(30));
  await turn(env, "b1", "and what about the mage", iso(20));
  await turn(env, "b2", "same question", iso(0));
  assert.equal(await findPreviousQuestion(env, { intentId: "b2", share: true }), "and what about the mage");
});
test("pronoun-only openers ('what about her', 'what about him', 'and them', 'what about there') are not topics: 'again?' still resolves to Q1", async () => {
  for (const [n, opener] of [["p1", "what about her?"], ["p2", "what about him"], ["p3", "and what about them"], ["p4", "what about there"], ["p5", "what about those ones"], ["p6", "what about you?"], ["p7", "what about me"], ["p8", "and what about us"], ["p9", "what about your"]]) {
    const env = makeEnv();
    await turn(env, n + "a", "what is the best spec for a paladin", iso(30));
    await turn(env, n + "b", opener, iso(20));
    await turn(env, n + "c", "again?", iso(0));
    assert.equal(await findPreviousQuestion(env, { intentId: n + "c", share: true }), "what is the best spec for a paladin", opener);
  }
});
test("known limit: the topic opener replaces Q1 wholesale, so Q1's predicate is not carried ('where ... train' is lost)", async () => {
  const env = makeEnv();
  await turn(env, "k0", "where do paladins train in stormwind", iso(30));
  await turn(env, "k1", "what about mages?", iso(20));
  await turn(env, "k2", "again?", iso(0));
  assert.equal(await findPreviousQuestion(env, { intentId: "k2", share: true }), "what about mages?");
});
test("topic-less openers ('what about mine', 'something else', 'yourself', 'the other one') are skipped; a non-Latin topic counts", async () => {
  for (const [n, opener, skip] of [["u1", "what about mine?", true], ["u2", "what about something else", true], ["u3", "what about yourself", true], ["u4", "what about the other one", true], ["u5", "what about 法师", false]]) {
    const env = makeEnv();
    await turn(env, n + "a", "what is the best spec for a paladin", iso(30));
    await turn(env, n + "b", opener, iso(20));
    await turn(env, n + "c", "again?", iso(0));
    assert.equal(await findPreviousQuestion(env, { intentId: n + "c", share: true }), skip ? "what is the best spec for a paladin" : opener, opener);
  }
});
test("topic drift: 'again?' after Q1 -> 'what about the mage?' ranks the mage page, not paladin", async () => {
  const env = makeEnv();
  await turn(env, "d0", "what is the best spec for a paladin", iso(30));
  await turn(env, "d1", "what about the mage?", iso(20));
  await turn(env, "d2", "again?", iso(0));
  const prev = await findPreviousQuestion(env, { intentId: "d2", share: true });
  assert.equal(prev, "what about the mage?");
  const i = await inputs(env, "again?", prev);
  assert.equal(i.hits[0].page, "classes/mage");
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
  assert.equal(i.abstain, true, "probe abstains");
  assert.ok(i.abstainPages.some((p) => p.id === "classes/paladin"), "build page kept");
  const j = await inputs(env, "zzorp flamingo paladin wands");
  assert.equal(j.abstain && !j.abstainPages.some((p) => p.id === "classes/paladin"), false, "a build word keeps the build pages");
  const k = await inputs(env, "what is the best pizza topping");
  assert.deepEqual(k.abstainPages, [], "a non-game question still gets no build pages");
});

// (6) cost: rank passes per path, and D1 statements, are bounded
const inputsAs = (env, who, question, previousQuestion = null) => buildAnswerInputs(env, { question, by: who.name, memberSlug: who.slug, journey: "curious", share: false, previousQuestion });
const WOLF = { name: "Gray Wolf", slug: "gray-wolf" };
test("rank passes are capped at 4 and the abstain lookups keep class + two professions on a plain abstain", async () => {
  const env = makeEnv();
  const plain = await inputsAs(env, WOLF, "zzorp flamingo paladin wands");
  assert.equal(plain.abstain, true);
  assert.deepEqual(plain.abstainPages.map((p) => p.id).sort(), ["classes/paladin", "professions/leatherworking", "professions/mining"], "claim 37: class page and both profession pages");
  assert.ok(plain.rankPasses <= 4);
  const opener = await inputsAs(env, WOLF, "and what about zzorp flamingo paladin wands", "zzorp qwix paladin blorp");
  assert.equal(opener.abstain, true);
  assert.equal(opener.rankPasses, 4, "the cap is what stops the opener-abstain path (5 passes without it)");
  assert.deepEqual(opener.abstainPages.map((p) => p.id), ["classes/paladin", "professions/leatherworking"], "class page + one profession");
  const passes = { plain: (await inputs(env, "what is the best spec for a paladin")).rankPasses, explicit: (await inputs(env, "again?", "what is the best spec for a paladin")).rankPasses, noContext: (await inputs(env, "again?")).rankPasses };
  console.log("RANK_PASSES", JSON.stringify({ ...passes, abstain: plain.rankPasses, openerAbstain: opener.rankPasses }));
  assert.deepEqual(passes, { plain: 1, explicit: 1, noContext: 0 });
});
test("findPreviousQuestion is exactly one D1 statement; buildAnswerInputs costs the same for a follow-up as for a plain question", async () => {
  const env = makeEnv();
  await turn(env, "s0", "what is the best spec for a paladin", iso(30));
  await turn(env, "s1", "again?", iso(0));
  const sqls = [];
  const orig = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { sqls.push(sql); return orig(sql); };
  await findPreviousQuestion(env, { intentId: "s1", share: true });
  assert.equal(sqls.length, 1);
  await inputs(env, "warm the library cache"); // the first call also loads the library pages
  sqls.length = 0; await inputs(env, "again?", "what is the best spec for a paladin"); const follow = sqls.length;
  sqls.length = 0; await inputs(env, "what is the best spec for a paladin"); const plain = sqls.length;
  console.log("D1_STATEMENTS lookup 1, buildAnswerInputs follow-up", follow, "plain", plain);
  assert.equal(follow, plain);
});

// review of the first head: "ok again" is a follow-up, not a greeting
test("'ok again', 'okay again', 'ok, again', 'and again?' are follow-ups and retrieve; plain greetings still skip", async () => {
  for (const q of ["ok again", "okay again", "ok, again", "and again?"]) {
    assert.equal(refersToPrevious(q), true, q);
    assert.equal(skipKind(q), null, q);
  }
  for (const q of ["thanks again", "ok", "hello"]) assert.equal(skipKind(q), "greeting", q);
  const i = await inputs(makeEnv(), "ok again", "what is the best spec for a paladin");
  assert.equal(i.retrieved, true); assert.equal(i.followUp, true); assert.equal(i.hits[0].page, "classes/paladin");
});

// the exact tie (half the content words unknown) is still about the game
test("exactly half unknown content words, no build word, still offers the asker's build pages", async () => {
  const env = makeEnv();
  const i = await inputs(env, "zzorp flamingo trainer seals");
  console.log("TIE", i.abstain, JSON.stringify(i.abstainPages));
  assert.equal(i.abstain, true, "probe abstains");
  assert.ok(i.abstainPages.length > 0, "tie keeps build pages");
});
