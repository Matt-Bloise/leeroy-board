// js/brain.js outage handling: a failed bootstrap is not cached for the session, and status().down says when the API cannot be reached (two failed polls in a row with no live socket, or one failed poll after a failed bootstrap). Pure: fake timers, fake WebSocket, scripted fetch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../js/brain.js"), "utf8");

function rig(answer) {
  let id = 0; const timers = new Map(), sockets = [], calls = [];
  class FakeWS { constructor() { this.readyState = 0; sockets.push(this); } send() {} close() { this.readyState = 3; if (this.onclose) this.onclose(); } open() { this.readyState = 1; if (this.onopen) this.onopen(); } }
  const win = {};
  const ctx = {
    window: win, console, URL, URLSearchParams, Date, JSON, Promise, Math,
    location: { hostname: "leeroy.party", protocol: "https:", href: "https://leeroy.party/", search: "", hash: "", pathname: "/", host: "leeroy.party" },
    history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, WebSocket: FakeWS,
    fetch: (u) => { calls.push(u); return answer(u); },
    setTimeout: (f) => { const t = ++id; timers.set(t, f); return t; }, clearTimeout: (t) => { timers.delete(t); },
    setInterval: () => ++id, clearInterval() {},
  };
  vm.runInNewContext(src, ctx);
  return { brain: win.BoardBrain, sockets, calls };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const ok = (body) => Promise.resolve({ status: 200, ok: true, json: async () => body });
const bad = () => Promise.resolve({ status: 503, ok: false, json: async () => { throw new Error("html"); } });

test("a failed bootstrap is retried on the next call, not cached as null", async () => {
  let up = false;
  const { brain, calls } = rig((u) => (/\/bootstrap/.test(u) ? (up ? ok({ ver: 3, launch: [] }) : bad()) : bad()));
  assert.equal(await brain.bootstrap(), null);
  up = true;
  const j = await brain.bootstrap();
  assert.ok(j && j.ver === 3, "second call must reach the network and succeed");
  assert.equal(calls.filter((u) => /\/bootstrap/.test(u)).length, 2);
});

test("a good bootstrap is still cached: one request for any number of callers", async () => {
  const { brain, calls } = rig((u) => (/\/bootstrap/.test(u) ? ok({ ver: 1 }) : bad()));
  await Promise.all([brain.bootstrap(), brain.bootstrap(), brain.bootstrap()]); await brain.bootstrap();
  assert.equal(calls.filter((u) => /\/bootstrap/.test(u)).length, 1);
});

test("down is false while healthy, true after two failed polls, false again after a good one", async () => {
  let state = "bad"; const seen = [];
  const { brain } = rig(() => (state === "bad" ? bad() : ok({ ver: 1 })));
  brain.start({ status: (s) => seen.push(s.down) }); await flush();
  assert.equal(brain.status().down, false, "one failed poll is not an outage yet");
  await brain._poll(); await flush();
  assert.equal(brain.status().down, true);
  assert.ok(seen.includes(true), "the status handler is told");
  state = "good"; await brain._poll(); await flush();
  assert.equal(brain.status().down, false);
});

test("a network error counts like a 503", async () => {
  const { brain } = rig(() => Promise.reject(new Error("net")));
  brain.start({}); await flush(); await brain._poll(); await flush();
  assert.equal(brain.status().down, true);
});

test("a live socket means not down, whatever the polls did", async () => {
  const { brain, sockets } = rig(() => bad());
  brain.start({}); await flush(); await brain._poll(); await flush();
  assert.equal(brain.status().down, true);
  sockets[0].open(); await flush();
  assert.equal(brain.status().down, false);
});

test("a dead socket with healthy polls is not an outage", async () => {
  const { brain, sockets } = rig(() => ok({ ver: 1 }));
  brain.start({}); await flush(); sockets[0].open(); sockets[0].close(); await flush();
  assert.equal(brain.status().down, false);
});
