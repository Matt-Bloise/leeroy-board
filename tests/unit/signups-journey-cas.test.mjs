// Follow-up to audit 2026-11-06 finding 2 (PR 203): the journey intent used to read the whole sign-ups document, change `journeys` in JS and
// write it back unguarded, so it could erase a sign-up written in between (and a sign-up could erase it). It now goes through updateKvJson
// like the other sign-up writers. A protected member write and a journey write racing each other must both land; contention is a 409.
// Real Worker over an in-memory SQLite D1 whose calls interleave like concurrent requests do. No network, made-up keys and names.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const SALT = "salt-for-tests-0123456789";
const KEYS = { bloise: "member-key-bloise-0123456789ab", santa: "member-key-santa-0123456789abc" };
const room = { fetch: async () => new Response("ok") };
const ctx = { waitUntil() {}, passThroughOnException() {} };

const latent = (d1) => {
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    raw: d1.raw, exec: d1.exec,
    batch: async (list) => { await tick(); return d1.batch(list); },
    prepare: (sql) => {
      const st = d1.prepare(sql), w = { bind: (...a) => (st.bind(...a), w), _run: () => st._run() };
      for (const m of ["all", "first", "run"]) w[m] = async () => { await tick(); return st[m](); };
      return w;
    },
  };
};
async function makeEnv(signups) {
  const DB = schemaDb();
  for (const [slug, key] of Object.entries(KEYS)) DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, '2026-11-01T00:00:00Z')").run(slug, await sha256Hex(`${SALT}:${key}`));
  if (signups) DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('signups', ?, '2026-10-29T00:00:00Z')").run(JSON.stringify(signups));
  return { DB: latent(DB), raw: DB, KEY_SALT: SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
async function post(env, who, path, body) {
  const silence = console.error; console.error = () => {};
  try {
    return await worker.fetch(new Request(`https://api.test/api${path}`, { method: "POST", headers: { Authorization: `Board ${KEYS[who]}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(body) }), env, ctx);
  } finally { console.error = silence; }
}
const kv = (env, key) => { const r = env.raw.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key); return r ? JSON.parse(r.json) : null; };
const SEED = () => ({ options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [{ name: "Street Rat", rsvp: "in" }] });

test("journey intent and a protected member sign-up racing: both land, in every round", async () => {
  for (let round = 0; round < 6; round++) {
    const env = await makeEnv(SEED());
    const res = await Promise.all([
      post(env, "bloise", "/intent", { kind: "journey", patch: { journey: "guided" } }),
      post(env, "santa", "/signups", { patch: { rsvp: "late", when: "6pm" } }),
      post(env, "bloise", "/signups", { patch: { pack: "yes" } }),
      post(env, "santa", "/intent", { kind: "journey", patch: { journey: "everything" } }),
    ]);
    assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200]);
    const doc = kv(env, "signups");
    assert.equal(doc.journeys.find((j) => j.slug === "bloise").journey, "guided");
    assert.equal(doc.journeys.find((j) => j.slug === "santa").journey, "everything");
    assert.equal(doc.journeys.length, 2, "no duplicated journey row");
    const santa = doc.entries.find((e) => e.slug === "santa");
    assert.equal(santa.rsvp, "late"); assert.equal(santa.when, "6pm");
    assert.equal(doc.entries.find((e) => e.slug === "bloise").pack, "yes");
    assert.ok(doc.entries.some((e) => e.name === "Street Rat"), "the seed row survives");
  }
});

test("journey intent with no sign-ups row writes nothing and still answers 200 (as before)", async () => {
  const env = await makeEnv(null);
  const res = await post(env, "bloise", "/intent", { kind: "journey", patch: { journey: "curious" } });
  assert.equal(res.status, 200);
  assert.equal(kv(env, "signups"), null);
});

test("journey intent: sustained contention answers 409, never a silent overwrite", async () => {
  const env = await makeEnv(SEED());
  // another writer changes the document between every read and write of the journey request
  const inner = env.DB;
  env.DB = { ...inner, prepare: (sql) => {
    const w = inner.prepare(sql);
    if (/^UPDATE kv_state SET json = \?, updated_at = \? WHERE key = \? AND json = \?/.test(sql)) {
      const run = w.all;
      w.all = async () => { env.raw.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'signups'").run(JSON.stringify({ ...SEED(), n: Math.random() })); return run(); };
    }
    return w;
  } };
  const res = await post(env, "bloise", "/intent", { kind: "journey", patch: { journey: "guided" } });
  assert.equal(res.status, 409);
  assert.ok(!("journeys" in kv(env, "signups")), "the stale journey write did not land");
});
