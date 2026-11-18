// THE CLAUDE SELF-TEST (POST /api/selftest/claude). Real Worker code over an in-memory SQLite D1; Anthropic is a fake; no network.
//   gate      no usable bot token = 404; missing, wrong or stale signature = 401; replay window 120 s; body over 1 KB = 413.
//   limit     a second call inside 60 s = 429 with retryAfter, and nothing is sent.
//   response  fixed vocabulary only: no key, no model id, no model text, no bot token.
//   spend     the reservation goes to the self-test's own sub-counter (and the monthly counter); no ask_turns row; a failed compose still runs the fast step.
// Run: node --test tests/unit/claude-selftest.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, counterKey, subCounterKey, monthTag } from "../../infrastructure/worker/research/claude.js";
import { signListen, listenerKey, resetListenerKeyCacheForTests } from "../../infrastructure/worker/listener-config.js";
import { SELFTEST_RATE_KEY, selftestSubCounterKey, SELFTEST_PROMPT } from "../../infrastructure/worker/selftest.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const FAKE_KEY = ["sk", "ant", "FAKE", "TEST", "0000"].join("-");
const BOT = ["bot", "token", "for", "selftest", "0123456789"].join("-");
const MODEL_TEXT = ["MODEL", "TEXT", "MARKER"].join("_");
const KEY = await listenerKey(BOT);
const realFetch = globalThis.fetch;
let sends = [];
let behave = () => ({ status: 200 });
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("anthropic")) return new Response("{}", { status: 599 });
  const body = JSON.parse(init.body);
  sends.push(body);
  const b = behave(body, sends.length);
  if (b.status !== 200) return new Response(JSON.stringify({ error: { type: "api_error", message: `${MODEL_TEXT} ${FAKE_KEY}` } }), { status: b.status });
  return new Response(JSON.stringify({ content: [{ type: "text", text: b.text ?? MODEL_TEXT }], usage: { input_tokens: 20, output_tokens: 3 } }), { status: 200, headers: { "Content-Type": "application/json" } });
};
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetListenerKeyCacheForTests(); resetKeyCacheForTests(); resetResearchClaudeForTests(); sends = []; behave = () => ({ status: 200 }); });

const mkEnv = (DB, extra = {}) => ({ DB, ANTHROPIC_API_KEY: FAKE_KEY, DISCORD_BOT_TOKEN: BOT, ...extra });
async function post(env, obj = { x: 1 }, { key = KEY, ts = Math.floor(Date.now() / 1000), sig = null, raw = null, headers = true } = {}) {
  const body = raw ?? JSON.stringify(obj);
  const h = { "Content-Type": "application/json" };
  if (headers) { h["X-Listen-Timestamp"] = String(ts); h["X-Listen-Signature"] = sig ?? (await signListen(key, String(ts), body)); }
  const res = await worker.fetch(new Request("https://worker.test/api/selftest/claude", { method: "POST", headers: h, body }), env, { waitUntil() {} });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), res };
}
const tokens = (DB, k) => { const r = DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(k); return r ? Number(r.json) : null; };
const clearLimit = (DB) => DB.raw.prepare("DELETE FROM kv_state WHERE key = ?").run(SELFTEST_RATE_KEY);
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

test("a signed call runs compose then fast, with the fixed prompt, and answers only fixed fields", async () => {
  const DB = await schemaDb();
  const r = await quiet(() => post(mkEnv(DB)));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.steps.map((s) => [s.stage, s.ok, s.reason, s.modelClass]), [["compose", true, "ok", "sonnet"], ["fast", true, "ok", "haiku"]]);
  for (const s of r.json.steps) assert.deepEqual(Object.keys(s).sort(), ["modelClass", "ms", "ok", "reason", "stage"]);
  assert.deepEqual(Object.keys(r.json).sort(), ["ok", "steps"]);
  assert.equal(sends.length, 2);
  for (const b of sends) { assert.equal(b.max_tokens, 8); assert.equal(b.messages[0].content, SELFTEST_PROMPT); }
  assert.match(sends[0].model, /sonnet/); assert.match(sends[1].model, /haiku/);
});

test("the response never holds the key, a model id, the model text or the bot token", async () => {
  const DB = await schemaDb();
  const okRes = await quiet(() => post(mkEnv(DB)));
  clearLimit(DB);
  behave = () => ({ status: 500 });
  const badRes = await quiet(() => post(mkEnv(DB)));
  for (const r of [okRes, badRes]) {
    for (const bad of [FAKE_KEY, MODEL_TEXT, BOT, "claude-", "sonnet-5", "haiku-5", "anthropic"]) assert.ok(!r.text.includes(bad), `response must not contain ${bad}`);
  }
  assert.deepEqual(badRes.json.steps.map((s) => s.reason), ["claude:http-500", "claude:http-500"]);
  assert.equal(badRes.json.ok, false);
});

test("no usable bot token: the route does not exist", async () => {
  const DB = await schemaDb();
  for (const token of [undefined, "", "short"]) {
    const r = await post(mkEnv(DB, { DISCORD_BOT_TOKEN: token }));
    assert.equal(r.status, 404, String(token));
  }
  assert.equal(sends.length, 0);
});

test("missing, wrong, other-key and tampered signatures are 401 and send nothing", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  assert.equal((await post(env, { x: 1 }, { headers: false })).status, 401);
  assert.equal((await post(env, { x: 1 }, { sig: "0".repeat(64) })).status, 401);
  assert.equal((await post(env, { x: 1 }, { sig: "" })).status, 401);
  assert.equal((await post(env, { x: 1 }, { key: await listenerKey("a-different-bot-token-entirely") })).status, 401);
  const body = JSON.stringify({ x: 1 });
  const ts = Math.floor(Date.now() / 1000);
  assert.equal((await post(env, null, { raw: JSON.stringify({ x: 2 }), sig: await signListen(KEY, String(ts), body), ts })).status, 401);
  assert.equal(sends.length, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS c FROM kv_state WHERE key = ?").get(SELFTEST_RATE_KEY).c, 0, "a rejected call leaves no limiter row");
});

test("replay window: 110 s old is accepted, 121 s old or ahead is refused", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(env, { x: 1 }, { ts: now - 121 })).status, 401);
  assert.equal((await post(env, { x: 1 }, { ts: now + 121 })).status, 401);
  assert.equal((await post(env, { x: 1 }, { ts: now - 3600 })).status, 401);
  assert.equal(sends.length, 0);
  assert.equal((await quiet(() => post(env, { x: 1 }, { ts: now - 110 }))).status, 200);
});

test("body: over 1 KB is 413, not JSON is 400 (after the signature)", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  assert.equal((await post(env, { pad: "x".repeat(1100) })).status, 413);
  assert.equal((await post(env, null, { raw: "not json" })).status, 400);
  assert.equal(sends.length, 0);
});

test("a second call inside 60 s is 429 with retryAfter and sends nothing; it works again after the window", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  assert.equal((await quiet(() => post(env))).status, 200);
  const n = sends.length;
  const r = await post(env);
  assert.equal(r.status, 429);
  assert.ok(Number.isInteger(r.json.retryAfter) && r.json.retryAfter >= 1 && r.json.retryAfter <= 60);
  assert.equal(r.res.headers.get("Retry-After"), String(r.json.retryAfter));
  assert.equal(sends.length, n, "no send on a limited call");
  DB.raw.prepare("UPDATE kv_state SET json = ? WHERE key = ?").run(JSON.stringify({ at: Date.now() - 61000 }), SELFTEST_RATE_KEY);
  assert.equal((await quiet(() => post(env))).status, 200);
});

test("the reservation goes to the self-test sub-counter, not the group or ask counters, and only expected rows are written", async () => {
  const DB = await schemaDb();
  const now = new Date();
  await quiet(() => post(mkEnv(DB)));
  const sub = tokens(DB, selftestSubCounterKey(now));
  assert.ok(sub > 0 && sub < 200, `tiny settled usage, got ${sub}`);
  assert.equal(tokens(DB, counterKey(now)), sub, "the monthly counter moved by the same amount");
  assert.equal(tokens(DB, subCounterKey(now)), null, "the group-wiki counter is untouched");
  assert.equal(selftestSubCounterKey(now), `claude_tokens_selftest_${monthTag(now)}`);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS c FROM ask_turns").get().c, 0);
  const keys = DB.raw.prepare("SELECT key FROM kv_state ORDER BY key").all().map((r) => r.key);
  assert.deepEqual(keys, [counterKey(now), selftestSubCounterKey(now), SELFTEST_RATE_KEY].sort());
});

test("the sub-cap is its own: a spent self-test counter stops the self-test and leaves the monthly counter alone", async () => {
  const DB = await schemaDb();
  const now = new Date();
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, '10000', 'x')").run(selftestSubCounterKey(now));
  const r = await quiet(() => post(mkEnv(DB)));
  assert.deepEqual(r.json.steps.map((s) => s.reason), ["claude:subcap", "claude:subcap"]);
  assert.equal(sends.length, 0);
  assert.equal(tokens(DB, counterKey(now)), null);
});

test("a failed compose still runs the fast step", async () => {
  const DB = await schemaDb();
  behave = (body) => (/sonnet/.test(body.model) ? { status: 529 } : { status: 200 });
  const r = await quiet(() => post(mkEnv(DB)));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.steps.map((s) => [s.stage, s.ok, s.reason]), [["compose", false, "claude:http-529"], ["fast", true, "ok"]]);
  assert.equal(sends.length, 2, "exactly two sends, no fallback model send");
});

test("a missing model id on compose is reported, with no fallback send", async () => {
  const DB = await schemaDb();
  behave = (body) => (/sonnet/.test(body.model) ? { status: 404 } : { status: 200 });
  const r = await quiet(() => post(mkEnv(DB)));
  assert.equal(r.json.steps[0].reason, "claude:http-404");
  assert.equal(sends.length, 2);
});

test("no Anthropic key: both steps say so and nothing is sent", async () => {
  const DB = await schemaDb();
  const r = await quiet(() => post(mkEnv(DB, { ANTHROPIC_API_KEY: undefined })));
  assert.deepEqual(r.json.steps.map((s) => s.reason), ["claude:no-key", "claude:no-key"]);
  assert.equal(sends.length, 0);
});

test("a limiter that cannot be written fails closed: 503 and no send", async () => {
  const DB = await schemaDb();
  const real = DB.prepare.bind(DB);
  const broken = { ...DB, prepare: (sql) => (/^INSERT OR IGNORE INTO kv_state/.test(sql) ? { bind: () => ({ all: async () => { throw new Error("d1 down"); } }) } : real(sql)) };
  const r = await post(mkEnv(broken));
  assert.equal(r.status, 503);
  assert.equal(sends.length, 0);
});
