// COMPOSED TABLE ANSWER, third outside review (Codex, master a38accb3): one test per finding, written before any fix. A test name starts with the finding id (A1, B2, ...); the PR table says which reproduced on master.
// Run: node --test tests/unit/game-facts-compose-round3.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { composeTableAnswer } from "../../infrastructure/worker/game-facts-compose.js";
import { readGameFacts } from "../../infrastructure/worker/game-facts-read.js";
import { lookupGameFactsChecked } from "../../infrastructure/worker/game-facts-lookup.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { loadFacts } from "../helpers/game-facts-fixture.mjs";

const row = (id, kind, subject, claim, value, note = "", extra = {}) => ({ id, kind, subject, claim, value, unit: "", source_table: id.split(":")[0], row_id: id.split(":")[1], note, ...extra });
const LEVEL = row("spelllevels:301", "spell_level", "Glimmer Spear", "Glimmer Spear requires level 22.", "22");
const COOL = row("spellcooldowns:302", "spell_cooldown", "Glimmer Spear", "Glimmer Spear has a cooldown of 45 seconds.", "45");
const ITEM = row("items:9", "item_level_req", "Glimmer Spear", "Glimmer Spear has a required level of 40.", "40");
const text = (c) => (c ? c.text : null);
async function compose(q, rows, loads = null) {
  const DB = await schemaDb();
  if (loads) for (const l of loads) loadFacts(DB, l.rows, { loadId: l.loadId, build: l.build }); else loadFacts(DB, rows);
  const gf = await readGameFacts({ DB, GAME_FACTS_READ: "on", GAME_FACTS_COMPOSE: "on" }, q);
  return gf && gf.res ? composeTableAnswer(q, gf.res) : null;
}
const POS = "**Glimmer Spear requires level 22.** [spelllevels:301]";

// ---- A: the wrong entity -------------------------------------------------------------------------------------------------------------------------
test("A1 cooldown of a name whose level rows belong to two classes (lookup says ambiguous) declines", async () => {
  const rows = [{ ...COOL, note: "class=Mage" }, { ...LEVEL, note: "class=Mage" }, row("spelllevels:304", "spell_level", "Glimmer Spear", "Glimmer Spear requires level 28.", "28", "class=Priest")];
  assert.equal(await compose("What is the cooldown of Glimmer Spear?", rows), null);
});
test("A2 'what level is X' with a spell cooldown row and an item level row of the name declines (item level vs spell level)", async () => {
  assert.equal(await compose("What level is Glimmer Spear?", [COOL, ITEM]), null);
});
test("A3 'required level for X' with a spell level row and an item row of the name declines", async () => {
  assert.equal(await compose("What is the required level for Glimmer Spear?", [LEVEL, ITEM]), null);
});
test("A4 ranks of a name that is both a spell (no rank note) and a talent declines unless the question says talent", async () => {
  const t = row("trait_max_ranks:4-9", "trait_max_ranks", "Glimmer Spear", "Glimmer Spear is a Priest talent with 5 ranks.", "5");
  assert.equal(await compose("How many ranks does Glimmer Spear have?", [LEVEL, t]), null);
});
test("A5 'when do I learn X' for a name that is a spell and a talent declines", async () => {
  const t = row("trait_max_ranks:4-9", "trait_max_ranks", "Glimmer Spear", "Glimmer Spear is a Priest talent with 5 ranks.", "5");
  assert.equal(await compose("When do I learn Glimmer Spear?", [LEVEL, t]), null);
});
test("A6 the class word of a talent row comes from its class slot, never from the subject name", async () => {
  const ma = row("trait_max_ranks:4-5", "trait_max_ranks", "Mage Armor", "Mage Armor is a Priest talent with 5 ranks.", "5");
  assert.equal(await compose("How many ranks can you put into the Mage talent Mage Armor?", [ma]), null);
  assert.equal(text(await compose("How many ranks can you put into the Priest talent Mage Armor?", [ma])), "**Mage Armor is a Priest talent with 5 ranks.** [trait_max_ranks:4-5]", "positive control");
});

// ---- B: punctuation and unit suffix ------------------------------------------------------------------------------------------------------------------
test("B1 'Bite!' asked, only the row 'Bite' loaded: declines; with the row 'Bite!' it composes", async () => {
  assert.equal(await compose("Bite!: how long is its cooldown?", [row("spellcooldowns:41", "spell_cooldown", "Bite", "Bite has a cooldown of 6 seconds.", "6")]), null);
  assert.equal(text(await compose("Bite!: how long is its cooldown?", [row("spellcooldowns:42", "spell_cooldown", "Bite!", "Bite! has a cooldown of 6 seconds.", "6")])), "**Bite! has a cooldown of 6 seconds.** [spellcooldowns:42]");
});
test("B2 'cooldown of Bite in Seconds' with only the row 'Bite' loaded (unit suffix versus a longer name)", async () => {
  assert.equal(await compose("What is the cooldown of Bite in Seconds?", [row("spellcooldowns:41", "spell_cooldown", "Bite", "Bite has a cooldown of 6 seconds.", "6")]), null);
});

// ---- C: claim validation -----------------------------------------------------------------------------------------------------------------------------
for (const [id, claim] of [
  ["C1 substring subject", "Glimmer Spearhead requires level 22."], ["C2 sign", "Glimmer Spear requires level -22."], ["C3 percent", "Glimmer Spear requires level 22%."],
  ["C4 wrong property and unit", "Glimmer Spear has a cooldown of 22 seconds."], ["C5 two figures", "Glimmer Spear requires level 22 and has a cooldown of 22 seconds."],
  ["C6 number word 'million'", "Glimmer Spear requires level 22 or a million after the patch."], ["C7 'Rank IV'", "Glimmer Spear Rank IV requires level 22."], ["C8 version qualifier", "Glimmer Spear requires level 22 in Classic."],
]) test(`${id}: a claim that is not the loader's own shape for the row is not composed`, async () => { assert.equal(await compose("What level is Glimmer Spear?", [{ ...LEVEL, claim }]), null, claim); });
test("C9 a non-numeric value for a numeric kind is not composed", async () => {
  const c = row("spellmisc:41", "spell_cast_time", "Glimmer Spear", "Glimmer Spear is instant.", "instant"); c.unit = "seconds";
  assert.equal(await compose("What is the cast time of Glimmer Spear?", [c]), null);
});

// ---- D: finishAnswerText must not rewrite a composed answer ----------------------------------------------------------------------------------------------
const FAKE_KEY = ["sk", "ant", "FAKE", "TEST", "0000"].join("-");
const realFetch = globalThis.fetch;
let anth = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes("anthropic")) { anth.push(init.body); return new Response(JSON.stringify({ content: [{ type: "text", text: "**x**\n-# Sources: general · unconfirmed" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }
  return new Response("{}", { status: 599 });
};
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); resetResearchClaudeForTests(); privacyBudget.ms = 1000; anth = []; });
const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const quiet = async (fn) => { const real = { log: console.log, warn: console.warn, error: console.error, info: console.info }; for (const k of Object.keys(real)) console[k] = () => {}; try { return await fn(); } finally { Object.assign(console, real); } };
let n = 0;
async function ask(question, { rows, nameMap = null } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = await schemaDb();
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin") }, updated: "x" }]));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, 'x')").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", match: [], id: "700000000000000001" }]));
  if (nameMap) DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('name_map', ?, 'x')").run(JSON.stringify(nameMap));
  loadFacts(DB, rows);
  const env = { DB, AI: { run: async () => { throw new Error("no"); } }, USER_SALT: "user-salt-for-tests-0123456789", ANTHROPIC_API_KEY: FAKE_KEY, ASK_RESEARCH: "on", RESEARCH_NAMES: "real", GROUP_MEMORY: "off", GAME_FACTS_READ: "on", GAME_FACTS_COMPOSE: "on",
    BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  const id = `r3${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, 'Red Fox', ?, 'groq', 'thinking', 1, '2026-11-18T10:00:00.000Z')").run(id, question);
  await quiet(() => answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Red Fox", memberSlug: "red-fox", question, provider: "claude", share: true, budget: null, isMember: true, channel: "900000000000000001" }));
  return { ...DB.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id), anth: anth.length };
}
const body = (a) => a.answer.replace(/\n-# Sources:.*$/s, "");
test("D1 house-voice repair does not rename a subject: 'Skippy' stays Skippy in a composed answer", async () => {
  const a = await ask("What level is Skippy?", { rows: [row("spelllevels:401", "spell_level", "Skippy", "Skippy requires level 22.", "22")] });
  assert.equal(a.anth, 0); assert.equal(body(a), "**Skippy requires level 22.** [spelllevels:401]");
});
test("D2 name_map cannot change a digit of a composed answer", async () => {
  const a = await ask("What level is Glimmer Spear?", { rows: [LEVEL], nameMap: { 22: "60" } });
  assert.equal(a.anth, 0); assert.equal(body(a), POS);
});
test("D3 name_map cannot inject channel mention markup into a composed answer", async () => {
  const a = await ask("What level is Glimmer Spear?", { rows: [LEVEL], nameMap: { Glimmer: "<#1234567890123456>" } });
  assert.equal(a.anth, 0); assert.equal(body(a), POS); assert.ok(!/<#/.test(a.answer));
});

// ---- E: long names swallowing question syntax ---------------------------------------------------------------------------------------------------------
const EMBER = row("spellcooldowns:40", "spell_cooldown", "Ember", "Ember has a cooldown of 10 seconds.", "10");
const ASH = row("spellcooldowns:47", "spell_cooldown", "Ash", "Ash has a cooldown of 20 seconds.", "20");
for (const [id, name, ext] of [["E1", "Ember and Ash", 48], ["E2", "Ember or Ash", 49], ["E3", "Ember vs Ash", 50], ["E4", "Ember in Classic", 51], ["E5", "Ember if buffed", 52], ["E6", "Ember and its cast time", 53], ["E7", "Ember - not Ash", 54]]) {
  test(`${id}: the cooldown of '${name}' while 'Ember' (and 'Ash') exist declines`, async () => {
    const long = row(`spellcooldowns:${ext}`, "spell_cooldown", name, `${name} has a cooldown of 45 seconds.`, "45");
    assert.equal(await compose(`What is the cooldown of ${name}?`, [EMBER, ASH, long]), null);
  });
}
test("E8 same with the shorter row Ember marked wrong", async () => {
  const long = row("spellcooldowns:48", "spell_cooldown", "Ember and Ash", "Ember and Ash has a cooldown of 45 seconds.", "45");
  assert.equal(await compose("What is the cooldown of Ember and Ash?", [{ ...EMBER, verdict: "wrong" }, ASH, long]), null);
});
test("E9 positive control: a name with a connector word and nothing overlapping still composes", async () => {
  const long = row("spellcooldowns:48", "spell_cooldown", "Ember and Ash", "Ember and Ash has a cooldown of 45 seconds.", "45");
  assert.equal(text(await compose("What is the cooldown of Ember and Ash?", [long])), "**Ember and Ash has a cooldown of 45 seconds.** [spellcooldowns:48]");
});

// ---- F: hidden sibling by base name -----------------------------------------------------------------------------------------------------------------------
for (const verdict of ["unverifiable", "holds", "wrong"]) {
  test(`F1 ${verdict}: a 'Bite II' row (subject_base bite) next to 'Bite' makes the Bite answer contested`, async () => {
    const bite = row("spellcooldowns:41", "spell_cooldown", "Bite", "Bite has a cooldown of 6 seconds.", "6");
    const bite2 = row("spellcooldowns:43", "spell_cooldown", "Bite II", "Bite II has a cooldown of 30 seconds.", "30", "", { verdict });
    assert.equal(await compose("What is the cooldown of Bite?", [bite, bite2]), null);
  });
}

// ---- G: duplicate ids ----------------------------------------------------------------------------------------------------------------------------------
const L60 = { ...LEVEL, claim: "Glimmer Spear requires level 60.", value: "60" };
test("G1 same build, same id twice (one wrong), either order: declines", async () => {
  for (const order of [[LEVEL, { ...L60, verdict: "wrong" }], [{ ...L60, verdict: "wrong" }, LEVEL]]) {
    const loads = [{ loadId: "load-a", build: "9.9.9.1", rows: [order[0]] }, { loadId: "load-b", build: "9.9.9.1", rows: [order[1]] }];
    assert.equal(await compose("What level is Glimmer Spear?", null, loads), null);
  }
});
test("G2 different builds, both holds, same id: declines", async () => {
  const loads = [{ loadId: "load-a", build: "9.9.9.1", rows: [LEVEL] }, { loadId: "load-b", build: "9.9.9.2", rows: [L60] }];
  assert.equal(await compose("What level is Glimmer Spear?", null, loads), null);
});
test("G3 a row the reader filtered (secret-shaped) cannot re-enter composition through another row's id", async () => {
  const DB = await schemaDb();
  loadFacts(DB, [L60], { loadId: "load-a", build: "9.9.9.1" });
  loadFacts(DB, [LEVEL], { loadId: "load-b", build: "9.9.9.2" });
  const q = "What level is Glimmer Spear?";
  const gf = await readGameFacts({ DB, GAME_FACTS_READ: "on", GAME_FACTS_COMPOSE: "on", SECRET_TEST: "requires level 60" }, q);
  assert.equal(gf && gf.res ? composeTableAnswer(q, gf.res) : null, null);
});

// ---- H: contract and caller edge cases (P3) ----------------------------------------------------------------------------------------------------------------
test("H3 an unusable (frozen) trace object does not make readGameFacts reject", async () => {
  const DB = await schemaDb(); loadFacts(DB, [LEVEL]);
  const r = await readGameFacts({ DB, GAME_FACTS_READ: "on" }, "What level is Glimmer Spear?", { trace: Object.freeze({}) });
  assert.ok(r === null || typeof r === "object");
});
test("H4 a question whose toString throws gives a failed lookup, not a rejection", async () => {
  const DB = await schemaDb();
  const r = await lookupGameFactsChecked({ DB }, { toString() { throw new Error("no"); } }, { reader: true });
  assert.equal(r.failed, true);
});
