// Characterisation tests for js/brain.js forget() and the WebSocket retry timer. Audit suspicion: forget() clears the retry timer (B.wsT) and never reconnects. Finding: forget() ends with openWs(), which reopens the socket or re-arms the retry timer, so the live connection is not lost. Pure: fake timers, fake WebSocket, fake fetch, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../js/brain.js"), "utf8");

function rig({ fetchFails = false } = {}) {
  let now = 0, id = 0; const timers = new Map(), sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.closed = false; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.closed = true; this.readyState = 3; if (this.onclose) this.onclose(); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    drop() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const win = {};
  const ctx = {
    window: win, console, URL, URLSearchParams, Date, JSON, Promise, Math,
    location: { hostname: "leeroy.party", protocol: "https:", href: "https://leeroy.party/", search: "", hash: "", pathname: "/", host: "leeroy.party" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: FakeWS,
    fetch: () => (fetchFails ? Promise.reject(new Error("down")) : Promise.resolve({ status: 200, ok: true, json: async () => ({}) })),
    setTimeout: (f, ms) => { const t = ++id; timers.set(t, { at: now + ms, f }); return t; },
    clearTimeout: (t) => { timers.delete(t); },
    setInterval: (f, ms) => { const t = ++id; timers.set(t, { at: now + ms, f, every: ms }); return t; },
    clearInterval: (t) => { timers.delete(t); },
  };
  vm.runInNewContext(src, ctx);
  const clock = {
    advance(ms) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; if (due[1].every) due[1].at += due[1].every; else timers.delete(due[0]); due[1].f(); } now = end; },
    pending: () => timers.size,
  };
  return { brain: win.BoardBrain, sockets, clock };
}
const flush = () => new Promise((r) => setImmediate(r));

test("forget() while the socket is down and waiting on its retry timer reopens a socket", async () => {
  const { brain, sockets } = rig();
  brain.start({}); await flush();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  sockets[0].drop();
  assert.equal(brain.status().via, "poll");
  brain.forget();
  assert.equal(sockets.length, 2, "forget() must call openWs");
});

test("forget() while the socket is open closes it, falls back to poll, and opens a fresh socket", async () => {
  const { brain, sockets } = rig();
  brain.start({}); await flush();
  sockets[0].open();
  assert.equal(brain.status().via, "ws");
  brain.forget();
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  assert.equal(brain.status().via, "poll");
  sockets[1].open();
  assert.equal(brain.status().via, "ws");
});

test("forget() while offline keeps a retry timer armed that later reopens the socket", async () => {
  const { brain, sockets, clock } = rig({ fetchFails: true });
  brain.start({}); await flush(); await flush();
  assert.equal(brain.status().offline, true);
  sockets[0].drop();
  brain.forget();
  assert.equal(sockets.length, 1, "offline: no new socket yet");
  assert.ok(clock.pending() > 0, "a retry timer must still be pending");
});

test("a dropped socket is retried by its own timer after WS_RETRY_MS", async () => {
  const { brain, sockets, clock } = rig();
  brain.start({}); await flush();
  sockets[0].open();
  sockets[0].drop();
  clock.advance(121000);
  assert.ok(sockets.length >= 2);
});
