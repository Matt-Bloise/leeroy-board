// Audit 2026-11-06 finding 3: production's seed sign-up row is named "=Bloise=" and has no slug, so the first member write by Bloise used to
// append a second row ("4 of 5 in" while 3 were in). A seed row and a member write must be one row. Real Worker over an in-memory SQLite D1;
// the sign-ups document is the committed seed (data/signups.json), so the test uses the shape production has. No network, made-up key.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { nameKey, upsertSignupEntry } from "../../infrastructure/worker/limits.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const KEY = "member-key-for-tests-0123456789ab", SALT = "salt-for-tests-0123456789";
const room = { fetch: async () => new Response("ok") };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const SEED = JSON.parse(readFileSync(new URL("../../data/signups.json", import.meta.url), "utf8"));

async function makeEnv(doc = SEED) {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('bloise', ?, '2026-11-01T00:00:00Z')").run(await sha256Hex(`${SALT}:${KEY}`));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('signups', ?, '2026-10-29T00:00:00Z')").run(JSON.stringify(doc));
  return { DB, KEY_SALT: SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
async function post(env, path, body) {
  const silence = console.error; console.error = () => {};
  try {
    return await worker.fetch(new Request(`https://api.test/api${path}`, { method: "POST", headers: { Authorization: `Board ${KEY}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(body) }), env, ctx);
  } finally { console.error = silence; }
}
const stored = (env) => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'signups'").get().json);

test("seed shape: the committed seed has a slug-less decorated row for Bloise", () => {
  assert.ok(SEED.entries.some((e) => e.name === "=Bloise=" && !e.slug));
  assert.equal(nameKey("=Bloise="), "bloise");
});

test("POST /signups: Bloise's first write lands on the seed row, still 3 people", async () => {
  const env = await makeEnv();
  const res = await post(env, "/signups", { patch: { rsvp: "late" } });
  assert.equal(res.status, 200);
  const doc = stored(env);
  assert.equal(doc.entries.length, 3, JSON.stringify(doc.entries.map((e) => e.name)));
  const mine = doc.entries.filter((e) => e.slug === "bloise" || /bloise/i.test(e.name));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].rsvp, "late", "the new answer won");
  assert.equal(mine[0].pack, "no", "values already on the seed row are kept");
  assert.equal(mine[0].when, "8pm");
  assert.equal(mine[0].name, "Bloise");
  const inCount = (doc.tallies.rsvp.in?.count || 0) + (doc.tallies.rsvp.late?.count || 0);
  assert.equal(inCount, 3);
  const again = await post(env, "/signups", { patch: { when: "6pm" } });
  assert.equal(again.status, 200);
  assert.equal(stored(env).entries.length, 3, "a second write does not add a row either");
});

test("POST /intent signup: the other write path lands on the seed row too", async () => {
  const env = await makeEnv();
  const res = await post(env, "/intent", { kind: "signup", field: "rsvp", value: "maybe" });
  assert.equal(res.status, 200, await res.clone().text());
  const doc = stored(env);
  assert.equal(doc.entries.length, 3);
  assert.equal(doc.entries.find((e) => e.slug === "bloise").rsvp, "maybe");
});

test("an existing duplicate is folded into one row on the next write", async () => {
  const dup = JSON.parse(JSON.stringify(SEED));
  dup.entries.push({ slug: "bloise", name: "Bloise", rsvp: "in", when: "6pm", meet: "The Crossroads", updated: "2026-11-02T00:00:00.000Z" });
  const env = await makeEnv(dup);
  assert.equal((await post(env, "/signups", { patch: { pack: "yes" } })).status, 200);
  const doc = stored(env);
  assert.equal(doc.entries.length, 3);
  const row = doc.entries.find((e) => e.slug === "bloise");
  assert.equal(row.pack, "yes");
  assert.equal(row.meet, "The Crossroads", "the newer duplicate's value is kept");
  assert.equal(row.when, "6pm");
});

test("upsertSignupEntry never takes another person's row", () => {
  const doc = { entries: [{ slug: "santa", name: "Santa" }, { name: "Handsome Squidward" }, { slug: "street-rat", name: "Street Rat" }] };
  const e = upsertSignupEntry(doc, { slug: "bloise", name: "Bloise" });
  assert.equal(doc.entries.length, 4);
  assert.deepEqual(e, { slug: "bloise", name: "Bloise" });
  // a row that already has another slug is not claimed by name punctuation
  const doc2 = { entries: [{ slug: "someone-else", name: "=Bloise=" }] };
  upsertSignupEntry(doc2, { slug: "bloise", name: "Bloise" });
  assert.equal(doc2.entries.length, 2);
  // a name made only of punctuation matches nothing by key
  const doc3 = { entries: [{ name: "???" }] };
  upsertSignupEntry(doc3, { slug: "x", name: "!!!" });
  assert.equal(doc3.entries.length, 2);
});

test("a populated slug is authoritative: same name, different slugs stay two rows and neither write claims the other", () => {
  const doc = { entries: [{ slug: "a-one", name: "Alex", pack: "no", updated: "1" }, { slug: "a-two", name: "Alex", rsvp: "in", updated: "2" }] };
  const e1 = upsertSignupEntry(doc, { slug: "a-one", name: "Alex" });
  assert.equal(doc.entries.length, 2);
  assert.equal(e1.slug, "a-one"); assert.equal(e1.pack, "no");
  const e2 = upsertSignupEntry(doc, { slug: "a-two", name: "Alex" });
  assert.equal(doc.entries.length, 2);
  assert.equal(e2.slug, "a-two"); assert.equal(e2.rsvp, "in");
  // a third member with the same name and a new slug gets a row of their own
  upsertSignupEntry(doc, { slug: "a-three", name: "Alex" });
  assert.equal(doc.entries.length, 3);
  assert.deepEqual(doc.entries.map((x) => x.slug).sort(), ["a-one", "a-three", "a-two"]);
});
