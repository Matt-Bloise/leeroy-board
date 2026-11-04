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
  broadcast(msg) {
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
    const sockets = this.ctx.getWebSockets();
    let sent = 0;
    for (const ws of sockets.slice(0, MAX_BROADCAST_RECIPIENTS)) {
      try {
        ws.send(raw);
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
      }
    } catch {
      // Ignore malformed client frames
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
