// =============================================================================
// `BoardRoom` Hibernatable WebSocket Durable Object (SQLite-backed)
// Coordinates real-time presence, character sheet edits, signups, and
// broadcasts D1 library/ask/data updates to all connected party members in <5ms.
// =============================================================================

import { purgeWorkerCache } from "./index.js";

export class BoardRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_kv (
          key TEXT PRIMARY KEY,
          json TEXT NOT NULL
        );
      `);
    });
  }

  getJson(key, fallback) {
    const rows = [...this.sql.exec("SELECT json FROM room_kv WHERE key = ?", key)];
    if (!rows.length) return fallback;
    try {
      return JSON.parse(rows[0].json);
    } catch {
      return fallback;
    }
  }

  setJson(key, val) {
    this.sql.exec(
      "INSERT INTO room_kv (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json",
      key,
      JSON.stringify(val)
    );
  }

  getFullState() {
    return {
      sheets: this.getJson("sheets", {}),
      intents: this.getJson("intents", []),
      updatedAt: this.getJson("updatedAt", new Date().toISOString()),
    };
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
      server.send(JSON.stringify({ type: "state", state: this.getFullState() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. GET `/api/state`
    if (req.method === "GET" && path === "/state") {
      return new Response(JSON.stringify(this.getFullState()), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 3. POST `/api/sheet` (Character sheet & signup updates)
    if (req.method === "POST" && path === "/sheet") {
      const body = await req.json();
      const member = String(body.member || "").trim().toLowerCase();
      if (!member) {
        return new Response(JSON.stringify({ error: "Missing member" }), { status: 400 });
      }
      const sheets = this.getJson("sheets", {});
      const now = new Date().toISOString();
      sheets[member] = {
        ...(sheets[member] || {}),
        ...(body.patch || {}),
        updatedAt: now,
      };
      this.setJson("sheets", sheets);
      this.setJson("updatedAt", now);

      // Also persist party sheet overrides into D1 `kv_state` if party doc exists
      try {
        const partyRow = await this.env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first();
        if (partyRow) {
          const party = JSON.parse(partyRow.json);
          const m = (party.members || []).find(
            (x) => (x.name || "").toLowerCase() === member || (x.class_key || "").toLowerCase() === member
          );
          if (m && body.patch) {
            if (body.patch.race) m.race = body.patch.race;
            if (body.patch.spec) m.spec = body.patch.spec;
            if (body.patch.professions) m.professions = body.patch.professions;
            if (body.patch.note !== undefined) m.note = body.patch.note;
            await this.env.DB.prepare(
              "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'party'"
            )
              .bind(JSON.stringify(party), now)
              .run();
            await purgeWorkerCache(url.origin, ["/api/bootstrap", "/api/data/party.json"]);
          }
        }
      } catch (e) {
        console.error("Failed to sync sheet to D1 party:", e);
      }

      const state = this.getFullState();
      this.broadcast({ type: "sheet", member, sheet: sheets[member], state });
      return new Response(JSON.stringify({ ok: true, sheet: sheets[member], state }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 4. Internal Worker -> Room broadcast (`https://room.internal/broadcast`)
    if (req.method === "POST" && path === "/broadcast") {
      const payload = await req.json();
      const now = new Date().toISOString();

      if (payload.item || payload.intent) {
        const item = payload.item || payload.intent;
        const intents = this.getJson("intents", []);
        const idx = intents.findIndex((x) => x.id === item.id);
        if (idx >= 0) intents[idx] = { ...intents[idx], ...item };
        else intents.unshift(item);
        this.setJson("intents", intents.slice(0, 30));
        this.setJson("updatedAt", now);
      }

      const state = this.getFullState();
      this.broadcast({ ...payload, state });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      if (data.type === "ping") {
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
