// THE DEAD-MAN CHECK (POST /api/heartbeat, POST /api/heartbeat/status, the one-minute cron step). Real Worker code over an in-memory SQLite D1; no network; made-up token.
//   gate      flag off = 404 and the cron step does nothing; signature, replay, body and size gates; the listener, self-test and shadow keys are refused.
//   throttle  at most one write per source per 20 s; extras answer 200 recorded:false.
//   check     a stale source opens exactly one incident across repeated cron runs; its heartbeat closes it; a never-seen source opens none unless DEADMAN_EXPECT lists it.
//   safety    a failing check does not break the other cron work; no outbound fetch of any kind.
// Run: node --test tests/unit/deadman.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import http from "node:http";
import worker from "../../infrastructure/worker/index.js";
import { signListen, listenerKey, heartbeatKey, heartbeatStatusKey, shadowKey, resetListenerKeyCacheForTests, resetHeartbeatKeyCacheForTests, heartbeatLabel, HEARTBEAT_STATUS_KEY_LABEL } from "../../infrastructure/worker/listener-config.js";
import { handleHeartbeat, handleHeartbeatStatus, runDeadmanCheck, staleSeconds, expectedSources, parseHeartbeatBody, notifyIncident, HEARTBEAT_ROW, HEARTBEAT_MIN_WRITE_MS } from "../../infrastructure/worker/deadman.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const BOT = ["bot", "token", "for", "deadman", "0123456789"].join("-");
const KEYS = { "pc-bot": await heartbeatKey(BOT, "pc-bot"), "pc-session": await heartbeatKey(BOT, "pc-session") };
const KEY = KEYS["pc-bot"];
const STATUS_KEY = await heartbeatStatusKey(BOT);
const LISTEN_KEY = await listenerKey(BOT);
const hmac = async (token, label) => { const enc = new TextEncoder(); const k = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(label))); };
const SHADOW_KEY = await shadowKey(BOT);

const realFetch = globalThis.fetch;
let fetchCalls = [];
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); return new Response("{}", { status: 599 }); };
test.after(() => { globalThis.fetch = realFetch; });
let tsn = 0; // signed timestamps rise by one second per call inside a test (the Worker refuses a timestamp that is not newer than the last accepted one), all inside the 120 s window
const nextTs = () => Math.floor(Date.now() / 1000) - 110 + tsn++;
test.beforeEach(() => { resetListenerKeyCacheForTests(); resetHeartbeatKeyCacheForTests(); fetchCalls = []; tsn = 0; });

const mkEnv = (DB, extra = {}) => ({ DB, DISCORD_BOT_TOKEN: BOT, DEADMAN: "on", ...extra });
const HB = { purpose: "heartbeat", source: "pc-bot" };
let seq = 0;
async function post(env, path = "/api/heartbeat", obj = HB, { key = path.endsWith("/status") ? STATUS_KEY : (obj && typeof obj.source === "string" && Object.hasOwn(KEYS, obj.source) ? KEYS[obj.source] : KEY), ts = nextTs(), sig = null, raw = null, headers = true } = {}) {
  const body = raw ?? JSON.stringify(obj);
  const h = { "Content-Type": "application/json" };
  if (headers) { h["X-Listen-Timestamp"] = String(ts); h["X-Listen-Signature"] = sig ?? (await signListen(key, String(ts), body)); }
  const res = await worker.fetch(new Request(`https://worker.test${path}`, { method: "POST", headers: h, body }), env, { waitUntil() {} });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const row = (DB) => { const r = DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(HEARTBEAT_ROW); return r ? JSON.parse(r.json) : null; };
const incidents = (DB) => DB.raw.prepare("SELECT * FROM incidents ORDER BY opened_at, id").all();
const seed = (DB, doc) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(HEARTBEAT_ROW, JSON.stringify(doc));
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const at = (ms) => () => new Date(ms);
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

// ---- flag, gate ---------------------------------------------------------------------------------------------------------------------------
test("flag off (unset, off, anything else): both routes answer 404, nothing is read or written, even with a valid signature", async () => {
  for (const DEADMAN of [undefined, "off", "", "true", "1", "ON-ish"]) {
    const DB = await schemaDb();
    const env = mkEnv(DB, { DEADMAN });
    if (DEADMAN === undefined) delete env.DEADMAN;
    assert.equal((await post(env)).status, 404, String(DEADMAN));
    assert.equal((await post(env, "/api/heartbeat/status", { purpose: "heartbeat-status" })).status, 404, String(DEADMAN));
    assert.equal(row(DB), null);
    assert.equal(incidents(DB).length, 0);
  }
});

test("no usable bot token, or a PR preview: 404 (the route does not exist)", async () => {
  const DB = await schemaDb();
  assert.equal((await post(mkEnv(DB, { DISCORD_BOT_TOKEN: "short" }))).status, 404);
  assert.equal((await post(mkEnv(DB, { IS_PR_PREVIEW: "1" }))).status, 404);
});

test("a signed heartbeat is accepted and recorded: lastAt, signed ts, seq, count; the row holds nothing else", async () => {
  const DB = await schemaDb();
  const ts = nextTs();
  const r = await post(mkEnv(DB), "/api/heartbeat", { ...HB, seq: 7 }, { ts });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, recorded: true });
  const doc = row(DB);
  assert.deepEqual(Object.keys(doc), ["pc-bot"]);
  assert.deepEqual(Object.keys(doc["pc-bot"]).sort(), ["count", "lastAt", "seq", "ts"]);
  assert.equal(doc["pc-bot"].seq, 7); assert.equal(doc["pc-bot"].count, 1); assert.equal(doc["pc-bot"].ts, ts);
  assert.equal(doc["pc-bot"].lastAt, ts * 1000, "liveness is the time the PC signed, never later");
  assert.ok(!JSON.stringify(doc).includes(BOT));
});

test("signature gates: missing headers, wrong, stale, future and tampered all 401 and write nothing", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(env, "/api/heartbeat", HB, { headers: false })).status, 401);
  assert.equal((await post(env, "/api/heartbeat", HB, { sig: "0".repeat(64) })).status, 401);
  assert.equal((await post(env, "/api/heartbeat", HB, { ts: now - 121 })).status, 401);
  assert.equal((await post(env, "/api/heartbeat", HB, { ts: now + 121 })).status, 401);
  const ts = now, good = await signListen(KEY, String(ts), JSON.stringify(HB));
  assert.equal((await post(env, "/api/heartbeat", HB, { ts, sig: good, raw: JSON.stringify({ ...HB, source: "pc-session" }) })).status, 401);
  assert.equal((await post(env, "/api/heartbeat", HB, { ts: ts + 1, sig: good })).status, 401);
  assert.equal(row(DB), null);
});

test("cross-key refusal: listener/self-test, shadow, the other source's key and the status key are all 401 on a heartbeat; a heartbeat key is 401 on status", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const status = { purpose: "heartbeat-status" };
  for (const [name, k] of [["listener/self-test", LISTEN_KEY], ["shadow", SHADOW_KEY], ["status key", STATUS_KEY], ["pc-session key", KEYS["pc-session"]]]) {
    assert.equal((await post(env, "/api/heartbeat", HB, { key: k })).status, 401, "pc-bot heartbeat signed with " + name);
  }
  assert.equal((await post(env, "/api/heartbeat", { ...HB, source: "pc-session" }, { key: KEYS["pc-bot"] })).status, 401, "pc-bot key on a pc-session heartbeat");
  assert.equal((await post(env, "/api/heartbeat", { ...HB, source: "pc-session" }, { key: STATUS_KEY })).status, 401);
  for (const [name, k] of [["listener/self-test", LISTEN_KEY], ["shadow", SHADOW_KEY], ["pc-bot", KEYS["pc-bot"]], ["pc-session", KEYS["pc-session"]]]) {
    assert.equal((await post(env, "/api/heartbeat/status", status, { key: k })).status, 401, "status signed with " + name);
  }
  // all keys differ, and each is the documented derivation
  const all = [LISTEN_KEY, SHADOW_KEY, STATUS_KEY, KEYS["pc-bot"], KEYS["pc-session"]].map((k) => Buffer.from(k).toString("hex"));
  assert.equal(new Set(all).size, 5);
  assert.equal(heartbeatLabel("pc-bot"), "leeroy-heartbeat-v1:pc-bot");
  assert.equal(HEARTBEAT_STATUS_KEY_LABEL, "leeroy-heartbeat-status-v1");
  assert.deepEqual([...KEYS["pc-session"]], [...(await hmac(BOT, "leeroy-heartbeat-v1:pc-session"))]);
  assert.deepEqual([...STATUS_KEY], [...(await hmac(BOT, "leeroy-heartbeat-status-v1"))]);
  assert.equal(await heartbeatKey(BOT, ""), null);
  assert.equal(row(DB), null);
  // and the right keys work
  assert.equal((await post(env, "/api/heartbeat", { ...HB, source: "pc-session" })).status, 200);
  assert.equal((await post(env, "/api/heartbeat/status", status)).status, 200);
  // a heartbeat key does not open the other routes either: a heartbeat-signed self-test call is refused
  const body = JSON.stringify({ purpose: "claude-selftest" }), ts = String(Math.floor(Date.now() / 1000));
  const res = await worker.fetch(new Request("https://worker.test/api/selftest/claude", { method: "POST", headers: { "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(KEY, ts, body) }, body }), mkEnv(DB, { ANTHROPIC_API_KEY: "x" }), { waitUntil() {} });
  assert.equal(res.status, 401);
});

test("body gates: a signed body of the wrong shape is 400; a body without a listed source cannot be signed by anyone and is 401", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const shapeBad = [
    { purpose: "claude-selftest", source: "pc-bot" }, { purpose: "heartbeat", source: "pc-bot", extra: 1 }, { purpose: "heartbeat", source: "pc-bot", seq: -1 }, { purpose: "heartbeat", source: "pc-bot", seq: 1.5 },
    { purpose: "heartbeat", source: "pc-bot", seq: "1" }, { purpose: "heartbeat", source: "pc-bot", name: "Red Fox" }, { purpose: "heartbeat-status", source: "pc-bot" },
  ];
  for (const b of shapeBad) assert.equal((await post(env, "/api/heartbeat", b)).status, 400, JSON.stringify(b));
  const unsignable = [
    { purpose: "claude-selftest" }, { purpose: "heartbeat" }, { purpose: "heartbeat", source: "someone" }, { purpose: "heartbeat", source: "__proto__" }, { purpose: "heartbeat-status" },
    ["heartbeat"], "heartbeat", null, 7,
    { id: "100000000000000001", guild_id: "100000000000000002", channel_id: "100000000000000003", author_id: "100000000000000004", kind: "mention", content: "hi" },
  ];
  for (const b of unsignable) assert.equal((await post(env, "/api/heartbeat", b)).status, 401, JSON.stringify(b));
  assert.equal((await post(env, "/api/heartbeat", null, { raw: "{not json" })).status, 401);
  assert.equal(row(DB), null);
  assert.equal(parseHeartbeatBody({ purpose: "heartbeat", source: "pc-session", seq: 0 }).seq, 0);
  assert.equal((await post(env, "/api/heartbeat", { purpose: "heartbeat", source: "pc-session" })).status, 200);
});

test("body over 1 KB: 413 before anything is read, by Content-Length and by streamed size", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const big = JSON.stringify({ ...HB, pad: "x".repeat(1100) });
  assert.equal((await post(env, "/api/heartbeat", null, { raw: big })).status, 413);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await handleHeartbeat(new Request("https://worker.test/api/heartbeat", { method: "POST", headers: { "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(KEY, ts, big) }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }), duplex: "half" }), env);
  assert.equal(res.status, 413);
  assert.equal(row(DB), null);
});

test("replay: the same signed request twice is 409 the second time, and only the first wrote", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const ts = nextTs(), sig = await signListen(KEY, String(ts), JSON.stringify(HB));
  assert.equal((await post(env, "/api/heartbeat", HB, { ts, sig })).status, 200);
  const before = JSON.stringify(row(DB));
  const again = await post(env, "/api/heartbeat", HB, { ts, sig: sig.toUpperCase() }); // case does not make it new
  assert.equal(again.status, 409);
  assert.equal(JSON.stringify(row(DB)), before);
  assert.equal(row(DB)["pc-bot"].count, 1);
});

test("monotonic signed timestamp per source: an equal or older timestamp is 409 and writes nothing; the other source has its own clock", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const t = nextTs();
  assert.equal((await post(env, "/api/heartbeat", HB, { ts: t + 5 })).status, 200);
  const before = JSON.stringify(row(DB));
  for (const old of [t + 5, t + 4, t, t - 5]) assert.equal((await post(env, "/api/heartbeat", HB, { ts: old })).status, 409, String(old - t));
  assert.equal(JSON.stringify(row(DB)), before);
  assert.equal((await post(env, "/api/heartbeat", { ...HB, source: "pc-session" }, { ts: t })).status, 200, "pc-session is not held back by pc-bot's timestamp");
});

test("a captured throttled request cannot advance liveness later: it is 409 once a newer heartbeat was accepted, and a late replay never moves lastAt past the time that was signed", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const send = async (ts, nowMs) => { const body = JSON.stringify(HB); return handleHeartbeat(new Request("https://worker.test/api/heartbeat", { method: "POST", headers: { "X-Listen-Timestamp": String(ts), "X-Listen-Signature": await signListen(KEY, String(ts), body) }, body }), env, { now: at(nowMs) }); };
  const base = Math.floor(Date.now() / 1000) - 100;
  const nowA = base * 1000;
  assert.equal((await (await send(base, nowA)).json()).recorded, true);
  assert.equal((await (await send(base + 5, nowA + 5000)).json()).recorded, false); // throttled: this signed request is "captured"
  assert.equal((await (await send(base + 30, nowA + 30000)).json()).recorded, true);
  assert.equal((await send(base + 5, nowA + 60000)).status, 409, "the captured throttled request, replayed after a newer one, is refused");
  assert.equal(row(DB)["pc-bot"].ts, base + 30);
  // and a late replay of a request nobody accepted before (captured, never delivered) can only record the time it was signed
  const DB2 = await schemaDb();
  const late = base + 40; // signed 60 s ago in real time, delivered now
  const r = await post(mkEnv(DB2), "/api/heartbeat", HB, { ts: late });
  assert.equal(r.status, 200);
  assert.equal(row(DB2)["pc-bot"].lastAt, late * 1000);
  assert.ok(Date.now() - row(DB2)["pc-bot"].lastAt >= 59000, "lastAt is the signed time, not the delivery time");
});

test("throttle: a second heartbeat for the same source inside 20 s is 200 recorded:false and writes nothing; another source records; after 20 s it records", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const send = async (src, nowMs) => { const body = JSON.stringify({ purpose: "heartbeat", source: src }), ts = String(nextTs()); return handleHeartbeat(new Request("https://worker.test/api/heartbeat", { method: "POST", headers: { "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(KEYS[src], ts, body) }, body }), env, { now: at(nowMs) }); };
  assert.deepEqual(await (await send("pc-bot", T0)).json(), { ok: true, recorded: true });
  const after1 = JSON.stringify(row(DB));
  const t = await send("pc-bot", T0 + HEARTBEAT_MIN_WRITE_MS - 1);
  assert.equal(t.status, 200);
  assert.deepEqual(await t.json(), { ok: true, recorded: false });
  assert.equal(JSON.stringify(row(DB)), after1, "a throttled call writes nothing");
  assert.deepEqual(await (await send("pc-session", T0 + 5000)).json(), { ok: true, recorded: true });
  assert.deepEqual(await (await send("pc-bot", T0 + HEARTBEAT_MIN_WRITE_MS)).json(), { ok: true, recorded: true });
  assert.equal(row(DB)["pc-bot"].count, 2);
  assert.equal(HEARTBEAT_MIN_WRITE_MS, 20000);
});

test("the row stays small: two sources, four fields each, no replay list", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  for (let i = 0; i < 40; i++) {
    const src = i % 2 ? "pc-bot" : "pc-session", body = JSON.stringify({ purpose: "heartbeat", source: src, seq: i }), ts = String(nextTs());
    await handleHeartbeat(new Request("https://worker.test/api/heartbeat", { method: "POST", headers: { "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(KEYS[src], ts, body) }, body }), env, { now: at(T0 + i * 21000) });
  }
  assert.deepEqual(Object.keys(row(DB)).sort(), ["pc-bot", "pc-session"]);
  assert.ok(JSON.stringify(row(DB)).length < 400);
});

// ---- cron: staleness and incidents --------------------------------------------------------------------------------------------------------
test("flag off: the cron step is a no-op (no read, no write)", async () => {
  const DB = await schemaDb();
  seed(DB, { "pc-bot": { lastAt: T0 - 99999000, seq: 1, count: 1 } });
  let touched = 0;
  const spy = { ...DB, prepare: (...a) => { touched++; return DB.prepare(...a); }, batch: (...a) => { touched++; return DB.batch(...a); } };
  const r = await runDeadmanCheck({ DB: spy, DEADMAN: "off" }, { now: at(T0) });
  assert.deepEqual(r, { ran: false });
  assert.equal(touched, 0);
  assert.equal(incidents(DB).length, 0);
});

test("a stale source opens exactly ONE incident across repeated cron runs; a fresh one opens none", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  seed(DB, { "pc-bot": { lastAt: T0 - 400000, seq: 9, count: 30 }, "pc-session": { lastAt: T0 - 60000, seq: 3, count: 4 } });
  const first = await quiet(() => runDeadmanCheck(env, { now: at(T0) }));
  assert.equal(first.opened, 1);
  for (let i = 1; i <= 5; i++) assert.equal((await quiet(() => runDeadmanCheck(env, { now: at(T0 + i * 10000) }))).opened, 0);
  const rows = incidents(DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "pc-bot"); assert.equal(rows[0].kind, "stale"); assert.equal(rows[0].closed_at, null);
  assert.equal(rows[0].opened_at, new Date(T0).toISOString());
  assert.equal(rows[0].last_seen_at, new Date(T0 - 400000).toISOString());
  assert.match(rows[0].detail, /^no heartbeat for 400s \(limit 300s\)$/);
});

test("the threshold is strict: exactly DEADMAN_STALE_SECONDS of silence is not stale, one second more is", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  seed(DB, { "pc-bot": { lastAt: T0 - 300000, seq: 1, count: 1 } });
  assert.equal((await runDeadmanCheck(env, { now: at(T0) })).opened, 0);
  assert.equal((await runDeadmanCheck(env, { now: at(T0 + 1000) })).opened, 1);
});

test("a heartbeat for the source closes its open incident; a new silence opens a new one (history kept)", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  seed(DB, { "pc-bot": { lastAt: T0 - 400000, seq: 9, count: 30 } });
  await quiet(() => runDeadmanCheck(env, { now: at(T0) }));
  assert.equal(incidents(DB).filter((r) => r.closed_at === null).length, 1);
  const hb = async (src, nowMs) => { const body = JSON.stringify({ purpose: "heartbeat", source: src }), ts = String(nextTs()); return handleHeartbeat(new Request("https://worker.test/api/heartbeat", { method: "POST", headers: { "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(KEYS[src], ts, body) }, body }), env, { now: at(nowMs) }); };
  assert.equal((await hb("pc-session", T0 + 1000)).status, 200);
  assert.equal(incidents(DB).filter((r) => r.closed_at === null).length, 1, "another source's heartbeat closes nothing");
  assert.equal((await hb("pc-bot", T0 + 2000)).status, 200);
  const closed = incidents(DB);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closed_at, new Date(T0 + 2000).toISOString());
  assert.equal((await quiet(() => runDeadmanCheck(env, { now: at(T0 + 3000) }))).opened, 0);
  const later = T0 + 2000 + 400000;
  assert.equal((await hb("pc-session", later - 5000)).status, 200); // the other source stays alive
  assert.equal((await quiet(() => runDeadmanCheck(env, { now: at(later) }))).opened, 1);
  const all = incidents(DB);
  assert.equal(all.length, 2);
  assert.equal(all.filter((r) => r.closed_at === null).length, 1);
});

test("the database itself refuses a second open incident for a source (unique partial index)", async () => {
  const DB = await schemaDb();
  const ins = (id) => DB.raw.prepare("INSERT INTO incidents (id, source, kind, opened_at) VALUES (?, 'pc-bot', 'stale', 'x')").run(id);
  ins("a");
  assert.throws(() => ins("b"), /UNIQUE/);
  DB.raw.prepare("UPDATE incidents SET closed_at = 'y' WHERE id = 'a'").run();
  ins("c");
});

test("a never-seen source opens no incident; with an empty or no heartbeat row nothing is written", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  assert.equal((await runDeadmanCheck(env, { now: at(T0) })).opened, 0);
  seed(DB, {});
  assert.equal((await runDeadmanCheck(env, { now: at(T0) })).opened, 0);
  assert.equal(incidents(DB).length, 0);
});

test("DEADMAN_EXPECT: a listed source that never sent opens a never_seen incident once; unknown names and unlisted sources do not", async () => {
  const DB = await schemaDb();
  const env = mkEnv(DB, { DEADMAN_EXPECT: " pc-session , nobody,pc-bot " });
  seed(DB, { "pc-bot": { lastAt: T0 - 10000, seq: 1, count: 1 } });
  assert.deepEqual(expectedSources(env), ["pc-session", "pc-bot"]);
  assert.equal((await quiet(() => runDeadmanCheck(env, { now: at(T0) }))).opened, 1);
  assert.equal((await quiet(() => runDeadmanCheck(env, { now: at(T0 + 60000) }))).opened, 0);
  const rows = incidents(DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "pc-session"); assert.equal(rows[0].kind, "never_seen"); assert.equal(rows[0].last_seen_at, null);
  assert.ok(!rows.some((r) => r.source === "nobody"));
});

test("DEADMAN_STALE_SECONDS: default 300, clamped to 120..3600, junk reads as the default", async () => {
  const cases = [[undefined, 300], ["", 300], ["abc", 300], ["-5", 300], ["1e3", 300], [{}, 300], ["300", 300], ["10", 120], ["0", 120], ["119", 120], ["120", 120], ["600", 600], ["3600", 3600], ["99999", 3600], [900, 900], [5, 120]];
  for (const [v, want] of cases) assert.equal(staleSeconds({ DEADMAN_STALE_SECONDS: v }), want, String(v));
  const DB = await schemaDb();
  seed(DB, { "pc-bot": { lastAt: T0 - 200000, seq: 1, count: 1 } }); // 200 s: stale at 120 (a "10" is clamped up to 120), fresh at 600
  assert.equal((await runDeadmanCheck(mkEnv(DB, { DEADMAN_STALE_SECONDS: "600" }), { now: at(T0) })).opened, 0);
  assert.equal((await quiet(() => runDeadmanCheck(mkEnv(DB, { DEADMAN_STALE_SECONDS: "10" }), { now: at(T0) }))).opened, 1);
  assert.match(incidents(DB)[0].detail, /limit 120s/);
});

test("budget: a quiet tick is one read and no write; a stale tick with an open incident is one read plus one batch of inserts that write nothing", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  const calls = [];
  const spy = { ...DB, prepare: (sql) => { calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" ")); return DB.prepare(sql); }, batch: (l) => { calls.push(`BATCH x${l.length}`); return DB.batch(l); } };
  seed(DB, { "pc-bot": { lastAt: T0 - 10000, seq: 1, count: 1 }, "pc-session": { lastAt: T0 - 10000, seq: 1, count: 1 } });
  await runDeadmanCheck({ ...env, DB: spy }, { now: at(T0) });
  assert.deepEqual(calls, ["SELECT json FROM"]);
  calls.length = 0;
  seed(DB, { "pc-bot": { lastAt: T0 - 999000, seq: 1, count: 1 }, "pc-session": { lastAt: T0 - 999000, seq: 1, count: 1 } });
  await quiet(() => runDeadmanCheck({ ...env, DB: spy }, { now: at(T0) }));
  assert.equal(calls.filter((c) => c.startsWith("BATCH")).length, 1);
  assert.equal(calls.filter((c) => c.startsWith("SELECT json")).length, 1);
  assert.equal(incidents(DB).length, 2);
});

test("before migration 0015 (no incidents table): the check does not throw, and the heartbeat route still records", async () => {
  const DB = await schemaDb();
  DB.raw.exec("DROP TABLE incidents");
  const env = mkEnv(DB);
  seed(DB, { "pc-bot": { lastAt: T0 - 999000, seq: 1, count: 1 } });
  const r = await quiet(() => runDeadmanCheck(env, { now: at(T0) }));
  assert.equal(r.error, true);
  assert.equal((await post(env)).status, 200);
  assert.equal(row(DB)["pc-bot"].count, 2);
  const st = await post(env, "/api/heartbeat/status", { purpose: "heartbeat-status" });
  assert.equal(st.status, 503, "no incidents table: the status route says unavailable, never an empty list"); assert.equal(st.json.openIncidents, undefined);
});

// ---- cron wiring ---------------------------------------------------------------------------------------------------------------------------
async function runCron(env) {
  const pending = [];
  await quiet(async () => { await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => pending.push(Promise.resolve(p)) }); });
  const settled = await quiet(() => Promise.allSettled(pending));
  return { calls: pending.length, settled };
}

test("the every-minute trigger runs the check when DEADMAN is on and adds nothing when it is off; the six-hour trigger never runs it", async () => {
  const DB = await schemaDb();
  seed(DB, { "pc-bot": { lastAt: Date.now() - 999000, seq: 1, count: 1 } });
  const off = await runCron({ DB, DISCORD_BOT_TOKEN: BOT });
  assert.equal(incidents(DB).length, 0);
  const on = await runCron(mkEnv(DB));
  assert.equal(on.calls, off.calls + 1);
  assert.ok(on.settled.every((s) => s.status === "fulfilled"));
  assert.equal(incidents(DB).length, 1);
  const six = []; await quiet(async () => { await worker.scheduled({ cron: "0 */6 * * *" }, mkEnv(await schemaDb()), { waitUntil: (p) => six.push(Promise.resolve(p).catch(() => {})) }); await Promise.all(six); });
  assert.equal(incidents(DB).length, 1);
});

test("a failing check does not break the other cron work: the other steps still run and settle, nothing rejects or throws", async () => {
  const DB = await schemaDb();
  const base = await runCron(mkEnv(DB, { DEADMAN: "off" }));
  for (const mode of ["rejects", "throws-sync", "bad-json"]) {
    const broken = { ...DB, prepare: (sql) => {
      if (/FROM kv_state WHERE key = \?/.test(sql)) {
        const stmt = DB.prepare(sql), bind = stmt.bind;
        stmt.bind = (...a) => { if (a[0] === HEARTBEAT_ROW) { if (mode === "throws-sync") throw new Error("boom"); if (mode === "bad-json") return { first: async () => ({ json: "{not json" }) }; return { first: async () => { throw new Error("D1 is having a bad day"); } }; } return bind(...a); };
        return stmt;
      }
      return DB.prepare(sql);
    } };
    const r = await runCron(mkEnv(broken));
    assert.equal(r.calls, base.calls + 1, mode);
    assert.ok(r.settled.every((s) => s.status === "fulfilled"), mode);
  }
  // and when the step itself is replaced by one that throws synchronously at the dispatch, the scheduled handler still returns
  await assert.doesNotReject(runCron({ get DEADMAN() { throw new Error("env getter"); }, DB, DISCORD_BOT_TOKEN: BOT }));
});

// ---- status route --------------------------------------------------------------------------------------------------------------------------
test("status: signed read returns only sources, ages in seconds, seq/count and incident ids and timestamps", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  assert.equal((await post(env, "/api/heartbeat", { ...HB, seq: 4 }, { ts: Math.floor(Date.now() / 1000) - 1 })).status, 200);
  seed(DB, { ...row(DB), "pc-session": { lastAt: Date.now() - 400000, seq: 2, count: 9 } });
  await quiet(() => runDeadmanCheck(env, { now: () => new Date() }));
  const r = await post(env, "/api/heartbeat/status", { purpose: "heartbeat-status" });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["ok", "openIncidents", "sources", "staleSeconds"]);
  assert.deepEqual(r.json.sources.map((s) => s.source), ["pc-bot", "pc-session"]);
  assert.deepEqual(Object.keys(r.json.sources[0]).sort(), ["ageSeconds", "count", "seq", "source"]);
  assert.ok(r.json.sources[0].ageSeconds <= 5); assert.ok(r.json.sources[1].ageSeconds >= 399);
  assert.equal(r.json.openIncidents.length, 1);
  assert.deepEqual(Object.keys(r.json.openIncidents[0]).sort(), ["id", "kind", "lastSeenAt", "openedAt", "source"]);
  assert.ok(!r.text.includes("_seen")); assert.ok(!r.text.includes(BOT));
});

test("status: gates (404 off, 401 wrong key or signature, 400 any other body incl. a heartbeat body)", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  assert.equal((await post(mkEnv(DB, { DEADMAN: "off" }), "/api/heartbeat/status", { purpose: "heartbeat-status" })).status, 404);
  assert.equal((await post(env, "/api/heartbeat/status", { purpose: "heartbeat-status" }, { sig: "0".repeat(64) })).status, 401);
  for (const b of [HB, { purpose: "heartbeat-status", extra: 1 }, {}, []]) assert.equal((await post(env, "/api/heartbeat/status", b)).status, 400, JSON.stringify(b));
  assert.equal(row(DB), null, "status never writes");
});

// ---- nothing is sent -----------------------------------------------------------------------------------------------------------------------
test("no outbound fetch of any kind: not on heartbeat, status, replay, throttle, an opened incident, a closed one, or the cron", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  await post(env); await post(env); await post(env, "/api/heartbeat/status", { purpose: "heartbeat-status" });
  seed(DB, { "pc-bot": { lastAt: T0 - 999000, seq: 1, count: 1 } });
  await quiet(() => runDeadmanCheck(env, { now: at(T0) }));
  await runCron(env);
  await post(env);
  assert.equal(fetchCalls.length, 0, fetchCalls.join(","));
});

test("notifyIncident is a stub: returns nothing, throws nothing, sends nothing; deadman.js has no network or Discord code", async () => {
  assert.equal(notifyIncident({}, { id: "x", source: "pc-bot", kind: "stale", openedAt: "t" }), undefined);
  assert.equal(fetchCalls.length, 0);
  const src = readFileSync(new URL("../../infrastructure/worker/deadman.js", import.meta.url), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest|WebSocket|sendBeacon/, /from "\.\/(discord|announce|discord-safety)\.js"/, /\bwebhook/i, /api\/webhooks|discord\.com/i]) assert.ok(!bad.test(code), String(bad));
  assert.match(src, /DEADMAN_ALERT/);
});

test("the data map, schema and migration agree: incidents is in schema.sql and in migration 0015 with the same columns and indexes", () => {
  const schema = readFileSync(new URL("../../infrastructure/schema.sql", import.meta.url), "utf8");
  const mig = readFileSync(new URL("../../infrastructure/migrations/0015_incidents.sql", import.meta.url), "utf8");
  const norm = (s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ");
  const stmts = (s) => norm(s).match(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS[^;]+;/g).filter((x) => /incidents/.test(x)).sort();
  assert.deepEqual(stmts(schema), stmts(mig));
  assert.equal(stmts(mig).length, 3);
});

// ---- the tools -----------------------------------------------------------------------------------------------------------------------------
const SEND = fileURLToPath(new URL("../../tools/heartbeat-send.mjs", import.meta.url));
const STATUS = fileURLToPath(new URL("../../tools/deadman-status.mjs", import.meta.url));
const tokenFile = () => { const dir = mkdtempSync(join(tmpdir(), "deadman-")); const f = join(dir, "t"); writeFileSync(f, BOT + "\n"); return { f, dir }; };
const run = (args, opts = {}) => new Promise((resolve) => { const c = spawn(process.execPath, args, opts); let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d)); c.on("close", (code) => resolve({ code, o, e })); });

test("tools refuse a non-https base URL, a bad --source or --loop, and print no token", () => {
  const { f, dir } = tokenFile();
  try {
    for (const url of ["http://api.example.test", "http://evil.test:8787", "ftp://api.example.test", "https://user:pw@api.example.test", "http://localhost.evil.test", "not a url", "file:///etc/passwd"]) {
      const a = spawnSync(process.execPath, [SEND, f, "--base", url], { encoding: "utf8", timeout: 20000 });
      assert.equal(a.status, 2, url); assert.match(a.stderr, /refusing/, url);
      const b = spawnSync(process.execPath, [STATUS, f, url], { encoding: "utf8", timeout: 20000 });
      assert.equal(b.status, 2, url); assert.match(b.stderr, /refusing/, url);
      for (const r of [a, b]) assert.ok(!(r.stdout + r.stderr).includes(BOT));
    }
    for (const args of [["--source", "evil"], ["--loop", "5"], ["--loop", "abc"], ["--loop", "99999"], ["--seq", "-1"], ["--nope", "1"]]) {
      const r = spawnSync(process.execPath, [SEND, f, ...args], { encoding: "utf8", timeout: 20000 });
      assert.equal(r.status, 2, args.join(" ")); assert.ok(!(r.stdout + r.stderr).includes(BOT));
    }
    assert.equal(spawnSync(process.execPath, [SEND], { encoding: "utf8" }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat-send sends exactly the heartbeat body, signed so the Worker accepts it, does not follow a redirect, and prints status only", async () => {
  const { f, dir } = tokenFile();
  const seen = [];
  let redirect = false;
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seen.push({ url: req.url, method: req.method, body: b, ts: req.headers["x-listen-timestamp"], sig: req.headers["x-listen-signature"] });
      if (redirect) { res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/elsewhere` }); res.end(); return; }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, recorded: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const out = await run([SEND, f, "--source", "pc-session", "--base", base, "--seq", "41"]);
    assert.equal(out.code, 0);
    assert.equal(seen[0].method, "POST"); assert.equal(seen[0].url, "/api/heartbeat");
    assert.equal(seen[0].body, JSON.stringify({ purpose: "heartbeat", source: "pc-session", seq: 41 }));
    assert.equal(seen[0].sig, await signListen(KEYS["pc-session"], seen[0].ts, seen[0].body));
    assert.match(out.o, /heartbeat pc-session status=200 recorded=yes/);
    assert.ok(!(out.o + out.e).includes(BOT));
    const DB = await schemaDb();
    const res = await handleHeartbeat(new Request("https://worker.test/api/heartbeat", { method: "POST", headers: { "X-Listen-Timestamp": seen[0].ts, "X-Listen-Signature": seen[0].sig }, body: seen[0].body }), mkEnv(DB));
    assert.equal(res.status, 200, "the tool's request is accepted by the handler");
    redirect = true; seen.length = 0;
    const r2 = await run([SEND, f, "--base", base]);
    assert.equal(r2.code, 1);
    assert.equal(seen.length, 1, "the redirect is not followed");
    assert.match(r2.o, /request failed/);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat-send --loop sends repeatedly with a rising seq (stopped by the test)", async () => {
  const { f, dir } = tokenFile();
  const seen = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push(JSON.parse(b)); res.end(JSON.stringify({ ok: true, recorded: true })); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = spawn(process.execPath, [SEND, f, "--base", `http://127.0.0.1:${server.address().port}`, "--loop", "20"]);
  try {
    for (let i = 0; i < 60 && seen.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length >= 1, true);
    assert.deepEqual(seen[0], { purpose: "heartbeat", source: "pc-bot", seq: 0 });
  } finally { c.kill(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("deadman-status prints the Worker's answer, signed with the status purpose", async () => {
  const { f, dir } = tokenFile();
  let seen = null;
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen = { url: req.url, body: b, ts: req.headers["x-listen-timestamp"], sig: req.headers["x-listen-signature"] }; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, staleSeconds: 300, sources: [], openIncidents: [] })); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await run([STATUS, f, `http://127.0.0.1:${server.address().port}/`]);
    assert.equal(out.code, 0);
    assert.equal(seen.url, "/api/heartbeat/status");
    assert.equal(seen.body, JSON.stringify({ purpose: "heartbeat-status" }));
    assert.equal(seen.sig, await signListen(STATUS_KEY, seen.ts, seen.body));
    assert.equal(JSON.parse(out.o).openIncidents.length, 0);
    assert.ok(!(out.o + out.e).includes(BOT));
    const DB = await schemaDb();
    const res = await handleHeartbeatStatus(new Request("https://worker.test/api/heartbeat/status", { method: "POST", headers: { "X-Listen-Timestamp": seen.ts, "X-Listen-Signature": seen.sig }, body: seen.body }), mkEnv(DB));
    assert.equal(res.status, 200);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---- review fixes: atomic open, close failures, status failures, preview gate ------------------------------------------------------------------
// A D1 wrapper: beforeBatch runs once, after the cron has READ its snapshot and just before its insert (the interleaving the review found); failOn makes matching statements throw (times: how often, default always).
function wrapDB(DB, { beforeBatch = null, failOn = null, times = Infinity } = {}) {
  let hook = beforeBatch, left = times;
  return {
    ...DB,
    prepare: (sql) => {
      if (failOn && failOn.test(sql) && left > 0) { left--; const boom = async () => { throw new Error("D1 is having a bad day"); }; return { bind: () => ({ run: boom, all: boom, first: boom }), run: boom, all: boom, first: boom }; }
      return DB.prepare(sql);
    },
    batch: async (l) => { if (hook) { const h = hook; hook = null; await h(); } return DB.batch(l); },
  };
}
const sendHb = async (env, src, nowMs, ts = nextTs()) => { const body = JSON.stringify({ purpose: "heartbeat", source: src }); return handleHeartbeat(new Request("https://worker.test/api/heartbeat", { method: "POST", headers: { "X-Listen-Timestamp": String(ts), "X-Listen-Signature": await signListen(KEYS[src], String(ts), body) }, body }), env, { now: at(nowMs) }); };

test("RACE: a heartbeat committed between the cron's read and its insert wins; no incident opens", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  seed(DB, { "pc-bot": { lastAt: T0 - 400000, ts: 1, seq: 1, count: 1 } });
  const racing = mkEnv(wrapDB(DB, { beforeBatch: async () => { assert.equal((await sendHb(env, "pc-bot", T0 - 500)).status, 200); } }));
  const r = await quiet(() => runDeadmanCheck(racing, { now: at(T0) }));
  assert.equal(r.opened, 0);
  assert.equal(incidents(DB).length, 0);
  assert.ok(row(DB)["pc-bot"].lastAt >= T0 - 500);
});

test("RACE: a never_seen snapshot loses to a first heartbeat that lands before the insert", async () => {
  const DB = await schemaDb(), env = mkEnv(DB, { DEADMAN_EXPECT: "pc-session" });
  const racing = { ...env, DB: wrapDB(DB, { beforeBatch: async () => { assert.equal((await sendHb(env, "pc-session", T0 - 100)).status, 200); } }) };
  assert.equal((await quiet(() => runDeadmanCheck(racing, { now: at(T0) }))).opened, 0);
  assert.equal(incidents(DB).length, 0);
});

test("RACE: an overlapping cron run with an old snapshot must not reopen an incident that a heartbeat just closed", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  seed(DB, { "pc-bot": { lastAt: T0 - 400000, ts: 1, seq: 1, count: 1 } });
  assert.equal((await quiet(() => runDeadmanCheck(env, { now: at(T0) }))).opened, 1); // run A opens it
  const overlapping = mkEnv(wrapDB(DB, { beforeBatch: async () => { assert.equal((await sendHb(env, "pc-bot", T0 + 1000)).status, 200); } })); // run B read the stale row; now the heartbeat lands and closes A's incident
  assert.equal((await quiet(() => runDeadmanCheck(overlapping, { now: at(T0 + 500) }))).opened, 0);
  const rows = incidents(DB);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].closed_at, null, "closed by the heartbeat and not reopened");
  assert.equal(rows.filter((r) => r.closed_at === null).length, 0);
});

test("the insert itself carries the freshness check: with a fresh heartbeat row and a stale snapshot passed in, nothing is inserted (statement-level, no cron read needed)", async () => {
  const DB = await schemaDb();
  seed(DB, { "pc-bot": { lastAt: T0 - 1000, ts: 1, seq: 1, count: 1 } });
  const captured = [];
  const spy = { ...DB, prepare: (sql) => { const st = DB.prepare(sql); if (/INSERT OR IGNORE INTO incidents/.test(sql)) captured.push(sql); return st; } };
  seed(DB, { "pc-bot": { lastAt: T0 - 999000, ts: 1, seq: 1, count: 1 } });
  await quiet(() => runDeadmanCheck(mkEnv(spy), { now: at(T0) }));
  assert.equal(captured.length, 1);
  assert.match(captured[0], /json_extract\(json, \?\)/);
  assert.match(captured[0], /NOT EXISTS \(SELECT 1 FROM incidents WHERE source = \? AND closed_at IS NULL\)/);
});

test("closing the open incident fails: the heartbeat answers 503 (not success), and the sender's next call closes it", async () => {
  const DB = await schemaDb(), env = mkEnv(DB);
  DB.raw.prepare("INSERT INTO incidents (id, source, kind, opened_at, last_seen_at) VALUES ('i1', 'pc-bot', 'stale', 'x', 'y')").run();
  const broken = mkEnv(wrapDB(DB, { failOn: /UPDATE incidents/, times: 1 }));
  const first = await sendHb(broken, "pc-bot", T0);
  assert.equal(first.status, 503);
  assert.equal(DB.raw.prepare("SELECT closed_at FROM incidents WHERE id = 'i1'").get().closed_at, null, "still open");
  const retry = await sendHb(broken, "pc-bot", T0 + 2000); // a new signature a few seconds later: inside the 20 s write throttle, and it still closes
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { ok: true, recorded: false });
  assert.notEqual(DB.raw.prepare("SELECT closed_at FROM incidents WHERE id = 'i1'").get().closed_at, null, "closed by the retry");
  assert.ok(env);
});

test("status: an incident query failure is 503, never an empty list; a heartbeat-row read failure is 503 too", async () => {
  const DB = await schemaDb();
  DB.raw.prepare("INSERT INTO incidents (id, source, kind, opened_at) VALUES ('i1', 'pc-bot', 'stale', 'x')").run();
  const ok = await post(mkEnv(DB), "/api/heartbeat/status", { purpose: "heartbeat-status" });
  assert.equal(ok.status, 200); assert.equal(ok.json.openIncidents.length, 1);
  for (const failOn of [/FROM incidents/, /FROM kv_state/]) {
    const r = await post(mkEnv(wrapDB(DB, { failOn })), "/api/heartbeat/status", { purpose: "heartbeat-status" });
    assert.equal(r.status, 503, String(failOn));
    assert.equal(r.json.openIncidents, undefined);
  }
});

test("the cron helper has the same preview gate as the routes: in a PR preview it does nothing and touches nothing", async () => {
  const DB = await schemaDb();
  seed(DB, { "pc-bot": { lastAt: T0 - 999000, ts: 1, seq: 1, count: 1 } });
  let touched = 0;
  const spy = { ...DB, prepare: (...a) => { touched++; return DB.prepare(...a); }, batch: (...a) => { touched++; return DB.batch(...a); } };
  assert.deepEqual(await runDeadmanCheck({ DB: spy, DISCORD_BOT_TOKEN: BOT, DEADMAN: "on", IS_PR_PREVIEW: "1" }, { now: at(T0) }), { ran: false });
  assert.equal(touched, 0);
  assert.equal(incidents(DB).length, 0);
  assert.equal((await quiet(() => runDeadmanCheck(mkEnv(DB), { now: at(T0) }))).opened, 1, "the same env outside a preview does open it");
});
