// =============================================================================
// `GatewayDO`: holds Discord's Gateway WebSocket from inside a Durable Object so @mentions and replies
// reach the Worker without any PC. FLAG OFF by default (`GATEWAY_ENABLED`). See docs/roadmap/GATEWAY-ON-CLOUDFLARE.md.
//
// This is a spike. An outbound WebSocket client keeps the object in memory (it cannot hibernate), so the object
// is billed wall-clock duration around the clock. The doc has the numbers.
//
// Survival: session_id, resume_gateway_url and the sequence live in DO storage. A deploy or eviction resets
// memory; the one-minute alarm notices there is no socket and reconnects with RESUME (or IDENTIFY if the
// session is gone). The bot token is read from env.DISCORD_BOT_TOKEN (same secret announce uses) and is never
// logged, stored, or returned by the status route.
// =============================================================================

import { answerWithAi, resolveAiProvider } from "./ai-models.js";
import { loadPersona, pickLine } from "./persona.js";
import { askBudgetKeys, hashId } from "./budget.js";
import { clampContent } from "./discord-safety.js";

export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15, privileged)
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
export const DEFAULT_COOLDOWN_MS = 20000;
export const ALARM_MS = 60000;
const MAX_EVENTS = 20;
const MAX_BOT_MSGS = 200;
const MAX_HANDLED = 50;
const IDENTIFY_DAILY_CAP = 900; // Discord allows 1000 IDENTIFYs per 24h; stay under it
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]); // auth failed, bad shard/version, invalid or disallowed intents
const FRESH_CLOSE_CODES = new Set([4007, 4009, 1000, 1001]); // invalid seq, session timed out, normal close: session is gone

export function gatewayEnabled(env) {
  return ["on", "true", "1"].includes(String((env && env.GATEWAY_ENABLED) || "off").toLowerCase());
}

const idOk = (v) => typeof v === "string" && /^[0-9]{5,25}$/.test(v);

// ---- pure message filter ---------------------------------------------------
// Returns { ok:true, question } or { ok:false, reason }. No I/O.
export function classifyMessage(message, { botId, guildId, channels, botMessageIds }) {
  const m = message || {};
  if (!botId) return { ok: false, reason: "no-bot-id" };
  if (!m.author || m.author.bot || m.author.id === botId || m.webhook_id) return { ok: false, reason: "bot-author" };
  if (!m.guild_id) return { ok: false, reason: "dm" };
  if (!idOk(guildId) || m.guild_id !== guildId) return { ok: false, reason: "other-guild" };
  if (!Array.isArray(channels) || !channels.includes(m.channel_id)) return { ok: false, reason: "channel-not-allowed" };
  const mentioned = Array.isArray(m.mentions) && m.mentions.some((u) => u && u.id === botId);
  const ref = m.message_reference && m.message_reference.message_id;
  const repliesToBot =
    (ref && Array.isArray(botMessageIds) && botMessageIds.includes(ref)) ||
    (m.referenced_message && m.referenced_message.author && m.referenced_message.author.id === botId);
  if (!mentioned && !repliesToBot) return { ok: false, reason: "not-addressed" };
  const question = String(m.content || "")
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
  if (!question) return { ok: false, reason: "empty" };
  return { ok: true, question };
}

// ---- the ask hand-off ------------------------------------------------------
// Same shape as the Interactions "Ask Leeroy" path: insert an ask_turns row, run answerWithAi unchanged, post the answer.
// Replies over REST with a reply reference and no pings. Returns the posted message id (or null).
export async function handleGatewayAsk({ env, message, question, deps = {} }) {
  const doFetch = deps.fetch || fetch;
  const answer = deps.answerWithAi || answerWithAi;
  const author = message.author || {};
  const byName = (message.member && message.member.nick) || author.global_name || author.username || "Someone";
  const q = question || String(message.content || "").trim();
  const intentId = String(Date.now());
  const now = new Date().toISOString();
  const provider = resolveAiProvider(env);
  await env.DB.prepare(
    "INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, ?, 'thinking', 1, ?)"
  )
    .bind(intentId, byName, q, provider, now)
    .run();

  await answer({
    env,
    origin: env.API_ORIGIN || "https://api.leeroy.party",
    intentId,
    by: byName,
    question: q,
    provider,
    share: true,
    budget: askBudgetKeys({ userPart: await hashId(author.id) }),
  });
  const row = await env.DB.prepare("SELECT answer, status FROM ask_turns WHERE id = ?").bind(intentId).first();
  let text = row && row.answer;
  if (row && row.status === "error") {
    const persona = await loadPersona(env).catch(() => null);
    if (persona) text = pickLine(persona, "errorLines", intentId, text);
  }
  if (!text) return null;
  const res = await doFetch(`https://discord.com/api/v10/channels/${message.channel_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: clampContent(text),
      message_reference: { message_id: message.id, channel_id: message.channel_id, guild_id: message.guild_id, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    }),
  });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    return null;
  }
  const posted = await res.json().catch(() => null);
  return posted && posted.id ? String(posted.id) : null;
}

// ---- production socket: outbound WebSocket from a Worker is a fetch() upgrade ----------
async function defaultConnect(url) {
  const res = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error("gateway upgrade refused");
  ws.accept();
  return ws;
}

const defaultTimers = () => ({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  now: () => Date.now(),
  random: () => Math.random(),
});

export class GatewayDO {
  // deps is for tests only: { connect, timers, ask }
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.connect = deps.connect || defaultConnect;
    this.t = deps.timers || defaultTimers();
    this.ask = deps.ask || handleGatewayAsk;
    this.fetchImpl = deps.fetch;
    this.ws = null;
    this.gen = 0; // bumped per socket so late events from an old socket are ignored
    this.connecting = false;
    this.state = "idle";
    this.hbTimer = null;
    this.reconnectTimer = null;
    this.awaitingAck = false;
    this.hbInterval = 0;
    this.lastHeartbeatAt = null;
    this.lastAckAt = null;
    this.events = [];
    this.attempt = 0;
    this.channelsCache = null;
    this.s = null; // persisted record, loaded in ready
    this.ready = ctx.blockConcurrencyWhile ? ctx.blockConcurrencyWhile(() => this.load()) : this.load();
  }

  async load() {
    const stored = (await this.ctx.storage.get("gw")) || {};
    this.s = {
      session_id: stored.session_id || null,
      resume_gateway_url: stored.resume_gateway_url || null,
      seq: Number.isInteger(stored.seq) ? stored.seq : null,
      bot_id: stored.bot_id || null,
      reconnects: stored.reconnects || 0,
      fatal: stored.fatal || null,
      identify_day: stored.identify_day || "",
      identify_count: stored.identify_count || 0,
      handled: Array.isArray(stored.handled) ? stored.handled : [],
      bot_msgs: Array.isArray(stored.bot_msgs) ? stored.bot_msgs : [],
    };
  }

  async save() {
    await this.ctx.storage.put("gw", this.s);
  }

  log(type) {
    this.events.push({ type, at: new Date(this.t.now()).toISOString() });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  enabled() {
    return gatewayEnabled(this.env);
  }

  // ---- HTTP surface (called by the Worker over the DO binding, never public) ----
  async fetch(req) {
    await this.ready;
    const path = new URL(req.url).pathname;
    if (path === "/status") return json(this.status());
    if (path === "/start" && req.method === "POST") {
      if (!this.enabled()) return json({ ok: false, error: "GATEWAY_ENABLED is off" }, 409);
      if (this.s.fatal && new URL(req.url).searchParams.get("clear") === "1") {
        this.s.fatal = null;
        await this.save();
      }
      await this.tick();
      return json({ ok: true, ...this.status() });
    }
    return new Response("Not found", { status: 404 });
  }

  status() {
    return {
      enabled: this.enabled(),
      state: this.state,
      fatal: this.s.fatal,
      has_session: Boolean(this.s.session_id),
      seq: this.s.seq,
      last_heartbeat_sent_at: this.lastHeartbeatAt ? new Date(this.lastHeartbeatAt).toISOString() : null,
      last_heartbeat_ack_at: this.lastAckAt ? new Date(this.lastAckAt).toISOString() : null,
      reconnect_count: this.s.reconnects,
      identifies_today: this.s.identify_count,
      last_events: this.events.map((e) => ({ type: e.type, at: e.at })), // types and times only, never message content
    };
  }

  // Alarm: the keep-alive. Fires every minute while enabled; a deploy or eviction leaves memory empty, so this reconnects.
  async alarm() {
    await this.ready;
    if (!this.enabled()) {
      this.teardown(false);
      this.state = "disabled";
      return;
    }
    await this.tick();
    if (this.s.fatal) return; // a fatal close (bad token, disallowed intent) stops the keep-alive until /start?clear=1
    await this.ctx.storage.setAlarm(this.t.now() + ALARM_MS);
  }

  async tick() {
    await this.ready;
    if (!this.enabled() || this.s.fatal) return;
    if (this.ctx.storage.getAlarm && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(this.t.now() + ALARM_MS);
    if (this.ws || this.connecting || this.reconnectTimer) return;
    await this.open();
  }

  // ---- connection lifecycle ----
  async open() {
    if (!this.env.DISCORD_BOT_TOKEN) {
      this.state = "no-token";
      return;
    }
    this.connecting = true;
    this.state = "connecting";
    const gen = ++this.gen;
    const base = this.s.session_id && this.s.resume_gateway_url ? this.s.resume_gateway_url.replace(/\/+$/, "") + "/?v=10&encoding=json" : GATEWAY_URL;
    let ws;
    try {
      ws = await this.connect(base);
    } catch {
      this.connecting = false;
      this.log("connect_failed");
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
    if (gen !== this.gen) {
      try { ws.close(1000); } catch {}
      return;
    }
    this.ws = ws;
    this.log("ws_open");
    ws.addEventListener("message", (ev) => { if (gen === this.gen) this.onMessage(ev.data).catch(() => {}); });
    ws.addEventListener("close", (ev) => { if (gen === this.gen) this.onClose(ev && ev.code).catch(() => {}); });
    ws.addEventListener("error", () => { if (gen === this.gen) this.log("ws_error"); });
  }

  teardown(closeSocket = true) {
    this.gen++;
    if (this.hbTimer) this.t.clearTimeout(this.hbTimer);
    if (this.reconnectTimer) this.t.clearTimeout(this.reconnectTimer);
    this.hbTimer = null;
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.connecting = false;
    if (ws && closeSocket) {
      try { ws.close(4000); } catch {}
    }
  }

  scheduleReconnect(minDelayMs = 0) {
    if (this.reconnectTimer || this.s.fatal) return;
    this.state = "reconnecting";
    this.s.reconnects += 1;
    this.attempt += 1;
    const cap = Math.min(60000, 1000 * 2 ** Math.min(this.attempt - 1, 6));
    const delay = Math.max(minDelayMs, Math.floor(cap * (0.5 + this.t.random() / 2)));
    this.reconnectTimer = this.t.setTimeout(() => {
      this.reconnectTimer = null;
      this.tick().catch(() => {});
    }, delay);
    this.save().catch(() => {});
  }

  async onClose(code) {
    this.log(`close:${code || "none"}`);
    this.teardown(false);
    if (FATAL_CLOSE_CODES.has(code)) {
      this.s.fatal = `close ${code}`;
      this.state = "fatal";
      await this.save();
      return;
    }
    if (FRESH_CLOSE_CODES.has(code)) this.clearSession();
    await this.save();
    this.scheduleReconnect();
  }

  clearSession() {
    this.s.session_id = null;
    this.s.resume_gateway_url = null;
    this.s.seq = null;
  }

  // ---- protocol ----
  send(obj) {
    if (this.ws) this.ws.send(JSON.stringify(obj));
  }

  async onMessage(raw) {
    let p;
    try {
      p = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (Number.isInteger(p.s)) this.s.seq = p.s;
    switch (p.op) {
      case 10: // HELLO
        this.hbInterval = Math.max(1000, Number(p.d && p.d.heartbeat_interval) || 41250);
        this.awaitingAck = false;
        this.log("hello");
        // first beat after interval * jitter, per the Gateway docs, then every interval
        this.scheduleBeat(Math.floor(this.hbInterval * this.t.random()));
        await this.handshake();
        break;
      case 11: // HEARTBEAT_ACK
        this.awaitingAck = false;
        this.lastAckAt = this.t.now();
        break;
      case 1: // server asks for an immediate heartbeat
        this.sendBeat();
        break;
      case 7: // RECONNECT
        this.log("reconnect_op");
        this.dropForReconnect();
        break;
      case 9: // INVALID_SESSION
        this.log(p.d ? "invalid_session_resumable" : "invalid_session");
        if (!p.d) {
          this.clearSession();
          await this.save();
        }
        this.dropForReconnect(1000 + Math.floor(this.t.random() * 4000)); // wait 1 to 5 s before the next handshake
        break;
      case 0:
        await this.onDispatch(p.t, p.d);
        break;
      default:
        break;
    }
  }

  dropForReconnect(minDelayMs = 0) {
    const ws = this.ws;
    this.teardown(false);
    if (ws) {
      try { ws.close(4000); } catch {} // not 1000/1001, so Discord keeps the session resumable
    }
    this.scheduleReconnect(minDelayMs);
  }

  async handshake() {
    const token = this.env.DISCORD_BOT_TOKEN;
    if (this.s.session_id && Number.isInteger(this.s.seq)) {
      this.log("resume");
      this.send({ op: 6, d: { token, session_id: this.s.session_id, seq: this.s.seq } });
      return;
    }
    const day = new Date(this.t.now()).toISOString().slice(0, 10);
    if (this.s.identify_day !== day) {
      this.s.identify_day = day;
      this.s.identify_count = 0;
    }
    if (this.s.identify_count >= IDENTIFY_DAILY_CAP) {
      this.log("identify_cap");
      this.state = "identify-cap";
      this.teardown(true);
      return;
    }
    this.s.identify_count += 1;
    await this.save();
    this.log("identify");
    this.send({
      op: 2,
      d: { token, intents: INTENTS, properties: { os: "cloudflare", browser: "leeroy-board", device: "leeroy-board" } },
    });
  }

  scheduleBeat(delay) {
    if (this.hbTimer) this.t.clearTimeout(this.hbTimer);
    this.hbTimer = this.t.setTimeout(() => {
      this.hbTimer = null;
      if (this.awaitingAck) {
        // zombied connection: no ACK since the last beat. Close and resume.
        this.log("zombie");
        this.dropForReconnect();
        return;
      }
      this.sendBeat();
      this.save().catch(() => {}); // persist the sequence about once per interval
      this.scheduleBeat(this.hbInterval);
    }, delay);
  }

  sendBeat() {
    this.awaitingAck = true;
    this.lastHeartbeatAt = this.t.now();
    this.send({ op: 1, d: Number.isInteger(this.s.seq) ? this.s.seq : null });
  }

  async onDispatch(type, d) {
    if (type === "READY") {
      this.s.session_id = d.session_id;
      this.s.resume_gateway_url = d.resume_gateway_url;
      this.s.bot_id = d.user && d.user.id;
      this.attempt = 0;
      this.state = "ready";
      this.log("ready");
      await this.save();
      return;
    }
    if (type === "RESUMED") {
      this.attempt = 0;
      this.state = "ready";
      this.log("resumed");
      await this.save();
      return;
    }
    if (type !== "MESSAGE_CREATE") return;
    await this.onMessageCreate(d);
  }

  async channelAllowList() {
    const now = this.t.now();
    if (this.channelsCache && now - this.channelsCache.at < 60000) return this.channelsCache;
    let channels = [];
    let guildId = null;
    try {
      const a = await this.env.DB.prepare("SELECT json FROM kv_state WHERE key = 'gateway_channels'").first();
      const arr = a ? JSON.parse(a.json) : [];
      channels = Array.isArray(arr) ? arr.filter(idOk) : [];
      const r = await this.env.DB.prepare("SELECT json FROM kv_state WHERE key = 'discord_roster'").first();
      const g = r ? JSON.parse(r.json).guildId : null;
      guildId = idOk(g) ? g : null;
    } catch {}
    this.channelsCache = { at: now, channels, guildId };
    return this.channelsCache;
  }

  async onMessageCreate(m) {
    if (!m) return;
    // Remember the bot's own message ids so a reply to one of them counts, even if Discord omits referenced_message.
    if (m.author && this.s.bot_id && m.author.id === this.s.bot_id) {
      this.rememberBotMessage(m.id);
      return;
    }
    if (m.author && m.author.bot) return;
    const cfg = await this.channelAllowList();
    const verdict = classifyMessage(m, { botId: this.s.bot_id, guildId: cfg.guildId, channels: cfg.channels, botMessageIds: this.s.bot_msgs });
    if (!verdict.ok) return;
    if (this.s.handled.includes(m.id)) return; // replayed after a resume
    const now = this.t.now();
    const cdMs = Number(this.env.GATEWAY_COOLDOWN_MS) > 0 ? Number(this.env.GATEWAY_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS;
    const key = `cd:${m.author.id}`;
    const last = await this.ctx.storage.get(key);
    if (typeof last === "number" && now - last < cdMs) {
      this.log("cooldown");
      return;
    }
    await this.ctx.storage.put(key, now);
    this.s.handled.push(m.id);
    if (this.s.handled.length > MAX_HANDLED) this.s.handled.shift();
    await this.save();
    this.log("ask");
    // Do not block the socket loop on the AI call.
    const work = this.ask({ env: this.env, message: m, question: verdict.question, deps: this.fetchImpl ? { fetch: this.fetchImpl } : {} })
      .then(async (postedId) => {
        if (postedId) {
          this.rememberBotMessage(postedId);
          await this.save();
        }
      })
      .catch(() => this.log("ask_failed"));
    this.pending = work;
    await this.pruneCooldowns(now, cdMs);
  }

  rememberBotMessage(id) {
    if (!id || this.s.bot_msgs.includes(id)) return;
    this.s.bot_msgs.push(id);
    if (this.s.bot_msgs.length > MAX_BOT_MSGS) this.s.bot_msgs.shift();
  }

  async pruneCooldowns(now, cdMs) {
    try {
      const all = await this.ctx.storage.list({ prefix: "cd:" });
      for (const [k, v] of all) if (typeof v !== "number" || now - v > cdMs * 5) await this.ctx.storage.delete(k);
    } catch {}
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Worker-side helpers. The single global object keeps one Gateway connection.
export function gatewayStub(env) {
  if (!env.GATEWAY) return null;
  return env.GATEWAY.get(env.GATEWAY.idFromName("global"));
}

export async function gatewayStatus(env) {
  const stub = gatewayStub(env);
  if (!stub) return { enabled: gatewayEnabled(env), bound: false };
  const res = await stub.fetch("https://gateway.internal/status");
  return { bound: true, ...(await res.json()) };
}

export async function kickGateway(env, clear = false) {
  if (!gatewayEnabled(env)) return { ok: false, error: "GATEWAY_ENABLED is off" };
  const stub = gatewayStub(env);
  if (!stub) return { ok: false, error: "GATEWAY binding missing" };
  const res = await stub.fetch(`https://gateway.internal/start${clear ? "?clear=1" : ""}`, { method: "POST" });
  return res.json();
}
