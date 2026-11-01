// =============================================================================
// `BoardRoom` Hibernatable WebSocket Durable Object
// Zero-SQLite pub/sub hub coordinates real-time push events to connected browsers:
// character sheet edits, signups, library updates, and ask Q&A completions.
// =============================================================================

export class BoardRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    try {
      // Intercept client "ping" keepalives at Cloudflare edge without waking Durable Object
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {}
  }

  broadcast(msg) {
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(raw);
      } catch {
        // Closed socket will be cleaned up by webSocketClose
      }
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";

    // 1. WebSocket Upgrade (`/api/live`) using Hibernatable WebSockets API
    if (path === "/live") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket Upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "connected", ts: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Internal Worker -> Room broadcast (`https://room.internal/broadcast`)
    if (req.method === "POST" && path === "/broadcast") {
      const payload = await req.json();
      this.broadcast(payload);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
