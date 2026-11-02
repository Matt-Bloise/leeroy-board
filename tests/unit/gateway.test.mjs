// GatewayDO against a fake Discord Gateway. No network, no AI, no secrets: the token below is a placeholder string.
// Run: node --test tests/unit/gateway.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { GatewayDO, classifyMessage, INTENTS, GATEWAY_URL, gatewayEnabled } from "../../infrastructure/worker/gateway.js";

const BOT = "100000000000000001";
const GUILD = "200000000000000002";
const CHAN = "300000000000000003";
const USER = "400000000000000004";

class FakeSocket {
  constructor(url) { this.url = url; this.sent = []; this.l = {}; this.closed = null; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close(code) { this.closed = code; }
  serverSend(obj) { for (const f of this.l.message || []) f({ data: JSON.stringify(obj) }); }
  serverClose(code) { for (const f of this.l.close || []) f({ code }); }
  ops(op) { return this.sent.filter((m) => m.op === op); }
}

function makeClock() {
  let now = 1_700_000_000_000, id = 0;
  const q = new Map();
  return {
    timers: {
      now: () => now,
      random: () => 0.5,
      setTimeout: (fn, ms) => { q.set(++id, { at: now + ms, fn }); return id; },
      clearTimeout: (h) => q.delete(h),
    },
    // advance virtual time, firing timers in order (and awaiting any promise they return)
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]);
        now = next[1].at;
        await next[1].fn();
        await flush();
      }
      now = end;
    },
    pending: () => q.size,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

function makeCtx() {
  const m = new Map();
  let alarm = null;
  return {
    storage: {
      get: async (k) => m.get(k),
      put: async (k, v) => { m.set(k, structuredClone(v)); },
      delete: async (k) => m.delete(k),
      list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
      getAlarm: async () => alarm,
      setAlarm: async (t) => { alarm = t; },
    },
    blockConcurrencyWhile: (fn) => fn(),
    _m: m,
    _alarm: () => alarm,
  };
}

function makeEnv(extra = {}) {
  const rows = { gateway_channels: JSON.stringify([CHAN]), discord_roster: JSON.stringify({ guildId: GUILD }) };
  return {
    GATEWAY_ENABLED: "on",
    DISCORD_BOT_TOKEN: "test-token-placeholder",
    DB: { prepare: (sql) => ({ first: async () => { const m = /key = '(\w+)'/.exec(sql); return m && rows[m[1]] ? { json: rows[m[1]] } : null; } }) },
    ...extra,
  };
}

function rig({ env = makeEnv(), ctx = makeCtx(), clock = makeClock(), asks = [] } = {}) {
  const sockets = [];
  const connect = async (url) => { const s = new FakeSocket(url); sockets.push(s); return s; };
  const make = () => new GatewayDO(ctx, env, { connect, timers: clock.timers, ask: async (a) => { asks.push(a); return "900000000000000009"; } });
  return { gw: make(), make, sockets, ctx, clock, env, asks };
}

const hello = (s, interval = 40000) => s.serverSend({ op: 10, d: { heartbeat_interval: interval } });
const ready = (s, seq = 1) => s.serverSend({ op: 0, t: "READY", s: seq, d: { session_id: "sess-1", resume_gateway_url: "wss://resume.example", user: { id: BOT } } });
const msg = (over = {}) => ({
  id: "500000000000000005", channel_id: CHAN, guild_id: GUILD, content: `<@${BOT}> what drops in Deadmines?`,
  author: { id: USER, username: "u" }, mentions: [{ id: BOT }], ...over,
});
const dispatchMsg = (s, seq, m) => s.serverSend({ op: 0, t: "MESSAGE_CREATE", s: seq, d: m });

async function boot(r) {
  await r.gw.tick();
  const s = r.sockets.at(-1);
  hello(s); await flush();
  ready(s); await flush();
  return s;
}

test("flag helper: off by default, on for on/true/1", () => {
  assert.equal(gatewayEnabled({}), false);
  assert.equal(gatewayEnabled({ GATEWAY_ENABLED: "off" }), false);
  assert.equal(gatewayEnabled({ GATEWAY_ENABLED: "on" }), true);
});

test("flag off: tick never opens a socket", async () => {
  const r = rig({ env: makeEnv({ GATEWAY_ENABLED: "off" }) });
  await r.gw.tick();
  assert.equal(r.sockets.length, 0);
});

test("handshake: identifies with GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT on the v10 json URL", async () => {
  const r = rig();
  const s = await boot(r);
  assert.equal(s.url, GATEWAY_URL);
  assert.equal(INTENTS, 1 | 512 | 32768);
  const id = s.ops(2);
  assert.equal(id.length, 1);
  assert.equal(id[0].d.intents, INTENTS);
  assert.equal(r.gw.status().state, "ready");
});

test("heartbeat timing: first beat at interval*jitter, then every interval, carrying the last sequence", async () => {
  const r = rig();
  const s = await boot(r);
  await r.clock.advance(19999);
  assert.equal(s.ops(1).length, 0, "no beat before interval * jitter (0.5 * 40000)");
  await r.clock.advance(2);
  assert.equal(s.ops(1).length, 1);
  assert.equal(s.ops(1)[0].d, 1, "carries the READY sequence");
  s.serverSend({ op: 11 });
  dispatchMsg(s, 2, msg({ content: "hi", mentions: [] }));
  await r.clock.advance(40000);
  assert.equal(s.ops(1).length, 2);
  assert.equal(s.ops(1)[1].d, 2);
  assert.ok(r.gw.status().last_heartbeat_ack_at);
});

test("a missed ACK closes the socket and resumes with the stored session", async () => {
  const r = rig();
  const s = await boot(r);
  await r.clock.advance(20001); // first beat, never acked
  await r.clock.advance(40000); // second beat finds no ack: zombie
  assert.equal(s.closed, 4000, "closed with a non-1000 code so the session stays resumable");
  await r.clock.advance(70000);
  const s2 = r.sockets.at(-1);
  assert.notEqual(s2, s);
  assert.equal(s2.url, "wss://resume.example/?v=10&encoding=json");
});

test("resume after a forced close: RESUME with session_id and sequence, no identify", async () => {
  const r = rig();
  const s = await boot(r);
  dispatchMsg(s, 7, msg({ content: "x", mentions: [] }));
  await flush();
  s.serverClose(1006);
  await flush();
  await r.clock.advance(65000);
  const s2 = r.sockets.at(-1);
  assert.equal(s2.url, "wss://resume.example/?v=10&encoding=json");
  hello(s2); await flush();
  assert.equal(s2.ops(2).length, 0);
  const res = s2.ops(6);
  assert.equal(res.length, 1);
  assert.equal(res[0].d.session_id, "sess-1");
  assert.equal(res[0].d.seq, 7);
  s2.serverSend({ op: 0, t: "RESUMED", s: 8, d: {} }); await flush();
  assert.equal(r.gw.status().state, "ready");
  assert.ok(r.gw.status().reconnect_count >= 1);
});

test("eviction/deploy: a new instance on the same storage resumes from the stored session; the alarm restarts it", async () => {
  const r = rig();
  const s = await boot(r);
  dispatchMsg(s, 5, msg({ content: "x", mentions: [] }));
  await r.clock.advance(41000); // heartbeat persists the sequence
  assert.ok(r.ctx._alarm(), "alarm armed");
  const r2 = rig({ ctx: r.ctx, clock: r.clock, env: r.env }); // fresh memory, same storage
  await r2.gw.alarm();
  const s2 = r2.sockets.at(-1);
  assert.ok(s2, "alarm opened a socket");
  hello(s2); await flush();
  assert.equal(s2.ops(6)[0].d.session_id, "sess-1");
  assert.equal(s2.ops(6)[0].d.seq, 5);
  assert.ok(r2.ctx._alarm() > r.clock.timers.now(), "alarm re-armed");
});

test("op 7 RECONNECT drops the socket and resumes", async () => {
  const r = rig();
  const s = await boot(r);
  s.serverSend({ op: 7, d: null }); await flush();
  assert.equal(s.closed, 4000);
  await r.clock.advance(65000);
  const s2 = r.sockets.at(-1);
  hello(s2); await flush();
  assert.equal(s2.ops(6).length, 1);
});

test("invalid session (not resumable) falls back to a fresh identify after 1-5 s", async () => {
  const r = rig();
  const s = await boot(r);
  s.serverClose(1006); await flush();
  await r.clock.advance(65000);
  const s2 = r.sockets.at(-1);
  hello(s2); await flush();
  assert.equal(s2.ops(6).length, 1);
  s2.serverSend({ op: 9, d: false }); await flush();
  await r.clock.advance(65000);
  const s3 = r.sockets.at(-1);
  assert.notEqual(s3, s2);
  hello(s3); await flush();
  assert.equal(s3.ops(6).length, 0);
  assert.equal(s3.ops(2).length, 1, "fresh identify");
  assert.equal(s3.url, GATEWAY_URL, "session cleared, default gateway url");
});

test("fatal close codes (4014 disallowed intents) stop retrying and say why", async () => {
  const r = rig();
  const s = await boot(r);
  s.serverClose(4014); await flush();
  await r.clock.advance(300000);
  assert.equal(r.sockets.length, 1);
  assert.equal(r.gw.status().state, "fatal");
  assert.match(r.gw.status().fatal, /4014/);
});

test("status never contains message content or the token", async () => {
  const r = rig();
  const s = await boot(r);
  dispatchMsg(s, 2, msg({ content: `<@${BOT}> SECRET-CONTENT` })); await flush();
  const blob = JSON.stringify(r.gw.status());
  assert.ok(!blob.includes("SECRET-CONTENT"));
  assert.ok(!blob.includes("test-token-placeholder"));
  assert.ok(r.gw.status().last_events.every((e) => Object.keys(e).sort().join() === "at,type"));
});

// ---- message filtering
const ctxFor = (over = {}) => ({ botId: BOT, guildId: GUILD, channels: [CHAN], botMessageIds: [], ...over });

test("mention in an allowed channel is accepted and the mention is stripped", () => {
  const v = classifyMessage(msg(), ctxFor());
  assert.equal(v.ok, true);
  assert.equal(v.question, "what drops in Deadmines?");
});

test("reply to one of the bot's own messages counts (stored id, or referenced author)", () => {
  const plain = msg({ content: "and the second boss?", mentions: [], message_reference: { message_id: "777" } });
  assert.equal(classifyMessage(plain, ctxFor()).reason, "not-addressed");
  assert.equal(classifyMessage(plain, ctxFor({ botMessageIds: ["777"] })).ok, true);
  const viaAuthor = msg({ content: "and the second boss?", mentions: [], referenced_message: { author: { id: BOT } } });
  assert.equal(classifyMessage(viaAuthor, ctxFor()).ok, true);
});

test("ignored: bots, the bot itself, webhooks, DMs, other guilds, other channels, unaddressed, empty", () => {
  assert.equal(classifyMessage(msg({ author: { id: USER, bot: true } }), ctxFor()).reason, "bot-author");
  assert.equal(classifyMessage(msg({ author: { id: BOT } }), ctxFor()).reason, "bot-author");
  assert.equal(classifyMessage(msg({ webhook_id: "1" }), ctxFor()).reason, "bot-author");
  assert.equal(classifyMessage(msg({ guild_id: undefined }), ctxFor()).reason, "dm");
  assert.equal(classifyMessage(msg({ guild_id: "999999999999999999" }), ctxFor()).reason, "other-guild");
  assert.equal(classifyMessage(msg({ channel_id: "888888888888888888" }), ctxFor()).reason, "channel-not-allowed");
  assert.equal(classifyMessage(msg({ mentions: [] }), ctxFor()).reason, "not-addressed");
  assert.equal(classifyMessage(msg({ content: `<@${BOT}>` }), ctxFor()).reason, "empty");
  assert.equal(classifyMessage(msg(), ctxFor({ channels: [] })).reason, "channel-not-allowed", "empty allow-list ignores everything");
  assert.equal(classifyMessage(msg(), ctxFor({ guildId: null })).reason, "other-guild", "no configured guild ignores everything");
});

test("end to end: only the mention reaches the ask handler; bot authors do not", async () => {
  const r = rig();
  const s = await boot(r);
  dispatchMsg(s, 2, msg({ id: "51", author: { id: "600000000000000006", bot: true } }));
  dispatchMsg(s, 3, msg({ id: "52", channel_id: "888888888888888888" }));
  await flush(); await flush();
  assert.equal(r.asks.length, 0);
  dispatchMsg(s, 4, msg({ id: "53" }));
  await flush(); await flush();
  assert.equal(r.asks.length, 1);
  assert.equal(r.asks[0].question, "what drops in Deadmines?");
});

test("per-user cooldown: a second ask inside 20 s is dropped, another user is not, and it clears after 20 s", async () => {
  const r = rig();
  const s = await boot(r);
  dispatchMsg(s, 2, msg({ id: "61" })); await flush(); await flush();
  dispatchMsg(s, 3, msg({ id: "62" })); await flush(); await flush();
  assert.equal(r.asks.length, 1);
  assert.ok(r.gw.status().last_events.some((e) => e.type === "cooldown"));
  dispatchMsg(s, 4, msg({ id: "63", author: { id: "700000000000000007", username: "other" } })); await flush(); await flush();
  assert.equal(r.asks.length, 2);
  await r.clock.advance(20001);
  dispatchMsg(s, 5, msg({ id: "64" })); await flush(); await flush();
  assert.equal(r.asks.length, 3);
});

test("a message replayed after a resume is not answered twice", async () => {
  const r = rig();
  const s = await boot(r);
  dispatchMsg(s, 2, msg({ id: "71" })); await flush(); await flush();
  await r.clock.advance(25000); // cooldown over
  dispatchMsg(s, 2, msg({ id: "71" })); await flush(); await flush();
  assert.equal(r.asks.length, 1);
});

test("the reply id is remembered, so a later reply to it (no mention) is answered", async () => {
  const r = rig();
  const s = await boot(r);
  dispatchMsg(s, 2, msg({ id: "81" })); await flush(); await flush(); await flush();
  await r.clock.advance(25000);
  dispatchMsg(s, 3, msg({ id: "82", content: "more please", mentions: [], message_reference: { message_id: "900000000000000009" } }));
  await flush(); await flush();
  assert.equal(r.asks.length, 2);
});

test("handleGatewayAsk: inserts ask_turns, replies over REST as a no-ping reply, never echoes the token", async () => {
  const { handleGatewayAsk } = await import("../../infrastructure/worker/gateway.js");
  const sql = [];
  const env = {
    DISCORD_BOT_TOKEN: "test-token-placeholder",
    DB: { prepare: (q) => ({ bind: (...a) => ({ run: async () => { sql.push([q, a]); }, first: async () => ({ answer: "Rend drops it.", status: "answered" }) }), first: async () => null }) },
  };
  let call;
  const fetch = async (url, init) => { call = { url, init }; return new Response(JSON.stringify({ id: "950000000000000009" }), { status: 200 }); };
  const answerWithAi = async () => {};
  const id = await handleGatewayAsk({ env, message: msg({ id: "55" }), question: "what drops?", deps: { fetch, answerWithAi } });
  assert.equal(id, "950000000000000009");
  assert.match(sql[0][0], /INSERT INTO ask_turns/);
  assert.equal(call.url, `https://discord.com/api/v10/channels/${CHAN}/messages`);
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(body.message_reference.message_id, "55");
  assert.equal(body.content, "Rend drops it.");
  assert.ok(!call.init.body.includes("test-token-placeholder"));
});
