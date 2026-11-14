// What the board shows for a web RSVP when the sign-up card re-stamps an entry with the same answer (cards.js: an RSVP click always stamps).
// POST /intent applies the web edit in the same request (infrastructure/worker/index.js), so by the time a card click can re-stamp the entry
// it already holds the web answer: settle() sees the web value and shows Saved, never "Discord has a newer answer". A different answer
// clicked after the web edit is a real newer answer and still shows as one. Runs the real js/brain.js in a vm with a fake fetch, unchanged.
// Fictional data only. Run: node --test tests/unit/brain-rsvp-restamp.test.mjs
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
  const fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || "GET";
    let body = {};
    if (u.endsWith("/me")) body = { slug: "ada", name: "Ada", pending: [] };
    else if (u.endsWith("/intent") && method === "POST") body = { at: SENT_AT, seq: 1 };
    return { status: 200, ok: true, json: async () => body };
  };
  class FakeWS { constructor() { this.readyState = 0; } send() {} close() {} }
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
  return win.BoardBrain;
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const entry = (rsvp, updated) => ({ entries: [{ name: "Ada", slug: "ada", rsvp, updated }] });

async function sent(brain) {
  let last = null;
  brain.on("pending", (p) => { last = p; });
  brain.start({});
  await flush();
  brain._state({ ver: 1, signups: entry("in", "2026-11-01T00:00:00.000Z") });
  await brain.setRsvp("maybe");
  return () => last;
}

test("a same-value card click after the web edit (the entry already holds the web answer, newer stamp) shows Saved", async () => {
  const b = rig(); const l = await sent(b);
  assert.equal(l().rsvp.state, "waiting");
  // the Worker applied the web edit at SENT_AT; Ada then clicks Tentative again on the card: same answer, newer stamp
  b._state({ ver: 2, signups: entry("maybe", "2026-11-20T20:01:00.000Z") });
  assert.equal(l().rsvp.state, "saved");
});

test("a different answer after the web edit still shows as newer, with that answer", async () => {
  const b = rig(); const l = await sent(b);
  b._state({ ver: 2, signups: entry("late", "2026-11-20T20:01:00.000Z") });
  assert.equal(l().rsvp.state, "newer");
  assert.equal(l().rsvp.other, "late");
});

test("setting the old answer back after the web edit is a newer answer too", async () => {
  const b = rig(); const l = await sent(b);
  b._state({ ver: 2, signups: entry("in", "2026-11-20T20:01:00.000Z") });
  assert.equal(l().rsvp.state, "newer");
  assert.equal(l().rsvp.other, "in");
});
