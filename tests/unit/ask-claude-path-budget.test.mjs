// Subrequest budget of the /ask research path BEFORE the Claude send, and what a realistic member ask costs.
// Why: Workers Free allows 50 subrequests per invocation; D1 statements, Durable Object calls and fetches all count (a db.batch counts as one). A "Too many subrequests" error is a plain Error,
// and the Claude hop turns any throw into a fixed reason. This test counts every D1 call (prepare().first/all/run/raw, batch as one) and every outside fetch/DO call made before the first
// Anthropic send, for a member ask with real names, with group memory off and on, and fails when the pre-Claude path exceeds BUDGET.
// Offline: fake Anthropic (fake fetch), fake Workers AI binding, in-memory D1 (tests/helpers/sqlite-d1.mjs). Fake key only.
// Run: node --test tests/unit/ask-claude-path-budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests } from "../../infrastructure/worker/research/claude.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const BUDGET = 30; // headroom under the Free plan limit of 50: the Claude send, the reservation settle, the answer write and the room broadcast still follow
const realFetch = globalThis.fetch;
const OK = "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
let subrequests = 0; // everything that counts toward the limit
let atFirstSend = null; // the count when the Anthropic fetch starts
let others = 0;
globalThis.fetch = async (url, init) => {
  subrequests++;
  if (String(url).includes("anthropic")) {
    if (atFirstSend === null) atFirstSend = subrequests;
    return new Response(JSON.stringify({ content: [{ type: "text", text: OK }], usage: { input_tokens: 111, output_tokens: 22 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  others++;
  return new Response("{}", { status: 200 });
};
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); resetResearchClaudeForTests(); });

// Wraps a D1 stand-in so each statement execution counts once and a batch counts once, as Cloudflare counts them.
function counting(DB, tally) {
  const wrapStmt = (s) => {
    const w = {
      sql: s.sql,
      bind: (...a) => { s.bind(...a); return w; },
      _run: () => s._run(),
    };
    for (const m of ["all", "first", "run", "raw"]) if (typeof s[m] === "function") w[m] = (...a) => { tally.d1++; subrequests++; return s[m](...a); };
    return w;
  };
  return {
    raw: DB.raw,
    prepare: (sql) => wrapStmt(DB.prepare(sql)),
    exec: (...a) => { tally.d1++; subrequests++; return DB.exec(...a); },
    batch: (list) => { tally.d1++; subrequests++; return DB.batch(list.map((x) => (x._inner ? x._inner : x))); },
  };
}

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const FIELDS = () => ({ class: f("paladin"), race: f("human"), level: f(40), role: f("tank"), professions: f("mining, engineering"), goals: f("clear the raid on Friday"), plan_zone: f("Stranglethorn") });
const SHEETS = ["red-fox", "blue-owl", "green-bat", "gold-elk", "grey-ram", "pink-eel", "jade-cat", "ruby-yak"].map((slug) => ({ slug, name: slug.replace(/-/g, " "), fields: FIELDS(), updated: "x" }));
const PAGES = Array.from({ length: 40 }, (_, i) => ({ id: `classes/page${i}`, category: "classes", title: `Tanking page ${i}`, blurb: "Who tanks", facts: [{ key: `tanking.k${i}`, value: `Who tanks tonight is agreed in the party channel number ${i}.` }] }));

let n = 0;
async function ask(question, { groupMemory = false, priorTurns = 3 } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const inner = schemaDb();
  for (const p of PAGES) inner.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  inner.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  inner.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('signups', ?, 'x')").run(JSON.stringify({ roster: { "Red Fox": { note: "on" }, "Blue Owl": { note: "on" } } }));
  inner.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('tonight', ?, 'x')").run(JSON.stringify({ title: "Raid night" }));
  const H_ME = "a".repeat(64);
  for (let i = 0; i < priorTurns; i++) {
    const sid = `seed${++n}`;
    const at = new Date(Date.now() - 3600 * 1000 * (i + 1)).toISOString();
    inner.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, model, status, share, created_at, answered_at) VALUES (?, 'x', ?, ?, 'claude:x+research', 'answered', 1, ?, ?)").run(sid, `an earlier question ${i}`, `an earlier answer ${i}`, at, at);
    inner.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").run(sid, H_ME);
  }
  const tally = { d1: 0 };
  const DB = counting(inner, tally);
  const fakeAi = { run: async () => { subrequests++; return { response: "x", usage: {} }; } };
  const room = { idFromName: () => "r", get: () => ({ fetch: async () => { subrequests++; return new Response("ok"); } }) };
  const env = { DB, AI: fakeAi, USER_SALT: "user-salt-for-tests-0123456789", ANTHROPIC_API_KEY: "sk-ant-FAKE-TEST-0000", AI_GATEWAY_ID: "leeroy-ai-gateway", AI_GATEWAY_TOKEN: "fakeGatewayToken123456", CLOUDFLARE_ACCOUNT_ID: "d2528a785cb6079f1f28e9bc69769516", ASK_RESEARCH: "on", RESEARCH_NAMES: "real", ...(groupMemory ? { GROUP_MEMORY: "on" } : {}), BOARD_ROOM: room };
  const id = `bud${++n}`;
  inner.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, 'Red Fox', ?, 'groq', 'thinking', 1, ?)").run(id, question, new Date().toISOString());
  inner.raw.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").run(id, H_ME);
  subrequests = 0; atFirstSend = null; others = 0;
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real)) console[k] = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Red Fox", memberSlug: "red-fox", question, provider: "groq", share: true, deep: false, journey: "curious", isMember: true }); } finally { Object.assign(console, real); }
  const row = inner.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id);
  return { row: { ...row }, atFirstSend, total: subrequests, d1: tally.d1 };
}

for (const groupMemory of [false, true]) {
  test(`a realistic member ask (real names, group memory ${groupMemory ? "on" : "off"}) makes at most ${BUDGET} subrequests before the Claude send`, async () => {
    const r = await ask("what should I level first as a paladin tank", { groupMemory });
    console.log(`[budget] group memory ${groupMemory ? "on" : "off"}: before the Claude send ${r.atFirstSend}, whole ask ${r.total} (D1 statements and batches ${r.d1}), model ${r.row.model}`);
    assert.ok(r.atFirstSend !== null, `the Claude send happened (model ${r.row.model})`);
    assert.ok(r.atFirstSend <= BUDGET, `${r.atFirstSend} subrequests before the Claude send (budget ${BUDGET}; Workers Free limit 50)`);
    assert.ok(r.total <= 45, `${r.total} subrequests for the whole ask (Workers Free limit 50)`);
  });
}
