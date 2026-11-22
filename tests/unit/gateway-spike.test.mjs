// Pure parts of tools/gateway-spike (throwaway Discord gateway spike): heartbeat jitter, resume vs identify, close codes, counters, redaction. Fake socket, fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GatewayMachine, classifyClose, firstHeartbeatDelay, decideConnect, identifyAllowed, gatewayUrl, newCounters, bump, ackRatio, awakeSeconds, gbSeconds,
  foldPreviousInstance, redactedStatus, INTENTS, PREDICTED_GBS_PER_HOUR, MAX_IDENTIFIES_PER_HOUR,
} from "../../tools/gateway-spike/src/state.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function rig({ stored = null, remaining = 900, rands = [] } = {}) {
  let t = 1_000_000;
  const timers = new Map(); let nextId = 1;
  const sockets = []; const logs = [];
  let storeObj = stored;
  const r = [...rands];
  const deps = {
    token: "TEST-TOKEN-NOT-REAL",
    store: { get: () => storeObj, set: (o) => { storeObj = JSON.parse(JSON.stringify(o)); } },
    now: () => t, rand: () => (r.length ? r.shift() : 0.5),
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    connect: (url, h) => { const s = { url, sent: [], closed: null, h, send(x) { this.sent.push(JSON.parse(x)); }, close(c) { this.closed = c; } }; sockets.push(s); return s; },
    fetchGatewayInfo: async () => ({ url: "wss://gateway.example.test", session_start_limit: { total: 1000, remaining, reset_after: 1, max_concurrency: 1 } }),
    log: (m) => logs.push(m),
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); t = due[1].at; due[1].fn();
    }
    t = end;
  };
  const m = new GatewayMachine(deps);
  const feed = (s, op, d, extra = {}) => s.h.onMessage(JSON.stringify({ op, d, ...extra }));
  return { m, deps, sockets, timers, advance, feed, logs, get store() { return storeObj; }, get t() { return t; } };
}

const ready = (rg, s, seq = 1) => rg.feed(s, 0, { session_id: "sess-1", resume_gateway_url: "wss://resume.example.test" }, { t: "READY", s: seq });

test("firstHeartbeatDelay stays inside 0..interval and clamps", () => {
  assert.equal(firstHeartbeatDelay(41250, () => 0), 0);
  assert.equal(firstHeartbeatDelay(41250, () => 0.5), 20625);
  assert.ok(firstHeartbeatDelay(41250, () => 0.999999) < 41250);
  assert.equal(firstHeartbeatDelay(41250, () => 7), 41250);
  assert.equal(firstHeartbeatDelay(41250, () => -3), 0);
});

test("classifyClose follows the Discord close-code table", () => {
  for (const c of [4004, 4010, 4011, 4012, 4013, 4014]) assert.equal(classifyClose(c), "fatal", String(c));
  for (const c of [4000, 4001, 4002, 4005, 4008]) assert.equal(classifyClose(c), "resume", String(c));
  for (const c of [4003, 4007, 4009]) assert.equal(classifyClose(c), "identify", String(c));
  for (const c of [1000, 1001]) assert.equal(classifyClose(c), "identify", String(c));
  for (const c of [1006, 1005, undefined, null]) assert.equal(classifyClose(c), "resume", String(c));
});

test("decideConnect resumes only with session id, resume url and an integer seq", () => {
  assert.equal(decideConnect(null), "identify");
  assert.equal(decideConnect({ sessionId: "a", resumeUrl: "wss://x", seq: 0 }), "resume");
  assert.equal(decideConnect({ sessionId: "a", resumeUrl: "wss://x", seq: null }), "identify");
  assert.equal(decideConnect({ sessionId: "a", seq: 5 }), "identify");
});

test("identifyAllowed: local hourly cap and session_start_limit floor", () => {
  const now = 10_000_000;
  assert.equal(identifyAllowed([], now, 900).ok, true);
  const many = Array.from({ length: MAX_IDENTIFIES_PER_HOUR }, (_, i) => now - 1000 * i);
  assert.equal(identifyAllowed(many, now, 900).ok, false);
  assert.equal(identifyAllowed([now - 3_700_000], now, 900).ok, true);
  assert.equal(identifyAllowed([], now, 2).ok, false);
});

test("gatewayUrl and intents", () => {
  assert.equal(gatewayUrl("wss://gateway.example.test/"), "wss://gateway.example.test/?v=10&encoding=json");
  assert.equal(INTENTS, (1 << 0) | (1 << 9));
  assert.equal(INTENTS & (1 << 15), 0, "no MESSAGE_CONTENT");
  assert.equal(INTENTS & (1 << 1), 0, "no GUILD_MEMBERS");
  assert.equal(INTENTS & (1 << 8), 0, "no GUILD_PRESENCES");
});

test("counter math, duration math", () => {
  const c = newCounters();
  bump(c, "heartbeatsSent"); bump(c, "heartbeatsSent"); bump(c, "heartbeatsSent"); bump(c, "heartbeatsSent"); bump(c, "acks"); bump(c, "acks"); bump(c, "acks");
  bump(c, "closeCodes", "4000"); bump(c, "closeCodes", "4000");
  assert.equal(ackRatio(c), 0.75);
  assert.equal(c.closeCodes["4000"], 2);
  assert.equal(ackRatio(newCounters()), null);
  assert.equal(PREDICTED_GBS_PER_HOUR, 450);
  assert.equal(gbSeconds(3600), 450);
  assert.equal(awakeSeconds(100, { bootAt: 1000 }, 11000), 110);
  const f = foldPreviousInstance(50, { bootAt: 0, lastSeen: 20000 }, 100000);
  assert.deepEqual(f, { accumS: 70, evictedAfterS: 20, gapS: 80 });
  assert.equal(foldPreviousInstance(5, null, 1).accumS, 5);
});

test("redactedStatus never carries token or session id", () => {
  const out = JSON.stringify(redactedStatus({ mode: "resume", phase: "ready", sessionId: "SESSION-SECRET", resumeUrl: "wss://r", token: "TOKEN-SECRET", seq: 9, counters: newCounters() }));
  assert.ok(!out.includes("SESSION-SECRET"));
  assert.ok(!out.includes("TOKEN-SECRET"));
  assert.ok(!out.includes("wss://r"));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hasSession, true);
  assert.equal(parsed.seq, 9);
});

test("fresh start: IDENTIFY with intents 513, first heartbeat inside jitter bound, READY stores session", async () => {
  const rg = rig({ rands: [0.25] });
  await rg.m.start();
  assert.equal(rg.sockets.length, 1);
  assert.equal(rg.sockets[0].url, "wss://gateway.example.test/?v=10&encoding=json");
  rg.feed(rg.sockets[0], 10, { heartbeat_interval: 40000 });
  const id = rg.sockets[0].sent[0];
  assert.equal(id.op, 2);
  assert.equal(id.d.intents, 513);
  assert.equal(id.d.token, "TEST-TOKEN-NOT-REAL");
  assert.equal(rg.m.counters.identifies, 1);
  rg.advance(9999); assert.equal(rg.m.counters.heartbeatsSent, 0);
  rg.advance(2); assert.equal(rg.m.counters.heartbeatsSent, 1); // 0.25 x 40000 = 10000
  ready(rg, rg.sockets[0]);
  assert.equal(rg.m.counters.readys, 1);
  assert.equal(rg.store.sessionId, "sess-1");
  assert.equal(rg.store.resumeUrl, "wss://resume.example.test");
  assert.equal(rg.store.seq, 1);
});

test("heartbeat ACK ratio over several beats, then a missed ACK closes with 4000 (zombie)", async () => {
  const rg = rig({ rands: [0] });
  await rg.m.start(); const s = rg.sockets[0];
  rg.feed(s, 10, { heartbeat_interval: 1000 }); ready(rg, s);
  rg.advance(0); rg.feed(s, 11); // jitter 0: first beat at once
  for (let i = 0; i < 3; i++) { rg.advance(1000); rg.feed(s, 11); }
  assert.equal(rg.m.counters.heartbeatsSent, 4);
  assert.equal(rg.m.counters.acks, 4);
  assert.equal(ackRatio(rg.m.counters), 1);
  rg.advance(1000); // fifth heartbeat, no ACK
  rg.advance(1000); // next tick finds no ACK: zombie
  assert.equal(rg.m.counters.zombies, 1);
  assert.equal(s.closed, 4000);
  assert.equal(ackRatio(rg.m.counters), 0.8);
});

test("server heartbeat request (op 1) answers immediately with the last seq", async () => {
  const rg = rig(); await rg.m.start(); const s = rg.sockets[0];
  rg.feed(s, 10, { heartbeat_interval: 40000 }); ready(rg, s, 7);
  rg.feed(s, 1, null);
  const last = s.sent[s.sent.length - 1];
  assert.deepEqual(last, { op: 1, d: 7 });
  assert.equal(rg.m.counters.heartbeatRequests, 1);
});

test("forced 4000 close then reconnect sends RESUME (op 6) with stored state and no second IDENTIFY", async () => {
  const rg = rig(); await rg.m.start(); const s1 = rg.sockets[0];
  rg.feed(s1, 10, { heartbeat_interval: 40000 }); ready(rg, s1, 1);
  rg.feed(s1, 0, { x: 1 }, { t: "MESSAGE_CREATE", s: 2 });
  assert.equal(rg.m.forceClose(4000), true);
  s1.h.onClose(4000);
  assert.equal(rg.m.counters.closeCodes["4000"], 1);
  assert.equal(rg.store.sessionId, "sess-1");
  rg.advance(5000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(rg.sockets.length, 2);
  const s2 = rg.sockets[1];
  assert.equal(s2.url, "wss://resume.example.test/?v=10&encoding=json");
  rg.feed(s2, 10, { heartbeat_interval: 40000 });
  assert.deepEqual(s2.sent[0], { op: 6, d: { token: "TEST-TOKEN-NOT-REAL", session_id: "sess-1", seq: 2 } });
  assert.equal(rg.m.counters.identifies, 1);
  assert.equal(rg.m.counters.resumes, 1);
  rg.feed(s2, 0, {}, { t: "RESUMED", s: 3 });
  assert.equal(rg.m.counters.resumed, 1);
  assert.equal(rg.m.counters.reconnects, 1);
});

test("op 9 false clears the session and the next connect identifies; op 9 true keeps it", async () => {
  const rg = rig(); await rg.m.start(); const s1 = rg.sockets[0];
  rg.feed(s1, 10, { heartbeat_interval: 40000 }); ready(rg, s1);
  rg.feed(s1, 9, true);
  assert.equal(s1.closed, 4000); assert.equal(rg.store.sessionId, "sess-1");
  s1.h.onClose(4000); rg.advance(5000); await Promise.resolve(); await Promise.resolve();
  const s2 = rg.sockets[1]; rg.feed(s2, 10, { heartbeat_interval: 40000 }); assert.equal(s2.sent[0].op, 6);
  rg.feed(s2, 9, false);
  assert.equal(rg.store.sessionId, null);
  s2.h.onClose(4000); rg.advance(10000); await Promise.resolve(); await Promise.resolve();
  const s3 = rg.sockets[2]; rg.feed(s3, 10, { heartbeat_interval: 40000 });
  assert.equal(s3.sent[0].op, 2);
});

test("fatal close code halts: no reconnect", async () => {
  const rg = rig(); await rg.m.start(); const s = rg.sockets[0];
  rg.feed(s, 10, { heartbeat_interval: 40000 });
  s.h.onClose(4014);
  assert.equal(rg.m.phase, "halted");
  rg.advance(120000); await Promise.resolve();
  assert.equal(rg.sockets.length, 1);
  assert.equal(rg.m.watchdog(), "halted");
});

test("close 1000 invalidates the stored session (next connect identifies)", async () => {
  const rg = rig(); await rg.m.start(); const s = rg.sockets[0];
  rg.feed(s, 10, { heartbeat_interval: 40000 }); ready(rg, s);
  s.h.onClose(1000);
  assert.equal(rg.store.sessionId, null);
});

test("identify circuit breaker: refuses when session_start_limit.remaining is low", async () => {
  const rg = rig({ remaining: 1 });
  await rg.m.start();
  assert.equal(rg.sockets.length, 0);
  assert.equal(rg.m.phase, "halted");
  assert.match(rg.m.lastError, /remaining=1/);
});

test("stale callbacks from an old socket are ignored", async () => {
  const rg = rig(); await rg.m.start(); const s1 = rg.sockets[0];
  rg.feed(s1, 10, { heartbeat_interval: 40000 }); ready(rg, s1);
  s1.h.onClose(1006); rg.advance(5000); await Promise.resolve(); await Promise.resolve();
  const before = rg.m.counters.events;
  rg.feed(s1, 0, {}, { t: "MESSAGE_CREATE", s: 99 });
  assert.equal(rg.m.counters.events, before);
  assert.notEqual(rg.m.state.seq, 99);
});

test("watchdog starts an idle machine (cold start) and closes a stale-ACK socket", async () => {
  const rg = rig({ stored: { sessionId: "s", resumeUrl: "wss://resume.example.test", seq: 4, identifyTimes: [] } });
  assert.equal(rg.m.watchdog(), "start");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(rg.sockets.length, 1);
  assert.equal(rg.sockets[0].url, "wss://resume.example.test/?v=10&encoding=json");
  const s = rg.sockets[0]; rg.feed(s, 10, { heartbeat_interval: 1000 }); rg.feed(s, 11);
  assert.equal(rg.m.watchdog(), "ok");
  rg.m.lastAckAt = rg.t - 5000; // last ACK older than 2.5 intervals
  assert.equal(rg.m.watchdog(), "zombie-close");
  assert.equal(s.closed, 4000);
});

test("harness: spike stays out of the production worker and the pages bundle", () => {
  const prod = fs.readFileSync(path.join(ROOT, "infrastructure/wrangler.toml"), "utf8");
  assert.ok(!/gateway-spike|GatewayDO/.test(prod));
  const bundle = fs.readFileSync(path.join(ROOT, "tools/pages-bundle.mjs"), "utf8");
  const items = bundle.match(/BUNDLE_ITEMS = Object\.freeze\(\[([^\]]*)\]/)[1];
  assert.ok(!/tools/.test(items));
  const spike = fs.readFileSync(path.join(ROOT, "tools/gateway-spike/wrangler.toml"), "utf8");
  assert.match(spike, /^name = "leeroy-gateway-spike"/m);
  assert.ok(!/d1_databases|\[vars\]|\[\[kv_namespaces|routes|crons/.test(spike.replace(/^#.*$/gm, "")), "no production bindings");
  assert.ok(!fs.existsSync(path.join(ROOT, "tools/gateway-spike/.dev.vars")));
});
