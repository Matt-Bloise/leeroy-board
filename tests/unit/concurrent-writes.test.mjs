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
// 12 writers against 8 tries each is not a guaranteed win: every round has at least one winner, so the unluckiest writer can lose 8 rounds in a row when the
// machine is loaded and the retry timers fire in lockstep. The Worker answers that case with 409 "busy, try again", which is its contract. A client
// retries on 409, so the parallel tests do too (up to 3 more times); what they prove is that no write is lost or overwritten, not that nobody is ever told to retry.
async function postRetry(env, who, path, body) {
  let res = await post(env, who, path, body);
  for (let i = 0; i < 3 && res.status === 409; i++) res = await post(env, who, path, body);
  return res;
}
const kv = (env, key) => { const r = env.raw.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key); return r ? JSON.parse(r.json) : null; };

// five different fields per member, plus one repeat of the first: 12 writes in all
const SIGNUP_PATCHES = [{ pack: "yes" }, { when: "6pm" }, { meet: "The Crossroads" }, { rsvp: "late" }, { meet_other: "x1" }, { pack: "yes" }];
const EXPECT = { pack: "yes", when: "6pm", meet: "The Crossroads", rsvp: "late", meet_other: "x1" };

for (const [label, seed] of [["no sign-ups row yet", null], ["an existing sign-ups row", { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [{ name: "Street Rat", rsvp: "in" }] }]]) {
  test(`12 parallel POST /signups (${label}): every field of both members survives`, async () => {
    const env = await makeEnv(seed);
    const calls = ["bloise", "santa"].flatMap((who) => SIGNUP_PATCHES.map((patch) => postRetry(env, who, "/signups", { patch })));
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
  const res = await Promise.all(["bloise", "santa"].flatMap((who) => bodies.map((b) => postRetry(env, who, "/intent", b))));
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
  const res = await Promise.all(["bloise", "santa"].flatMap((who) => FIELDS.map(([field, value]) => postRetry(env, who, "/sheet", { field, value }))));
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

// ---- Privacy and atomicity (council review of PR 203) ----
const PARTY_DOC = () => ({ members: [{ name: "Bloise", race: "Undead", class: "Mage" }, { name: "Santa", race: "Tauren" }] });
async function envWithParty() {
  const env = await makeEnv(null);
  env.raw.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ?, '2026-10-29T00:00:00Z')").run(JSON.stringify(PARTY_DOC()));
  return env;
}
const bloiseParty = (env) => kv(env, "party").members.find((m) => m.name === "Bloise");

for (const order of ["visible-then-hide", "hide-then-visible", "parallel"]) {
  test(`hidden field never stays in the public party doc (${order}, repeated)`, async () => {
    for (let round = 0; round < 8; round++) {
      const env = await envWithParty();
      const show = () => post(env, "bloise", "/sheet", { field: "race", value: "Orc", visible: true });
      const hide = () => post(env, "bloise", "/sheet", { field: "race", value: "Orc", visible: false });
      let res;
      if (order === "visible-then-hide") res = [await show(), await hide()];
      else if (order === "hide-then-visible") res = [await hide(), await show()];
      else res = await Promise.all([show(), hide()]);
      assert.ok(res.every((r) => r.status === 200), "both writes succeed");
      const sheet = kv(env, "party_sheets").find((p) => p.slug === "bloise").fields.race;
      const pub = bloiseParty(env).race;
      // the invariant: whenever the final sheet says hidden, the public doc has no race; when visible, it shows exactly the sheet value
      if (sheet.visible === false) assert.equal(pub, undefined, `hidden race leaked: ${pub}`);
      else assert.equal(pub, String(sheet.value));
      if (order === "visible-then-hide") assert.equal(pub, undefined);
      if (order === "hide-then-visible") assert.equal(pub, "Orc");
    }
  });
}

test("hide removes a value published earlier, and a later write self-heals a stale public value of another member", async () => {
  const env = await envWithParty();
  await post(env, "bloise", "/sheet", { field: "race", value: "Orc", visible: true });
  assert.equal(bloiseParty(env).race, "Orc");
  await post(env, "bloise", "/sheet", { field: "race", value: "Orc", visible: false });
  assert.equal(bloiseParty(env).race, undefined);
  // someone re-publishes the hidden value out of band; the next write re-derives it away
  const doc = kv(env, "party"); doc.members[0].race = "Orc";
  env.raw.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'party'").run(JSON.stringify(doc));
  await post(env, "bloise", "/sheet", { field: "level", value: 5 });
  assert.equal(bloiseParty(env).race, undefined);
});

test("a failing public update fails the request and writes nothing (no hidden value left public, no ghost event)", async () => {
  const env = await envWithParty();
  await post(env, "bloise", "/sheet", { field: "race", value: "Orc", visible: true });
  const before = { party: kv(env, "party"), sheets: kv(env, "party_sheets"), events: env.raw.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n };
  const real = env.DB.batch;
  env.DB.batch = async () => { throw new Error("D1 down"); };
  const res = await post(env, "bloise", "/sheet", { field: "race", value: "Orc", visible: false });
  env.DB.batch = real;
  assert.equal(res.status, 500);
  assert.deepEqual(kv(env, "party"), before.party);
  assert.deepEqual(kv(env, "party_sheets"), before.sheets);
  assert.equal(env.raw.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n, before.events);
});

test("a 409 after exhausted retries leaves no ghost event for a later rebuild", async () => {
  const env = await envWithParty();
  const realPrepare = env.DB.prepare;
  // every sheet commit loses its race: the row's text changes between the read and the batch
  env.DB.prepare = (sql) => {
    const st = realPrepare(sql);
    if (/FROM kv_state WHERE key IN \('party_sheets', 'party'\)/.test(sql)) {
      const all = st.all;
      st.all = async () => { const r = await all.call(st); env.raw.raw.prepare("UPDATE kv_state SET json = json || ' ' WHERE key IN ('party_sheets')").run(); return r; };
    }
    return st;
  };
  env.raw.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party_sheets', '[]', 'x')").run();
  const res = await post(env, "bloise", "/sheet", { field: "race", value: "Orc", visible: true });
  env.DB.prepare = realPrepare;
  assert.equal(res.status, 409);
  assert.equal(env.raw.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n, 0, "no committed event");
  const { party } = await (await import("../../infrastructure/worker/index.js")).buildPartySheetsFromD1({ DB: env.raw }, { persist: false });
  const sheet = party.find((p) => p.slug === "bloise");
  assert.notEqual(sheet && sheet.fields.race && sheet.fields.race.value, "Orc", "rebuild does not resurrect the rejected write");
});

test("first write on an empty kv_state succeeds on attempt 1, with no retry sleep", async () => {
  const env = await makeEnv(null);
  let sleeps = 0, batches = 0;
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms > 0) sleeps++; return realSet(fn, ms, ...a); };
  const rb = env.DB.batch; env.DB.batch = async (l) => { batches++; return rb(l); };
  try {
    const res = await post(env, "bloise", "/sheet", { field: "race", value: "orc", visible: true });
    assert.equal(res.status, 200);
  } finally { globalThis.setTimeout = realSet; }
  assert.equal(batches, 1, "one commit, no retry");
  assert.equal(sleeps, 0, "no retry sleep");
  assert.equal(kv(env, "party_sheets").find((p) => p.slug === "bloise").fields.race.value, "orc");
  assert.equal(env.raw.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n, 1);
});

test("a caller that omits visible leaves the field visible (default true) and published", async () => {
  const env = await envWithParty();
  const { recordSheetEventInD1 } = await import("../../infrastructure/worker/index.js");
  await recordSheetEventInD1(env, "https://api.test", { slug: "bloise", name: "Bloise", field: "race", value: "Orc" });
  assert.equal(bloiseParty(env).race, "Orc");
  const f = kv(env, "party_sheets").find((p) => p.slug === "bloise").fields.race;
  assert.equal(f.visible, true); assert.equal(f.source, "board");
});

test("POST /intent launch: a lost race answers 409, not 500", async () => {
  const env = await envWithParty();
  const real = env.DB.prepare;
  env.DB.prepare = (sql) => {
    const st = real(sql);
    if (/FROM kv_state WHERE key IN \('party_sheets', 'party'\)/.test(sql)) {
      const all = st.all;
      st.all = async () => { const r = await all.call(st); env.raw.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify([{ slug: "n", name: "n", fields: {}, updated: String(Math.random()) }])); return r; };
    }
    return st;
  };
  const res = await post(env, "bloise", "/intent", { kind: "launch", patch: { state: "in" } });
  env.DB.prepare = real;
  assert.equal(res.status, 409);
});

test("contention never costs more than 8 attempts (subrequest budget)", async () => {
  const env = await envWithParty();
  let calls = 0;
  const real = env.DB.prepare;
  env.DB.prepare = (sql) => { calls++; const st = real(sql); if (/FROM kv_state WHERE key IN \('party_sheets', 'party'\)/.test(sql)) { const all = st.all; st.all = async () => { const r = await all.call(st); env.raw.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify([{ slug: "n", name: "n", fields: {}, updated: String(Math.random()) }])); return r; }; } return st; };
  const res = await post(env, "bloise", "/sheet", { field: "race", value: "Orc" });
  env.DB.prepare = real;
  assert.equal(res.status, 409);
  assert.ok(calls < 50, `${calls} D1 statements prepared`);
});
