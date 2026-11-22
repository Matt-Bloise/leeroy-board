// GAME_FACTS_READ OFF: the /ask path is byte-identical to the path before the reader existed, even with facts in the table.
//   1  the seven scenarios of tests/fixtures/shadow-ask/ask-trace.json (recorded on master before the shadow sink), replayed with game_facts rows present and the flag unset, "off" and every non-"on" value: equal to the fixture
//   2  a table-fact question (the one the reader exists for) with matching rows present, flag unset / "off" / junk values: equal to tests/fixtures/game-facts-read/off-trace.json, which was RECORDED ON master (4af0dfee, before the reader existed)
//      by running this same file against that tree with GF_TRACE_OUT set; this change must reproduce it byte for byte (turn row, group log, stats, socket, webhook and the Anthropic request bodies)
//   3  the flag is read by "on" only: with "on" the same table-fact trace DIFFERS (so the two checks above are not vacuous)
// Offline: fake Anthropic endpoint, in-memory D1 from schema.sql, fictional names and facts. Imports only modules that exist on master, so it can be run against the pre-reader tree.
// Run: node --test tests/unit/game-facts-read-off.test.mjs   (GF_TRACE_OUT=<file> writes the table-fact trace instead of checking it)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { loadFacts } from "../helpers/game-facts-fixture.mjs";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const FAKE_KEY = ["sk", "ant", "FAKE", "TEST", "0000"].join("-");
const BOT = ["bot", "token", "for", "shadow", "0123456789"].join("-");
const USER_SALT = "user-salt-for-tests-0123456789";
const HOOK = ["https://discord.test/api/webhooks", "123", "hookpart"].join("/");
const realFetch = globalThis.fetch;
let anth = [];
let others = [];
let rooms = [];
let claude = () => ({ status: 200, text: OK });
const OK = "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge \u00b7 unconfirmed";
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("anthropic")) {
    const body = JSON.parse(init.body);
    anth.push({ model: body.model, body, raw: init.body });
    const r = claude(body, anth.length);
    if (r.throws) throw r.throws;
    return new Response(JSON.stringify({ content: r.text === undefined ? [] : [{ type: "text", text: r.text }], usage: { input_tokens: 111, output_tokens: 22 } }), { status: r.status || 200, headers: { "content-type": "application/json" } });
  }
  others.push({ url: u, method: init && init.method });
  return new Response("{}", { status: 599 });
};
const fakeAi = { run: async () => { throw new Error("Workers AI must not be called for a member"); } };
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetKeyCacheForTests(); resetResearchClaudeForTests(); privacyBudget.ms = 1000; anth = []; others = []; rooms = []; claude = () => ({ status: 200, text: OK }); });

const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(12) }, updated: "x" },
  { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), race: f("gnome"), level: f(10) }, updated: "x" },
];
const MEMBERS = [{ slug: "red-fox", name: "Red Fox", match: [], id: "700000000000000001" }, { slug: "blue-owl", name: "Blue Owl", match: [], id: "700000000000000002" }];
const TANK_PAGE = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };
const CH = "900000000000000001";
const GROUP_MARK = "ZEBRA-CHATTER-MARKER";
const roomStub = { idFromName: () => "r", get: () => ({ fetch: async (_u, init) => { rooms.push(init && init.body); return new Response("ok"); } }) };
const quiet = async (fn) => { const real = { log: console.log, warn: console.warn, error: console.error, info: console.info }; for (const k of Object.keys(real)) console[k] = () => {}; try { return await fn(); } finally { Object.assign(console, real); } };

function seed(DB) {
  DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(TANK_PAGE.id, TANK_PAGE.category, TANK_PAGE.title, TANK_PAGE.blurb, JSON.stringify(TANK_PAGE.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(SHEETS));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, 'x')").run(JSON.stringify(MEMBERS));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('stats', ?, 'x')").run(JSON.stringify({ answers: 3, recent: [], updated: "2026-11-01" }));
  DB.raw.prepare("INSERT INTO group_log (at, channel, author_slug, kind, text, source) VALUES (?, ?, 'blue-owl', 'message', ?, 'listener')").run("2026-11-10T12:00:00.000Z", CH, `${GROUP_MARK} we tanked it last week`);
}
// GAME_FACTS_READ is spread in only when the scenario names it: "unset" means the key is absent from env.
const mkEnv = (DB, extra = {}) => ({ DB, AI: fakeAi, USER_SALT, ANTHROPIC_API_KEY: FAKE_KEY, DISCORD_BOT_TOKEN: BOT, ASK_RESEARCH: "on", RESEARCH_NAMES: "real", GROUP_MEMORY: "on", SHADOW_ASK: "on", BOARD_ROOM: roomStub, DISCORD_WEBHOOK_URL: HOOK, ...extra });
async function freshDb({ facts = false } = {}) { invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache(); const DB = await schemaDb(); seed(DB); if (facts) loadFacts(DB); return DB; }

const SCENARIOS = [
  { name: "member shared, Claude answers", claude: () => ({ status: 200, text: OK }), share: true },
  { name: "member private, Claude answers", claude: () => ({ status: 200, text: OK }), share: false },
  { name: "member shared, Claude fails (degraded)", claude: () => ({ status: 401 }), share: true },
  { name: "member shared, Claude overloaded then fast model answers", claude: (b) => (/sonnet/.test(b.model) ? { status: 529 } : { status: 200, text: OK }), share: true },
  { name: "member shared, reply carries a long id (masked)", claude: () => ({ status: 200, text: "**Here.**\nThe id is 123456789012345678.\n-# Sources: general Classic-era knowledge \u00b7 unconfirmed" }), share: true },
  { name: "member shared, no key", claude: () => ({ status: 200, text: OK }), share: true, env: { ANTHROPIC_API_KEY: undefined } },
  { name: "member shared, cap spent", claude: () => ({ status: 200, text: OK }), share: true, env: { RESEARCH_CLAUDE_MONTHLY_TOKENS: "1000" } },
];
const TABLE_Q = "what level is Zorbo Bolt rank 4";
const TABLE_SCENARIOS = [
  { name: "table question shared, Claude answers", claude: () => ({ status: 200, text: OK }), share: true },
  { name: "table question private, Claude answers with a figure", claude: () => ({ status: 200, text: "**Zorbo Bolt rank 4 needs level 18.**\n-# Sources: general Classic-era knowledge \u00b7 unconfirmed" }), share: false },
  { name: "table question shared, Claude fails (degraded)", claude: () => ({ status: 401 }), share: true },
];
const norm = (v) => JSON.parse(JSON.stringify(v).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<iso>").replace(/\d{4}-\d{2}-\d{2}/g, "<day>").replace(/"latency_ms":\d+/g, '"latency_ms":0').replace(/("ms"|\\"ms\\"):\d+/g, "$1:0").replace(/"at":\d{13}/g, '"at":0'));
async function traceScenario(sc, { question, facts, flag }) {
  const DB = await freshDb({ facts });
  const id = "diff-ask-1";
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, 'Red Fox', ?, 'groq', 'thinking', ?, '2026-11-18T10:00:00.000Z')").run(id, question, sc.share ? 1 : 0);
  anth = []; others = []; rooms = []; claude = sc.claude;
  const env = mkEnv(DB, { ANSWER_UX: "on", ...(flag === undefined ? {} : { GAME_FACTS_READ: flag }), ...(sc.env || {}) });
  const posted = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith(HOOK)) { posted.push(JSON.parse(init.body)); return new Response("{}", { status: 204 }); } return prevFetch(url, init); };
  try { await quiet(() => answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Red Fox", memberSlug: "red-fox", question, provider: "claude", share: sc.share, budget: null, isMember: true, storeDetails: true, channel: CH })); }
  finally { globalThis.fetch = prevFetch; }
  const rows = (sql) => DB.raw.prepare(sql).all();
  return norm({
    turn: rows("SELECT id, by_name, question, answer, cites_json, model, status, share FROM ask_turns"),
    details: rows("SELECT intent_id, more, sources FROM answer_details"),
    groupLog: rows("SELECT channel, author_slug, kind, text, source FROM group_log ORDER BY id"),
    stats: rows("SELECT json FROM kv_state WHERE key = 'stats'"),
    counters: rows("SELECT key, json FROM kv_state WHERE key LIKE 'claude_tokens%' OR key LIKE 'alert:%' ORDER BY key").map((r) => ({ ...r, key: r.key.replace(/\d{6}/, "<month>") })),
    rooms: rooms.map((b) => { try { return JSON.parse(b); } catch { return String(b); } }),
    webhook: posted,
    sends: anth.map((a) => a.raw),
    other: others.map((o) => o.url),
  });
}
const GOLDEN = new URL("../fixtures/shadow-ask/ask-trace.json", import.meta.url);
const OFF_TRACE = new URL("../fixtures/game-facts-read/off-trace.json", import.meta.url);
const NOT_ON = [undefined, "off", "OFF", "", "true", "1", "yes", "dry", "onn"];

test("flag not on (unset, off, any other value), game facts in the table: the seven recorded scenarios of the shadow-ask differential are reproduced byte for byte", async () => {
  if (process.env.GF_TRACE_OUT) return;
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  for (const flag of NOT_ON) {
    const trace = {};
    for (const sc of SCENARIOS) trace[sc.name] = await traceScenario(sc, { question: "who tanks tonight", facts: true, flag });
    assert.deepEqual(Object.keys(trace), Object.keys(golden), String(flag));
    for (const name of Object.keys(golden)) assert.deepEqual(trace[name], golden[name], `${name} (flag ${JSON.stringify(flag)})`);
  }
});

test("flag not on, a table-fact question with matching rows in the table: equal to the trace recorded on master before the reader existed", async () => {
  const run = async (flag) => { const t = {}; for (const sc of TABLE_SCENARIOS) t[sc.name] = await traceScenario(sc, { question: TABLE_Q, facts: true, flag }); return t; };
  if (process.env.GF_TRACE_OUT) { writeFileSync(process.env.GF_TRACE_OUT, JSON.stringify(await run(undefined), null, 1) + "\n"); return; }
  const golden = JSON.parse(readFileSync(OFF_TRACE, "utf8"));
  for (const flag of NOT_ON) {
    const trace = await run(flag);
    assert.deepEqual(Object.keys(trace), Object.keys(golden), String(flag));
    for (const name of Object.keys(golden)) assert.deepEqual(trace[name], golden[name], `${name} (flag ${JSON.stringify(flag)})`);
  }
  const first = golden[TABLE_SCENARIOS[0].name];
  assert.ok(first.sends.length >= 1 && !first.sends[0].includes("GAME_FACTS") && !first.sends[0].includes("spelllevels:101"), "the recorded request is the master request: no block, no row id");
  assert.equal(first.turn[0].status, "answered");
});

test("flag on, the same table-fact trace DIFFERS (the checks above are not vacuous): the request carries the block", async () => {
  if (process.env.GF_TRACE_OUT) return;
  const golden = JSON.parse(readFileSync(OFF_TRACE, "utf8"));
  const on = await traceScenario(TABLE_SCENARIOS[0], { question: TABLE_Q, facts: true, flag: "on" });
  assert.notDeepEqual(on.sends, golden[TABLE_SCENARIOS[0].name].sends);
  assert.ok(on.sends[0].includes("GAME_FACTS") && on.sends[0].includes("spelllevels:101"));
});
