// Pure state machine for the gateway spike. No Cloudflare APIs here: the Durable Object and the unit test both import this file.
// Everything effectful (sockets, timers, storage, clock, randomness, REST) is injected, so a fake WebSocket can drive it.
// Discord rules are from https://docs.discord.com/developers/events/gateway and /topics/opcodes-and-status-codes (see docs/runbooks/gateway-spike.md).

export const INTENTS = 513; // GUILDS (1 << 0) + GUILD_MESSAGES (1 << 9): no privileged intent
export const GB_PER_OBJECT = 0.125; // 128 MB, billed regardless of use (Cloudflare DO pricing page)
export const PREDICTED_GBS_PER_HOUR = 3600 * GB_PER_OBJECT; // 450
export const CLIENT_CLOSE_CODE = 4000; // our own close for zombie / reconnect / forced test: anything except 1000 and 1001 keeps the session
export const MAX_IDENTIFIES_PER_HOUR = 3; // spike circuit breaker (our rule, not Discord's)
export const MIN_SESSION_STARTS_REMAINING = 5; // refuse to identify below this (our rule)
export const SEQ_PERSIST_EVERY_MS = 30000; // seq is written to storage at most this often, plus on close (limits SQLite rows written)

// Per the Discord close-code table. "resume": reconnect and send op 6. "identify": reconnect with a fresh IDENTIFY (the session is gone).
// "fatal": do not reconnect (fix the config first).
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NEW_SESSION = new Set([4003, 4007, 4009]); // 4007 "start a new session", 4009 "start a new one", 4003 "session was invalidated"
const RESUMABLE = new Set([4000, 4001, 4002, 4005, 4008]);

export function classifyClose(code) {
  if (code === 1000 || code === 1001) return "identify"; // closing with 1000/1001 invalidates the session
  if (FATAL.has(code)) return "fatal";
  if (NEW_SESSION.has(code)) return "identify";
  if (RESUMABLE.has(code)) return "resume";
  return "resume"; // 1006 / 1005 / null / transport drop: the session stays alive for a few minutes
}

// First heartbeat after heartbeat_interval x jitter (jitter is 0..1), then every heartbeat_interval.
export function firstHeartbeatDelay(intervalMs, rand) {
  const j = Math.min(1, Math.max(0, Number(rand())));
  return Math.floor(intervalMs * j);
}

export function decideConnect(stored) {
  const s = stored || {};
  return s.sessionId && s.resumeUrl && Number.isInteger(s.seq) ? "resume" : "identify";
}

export function identifyAllowed(identifyTimes, nowMs, sessionStartsRemaining) {
  const recent = (identifyTimes || []).filter((t) => nowMs - t < 3600000);
  if (recent.length >= MAX_IDENTIFIES_PER_HOUR) return { ok: false, reason: "local cap: " + recent.length + " identifies in the last hour" };
  if (Number.isInteger(sessionStartsRemaining) && sessionStartsRemaining < MIN_SESSION_STARTS_REMAINING) return { ok: false, reason: "session_start_limit.remaining=" + sessionStartsRemaining };
  return { ok: true, reason: "" };
}

export function gatewayUrl(base, version = 10) {
  const b = String(base).replace(/\/+$/, "");
  return b + "/?v=" + version + "&encoding=json";
}

export function newCounters() {
  return { events: 0, eventTypes: {}, heartbeatsSent: 0, heartbeatRequests: 0, acks: 0, zombies: 0, connects: 0, reconnects: 0, identifies: 0, resumes: 0, resumed: 0, readys: 0, invalidSessions: 0, opReconnects: 0, closeCodes: {}, errors: 0, storageWrites: 0, coldStarts: 0 };
}

export function bump(counters, key, sub) {
  if (sub === undefined) counters[key] = (counters[key] || 0) + 1;
  else { counters[key] = counters[key] || {}; counters[key][sub] = (counters[key][sub] || 0) + 1; }
}

export function ackRatio(c) {
  return c.heartbeatsSent > 0 ? Math.round((c.acks / c.heartbeatsSent) * 1000) / 1000 : null;
}

// Wall-clock awake time. `inst` = { bootAt, lastSeen } of the current instance; `accumS` = seconds from earlier instances.
export function awakeSeconds(accumS, inst, nowMs) {
  const cur = inst ? Math.max(0, (nowMs - inst.bootAt) / 1000) : 0;
  return Math.round((accumS + cur) * 1000) / 1000;
}
export function gbSeconds(seconds) { return Math.round(seconds * GB_PER_OBJECT * 1000) / 1000; }

// A new instance booted: fold the previous instance (bootAt..lastSeen) into the accumulator. A gap before this boot means it was evicted.
export function foldPreviousInstance(accumS, prev, nowMs) {
  if (!prev) return { accumS, evictedAfterS: null, gapS: null };
  const ranS = Math.max(0, (prev.lastSeen - prev.bootAt) / 1000);
  return { accumS: accumS + ranS, evictedAfterS: Math.round(ranS), gapS: Math.round(Math.max(0, (nowMs - prev.lastSeen) / 1000)) };
}

// Redaction: the token and the session id never leave. Booleans and counts only.
export function redactedStatus(snapshot) {
  const s = snapshot || {};
  const out = {
    mode: s.mode, phase: s.phase, hasSession: !!s.sessionId, hasResumeUrl: !!s.resumeUrl, seq: s.seq ?? null,
    heartbeatIntervalMs: s.heartbeatIntervalMs ?? null, lastAckAgeMs: s.lastAckAgeMs ?? null, lastClose: s.lastClose ?? null, lastError: s.lastError ?? null,
    sessionStart: s.sessionStart ?? null, timeToReadyMs: s.timeToReadyMs ?? null,
    alarmsEnabled: s.alarmsEnabled ?? null, counters: s.counters, ackRatio: s.counters ? ackRatio(s.counters) : null,
    awakeSeconds: s.awakeSeconds ?? null, bootHistory: s.bootHistory ?? [],
  };
  return JSON.parse(JSON.stringify(out, (k, v) => (k === "token" ? undefined : v)));
}

// The machine. deps: { token, store: {get(), set(obj)}, now(), rand(), setTimer(fn, ms) -> handle, clearTimer(handle), connect(url, handlers) -> socket {send, close},
// fetchGatewayInfo() -> {url, session_start_limit}, log(msg) }. handlers given to connect: onOpen(), onMessage(text), onClose(code), onError(msg).
export class GatewayMachine {
  constructor(deps) {
    this.d = deps;
    this.counters = newCounters();
    this.phase = "idle"; // idle | connecting | hello | ready | backoff | halted
    this.sock = null;
    this.gen = 0; // one connection generation: callbacks from older sockets are ignored
    this.hbTimer = null; this.reconnectTimer = null;
    this.interval = null; this.ackOk = true; this.lastAckAt = null; this.hbSentAt = null;
    this.mode = null; this.lastClose = null; this.lastError = null; this.sessionStart = null;
    this.connectStartedAt = null; this.timeToReadyMs = null;
    this.lastSeqPersistAt = 0; this.state = { sessionId: null, resumeUrl: null, seq: null, identifyTimes: [] };
    this.backoffMs = 1000;
  }

  load() { const s = this.d.store.get(); if (s) this.state = { sessionId: s.sessionId || null, resumeUrl: s.resumeUrl || null, seq: Number.isInteger(s.seq) ? s.seq : null, identifyTimes: Array.isArray(s.identifyTimes) ? s.identifyTimes : [] }; }
  persist() { this.d.store.set(this.state); bump(this.counters, "storageWrites"); this.lastSeqPersistAt = this.d.now(); }

  async start() {
    if (this.phase === "halted") return;
    if (this.sock || this.phase === "connecting") return;
    this.load();
    this.mode = decideConnect(this.state);
    this.phase = "connecting";
    this.connectStartedAt = this.d.now();
    let url;
    try {
      const info = await this.d.fetchGatewayInfo(); // GET /gateway/bot: url + session_start_limit
      this.sessionStart = info.session_start_limit || null;
      url = this.mode === "resume" ? this.state.resumeUrl : info.url;
      if (this.mode === "identify") {
        const chk = identifyAllowed(this.state.identifyTimes, this.d.now(), this.sessionStart ? this.sessionStart.remaining : undefined);
        if (!chk.ok) { this.lastError = "identify refused: " + chk.reason; this.phase = "halted"; this.d.log(this.lastError); return; }
      }
    } catch (e) { this.fail("gateway info: " + (e && e.message ? e.message : e)); return; }
    this.open(gatewayUrl(url));
  }

  open(url) {
    const gen = ++this.gen;
    bump(this.counters, "connects");
    this.sock = this.d.connect(url, {
      onOpen: () => {},
      onMessage: (t) => { if (gen === this.gen) this.onMessage(t); },
      onClose: (c) => { if (gen === this.gen) this.onClose(c); },
      onError: (m) => { if (gen === this.gen) { bump(this.counters, "errors"); this.lastError = String(m); } },
    });
  }

  send(obj) { if (this.sock) this.sock.send(JSON.stringify(obj)); }

  onMessage(text) {
    let m; try { m = JSON.parse(text); } catch { bump(this.counters, "errors"); return; }
    if (Number.isInteger(m.s)) { this.state.seq = m.s; }
    switch (m.op) {
      case 10: return this.onHello(m.d);
      case 11: this.ackOk = true; this.lastAckAt = this.d.now(); bump(this.counters, "acks"); return;
      case 1: bump(this.counters, "heartbeatRequests"); this.heartbeat(); return;
      case 7: bump(this.counters, "opReconnects"); this.closeSocket(CLIENT_CLOSE_CODE); return;
      case 9: bump(this.counters, "invalidSessions");
        if (m.d === true) this.closeSocket(CLIENT_CLOSE_CODE);
        else { this.state.sessionId = null; this.state.resumeUrl = null; this.state.seq = null; this.persist(); this.closeSocket(CLIENT_CLOSE_CODE); }
        return;
      case 0: return this.onDispatch(m);
      default: return;
    }
  }

  onHello(d) {
    this.phase = "hello";
    this.interval = d && d.heartbeat_interval;
    this.ackOk = true; // nothing outstanding yet
    this.clearHb();
    this.hbTimer = this.d.setTimer(() => this.heartbeatTick(), firstHeartbeatDelay(this.interval, this.d.rand));
    if (this.mode === "resume") {
      bump(this.counters, "resumes");
      this.send({ op: 6, d: { token: this.d.token, session_id: this.state.sessionId, seq: this.state.seq } });
    } else {
      const chk = identifyAllowed(this.state.identifyTimes, this.d.now(), this.sessionStart ? this.sessionStart.remaining : undefined);
      if (!chk.ok) { this.lastError = "identify refused: " + chk.reason; this.phase = "halted"; this.clearHb(); this.closeSocket(1000); return; }
      this.state.identifyTimes = this.state.identifyTimes.filter((t) => this.d.now() - t < 3600000).concat([this.d.now()]);
      bump(this.counters, "identifies");
      this.persist();
      this.send({ op: 2, d: { token: this.d.token, intents: INTENTS, properties: { os: "spike", browser: "gateway-spike", device: "gateway-spike" } } });
    }
  }

  onDispatch(m) {
    bump(this.counters, "events"); bump(this.counters, "eventTypes", String(m.t));
    if (m.t === "READY") {
      this.state.sessionId = m.d.session_id; this.state.resumeUrl = m.d.resume_gateway_url;
      this.phase = "ready"; bump(this.counters, "readys");
      if (this.timeToReadyMs === null || this.mode === "identify") this.timeToReadyMs = this.d.now() - this.connectStartedAt;
      this.backoffMs = 1000;
      this.persist();
    } else if (m.t === "RESUMED") {
      this.phase = "ready"; bump(this.counters, "resumed"); this.backoffMs = 1000; this.persist();
    } else if (this.d.now() - this.lastSeqPersistAt >= SEQ_PERSIST_EVERY_MS) this.persist();
  }

  heartbeat() { bump(this.counters, "heartbeatsSent"); this.hbSentAt = this.d.now(); this.send({ op: 1, d: Number.isInteger(this.state.seq) ? this.state.seq : null }); }

  heartbeatTick() {
    if (!this.sock) return;
    if (!this.ackOk) { bump(this.counters, "zombies"); this.closeSocket(CLIENT_CLOSE_CODE); return; } // no ACK since the previous heartbeat: zombied
    this.ackOk = false;
    this.heartbeat();
    this.persist(); // seq checkpoint rides on the heartbeat
    this.hbTimer = this.d.setTimer(() => this.heartbeatTick(), this.interval);
  }

  // Alarm / external watchdog entry point: no socket and not halted means start; stale ACK means close.
  watchdog() {
    if (this.phase === "halted") return "halted";
    if (!this.sock && this.phase === "idle") { this.start(); return "start"; } // idle after a cold start; backoff and connecting have their own timers
    if (this.sock && this.interval && this.lastAckAt !== null && this.d.now() - this.lastAckAt > this.interval * 2.5) { bump(this.counters, "zombies"); this.closeSocket(CLIENT_CLOSE_CODE); return "zombie-close"; }
    return "ok";
  }

  forceClose(code = CLIENT_CLOSE_CODE) { if (!this.sock) return false; this.closeSocket(code); return true; }

  closeSocket(code) { try { this.sock && this.sock.close(code, "spike"); } catch { /* already closed */ } }

  clearHb() { if (this.hbTimer !== null) { this.d.clearTimer(this.hbTimer); this.hbTimer = null; } }

  onClose(code) {
    this.lastClose = code === undefined ? null : code;
    bump(this.counters, "closeCodes", String(code));
    this.clearHb(); this.sock = null; this.ackOk = true;
    this.persist();
    const kind = classifyClose(code);
    if (kind === "fatal") { this.phase = "halted"; this.lastError = "fatal close code " + code; return; }
    if (kind === "identify") { this.state.sessionId = null; this.state.resumeUrl = null; this.state.seq = null; this.persist(); }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.phase === "halted") return;
    this.phase = "backoff";
    bump(this.counters, "reconnects");
    const wait = this.backoffMs + Math.floor(this.d.rand() * 1000);
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    if (this.reconnectTimer !== null) this.d.clearTimer(this.reconnectTimer);
    this.reconnectTimer = this.d.setTimer(() => { this.reconnectTimer = null; this.phase = "idle"; this.start(); }, wait);
  }

  fail(msg) { bump(this.counters, "errors"); this.lastError = msg; this.sock = null; this.scheduleReconnect(); }

  snapshot(extra) {
    return Object.assign({ mode: this.mode, phase: this.phase, sessionId: this.state.sessionId, resumeUrl: this.state.resumeUrl, seq: this.state.seq, heartbeatIntervalMs: this.interval,
      lastAckAgeMs: this.lastAckAt === null ? null : this.d.now() - this.lastAckAt, lastClose: this.lastClose, lastError: this.lastError, sessionStart: this.sessionStart,
      timeToReadyMs: this.timeToReadyMs, counters: this.counters }, extra || {});
  }
}
