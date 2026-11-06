// Audit 2026-11-06 finding 2: overlapping POST /api/signups and POST /api/sheet used to lose each other's fields (read, change in JS, write the
// whole document back). Twelve writes fired at once must all survive. Real Worker over an in-memory SQLite D1 whose calls interleave like
// concurrent requests do. No network, made-up keys.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { updateKvJson, KvConflictError } from "../../infrastructure/worker/kv-cas.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const SALT = "salt-for-tests-0123456789";
const KEYS = { bloise: "member-key-bloise-0123456789ab", santa: "member-key-santa-0123456789abc" };
const room = { fetch: async () => new Response("ok") };
const ctx = { waitUntil() {}, passThroughOnException() {} };

// Every D1 call yields to the event loop first, the way a network round trip to D1 does, so overlapping requests really interleave.
const latent = (d1) => {
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    raw: d1.raw,
    exec: d1.exec,
    batch: async (list) => { await tick(); return d1.batch(list); },
    prepare: (sql) => {
      const st = d1.prepare(sql), w = { bind: (...a) => (st.bind(...a), w), _run: () => st._run() };
      for (const m of ["all", "first", "run"]) w[m] = async () => { await tick(); return st[m](); };
      return w;
    },
  };
};

async function makeEnv(signups) {
  const raw = schemaDb(), DB = raw;
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

// five different fields per member, plus one repeat of the first: 12 writes in all
const SIGNUP_PATCHES = [{ pack: "yes" }, { when: "6pm" }, { meet: "The Crossroads" }, { rsvp: "late" }, { meet_other: "x1" }, { pack: "yes" }];
const EXPECT = { pack: "yes", when: "6pm", meet: "The Crossroads", rsvp: "late", meet_other: "x1" };

for (const [label, seed] of [["no sign-ups row yet", null], ["an existing sign-ups row", { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [{ name: "Street Rat", rsvp: "in" }] }]]) {
  test(`12 parallel POST /signups (${label}): every field of both members survives`, async () => {
    const env = await makeEnv(seed);
    const calls = ["bloise", "santa"].flatMap((who) => SIGNUP_PATCHES.map((patch) => post(env, who, "/signups", { patch })));
    const res = await Promise.all(calls);
    assert.deepEqual(res.map((r) => r.status), Array(12).fill(200));
    const doc = kv(env, "signups");
    for (const slug of ["bloise", "santa"]) {
      const rows = doc.entries.filter((e) => e.slug === slug);
      assert.equal(rows.length, 1, `${slug} has one row`);
      for (const [k, v] of Object.entries(EXPECT)) assert.equal(rows[0][k], v, `${slug}.${k}`);
    }
    assert.equal(doc.entries.length, seed ? 3 : 2, "no row was lost or duplicated");
  });
}

test("12 parallel POST /intent signup: every field survives", async () => {
  const env = await makeEnv(null);
  const mk = (k, v) => ({ kind: "signup", field: k, value: v });
  const bodies = [mk("rsvp", "late"), mk("when", "6pm"), mk("pack", "yes"), mk("meet", "The Crossroads"), mk("rsvp", "late"), mk("when", "6pm")];
  const res = await Promise.all(["bloise", "santa"].flatMap((who) => bodies.map((b) => post(env, who, "/intent", b))));
  assert.deepEqual(res.map((r) => r.status), Array(12).fill(200));
  const doc = kv(env, "signups");
  for (const slug of ["bloise", "santa"]) {
    const row = doc.entries.find((e) => e.slug === slug);
    assert.equal(row.rsvp, "late"); assert.equal(row.when, "6pm"); assert.equal(row.pack, "yes");
  }
});

test("12 parallel POST /sheet: every field of both members survives", async () => {
  const env = await makeEnv(null);
  const FIELDS = [["race", "tauren"], ["class", "druid"], ["spec_path", "feral-tank"], ["level", 12], ["plan_zone", "mulgore"], ["goals", ["a pack"]]];
  const res = await Promise.all(["bloise", "santa"].flatMap((who) => FIELDS.map(([field, value]) => post(env, who, "/sheet", { field, value }))));
  assert.deepEqual(res.map((r) => r.status), Array(12).fill(200));
  const party = kv(env, "party_sheets");
  for (const slug of ["bloise", "santa"]) {
    const sheet = party.find((p) => p.slug === slug);
    for (const [field, value] of FIELDS) assert.deepEqual(sheet.fields[field] && sheet.fields[field].value, value, `${slug}.${field}`);
  }
  const events = env.raw.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n;
  assert.equal(Number(events), 12, "one event per write");
});

test("updateKvJson: a stale write is retried on the fresh document, and gives up with KvConflictError", async () => {
  const env = await makeEnv(null);
  env.raw.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('t', '{\"n\":0}', 'x')").run();
  let attempts = 0;
  const bump = async (cur, attempt) => { attempts++; if (attempt === 0) env.raw.raw.prepare("UPDATE kv_state SET json = '{\"n\":5}' WHERE key = 't'").run(); return { doc: { n: cur.n + 1 } }; };
  const out = await updateKvJson(env, "t", bump);
  assert.equal(attempts, 2);
  assert.deepEqual(kv(env, "t"), { n: 6 });
  assert.equal(out.doc.n, 6);
  const always = async (cur) => { env.raw.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 't'").run(JSON.stringify({ n: Math.random() })); return { doc: { n: -1 } }; };
  await assert.rejects(() => updateKvJson(env, "t", always, { tries: 3 }), KvConflictError);
});
