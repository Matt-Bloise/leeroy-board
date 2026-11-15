// Carry-list restores for /ask research mode (ASK_RESEARCH on). Written red-first; every item is research-only and flag-off stays as it was.
//  (a) conversation memory: the asker's own last turns, one D1 read, tokenised and guarded like any user text
//  (b) loosened length: the persona's "under N characters" line no longer undercuts the research cap
//  (c) abstain in voice: no code-written "not covered" line reaches the user; the code-written fallbacks name what would settle it
//  (d) advice stripper off under research: an imperative pick is kept when asked "what should I"
// Offline: fake Workers AI, fake Anthropic endpoint, in-memory D1. Fictional names. Run: node --test tests/unit/ask-carry-restores.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, invalidatePagesCache, repairHouseVoice } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { RESEARCH_DOWN_ANSWER } from "../../infrastructure/worker/research/provider.js";
import { MEMBER_FALLBACK_LINES, WALL_RE } from "../../infrastructure/worker/research/no-wall.js";
import { ABSTAIN_LINE } from "../../infrastructure/worker/self-rag.js";
import { NOT_PUBLISHED_LINE } from "../../infrastructure/worker/ask-build.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
const FAKE_KEY = "sk-ant-FAKE-TEST-0000";
let anth = [];
let wai = [];
let claudeText = () => "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
let waiText = () => "**Workers answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
globalThis.fetch = async (url, init) => {
  if (String(url).includes("anthropic")) {
    const body = JSON.parse(init.body);
    anth.push({ body, raw: init.body });
    return new Response(JSON.stringify({ content: [{ type: "text", text: claudeText(body) }], usage: { input_tokens: 111, output_tokens: 22 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  // Flag off, provider groq: the OpenAI-shaped outside call; its messages count as the prompt too.
  let b = {}; try { b = JSON.parse(init.body); } catch {}
  wai.push(b);
  const t = waiText(b);
  return new Response(JSON.stringify({ choices: [{ message: { content: t } }] }), { status: 200, headers: { "content-type": "application/json" } });
};
const fakeAi = { run: async (_m, inputs) => { wai.push(inputs); return { response: waiText(inputs), usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); resetResearchClaudeForTests(); privacyBudget.ms = 1000; });

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(12) }, updated: "x" }];
const TANK_PAGE = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };
const ABSTAIN_Q = "tell me about the weather";
const H_ME = "a".repeat(64);
const H_OTHER = "b".repeat(64);
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

let n = 0;
// seed: [{ q, a, hash, hoursAgo, share, status, model, id }]
async function ask(question, { research = true, seed = [], key = false, share = true, hash = H_ME, persona = null, respond = null, by = "Red Fox", memberSlug = "red-fox" } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(TANK_PAGE.id, TANK_PAGE.category, TANK_PAGE.title, TANK_PAGE.blurb, JSON.stringify(TANK_PAGE.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  if (persona) DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('persona', ?, 'x')").run(JSON.stringify(persona));
  for (const s of seed) {
    const id = s.id || `seed${++n}`;
    DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, model, status, share, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, "someone", s.q, s.a === undefined ? "an earlier answer" : s.a, s.model || "workers-ai:x+research", s.status || "answered", s.share === false ? 0 : 1, hoursAgo(s.hoursAgo ?? 1), hoursAgo(s.hoursAgo ?? 1));
    if (!s.noAsker) DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").run(id, s.hash || H_ME);
  }
  const reads = [];
  const env = { DB: { ...DB, prepare: (sql) => { if (/t.answer <> ''/.test(sql) && /JOIN ask_turn_askers/i.test(sql)) reads.push(sql); return DB.prepare(sql); } }, AI: fakeAi, GROQ_API_KEY: "test-key-not-real", ...(key ? { ANTHROPIC_API_KEY: FAKE_KEY } : {}), ...(research ? { ASK_RESEARCH: "on" } : {}), BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  const id = `cr${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, 'groq', 'thinking', ?, ?)").run(id, by, question, share ? 1 : 0, new Date().toISOString());
  DB.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").run(id, hash);
  anth = []; wai = [];
  if (respond) waiText = claudeText = respond;
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(real)) console[k] = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug, question, provider: "groq", share, deep: false, journey: "curious", isMember: true }); } finally { Object.assign(console, real); }
  const row = DB.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id);
  return { row: { ...row }, answer: row.answer, reads, anth: anth.slice(), wai: wai.slice(), prompt: wai.map((b) => (b.messages || []).map((m) => m.content).join("\n")).join("\n====\n"), claudePrompt: anth.map((a) => JSON.stringify(a.body)).join("\n====\n") };
}
const reset = () => {
  claudeText = () => "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
  waiText = () => "**Workers answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
};
test.beforeEach(reset);

// ---- (a) conversation memory ------------------------------------------------------------------------------------------------------------------------
test("a: the asker's own last turns (question and answer) are in the research prompt, oldest first, at most 3", async () => {
  const seed = [
    { q: "OLDEST-QUESTION-ZERO", a: "OLDEST-ANSWER-ZERO", hoursAgo: 5 },
    { q: "first mage question", a: "first mage answer about frost", hoursAgo: 4 },
    { q: "second mage question", a: "second mage answer about blink", hoursAgo: 3 },
    { q: "third mage question", a: "third mage answer about polymorph", hoursAgo: 2 },
  ];
  const r = await ask("and what about the talents", { seed });
  for (const s of ["first mage question", "first mage answer about frost", "second mage answer about blink", "third mage question", "third mage answer about polymorph"]) assert.ok(r.prompt.includes(s), `missing: ${s}`);
  assert.ok(!r.prompt.includes("OLDEST-QUESTION-ZERO") && !r.prompt.includes("OLDEST-ANSWER-ZERO"), "only the last 3 turns");
  assert.ok(r.prompt.indexOf("first mage question") < r.prompt.indexOf("third mage question"), "oldest first");
  assert.match(r.prompt, /<<<PRIOR_TURNS/, "fenced as data");
});

test("a: another asker's turns never appear (hash scoping), nor do private turns in a public ask, expired, unanswered or error rows", async () => {
  const seed = [
    { q: "MINE-visible question", a: "MINE-visible answer" },
    { q: "OTHER-USER-QUESTION", a: "OTHER-USER-ANSWER", hash: H_OTHER },
    { q: "MINE-private question", a: "MINE-private answer", share: false },
    { q: "MINE-expired question", a: "MINE-expired answer", hoursAgo: 30 },
    { q: "MINE-pending question", a: null, status: "thinking" },
    { q: "MINE-errored question", a: "MINE-error text", status: "error" },
    { q: "MINE-budget question", a: "MINE-budget line", model: "workers-ai:daily-limit" },
    { q: "MINE-down question", a: "MINE-down line", model: "workers-ai-research-down" },
  ];
  const r = await ask("and the other thing", { seed });
  assert.ok(r.prompt.includes("MINE-visible question") && r.prompt.includes("MINE-visible answer"));
  for (const bad of ["OTHER-USER", "MINE-private", "MINE-expired", "MINE-pending", "MINE-error", "MINE-budget", "MINE-down"]) assert.ok(!r.prompt.includes(bad), `leaked: ${bad}`);
  // a private ask may use the asker's private turns too
  const p = await ask("and the other thing", { seed, share: false });
  assert.ok(p.prompt.includes("MINE-private question"));
  assert.ok(!p.prompt.includes("OTHER-USER"));
});

test("a: an erased turn is gone from the prompt (the erase deletes the asker rows; the read joins on them)", async () => {
  const r = await ask("again", { seed: [{ q: "ERASED-QUESTION", a: "ERASED-ANSWER", noAsker: true }, { q: "kept question", a: "kept answer" }] });
  assert.ok(r.prompt.includes("kept question"));
  assert.ok(!r.prompt.includes("ERASED-QUESTION") && !r.prompt.includes("ERASED-ANSWER"));
});

test("a: one D1 read for the turns; none with the flag off; none for a visitor-less hash-less ask beyond the one read", async () => {
  const on = await ask(ABSTAIN_Q, { seed: [{ q: "ZQ1-MARKER", a: "ZA1-MARKER" }] });
  assert.equal(on.reads.length, 1, "exactly one ask_turns read in research mode for a non-follow-up question");
  const off = await ask(ABSTAIN_Q, { research: false, seed: [{ q: "ZQ1-MARKER", a: "ZA1-MARKER" }] });
  assert.equal(off.reads.length, 0, "flag off: no new read (a non-follow-up question reads nothing)");
  assert.ok(!off.prompt.includes("PRIOR_TURNS") && !off.prompt.includes("ZA1-MARKER") && !off.prompt.includes("ZQ1-MARKER"));
});

test("a: the turns go through the tokeniser and the privacy guard like every other user text", async () => {
  // A roster-looking name inside an earlier turn is a token on the wire to Claude, never the raw text.
  const { ROSTER_DATA } = await import("../../infrastructure/worker/bot-data.js");
  const name = ROSTER_DATA[1].display;
  const r = await ask("and the other thing", { key: true, seed: [{ q: `does ${name} tank`, a: `${name} tanks on Fridays.` }] });
  assert.equal(r.anth.length, 1, r.row.model);
  assert.ok(!r.claudePrompt.includes(name), "the raw name never reaches Anthropic");
  assert.match(r.claudePrompt, /\{P\d+\.[a-z0-9]{4}\}/);
  // A guard hit inside an earlier turn stops Claude for the ask (Workers AI answers); the guard saw the turn.
  const b64 = Buffer.from(name).toString("base64"); // an obfuscated roster name: the strict guard stops it (same probe as ask-research-claude.test.mjs)
  const g = await ask("and the other thing", { key: true, seed: [{ q: `what does ${b64} think`, a: "fine" }] });
  assert.equal(g.anth.length, 0, "an obfuscated name in an earlier question stops the Claude call");
  assert.match(g.row.model, /guard:/);
  assert.ok(g.answer && g.answer.length > 5, "never a refusal");
  assert.ok(!g.prompt.includes("PRIOR_TURNS") || g.wai.length >= 1, "Workers AI (inside Cloudflare) answers the same tokenised prompt");
  const ga = await ask("and the other thing", { key: true, seed: [{ q: "fine question", a: `what does ${b64} think` }] });
  assert.equal(ga.anth.length, 0, "the earlier ANSWER is guarded too");
  assert.match(ga.row.model, /guard:/);
});

test("a: size cap, one line per field, links and mentions removed from carried answers; no turns means no block", async () => {
  const long = "word ".repeat(400);
  const r = await ask("and the other thing", { seed: [{ q: long, a: `${long} https://evil.example/x [site](<https://evil.example>) @everyone\n-# Sources: classes/tanking` }, { q: "q2", a: long }, { q: "q3", a: long }] });
  const block = /<<<PRIOR_TURNS\n([\s\S]*?)\nPRIOR_TURNS>>>/.exec(r.prompt);
  assert.ok(block, "block present");
  assert.ok(block[1].length <= 2000, `block ${block[1].length} chars`);
  assert.ok(!/evil\.example|@everyone|-# Sources/.test(block[1]));
  const none = await ask("hello there", { seed: [] });
  assert.ok(!none.prompt.includes("PRIOR_TURNS"));
});

test("a: a different asker with the same question text sees nothing of the first asker's turns", async () => {
  const r = await ask("and the other thing", { hash: H_OTHER, seed: [{ q: "FIRST-ASKER-Q", a: "FIRST-ASKER-A" }] });
  assert.ok(!r.prompt.includes("FIRST-ASKER"));
});

// ---- (b) length ------------------------------------------------------------------------------------------------------------------------------------------
test("b: the live research path sends 700 tokens and finishes at 1900; the persona's shorter 'under N characters' line is overridden in the research prompt", async () => {
  const persona = { system: "You are Leeroy.", format: { chatMaxChars: 1200 } };
  const on = await ask(ABSTAIN_Q, { persona });
  assert.equal(on.wai[0].max_tokens, 700);
  assert.match(on.prompt, /under 1200 characters/, "sanity: the stored persona line is there");
  assert.match(on.prompt, /replaced by this one[^\n]*1500 characters/i, "the research rules replace it with the 1500 cap");
  const off = await ask(ABSTAIN_Q, { research: false, persona });
  assert.ok(!/replaced by this one/i.test(off.prompt), "flag off: prompt untouched");
  const body = ("A sentence that carries a fact about Classic mage frost damage. ").repeat(40);
  const big = await ask(ABSTAIN_Q, { persona, respond: () => `${body}\n-# Sources: general Classic-era knowledge · unconfirmed` });
  assert.ok(big.answer.length <= 1900, `${big.answer.length}`);
  assert.ok(big.answer.length > 1200, `research answer was cut at the persona cap: ${big.answer.length}`);
});

// ---- (c) abstain in voice --------------------------------------------------------------------------------------------------------------------------
test("c: no code-written abstain line reaches the user under research, even when the model itself emits the refusal", async () => {
  for (const reply of [ABSTAIN_LINE, NOT_PUBLISHED_LINE, "The Library does not cover that yet, so I won't guess."]) {
    const r = await ask(ABSTAIN_Q, { respond: () => reply });
    for (const line of [ABSTAIN_LINE, NOT_PUBLISHED_LINE]) assert.ok(!r.answer.includes(line), `abstain line shown: ${r.answer}`);
    assert.ok(!/does not (?:cover|have) that yet/i.test(r.answer), r.answer);
    assert.match(r.answer, /would settle it/i, "the fallback names what would settle it");
  }
});

test("c: the code-written research fallbacks are in voice and name what would settle it; none is a wall", () => {
  for (const line of [RESEARCH_DOWN_ANSWER, ...MEMBER_FALLBACK_LINES]) {
    assert.match(line, /settle it/i, line);
    assert.doesNotMatch(line, WALL_RE, line);
    assert.doesNotMatch(line, /library does not|not published yet|won't guess|cannot answer/i, line);
  }
  assert.match(RESEARCH_DOWN_ANSWER, /out of reach right now/, "still recognised as the outage line by the lint");
});

// ---- (d) advice stripper ---------------------------------------------------------------------------------------------------------------------------
test("d: repairHouseVoice keeps imperative advice with keepAdvice, strips it by default (flag-off behaviour)", () => {
  const text = "Frost is the safe pick. You should go with Frost for the single target threat.";
  assert.match(repairHouseVoice(text, { keepAdvice: true }), /You should go with Frost/);
  assert.doesNotMatch(repairHouseVoice(text, {}), /You should go with Frost/);
  assert.doesNotMatch(repairHouseVoice(text), /You should go with Frost/);
});

test("d: under research a 'what should I' answer keeps its imperative pick; with the flag off it is stripped as before", async () => {
  const reply = () => "Frost is the safe pick for a first mage. Go with Frost for the single target threat and the control.\n-# Sources: general Classic-era knowledge · likely";
  const on = await ask("what should I level as a mage", { respond: reply });
  assert.match(on.answer, /Go with Frost for the single target/, on.answer);
  const off = await ask("what should I level as a mage", { research: false, respond: reply });
  assert.doesNotMatch(off.answer, /Go with Frost/, off.answer);
});
