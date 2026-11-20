// COMPOSED TABLE ANSWER (flag GAME_FACTS_COMPOSE): the composer driven through the REAL reader and lookup (limits, per-name cap, row budget included), the ask path with the flag on and off, the config. Fictional rows only; Anthropic is a fake; no network.
// Run: node --test tests/unit/game-facts-compose.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { composeTableAnswer, tableFigureKind, GAME_FACTS_COMPOSE_MAX_WORDS } from "../../infrastructure/worker/game-facts-compose.js";
import { gameFactsComposeOn, readGameFacts } from "../../infrastructure/worker/game-facts-read.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { loadFacts } from "../helpers/game-facts-fixture.mjs";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const row = (id, kind, subject, claim, value, note = "") => ({ id, kind, subject, claim, value, unit: "", source_table: id.split(":")[0], row_id: id.split(":")[1], note });
const LEVEL = row("spelllevels:301", "spell_level", "Glimmer Spear", "Glimmer Spear requires level 22.", "22");
const COOL = row("spellcooldowns:302", "spell_cooldown", "Glimmer Spear", "Glimmer Spear has a cooldown of 45 seconds.", "45");
const MANA = row("spellmana:303", "spell_mana_cost", "Glimmer Spear", "Glimmer Spear costs 120 mana.", "120");
const ITEM = row("items:9", "item_level_req", "Glimmer Blade", "Glimmer Blade requires level 22.", "22");

// Through the real reader and lookup over fixture rows: what the ask path would see.
async function compose(q, rows) {
  const DB = await schemaDb();
  loadFacts(DB, rows);
  const gf = await readGameFacts({ DB }, q);
  return gf && gf.res ? composeTableAnswer(q, gf.res) : null;
}
const text = (c) => (c ? c.text : null);

// ---- the happy path --------------------------------------------------------------------------------------------------------------------------------
test("one plain question in a known shape, one row of the asked kind: the row's claim and its id", async () => {
  assert.equal(text(await compose("what level is Glimmer Spear?", [LEVEL, COOL, MANA])), "**Glimmer Spear requires level 22.** [spelllevels:301]");
  assert.equal(text(await compose("What is the cooldown of Glimmer Spear, in seconds?", [LEVEL, COOL, MANA])), "**Glimmer Spear has a cooldown of 45 seconds.** [spellcooldowns:302]");
  assert.equal(text(await compose("How much mana does Glimmer Spear cost?", [LEVEL, COOL, MANA])), "**Glimmer Spear costs 120 mana.** [spellmana:303]");
  assert.equal(text(await compose("What level do you need to be to equip Glimmer Blade?", [ITEM])), "**Glimmer Blade requires level 22.** [items:9]");
});

test("every digit of an answer is in the claim or the id (a property over the happy shapes)", async () => {
  for (const [q, rows] of [["what level is Glimmer Spear", [LEVEL, COOL]], ["how many seconds is the cooldown on Glimmer Spear", [LEVEL, COOL]], ["how much mana does Glimmer Spear cost", [MANA]]]) {
    const c = await compose(q, rows);
    const r = rows.find((x) => x.id === c.ids[0]);
    const allowed = new Set(`${r.claim} ${r.id}`.match(/\d+/g));
    for (const d of c.text.match(/\d+/g) || []) assert.ok(allowed.has(d), `${d} in ${c.text}`);
  }
});

// ---- review finding 1: the wrong entity ----------------------------------------------------------------------------------------------------------------
test("a row of a SHORTER name is never composed for a longer or surrounding name", async () => {
  const WRATH = row("spellcooldowns:1", "spell_cooldown", "Wrath", "Wrath has a cooldown of 6 seconds.", "6");
  for (const q of ["what is the cooldown of Bestial Wrath?", "what is the cooldown of Improved Wrath", "what is the cooldown of Wrath of the Titans?", "what is the cooldown of Wrath Bolt"]) assert.equal(await compose(q, [WRATH]), null, q);
  assert.equal(text(await compose("what is the cooldown of Wrath?", [WRATH])), "**Wrath has a cooldown of 6 seconds.** [spellcooldowns:1]");
});

// ---- finding 2: a second entity, present or absent ------------------------------------------------------------------------------------------------------
test("a second entity in the question declines, whether the table holds it or not, and whether or not the row budget would hide it", async () => {
  const pom = row("spellcooldowns:50", "spell_cooldown", "Presence of Thought", "Presence of Thought has a cooldown of 180 seconds.", "180");
  const fb = [];
  for (let i = 1; i <= 5; i++) { fb.push(row(`spelllevels:6${i}`, "spell_level", "Emberball", `Emberball (Rank ${i}) requires level ${i * 6}.`, String(i * 6), `rank=${i}`)); fb.push(row(`spellmana:6${i}`, "spell_mana_cost", "Emberball", `Emberball (Rank ${i}) costs ${i * 30} mana.`, String(i * 30), `rank=${i}`)); }
  const rows = [pom, ...fb, row("spellcooldowns:69", "spell_cooldown", "Emberball", "Emberball has a cooldown of 8 seconds.", "8")];
  assert.equal(await compose("what is the cooldown of Emberball with Presence of Thought?", rows), null);
  assert.equal(await compose("what is the cooldown of Emberball with Cinder Skin?", rows), null, "an entity the table does not hold is still there in the question");
  assert.equal(text(await compose("what is the cooldown of Emberball?", rows)), "**Emberball has a cooldown of 8 seconds.** [spellcooldowns:69]");
});

// ---- finding 3: a hidden second candidate ----------------------------------------------------------------------------------------------------------------
test("a second row of the asked kind hidden by the per-name cap or by the SQL LIMIT declines", async () => {
  const ladder = [];
  for (let i = 1; i <= 6; i++) { ladder.push(row(`spelllevels:4${i}`, "spell_level", "Shadeburn", `Shadeburn (Rank ${i}) requires level ${i * 8}.`, String(i * 8), `rank=${i};class=Tinker`)); ladder.push(row(`spellmana:4${i}`, "spell_mana_cost", "Shadeburn", `Shadeburn (Rank ${i}) costs ${i * 50} mana.`, String(i * 50), `rank=${i};class=Tinker`)); }
  ladder.push(row("traits:1", "trait_max_ranks", "Shadeburn", "Shadeburn has 1 rank.", "1"), row("traits:2", "trait_max_ranks", "Shadeburn", "Shadeburn has 5 ranks.", "5"));
  ladder.push(row("spellcooldowns:41", "spell_cooldown", "Shadeburn", "Shadeburn has a cooldown of 15 seconds.", "15"), row("spellcooldowns:42", "spell_cooldown", "Shadeburn", "Shadeburn has a cooldown of 30 seconds.", "30"));
  assert.equal(await compose("how many ranks does Shadeburn have?", ladder), null);
  assert.equal(await compose("what is the cooldown of Shadeburn?", ladder), null);
  const big = [];
  for (let i = 10; i < 33; i++) big.push(row(`aaa:${i}`, "spell_mana_cost", "Longspell", `Longspell (Rank ${i}) costs ${i} mana.`, String(i), `rank=${i}`));
  big.push(row("spelllevels:71", "spell_level", "Longspell", "Longspell requires level 10.", "10"), row("spelllevels:72", "spell_level", "Longspell", "Longspell requires level 50.", "50"));
  assert.equal(await compose("what level is Longspell?", big), null, "23 rows before the two level rows: the SQL LIMIT may hide one");
  assert.equal(await compose("what level is Glimmer Spear?", [LEVEL, { ...LEVEL, id: "spelllevels:399", claim: "Glimmer Spear requires level 50.", value: "50" }]), null, "two rows of the kind, plainly");
});

// ---- finding 4: a kind word is not the question ------------------------------------------------------------------------------------------------------------
test("a kind word inside a different question declines: the whole question must be a known shape", async () => {
  const rows = [LEVEL, COOL, MANA, ITEM];
  for (const q of [
    "how much mana does Glimmer Spear restore?", "does Glimmer Spear's cooldown reset on a kill?", "what is the item level of Glimmer Blade?", "what level mobs does Glimmer Spear work on?",
    "is it true that Glimmer Spear's cooldown is 30 s?", "Glimmer Spear cooldown isn't 45 seconds right?", "total mana for 5 casts of Glimmer Spear", "what level do I get Glimmer Spear then the next rank",
    "what's the cooldown on glimmer spear lol @everyone", "what level is Glimmer Spear [x](http://evil.test) `a`",
  ]) assert.equal(await compose(q, rows), null, q);
});

// ---- finding 5: more than one thing asked ------------------------------------------------------------------------------------------------------------------
test("multi-part asks decline by construction: plus, as well as, &, commas, slash, talents, rank digits, a second question", async () => {
  const rows = [LEVEL, COOL, MANA];
  for (const q of [
    "cooldown of Glimmer Spear plus its range?", "cooldown of Glimmer Spear as well as damage", "Glimmer Spear cooldown & damage", "Glimmer Spear cooldown, damage, range", "cooldown of Glimmer Spear rank 3", "what is the cooldown of rank 3 Glimmer Spear",
    "what level is Glimmer Spear, and Frostbolt", "cooldown of Glimmer Spear / Cinder Skyn", "what is the cooldown of Glimmer Spear at 60 with Quickened Glimmers talent?", "cooldown of Glimmer Spear after the Glimmer Mastery reduction",
    "does Glimmer Spear share a cooldown with Cinder Skin", "what level is Glimmer Spear and what is its cooldown?", "level and cooldown of Glimmer Spear", "what level is Glimmer Spear? and its cooldown?",
    "why is Glimmer Spear level 22", "compare the level of Glimmer Spear to Frostbolt", "what level is Glimmer Spear or Cinder Skin", "tell me everything about the level of Glimmer Spear as a Tinker who wants to know all of the things about it right now please",
  ]) assert.equal(await compose(q, rows), null, q);
  assert.ok("tell me everything about the level of Glimmer Spear as a Tinker who wants to know all of the things about it right now please".split(" ").length > GAME_FACTS_COMPOSE_MAX_WORDS);
});

// ---- finding 6: the claim ---------------------------------------------------------------------------------------------------------------------------------------
test("a claim with a link, a discord invite, an empty value, a value that is only part of a number, or another number is not composed", async () => {
  const q = "what level is Glimmer Spear";
  for (const [claim, value] of [
    ["Glimmer Spear requires level 22. See http://evil.test/x", "22"], ["Glimmer Spear requires level 22, discord.gg/abc", "22"], ["Glimmer Spear requires a level.", ""], ["Glimmer Spear requires level 22 (30 at rank 2).", "2"],
    ["Glimmer Spear requires level 22.", "2"], ["Glimmer Spear requires level 22. @everyone", "22"], ["Glimmer Spear `requires` level 22.", "22"], ["Glimmer Spear requires level 22 on evil.example.", "22"],
  ]) assert.equal(await compose(q, [{ ...LEVEL, claim, value }]), null, `${claim} / ${JSON.stringify(value)}`);
  assert.equal(composeTableAnswer(q, { rows: [{ ...LEVEL, id: "bad id" }], doNotSay: [], cut: false, groups: 1 }), null);
  assert.equal(composeTableAnswer(q, { rows: [{ ...LEVEL, verdict: "wrong" }], doNotSay: [], cut: false, groups: 1 }), null);
});

test("the composer reads the reader's own filtered rows: a secret-shaped row is never composed", async () => {
  const leaky = { ...LEVEL, claim: "Glimmer Spear requires level 22. Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" };
  assert.equal(await compose("what level is Glimmer Spear", [leaky]), null);
});

// ---- the contract between the lookup and the composer --------------------------------------------------------------------------------------------------------
test("without the lookup's proof (cut false, one name group) the composer declines; a do-not-state row and a missing rank decline", () => {
  const ok = { rows: [LEVEL], doNotSay: [], cut: false, groups: 1 };
  assert.equal(text(composeTableAnswer("what level is Glimmer Spear", ok)), "**Glimmer Spear requires level 22.** [spelllevels:301]");
  for (const bad of [{ ...ok, cut: true }, { ...ok, cut: undefined }, { ...ok, groups: 2 }, { ...ok, groups: 0 }, { ...ok, groups: undefined }, { ...ok, rows: [] }, { ...ok, doNotSay: [{ claim: "Glimmer Spear requires level 5." }] }, { ...ok, rankMissing: true }, { ...ok, failed: true }, null, undefined]) {
    assert.equal(composeTableAnswer("what level is Glimmer Spear", bad), null, JSON.stringify(bad));
  }
  const other = row("spelllevels:304", "spell_level", "Cinder Skin", "Cinder Skin requires level 10.", "10");
  assert.equal(composeTableAnswer("what level is Glimmer Spear", { ...ok, rows: [LEVEL, other] }), null, "two subjects");
});

test("the question must name the entity of the row, once", () => {
  const ok = { rows: [LEVEL], doNotSay: [], cut: false, groups: 1 };
  assert.equal(composeTableAnswer("what level is it", ok), null);
  assert.equal(composeTableAnswer("what level is Glimmer", ok), null);
  assert.equal(composeTableAnswer("what level is Glimmer Spear Glimmer Spear", ok), null);
});

test("the known shapes, by kind (class names allowed in the talent shapes)", () => {
  const k = (q, s) => tableFigureKind(q, s);
  assert.equal(k("how many seconds does Glimmer Spear take to cast", "glimmer spear"), "spell_cast_time");
  assert.equal(k("how much mana does Glimmer Spear cost", "glimmer spear"), "spell_mana_cost");
  assert.equal(k("In the Druid talent tree, how many ranks does Glimmer Spear have?", "glimmer spear"), "trait_max_ranks");
  assert.equal(k("Hunter talent Glimmer Spear: how many points do you need to have spent in the tree first?", "glimmer spear"), "trait_points_required");
  assert.equal(k("Which Rogue talent do you need to take first before you can learn Glimmer Spear?", "glimmer spear"), "trait_prereq");
  assert.equal(k("who tanks tonight", "glimmer spear"), null);
  assert.equal(k("What is the cooldown of Spicy!, in seconds?", "spicy"), "spell_cooldown");
  assert.equal(k("Bite!: how long is its cooldown (in seconds)?", "bite"), "spell_cooldown");
});

// ---- the ask path ----------------------------------------------------------------------------------------------------------------------------------
const FAKE_KEY = ["sk", "ant", "FAKE", "TEST", "0000"].join("-");
const USER_SALT = "user-salt-for-tests-0123456789";
const realFetch = globalThis.fetch;
let anth = [];
const OK = "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
globalThis.fetch = async (url, init) => {
  if (String(url).includes("anthropic")) {
    anth.push({ body: JSON.parse(init.body), raw: init.body });
    return new Response(JSON.stringify({ content: [{ type: "text", text: OK }], usage: { input_tokens: 111, output_tokens: 22 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 599 });
};
const fakeAi = { run: async () => { throw new Error("Workers AI must not be called for a member"); } };
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); resetResearchClaudeForTests(); privacyBudget.ms = 1000; anth = []; });
const roomStub = { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) };
const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const CH = "900000000000000001";
const quiet = async (fn) => { const real = { log: console.log, warn: console.warn, error: console.error, info: console.info }; for (const k of Object.keys(real)) console[k] = () => {}; try { return await fn(); } finally { Object.assign(console, real); } };
let n = 0;
async function ask(question, { read = "on", compose = "on", rows = [LEVEL, COOL], isMember = true } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = await schemaDb();
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin") }, updated: "x" }]));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, 'x')").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", match: [], id: "700000000000000001" }]));
  loadFacts(DB, rows);
  const env = { DB, AI: fakeAi, USER_SALT, ANTHROPIC_API_KEY: FAKE_KEY, ASK_RESEARCH: "on", RESEARCH_NAMES: "real", GROUP_MEMORY: "off", BOARD_ROOM: roomStub, ...(read ? { GAME_FACTS_READ: read } : {}), ...(compose ? { GAME_FACTS_COMPOSE: compose } : {}) };
  const id = `gfc${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, 'Red Fox', ?, 'groq', 'thinking', 1, '2026-11-18T10:00:00.000Z')").run(id, question);
  anth = [];
  await quiet(() => answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Red Fox", memberSlug: "red-fox", question, provider: "claude", share: true, budget: null, isMember, channel: CH }));
  return { row: { ...DB.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id) }, anth: anth.slice() };
}

test("flag on: a plain one-figure question is answered from the row with no model call", async () => {
  const a = await ask("what level is Glimmer Spear?");
  assert.equal(a.anth.length, 0, "no Anthropic request");
  assert.equal(a.row.status, "answered");
  assert.match(a.row.answer, /Glimmer Spear requires level 22\./);
  assert.match(a.row.answer, /\[spelllevels:301\]/);
  assert.match(a.row.answer, /client table spelllevels:301/);
  assert.equal((a.row.answer.match(/-# Sources/g) || []).length, 1, "one Sources line: " + a.row.answer);
  assert.ok(!/cooldown|45/i.test(a.row.answer), "no other figure of the entity");
  assert.match(a.row.model, /^library:table/);
});

test("flag on, a question the composer declines: the model answers, with the request the reader alone would send", async () => {
  const a = await ask("what level is Glimmer Spear and what is its cooldown?");
  assert.equal(a.anth.length, 1);
  const b = await ask("what level is Glimmer Spear and what is its cooldown?", { compose: null });
  assert.equal(a.anth[0].raw, b.anth[0].raw, "byte-identical request: the composer changed nothing it did not answer");
});

test("flag off (\"off\", unset or junk), with the reader on: byte-identical request and a model answer", async () => {
  const base = await ask("what level is Glimmer Spear?", { compose: null });
  assert.equal(base.anth.length, 1);
  for (const v of ["off", "", "true", "1", "onn"]) {
    const a = await ask("what level is Glimmer Spear?", { compose: v });
    assert.equal(a.anth.length, 1, v);
    assert.equal(a.anth[0].raw, base.anth[0].raw, `compose=${JSON.stringify(v)}`);
    assert.equal(a.row.answer, base.row.answer);
    assert.ok(!/^library:table/.test(a.row.model));
  }
});

test("a guest never gets a composed answer: the table is read for members only, so the guests' request rate limit (2 an hour per IP, in the POST /api/ask handler before answerWithAi) is never bypassed", async () => {
  const a = await ask("what level is Glimmer Spear?", { isMember: false });
  assert.ok(!/^library:table/.test(a.row.model), a.row.model);
  const handler = read("infrastructure/worker/index.js");
  assert.ok(handler.indexOf("Public guest access is limited to 2 questions per hour") < handler.indexOf("answerWithAi({"), "the request limit runs before the answer path, composed or not");
});

test("the compose flag does nothing without the reader", async () => {
  const a = await ask("what level is Glimmer Spear?", { read: null });
  assert.equal(a.anth.length, 1);
  assert.equal(gameFactsComposeOn({ GAME_FACTS_COMPOSE: "on" }), false);
  assert.equal(gameFactsComposeOn({ GAME_FACTS_COMPOSE: "on", GAME_FACTS_READ: "on" }), true);
  assert.equal(gameFactsComposeOn({ GAME_FACTS_COMPOSE: "off", GAME_FACTS_READ: "on" }), false);
});

test("flag on, the name has two rows of the asked kind: the model answers", async () => {
  const second = row("spelllevels:303", "spell_level", "Glimmer Spear", "Glimmer Spear requires level 30.", "30");
  const a = await ask("what level is Glimmer Spear?", { rows: [LEVEL, second] });
  assert.equal(a.anth.length, 1);
});

test("GAME_FACTS_COMPOSE is one declared [vars] entry, off, documented, and the composer is pure", () => {
  const toml = read("infrastructure/wrangler.toml");
  const vars = toml.slice(toml.indexOf("[vars]"));
  assert.equal((vars.match(/^GAME_FACTS_COMPOSE\s*=/gm) || []).length, 1);
  assert.match(vars, /^GAME_FACTS_COMPOSE = "off"/m, "ships off");
  assert.match(read("docs/runbooks/flags.md"), /## GAME_FACTS_COMPOSE/);
  assert.ok(read("docs/runbooks/game-facts.md").includes("Composed table answer"));
  const src = read("infrastructure/worker/game-facts-compose.js");
  assert.ok(!/\bfetch\(|\.DB\b|env\.|Date\.now|crypto\./.test(src), "pure: no I/O, no clock");
  assert.match(read("infrastructure/worker/ai-models.js"), /composeTableAnswer\(question, gf\.res\)/);
});
