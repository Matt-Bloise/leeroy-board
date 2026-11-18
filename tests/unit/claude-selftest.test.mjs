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
import { signListen, listenerKey, parseListenEvent, resetListenerKeyCacheForTests } from "../../infrastructure/worker/listener-config.js";
import { handleSelftestClaude, safeReason, isSelftestBody, SELFTEST_RATE_KEY, selftestSubCounterKey, SELFTEST_PROMPT } from "../../infrastructure/worker/selftest.js";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
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

const BODY = { purpose: "claude-selftest" };
let seq = 0; // each call signs a different second (inside the 120 s window) so a repeat of the SAME signature is the only replay
const mkEnv = (DB, extra = {}) => ({ DB, ANTHROPIC_API_KEY: FAKE_KEY, DISCORD_BOT_TOKEN: BOT, ...extra });
async function post(env, obj = BODY, { key = KEY, ts = Math.floor(Date.now() / 1000) - (seq++ % 100), sig = null, raw = null, headers = true } = {}) {
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
  assert.equal((await post(env, BODY, { headers: false })).status, 401);
  assert.equal((await post(env, BODY, { sig: "0".repeat(64) })).status, 401);
  assert.equal((await post(env, BODY, { sig: "" })).status, 401);
  assert.equal((await post(env, BODY, { key: await listenerKey("a-different-bot-token-entirely") })).status, 401);
  const body = JSON.stringify(BODY);
  const ts = Math.floor(Date.now() / 1000);
  assert.equal((await post(env, null, { raw: JSON.stringify({ purpose: "other" }), sig: await signListen(KEY, String(ts), body), ts })).status, 401);
  assert.equal(sends.length, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS c FROM kv_state WHERE key = ?").get(SELFTEST_RATE_KEY).c, 0, "a rejected call leaves no limiter row");
});

test("replay window: 110 s old is accepted, 121 s old or ahead is refused", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(env, BODY, { ts: now - 121 })).status, 401);
  assert.equal((await post(env, BODY, { ts: now + 121 })).status, 401);
  assert.equal((await post(env, BODY, { ts: now - 3600 })).status, 401);
  assert.equal(sends.length, 0);
  assert.equal((await quiet(() => post(env, BODY, { ts: now - 110 }))).status, 200);
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

// ---- review fixes: cross-route replay, replay inside the window, reason vocabulary, the script ----------------------------------------------------
const LISTENER_EVENT = { id: "600000000000000001", guild_id: "800000000000000001", channel_id: "900000000000000001", author_id: "700000000000000001", kind: "mention", content: "who tanks tonight" };

test("a signed listener-shaped body is refused for the self-test, and the self-test body is not a listener event", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  const r = await post(env, LISTENER_EVENT); // validly signed with the shared key
  assert.equal(r.status, 400);
  assert.equal(sends.length, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS c FROM kv_state").get().c, 0, "nothing stored");
  assert.equal(parseListenEvent(BODY).ok, false, "the self-test body does not pass the listener parser");
  for (const bad of [{}, { purpose: "claude-selftest", extra: 1 }, { purpose: "other" }, { purpose: ["claude-selftest"] }, [BODY], "claude-selftest", null, 5]) {
    assert.equal(isSelftestBody(bad), false, JSON.stringify(bad));
    assert.equal((await post(env, null, { raw: JSON.stringify(bad) })).status, 400, JSON.stringify(bad));
  }
  assert.equal(sends.length, 0);
  assert.equal(isSelftestBody(BODY), true);
});

test("an exact repeat of an accepted signature inside the window is 409 with no send, in any letter case; hashes, not signatures, are stored", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  const ts = Math.floor(Date.now() / 1000) - 5;
  const sig = await signListen(KEY, String(ts), JSON.stringify(BODY));
  assert.equal((await quiet(() => post(env, BODY, { ts, sig }))).status, 200);
  const n = sends.length;
  assert.equal((await post(env, BODY, { ts, sig })).status, 409);
  assert.equal((await post(env, BODY, { ts, sig: sig.toUpperCase() })).status, 409, "upper-case hex is the same signature");
  assert.equal(sends.length, n);
  const row = DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(SELFTEST_RATE_KEY).json;
  assert.ok(!row.toLowerCase().includes(sig), "the signature itself is not stored");
  assert.match(JSON.parse(row).seen[0].h, /^[0-9a-f]{64}$/);
  assert.equal((await post(env)).status, 429, "a different, fresh signature is not a replay: the ordinary 429");
});

test("a limited (429) call is recorded too, so its repeat is 409; hashes older than 120 s are dropped", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB);
  await quiet(() => post(env));
  const ts = Math.floor(Date.now() / 1000) - 7;
  const sig = await signListen(KEY, String(ts), JSON.stringify(BODY));
  assert.equal((await post(env, BODY, { ts, sig })).status, 429);
  assert.equal((await post(env, BODY, { ts, sig })).status, 409);
  const doc = JSON.parse(DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(SELFTEST_RATE_KEY).json);
  doc.seen = doc.seen.map((e) => ({ ...e, t: e.t - 121000 }));
  doc.at = Date.now() - 61000;
  DB.raw.prepare("UPDATE kv_state SET json = ? WHERE key = ?").run(JSON.stringify(doc), SELFTEST_RATE_KEY);
  assert.equal((await quiet(() => post(env, BODY, { ts, sig }))).status, 200, "an expired hash no longer blocks");
  assert.ok(JSON.parse(DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(SELFTEST_RATE_KEY).json).seen.length <= 2);
});

test("reason is a fixed vocabulary: hostile and unknown strings become claude:error, in the response and the log", async () => {
  for (const bad of ["claude:error-Evil", "claude:http-5xx", "claude:http-12", "guard:leak-kind", "claude:timeout@evil-9s", "claude:timeout@compose-9999s", "OK", "ok ", "sk-" + "x".repeat(30), "claude:" + "a".repeat(200), "", null, undefined, {}, 5]) {
    assert.equal(safeReason(bad), "claude:error", String(bad));
  }
  for (const good of ["ok", "claude:no-key", "claude:paused", "claude:cap", "claude:subcap", "claude:counter-error", "claude:no-time", "claude:error", "claude:http-529", "claude:timeout", "claude:timeout@compose-16s", "claude:timeout@retry-6s", "claude:header", "claude:subrequests", "claude:overloaded", "guard:secret", "guard:host", "guard:config", "claude:empty"]) {
    assert.equal(safeReason(good), good);
  }
  const DB = await schemaDb();
  const evil = "Evil" + FAKE_KEY.replace(/-/g, "");
  const hostile = Object.assign(new Error("HTTP 4xx " + FAKE_KEY), { name: evil });
  const body = JSON.stringify(BODY), ts = Math.floor(Date.now() / 1000);
  const req = new Request("https://worker.test/api/selftest/claude", { method: "POST", headers: { "X-Listen-Timestamp": String(ts), "X-Listen-Signature": await signListen(KEY, String(ts), body) }, body });
  const logs = [];
  const l = console.log; console.log = (x) => logs.push(String(x));
  let res;
  try { res = await handleSelftestClaude(req, mkEnv(DB), { call: async () => { throw hostile; } }); } finally { console.log = l; }
  const text = await res.text();
  assert.deepEqual(JSON.parse(text).steps.map((s) => s.reason), ["claude:error", "claude:error"]);
  for (const out of [text, logs.join("\n")]) { assert.ok(!out.includes(evil)); assert.ok(!out.includes(FAKE_KEY)); }
  assert.match(logs.join("\n"), /"compose":"claude:error"/);
});

// The script: signs exactly the self-test body, refuses a non-https base URL (localhost and 127.0.0.1 may be http), never prints the token.
const SCRIPT = fileURLToPath(new URL("../../tools/claude-selftest.mjs", import.meta.url));
function tokenFile() { const dir = mkdtempSync(join(tmpdir(), "selftest-")); const f = join(dir, "t"); writeFileSync(f, BOT + "\n"); return { f, dir }; }
test("tools/claude-selftest.mjs refuses a non-https base URL and prints no token", () => {
  const { f, dir } = tokenFile();
  try {
    for (const url of ["http://api.example.test", "http://evil.test:8787", "ftp://api.example.test", "https://user:pw@api.example.test", "http://localhost.evil.test", "not a url", "file:///etc/passwd"]) {
      const r = spawnSync(process.execPath, [SCRIPT, f, url], { encoding: "utf8", timeout: 20000 });
      assert.equal(r.status, 2, url);
      assert.match(r.stderr, /refusing/, url);
      assert.ok(!(r.stdout + r.stderr).includes(BOT));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools/claude-selftest.mjs sends exactly the self-test body, signed so the Worker accepts it, to a localhost http URL", async () => {
  const { f, dir } = tokenFile();
  let seen = null;
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen = { url: req.url, method: req.method, body: b, ts: req.headers["x-listen-timestamp"], sig: req.headers["x-listen-signature"] }; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, steps: [] })); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await new Promise((resolve) => { const c = spawn(process.execPath, [SCRIPT, f, `http://127.0.0.1:${server.address().port}/`]); let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d)); c.on("close", (code) => resolve({ code, o, e })); });
    assert.equal(out.code, 0);
    assert.equal(seen.method, "POST"); assert.equal(seen.url, "/api/selftest/claude");
    assert.equal(seen.body, JSON.stringify(BODY));
    assert.equal(seen.sig, await signListen(KEY, seen.ts, seen.body));
    assert.ok(!(out.o + out.e).includes(BOT));
    const DB = await schemaDb();
    const req = new Request("https://worker.test/api/selftest/claude", { method: "POST", headers: { "X-Listen-Timestamp": seen.ts, "X-Listen-Signature": seen.sig }, body: seen.body });
    const res = await quiet(() => handleSelftestClaude(req, mkEnv(DB), { call: async () => ({ answer: "ok", model: "m", usage: { input_tokens: 5, output_tokens: 1 } }) }));
    assert.equal(res.status, 200, "the script's request is accepted by the handler");
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
