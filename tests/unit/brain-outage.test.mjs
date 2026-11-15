// js/brain.js outage handling: a failed bootstrap is not cached for the session, and status().down says when the API cannot be reached (two failed polls in a row with no live socket, or one failed poll after a failed bootstrap). Pure: fake timers, fake WebSocket, scripted fetch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../js/brain.js"), "utf8");

function rig(answer, { doc } = {}) {
  let id = 0; const timers = new Map(), sockets = [], calls = [], delays = [];
  class FakeWS { constructor() { this.readyState = 0; sockets.push(this); } send() {} close() { this.readyState = 3; if (this.onclose) this.onclose(); } open() { this.readyState = 1; if (this.onopen) this.onopen(); } }
  const win = {};
  const ctx = {
    window: win, console, URL, URLSearchParams, Date, JSON, Promise, Math,
    location: { hostname: "leeroy.party", protocol: "https:", href: "https://leeroy.party/", search: "", hash: "", pathname: "/", host: "leeroy.party" },
    history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, WebSocket: FakeWS,
    fetch: (u) => { calls.push(u); return answer(u); },
    setTimeout: (f, ms) => { const t = ++id; timers.set(t, f); delays.push(ms); return t; }, clearTimeout: (t) => { timers.delete(t); },
    setInterval: () => ++id, clearInterval() {},
    ...(doc ? { document: doc } : {}),
  };
  vm.runInNewContext(src, ctx);
  return { brain: win.BoardBrain, sockets, calls, delays };
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

const deferred = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };

test("after an earlier outage, an ordinary socket drop is not an outage and does not announce one", async () => {
  let state = "bad"; const seen = [];
  const { brain, sockets } = rig(() => (state === "bad" ? bad() : ok({ ver: 1 })));
  brain.start({ status: (s) => seen.push(s.down) }); await flush(); await brain._poll(); await flush();
  assert.equal(brain.status().down, true, "the outage itself");
  state = "good"; sockets[0].open(); await flush();
  assert.equal(brain.status().down, false);
  seen.length = 0; state = "bad";
  sockets[0].close(); await flush(); await brain._poll(); await flush();
  assert.equal(brain.status().down, false, "one failed poll after a socket drop is a blip, not an outage");
  assert.ok(!seen.includes(true), "the status handler is never told down");
});

test("a hidden tab does not keep the line up: the socket opening clears the outage with no poll", async () => {
  const doc = { hidden: false, visibilityState: "visible", addEventListener() {} };
  const { brain, sockets } = rig(() => bad(), { doc });
  brain.start({}); await flush(); await brain._poll(); await flush();
  assert.equal(brain.status().down, true);
  doc.hidden = true; doc.visibilityState = "hidden";
  sockets[0].open(); await flush();
  assert.equal(brain.status().down, false);
  sockets[0].close(); await flush();
  assert.equal(brain.status().down, false, "closing while hidden runs no poll and must not bring the line back");
});

test("two polls started at once make one request (tab return fires visibilitychange and focus together)", async () => {
  const d = deferred();
  const { brain, calls } = rig((u) => (/\/state/.test(u) ? d.p : bad()));
  brain.start({}); await flush();
  const n0 = calls.filter((u) => /\/state/.test(u)).length;
  const a = brain._poll(), b = brain._poll(), c = brain._poll();
  assert.equal(calls.filter((u) => /\/state/.test(u)).length, n0, "no new request while one is in flight");
  d.res({ status: 503, ok: false, json: async () => { throw new Error("html"); } });
  await Promise.all([a, b, c]); await flush();
  assert.equal(brain.status().errors, 1, "one bad answer counts once");
  assert.equal(brain.status().down, false);
});

test("a failed bootstrap stops counting after the first good poll", async () => {
  let state = "bad";
  const { brain } = rig(() => (state === "bad" ? bad() : ok({ ver: 1 })));
  assert.equal(await brain.bootstrap(), null);
  brain.start({}); await flush();
  assert.equal(brain.status().down, true, "failed bootstrap plus one failed poll is down");
  state = "good"; await brain._poll(); await flush();
  assert.equal(brain.status().down, false);
  state = "bad"; await brain._poll(); await flush();
  assert.equal(brain.status().down, false, "a single failed poll after recovery is a blip");
});

test("while offline the next poll is not two minutes away", async () => {
  const { brain, delays } = rig(() => Promise.reject(new Error("net")));
  brain.start({}); await flush(); await brain._poll(); await flush();
  assert.ok(delays.length > 0 && Math.min(...delays.slice(-2)) <= 30000, `scheduled ${delays.slice(-3)}`);
  assert.ok(delays[delays.length - 1] <= 30000, `last poll delay ${delays[delays.length - 1]}`);
});
