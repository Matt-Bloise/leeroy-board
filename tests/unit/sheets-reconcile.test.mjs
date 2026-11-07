// A person in the party document but not in the stored party_sheets row (added later by an admin or /join) must appear in the sheets the
// board reads, keep what the document says about them after their first sheet write, and never become two people. Fictional members only.
// Run: node --test tests/unit/sheets-reconcile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { buildPartySheetsFromD1, recordSheetEventInD1, projectPublicParty, purgeWorkerCache } from "../../infrastructure/worker/index.js";
import { reconcileSheetsWithDoc } from "../../infrastructure/worker/party-source.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

let outbound = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { outbound += 1; return new Response("blocked in tests", { status: 599 }); };
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-10-30T00:00:00.000Z" });
const STORED = () => [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin") }, updated: "x" }];
const DOC = () => ({ members: [{ name: "Red Fox", class_key: "paladin", class: "Paladin", race: "Human" }, { name: "Blue Owl", class_key: "mage", class: "Mage", race: "Gnome", start_zone: "Dun Morogh" }] });

function makeEnv({ stored = STORED(), doc = DOC() } = {}) {
  const DB = schemaDb();
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  if (stored) put("party_sheets", stored);
  if (doc) put("party", doc);
  const room = { fetch: async () => new Response("ok") };
  return { DB, BOARD_ROOM: { idFromName: () => "r", get: () => room }, ALLOWED_ORIGINS: "" };
}
const kv = (env, key) => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key).json);
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const getState = async (env) => {
  await purgeWorkerCache(ORIGIN, ["/api/state"]);
  return quiet(async () => (await worker.fetch(new Request(`${ORIGIN}/api/state`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }), env, ctx)).json());
};

test("a document member without a sheet gets one; the stored sheet is untouched", () => {
  const out = reconcileSheetsWithDoc(STORED(), DOC());
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], STORED()[0]);
  const owl = out.find((s) => s.slug === "blue-owl");
  assert.equal(owl.fields.class.value, "mage");
  assert.equal(owl.fields.race.value, "gnome");
  assert.equal(owl.fields.plan_zone.value, "dun-morogh");
});

test("nothing missing returns the same array; no document and junk change nothing", () => {
  const s = STORED();
  assert.equal(reconcileSheetsWithDoc(s, { members: [{ name: "red fox" }] }), s);
  assert.equal(reconcileSheetsWithDoc(s, null), s);
  assert.equal(reconcileSheetsWithDoc(s, { members: [null, {}, { name: 5 }] }), s);
  assert.deepEqual(reconcileSheetsWithDoc(null, null), []);
});

test("a true admin rename does not make a second person", () => {
  const stored = [{ slug: "winton", name: "Winton", fields: { class: f("paladin") }, updated: "x" }];
  for (const renamed of ["Winton (alt)", "WINTON  (tank)"]) {
    assert.equal(reconcileSheetsWithDoc(stored, { members: [{ name: renamed, class_key: "paladin", race: "Undead" }] }), stored, renamed);
  }
  assert.equal(reconcileSheetsWithDoc(stored, { members: [{ name: "Winton Jr", class_key: "mage", race: "Gnome" }] }).length, 2, "a different name is a different person");
});

test("distinct people whose names differ only by a parenthetical stay distinct", () => {
  const stored = [{ slug: "winton", name: "Winton", fields: { class: f("paladin") }, updated: "x" }];
  const both = reconcileSheetsWithDoc(stored, { members: [{ name: "Winton", class_key: "paladin", race: "Undead" }, { name: "Winton (alt)", class_key: "mage", race: "Gnome" }] });
  assert.deepEqual(both.map((x) => x.slug), ["winton", "winton-alt"]);
  const sams = reconcileSheetsWithDoc([], { members: [{ name: "Sam (Horde)", class_key: "hunter", race: "Orc" }, { name: "Sam (Alliance)", class_key: "rogue", race: "Human" }] });
  assert.deepEqual(sams.map((x) => x.slug), ["sam-horde", "sam-alliance"]);
  assert.equal(sams[1].fields.class.value, "rogue");
});

test("WRITE THEN READ: a synthesized member keeps race, class and zone after their first sheet write", async () => {
  const env = makeEnv();
  await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "blue-owl", name: "Blue Owl", field: "level", value: 7 }));
  const owl = kv(env, "party_sheets").find((s) => s.slug === "blue-owl");
  assert.equal(owl.fields.level.value, 7);
  assert.equal(owl.fields.class.value, "mage", JSON.stringify(owl));
  assert.equal(owl.fields.race.value, "gnome");
  assert.equal(owl.fields.plan_zone.value, "dun-morogh");
  assert.equal(kv(env, "party_sheets").filter((s) => s.slug === "blue-owl").length, 1);
  const again = (await buildPartySheetsFromD1(env)).party.find((s) => s.slug === "blue-owl");
  assert.equal(again.fields.class.value, "mage", "a later read still has it");
});

test("buildPartySheetsFromD1 reads the reconciled list, writes nothing, and never adds the built-in five", async () => {
  const env = makeEnv();
  const { party } = await buildPartySheetsFromD1(env);
  assert.deepEqual(party.map((p) => p.slug).sort(), ["blue-owl", "red-fox"]);
  assert.equal(kv(env, "party_sheets").length, 1, "a read does not rewrite the stored row");
  const passed = await buildPartySheetsFromD1(env, { partyDoc: DOC() });
  assert.deepEqual(passed.party.map((p) => p.slug).sort(), ["blue-owl", "red-fox"], "a pre-read document gives the same list");
});

test("an anonymous GET /api/state lists the document member; a hidden field stays out", async () => {
  const env = makeEnv({ stored: [{ slug: "red-fox", name: "Red Fox", fields: { class: f("SECRET-CLASS", false), race: f("human") }, updated: "x" }] });
  const state = await getState(env);
  assert.ok(state.party.some((p) => p.slug === "blue-owl"), "Blue Owl is in party");
  const fox = state.party.find((p) => p.slug === "red-fox");
  assert.ok(!JSON.stringify(state.party).includes("SECRET-CLASS"), "the hidden field never reaches an anonymous caller");
  assert.ok(fox.fields.race, "the visible field still does");
});

test("hiding a class also removes class_key from the public document", () => {
  const doc = { members: [{ name: "Red Fox", class: "Paladin", class_key: "paladin" }] };
  projectPublicParty(doc, [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin", false) } }], "red-fox", "class");
  assert.equal(doc.members[0].class, undefined);
  assert.equal(doc.members[0].class_key, undefined);
});

test("a hide reaches a renamed person, but not a distinct person with a similar name", () => {
  const doc = { members: [{ name: "Winton (alt)", class: "Paladin", class_key: "paladin" }] };
  projectPublicParty(doc, [{ slug: "winton", name: "Winton", fields: { class: f("paladin", false) } }], "winton", "class");
  assert.equal(doc.members[0].class, undefined, "renamed: hidden");
  const two = { members: [{ name: "Winton", class: "Paladin", class_key: "paladin" }, { name: "Winton (alt)", class: "Mage", class_key: "mage" }] };
  projectPublicParty(two, [{ slug: "winton", name: "Winton", fields: { class: f("paladin", false) } }, { slug: "winton-alt", name: "Winton (alt)", fields: { class: f("mage") } }], "winton", "class");
  assert.equal(two.members[0].class, undefined);
  assert.equal(two.members[1].class, "Mage", "the other person keeps theirs");
});

test("GET /api/bootstrap reads the party row once", async () => {
  const env = makeEnv();
  await purgeWorkerCache(ORIGIN, ["/api/bootstrap"]);
  const reads = [];
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/FROM kv_state WHERE key = 'party'/.test(sql)) reads.push(sql); return real(sql); };
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/bootstrap`, { headers: { "CF-Connecting-IP": "203.0.113.10" } }), env, ctx));
  const body = await res.json();
  assert.equal(reads.length, 0, "the party row comes from the bundle select, not a second query");
  assert.ok(body.partySheets.some((p) => p.slug === "blue-owl"), "and the document member is listed");
});
