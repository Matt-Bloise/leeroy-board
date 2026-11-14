import { authenticate } from "./auth.js";

// =============================================================================
// `BoardRoom` Hibernatable WebSocket Durable Object
// Zero-SQLite pub/sub hub coordinates real-time push events to connected browsers:
// character sheet edits, signups, library updates, and ask Q&A completions.
// =============================================================================

// Bounds. The broadcast route is internal (the Worker calls it), but it fans one body out to every open socket, so a bad or oversize call
// must fail loudly instead of being copied to hundreds of browsers.
export const MAX_BROADCAST_BYTES = 256 * 1024; // one message; Cloudflare allows 1 MiB per WebSocket message, a party snapshot is far smaller
export const MAX_BROADCAST_RECIPIENTS = 500; // sockets one broadcast is sent to
export const MAX_SOCKETS = MAX_BROADCAST_RECIPIENTS; // open sockets; equal to the fan-out cap so no open socket is silently skipped. /live refuses new ones above this (the page falls back to polling)

// Who may read shared question and answer text on the socket. A socket starts anonymous. It becomes a member when the Worker vouches
// for a valid web session on the upgrade (header below, always stripped from the client's own request) or when the page sends
// {"type":"auth","key":"<member key>"}; it becomes a guest-owner when the page sends {"type":"auth","ask":"<its own ask id>"}
// (the same random id that GET /api/ask?id= already treats as the capability). Anyone else gets presence nudges with no content.
export const LIVE_AUTH_HEADER = "x-board-live-auth";
const ASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // the same shape GET /api/ask?id= accepts as a credential
const CONTENT_KEYS = ["q", "text", "question", "answer", "cites", "sources", "body", "error"];

// What an anonymous socket may read of an "item" or "intent" object: an allow list, so a field added to an ask item later never reaches a
// stranger by default. CONTENT_KEYS above is the subset a member socket gets on top of this. Kept by tests/unit/public-read-contract.test.mjs.
export const PUBLIC_ITEM_KEYS = Object.freeze(["id", "kind", "by", "slug", "provider", "model", "status", "at", "ms", "share"]);
// The top-level keys of every message the Worker broadcasts today (broadcastToRoom call sites in ai-models.js, ask-answer.js, cards-handler.js,
// discord.js, index.js), minus "ask" and "forAsk". Any other top-level key reaches member and guest-owner sockets only.
export const PUBLIC_TOP_KEYS = Object.freeze(["type", "slug", "key", "data", "intent", "item", "party", "categories", "page"]);

// Returns the message every socket may read: only PUBLIC_TOP_KEYS (so no "ask" item), and only PUBLIC_ITEM_KEYS on an "item" or "intent" object.
export function redactForPublic(payload) {
  const out = { ...payload };
  let changed = false;
  for (const k of Object.keys(out)) if (!PUBLIC_TOP_KEYS.includes(k)) { delete out[k]; changed = true; }
  for (const k of ["item", "intent"]) {
    if (!(k in out)) continue;
    const o = out[k];
    if (!o || typeof o !== "object" || Array.isArray(o)) { delete out[k]; changed = true; continue; }
    const copy = {};
    for (const key of PUBLIC_ITEM_KEYS) if (key in o && (o[key] === null || typeof o[key] !== "object")) copy[key] = o[key];
    if (Object.keys(copy).length !== Object.keys(o).length) { out[k] = copy; changed = true; }
  }
  return changed ? out : payload;
}

function audienceOf(ws) {
  try {
    const a = typeof ws.deserializeAttachment === "function" ? ws.deserializeAttachment() : null;
    return a && typeof a === "object" ? a : {};
  } catch { return {}; }
}

const jsonResponse = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const byteLength = (str) => new TextEncoder().encode(str).length;

export class BoardRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    try {
      // Intercept client "ping" keepalives at Cloudflare edge without waking Durable Object
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {}
  }

  // Sends one message to at most MAX_BROADCAST_RECIPIENTS sockets. Returns { sent, skipped } so the caller can see a capped fan-out.
  // Question and answer text goes to member sockets only (and, with payload.forAsk, to the one guest socket that owns that ask).
  // Everyone else gets the same message with the text removed, so the page still knows something changed. forAsk never goes out.
  broadcast(msg) {
    let payload = msg;
    if (typeof msg === "string") { try { payload = JSON.parse(msg); } catch { return { sent: 0, skipped: 0 }; } }
    const forAsk = payload && typeof payload === "object" && payload.forAsk != null ? String(payload.forAsk) : null;
    if (forAsk !== null) { payload = { ...payload }; delete payload.forAsk; }
    const trimmed = redactForPublic(payload);
    const publicRaw = JSON.stringify(trimmed);
    const fullRaw = trimmed === payload ? publicRaw : JSON.stringify(payload);
    const sockets = this.ctx.getWebSockets();
    let sent = 0;
    for (const ws of sockets.slice(0, MAX_BROADCAST_RECIPIENTS)) {
      const aud = trimmed === payload ? null : audienceOf(ws);
      const full = aud && (forAsk !== null ? aud.ask === forAsk : aud.member === true);
      try {
        ws.send(full ? fullRaw : publicRaw);
        sent += 1;
      } catch {
        // Closed socket will be cleaned up by webSocketClose
      }
    }
    return { sent, skipped: Math.max(0, sockets.length - MAX_BROADCAST_RECIPIENTS) };
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";

    // 1. WebSocket Upgrade (`/api/live`) using Hibernatable WebSockets API
    if (path === "/live") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket Upgrade", { status: 426 });
      }
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
        return jsonResponse({ ok: false, error: "too_many_connections", limit: MAX_SOCKETS }, 503);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      if (req.headers.get(LIVE_AUTH_HEADER) === "web") { try { server.serializeAttachment({ member: true }); } catch {} }
      server.send(JSON.stringify({ type: "connected", ts: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Internal Worker -> Room broadcast (`https://room.internal/broadcast`)
    if (req.method === "POST" && path === "/broadcast") {
      const declared = Number(req.headers.get("Content-Length"));
      if (Number.isFinite(declared) && declared > MAX_BROADCAST_BYTES) {
        return jsonResponse({ ok: false, error: "payload_too_large", limit: MAX_BROADCAST_BYTES }, 413);
      }
      const text = await req.text();
      if (byteLength(text) > MAX_BROADCAST_BYTES) {
        return jsonResponse({ ok: false, error: "payload_too_large", limit: MAX_BROADCAST_BYTES }, 413);
      }
      let payload;
      try { payload = JSON.parse(text); } catch { return jsonResponse({ ok: false, error: "invalid_json" }, 400); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return jsonResponse({ ok: false, error: "payload_must_be_an_object" }, 400);
      }
      const { sent, skipped } = this.broadcast(payload);
      return jsonResponse({ ok: true, sent, skipped }, 200);
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    try {
      const txt = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (txt === "ping") {
        ws.send("pong");
        return;
      }
      const data = JSON.parse(txt);
      if (data && data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      } else if (data && data.type === "auth") {
        await this.authSocket(ws, data);
      }
    } catch {
      // Ignore malformed client frames
    }
  }

  // {"type":"auth","key"} -> member when the key is good; {"type":"auth","ask"} -> owner of that one guest ask. A bad key changes nothing.
  async authSocket(ws, data) {
    const cur = audienceOf(ws);
    if (typeof data.key === "string" && cur.member !== true) {
      const res = await authenticate(new Request("https://room.internal/auth", { headers: { Authorization: `Board ${data.key}` } }), this.env);
      if (res && res.slug) { ws.serializeAttachment({ ...cur, member: true }); ws.send(JSON.stringify({ type: "auth", ok: true })); return; }
      ws.send(JSON.stringify({ type: "auth", ok: false }));
    } else if (typeof data.ask === "string" && ASK_ID_RE.test(data.ask)) {
      ws.serializeAttachment({ ...cur, ask: data.ask });
      ws.send(JSON.stringify({ type: "auth", ok: true }));
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code, "closed");
    } catch {
      // Already closed
    }
  }
}
