// The web RSVP's "Discord has a newer answer" state (js/brain.js settle) must come from a newer ANSWER, not from a newer stamp alone. A
// same-value RSVP click on the sign-up card re-stamps entry.updated without changing the answer; the web edit waiting for Discord must keep
// waiting, then show as saved. A real change to another answer still shows as newer. Pure: vm, fake fetch, fake timers, no network.
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

test("a same-value re-stamp of the entry does not mark the web answer as overtaken; a real change does", async () => {
  const brain = rig();
  let last = null;
  brain.on("pending", (p) => { last = p; });
  brain.start({});
  await flush();
  brain._state({ ver: 1, signups: entry("in", "2026-11-01T00:00:00.000Z") });
  await brain.setRsvp("maybe");
  assert.equal(last.rsvp.state, "waiting");
  // Ada clicks In again on the card (already In): the answer is the same, the stamp is newer
  brain._state({ ver: 2, signups: entry("in", "2026-11-20T20:01:00.000Z") });
  assert.equal(last.rsvp.state, "waiting", "the same answer with a newer stamp is not a newer answer");
  // Discord then applies the web edit
  brain._state({ ver: 3, signups: entry("maybe", "2026-11-20T20:02:00.000Z") });
  assert.equal(last.rsvp.state, "saved");
});

test("a different answer after the web edit still shows as newer, with that answer", async () => {
  const brain = rig();
  let last = null;
  brain.on("pending", (p) => { last = p; });
  brain.start({});
  await flush();
  brain._state({ ver: 1, signups: entry("in", "2026-11-01T00:00:00.000Z") });
  await brain.setRsvp("maybe");
  brain._state({ ver: 2, signups: entry("late", "2026-11-20T20:01:00.000Z") });
  assert.equal(last.rsvp.state, "newer");
  assert.equal(last.rsvp.other, "late");
});
