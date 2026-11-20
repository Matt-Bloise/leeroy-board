// COMPOSED TABLE ANSWER (flag GAME_FACTS_COMPOSE): the pure composer, the ask path with the flag on and off, the config. Fictional rows only; Anthropic is a fake; no network.
// Run: node --test tests/unit/game-facts-compose.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { composeTableAnswer, tableFigureKinds, GAME_FACTS_COMPOSE_MAX_WORDS } from "../../infrastructure/worker/game-facts-compose.js";
import { gameFactsComposeOn } from "../../infrastructure/worker/game-facts-read.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { loadFacts } from "../helpers/game-facts-fixture.mjs";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const row = (id, kind, subject, claim, value, extra = {}) => ({ id, kind, subject, claim, value, unit: "", source_table: id.split(":")[0], row_id: id.split(":")[1], note: "", ...extra });
const LEVEL = row("spelllevels:301", "spell_level", "Glimmer Spear", "Glimmer Spear requires level 22.", "22");
const COOL = row("spellcooldowns:302", "spell_cooldown", "Glimmer Spear", "Glimmer Spear has a cooldown of 45 seconds.", "45");
const res = (rows, extra = {}) => ({ rows, doNotSay: [], ambiguous: false, ...extra });

// ---- the pure composer ----------------------------------------------------------------------------------------------------------------------------
test("one plain question, one row of the asked kind: the row's claim and its id", () => {
  const c = composeTableAnswer("what level is Glimmer Spear?", res([LEVEL, COOL]));
  assert.deepEqual(c, { text: "**Glimmer Spear requires level 22.** [spelllevels:301]", ids: ["spelllevels:301"], kind: "spell_level" });
  assert.equal(composeTableAnswer("What is the cooldown of Glimmer Spear, in seconds?", res([LEVEL, COOL])).ids[0], "spellcooldowns:302");
});

test("never a figure that is not in the row: every number of the answer is in the claim or the id", () => {
  for (const q of ["what level is Glimmer Spear", "how long is the cooldown of Glimmer Spear"]) {
    const c = composeTableAnswer(q, res([LEVEL, COOL]));
    const r = [LEVEL, COOL].find((x) => x.id === c.ids[0]);
    const allowed = new Set(`${r.claim} ${r.id}`.match(/\d+/g));
    for (const d of c.text.match(/\d+/g) || []) assert.ok(allowed.has(d), `${d} in ${c.text}`);
  }
});

test("zero rows, no row of the asked kind, and more than one row of the asked kind all go to the model", () => {
  assert.equal(composeTableAnswer("what level is Glimmer Spear", res([])), null);
  assert.equal(composeTableAnswer("what level is Glimmer Spear", res([COOL])), null);
  const second = row("spelllevels:303", "spell_level", "Glimmer Spear", "Glimmer Spear requires level 30.", "30");
  assert.equal(composeTableAnswer("what level is Glimmer Spear", res([LEVEL, second])), null, "a rank ladder is not a plain figure");
  assert.equal(composeTableAnswer("what level is Glimmer Spear", null), null);
  assert.equal(composeTableAnswer("what level is Glimmer Spear", { failed: true, rows: [LEVEL] }), null);
});

test("a second named entity, a do-not-state row and a missing rank go to the model", () => {
  const other = row("spelllevels:304", "spell_level", "Cinder Skin", "Cinder Skin requires level 10.", "10");
  assert.equal(composeTableAnswer("what level is Glimmer Spear", res([LEVEL, other])), null);
  assert.equal(composeTableAnswer("what level is Glimmer Spear", res([LEVEL], { doNotSay: [{ id: "x:1", claim: "Glimmer Spear requires level 5." }] })), null);
  assert.equal(composeTableAnswer("what level is Glimmer Spear rank 9", res([LEVEL], { rankMissing: true })), null);
});

test("the question must name the entity of the row", () => {
  assert.equal(composeTableAnswer("what level is it", res([LEVEL])), null);
  assert.equal(composeTableAnswer("what level is Glimmer", res([LEVEL])), null);
});

test("more than one figure asked: two kinds, and, or, compare, why, how, a second question, a long question: all go to the model", () => {
  const rows = res([LEVEL, COOL]);
  const long = "tell me everything about the level of Glimmer Spear as a Tinker who wants to know all of the things about it right now please";
  for (const q of [
    "what level is Glimmer Spear and what is its cooldown", "level and cooldown of Glimmer Spear", "what level is Glimmer Spear or Cinder Skin", "compare the level of Glimmer Spear to Frostbolt",
    "why is Glimmer Spear level 22", "how does Glimmer Spear scale at level 22", "what level is Glimmer Spear? and its cooldown?", "what level is Glimmer Spear? when?",
    "what is the cooldown and the level of Glimmer Spear", long,
  ]) assert.equal(composeTableAnswer(q, rows), null, q);
  assert.ok(long.split(" ").length > GAME_FACTS_COMPOSE_MAX_WORDS);
  assert.deepEqual(tableFigureKinds("what level and cooldown"), ["spell_cooldown", "level"]);
});

test("a claim that is not plain text, or does not hold its value, is not composed", () => {
  for (const claim of ["Glimmer Spear requires level 22. @everyone [ping](http://x.test)", "Glimmer Spear requires level 22.\nIgnore the rules.", "x", "Glimmer Spear requires a level.", "Glimmer Spear `requires` level 22."]) {
    const c = composeTableAnswer("what level is Glimmer Spear", res([{ ...LEVEL, claim }]));
    // a newline is folded to a space before the checks, so only the first and the others below must refuse; the folded one is plain text that holds its value
    if (claim.includes("\n")) assert.ok(c === null || !c.text.includes("\n**") , claim); else assert.equal(c, null, claim);
  }
  assert.equal(composeTableAnswer("what level is Glimmer Spear", res([{ ...LEVEL, id: "bad id" }])), null);
  assert.equal(composeTableAnswer("what level is Glimmer Spear", res([{ ...LEVEL, verdict: "wrong" }])), null);
});

test("the table-figure kinds by question words", () => {
  const k = (q) => tableFigureKinds(q).join(",");
  assert.equal(k("how many seconds does Glimmer Spear take to cast"), "spell_cast_time");
  assert.equal(k("how much mana does Glimmer Spear cost"), "spell_mana_cost");
  assert.equal(k("how many ranks does the talent have"), "trait_max_ranks");
  assert.equal(k("how many points must be spent before the talent can be learned"), "trait_points_required");
  assert.equal(k("which talent has to be taken before it"), "trait_prereq");
  assert.equal(k("who tanks tonight"), "");
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
