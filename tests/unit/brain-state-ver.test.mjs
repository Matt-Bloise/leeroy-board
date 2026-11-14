// The Worker's /state always carries ver 1. A waiting web RSVP must still reach Saved (or newer) when a later /state, or the live socket's
// { type: "data", key: "signups" } message, brings the saved sign-ups. Before this fix the brain dropped every equal-ver state once sign-ups
// were loaded and ignored the socket's sign-up documents, so the RSVP ended at "stored" forever. Runs the real js/brain.js in a vm with a
// fake fetch and a fake WebSocket. Fictional data only. Run: node --test tests/unit/brain-state-ver.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../js/brain.js"), "utf8");

const SENT_AT = "2026-11-20T20:00:00.000Z";
function rig() {
  const stored = { "board-key": "fictional_key_abcdefghijklmnop" };
  const sockets = [];
  const fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || "GET";
    let body = {};
    if (u.endsWith("/me")) body = { slug: "ada", name: "Ada", pending: [] };
    else if (u.endsWith("/intent") && method === "POST") body = { at: SENT_AT, seq: 1 };
    return { status: 200, ok: true, json: async () => body };
  };
  class FakeWS { constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); } send() {} close() {} }
  const win = {};
  const ctx = {
    window: win, console, URL, URLSearchParams, Date, JSON, Promise, Math,
    location: { hostname: "leeroy.party", protocol: "https:", href: "https://leeroy.party/", search: "", hash: "", pathname: "/", host: "leeroy.party" },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } },
    WebSocket: FakeWS, fetch,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(src, ctx);
  return { brain: win.BoardBrain, sockets };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const doc = (rsvp, updated) => ({ entries: [{ name: "Ada", slug: "ada", rsvp, updated }] });

async function waiting() {
  const r = rig();
  let last = null, states = 0;
  r.brain.on("pending", (p) => { last = p; });
  r.brain.on("state", () => { states++; });
  r.brain.start({});
  await flush();
  r.brain._state({ type: "state", ver: 1, at: "2026-11-20T19:00:00.000Z", signups: doc("in", "2026-11-01T00:00:00.000Z") });
  await r.brain.setRsvp("maybe");
  assert.equal(last.rsvp.state, "waiting");
  return { ...r, last: () => last, states: () => states };
}

test("a later /state with the same ver 1 but the saved answer settles the web RSVP as Saved", async () => {
  const w = await waiting();
  assert.equal(w.brain._state({ type: "state", ver: 1, at: "2026-11-20T20:00:15.000Z", signups: doc("maybe", SENT_AT) }), true);
  assert.equal(w.last().rsvp.state, "saved");
});

test("a later /state with ver 1 and a different answer after the edit shows newer", async () => {
  const w = await waiting();
  w.brain._state({ type: "state", ver: 1, at: "2026-11-20T20:01:15.000Z", signups: doc("late", "2026-11-20T20:01:00.000Z") });
  assert.equal(w.last().rsvp.state, "newer");
  assert.equal(w.last().rsvp.other, "late");
});

test("an identical ver 1 state is still dropped (no re-render on every poll); an older ver is refused", async () => {
  const w = await waiting();
  const before = w.states();
  assert.equal(w.brain._state({ type: "state", ver: 1, at: "2026-11-20T20:00:30.000Z", signups: doc("in", "2026-11-01T00:00:00.000Z") }), false);
  assert.equal(w.states(), before);
  assert.equal(w.brain._state({ type: "state", ver: 0, signups: doc("maybe", SENT_AT) }), false);
  assert.equal(w.last().rsvp.state, "waiting");
});

test("the live socket's sign-up document settles the web RSVP too", async () => {
  const w = await waiting();
  const ws = w.sockets[w.sockets.length - 1];
  assert.ok(ws && typeof ws.onmessage === "function", "the brain opened a socket");
  ws.onmessage({ data: JSON.stringify({ type: "data", key: "signups", data: doc("maybe", SENT_AT) }) });
  assert.equal(w.last().rsvp.state, "saved");
  // a malformed or unrelated data message changes nothing
  ws.onmessage({ data: JSON.stringify({ type: "data", key: "signups", data: { nope: 1 } }) });
  ws.onmessage({ data: JSON.stringify({ type: "data", key: "party", data: doc("late", "2026-11-20T21:00:00.000Z") }) });
  assert.equal(w.last().rsvp.state, "saved");
});

test("review: an older document (cached /state, late socket message) never rolls the board back", async () => {
  const w = await waiting();
  const ws = w.sockets[w.sockets.length - 1];
  ws.onmessage({ data: JSON.stringify({ type: "data", key: "signups", data: doc("maybe", SENT_AT) }) });
  assert.equal(w.last().rsvp.state, "saved");
  assert.equal(w.brain._state({ type: "state", ver: 1, at: "2026-11-20T20:00:40.000Z", signups: doc("in", "2026-11-01T00:00:00.000Z") }), false, "the cached older /state is refused");
  assert.equal(w.brain.mine().rsvp, "maybe");
  ws.onmessage({ data: JSON.stringify({ type: "data", key: "signups", data: doc("in", "2026-11-01T00:00:00.000Z") }) });
  assert.equal(w.brain.mine().rsvp, "maybe", "an older socket document is refused too");
});

test("review: a document with a bad row is ignored without throwing; a /state without sign-ups re-emits nothing", async () => {
  const w = await waiting();
  const ws = w.sockets[w.sockets.length - 1];
  assert.doesNotThrow(() => ws.onmessage({ data: JSON.stringify({ type: "data", key: "signups", data: { entries: [null, { name: "Ada", slug: "ada", rsvp: "maybe", updated: SENT_AT }] } }) }));
  assert.equal(w.last().rsvp.state, "waiting");
  let party = 0;
  w.brain.on("party", () => { party++; });
  for (let i = 0; i < 3; i++) w.brain._state({ type: "state", ver: 1, at: `2026-11-20T20:0${i}:00.000Z`, party: [], signups: null });
  assert.equal(party, 0);
});
