// q-20261114-22 "Sheet field, admin can fill": the level line of a friend's sheet. Server-side validation (an integer from 1 to the level cap),
// its own `at` stamp, the friend's write (POST /sheet), the admin's write (POST /admin/sheet), and the hidden-field rule: a hidden level never
// reaches GET /state, GET /bootstrap, GET /data/party or a room message. Real Worker over an in-memory SQLite D1. Fictional names, made-up keys.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { purgeWorkerCache } from "../../infrastructure/worker/index.js";
import { LEVEL_CAP, sheetValueProblem, ADMIN_SHEET_FIELDS } from "../../infrastructure/worker/sheet-values.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const SALT = "salt-for-tests-0123456789";
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const KEYS = { "red-fox": "member-key-red-fox-0123456789ab", "blue-owl": "member-key-blue-owl-0123456789a" };
const PARTY_DOC = { members: [
  { name: "Red Fox", class: "Paladin", class_key: "paladin", race: "Human", role: "tank" },
  { name: "Blue Owl", class: "Priest", class_key: "priest", race: "Dwarf", role: "healer" },
] };
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function makeEnv() {
  const DB = schemaDb(), sent = [];
  for (const [slug, key] of Object.entries(KEYS)) DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, '2026-11-01T00:00:00Z')").run(slug, await sha256Hex(`${SALT}:${key}`));
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ?, '2026-11-01T00:00:00Z')").run(JSON.stringify(PARTY_DOC));
  const room = { fetch: async (_u, init) => { if (init && init.body) sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ok: true })); } };
  return { DB, sent, BOARD_ADMIN_TOKEN: ADMIN, KEY_SALT: SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const call = (env, method, path, { auth, body } = {}) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, {
  method, headers: { ...(auth ? { Authorization: auth } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), "CF-Connecting-IP": "203.0.113.70" },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
}), env, ctx));
const asMember = (slug) => `Board ${KEYS[slug]}`;
const asAdmin = `Bearer ${ADMIN}`;
const sheets = (env) => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json);
const sheetOf = (env, slug) => sheets(env).find((s) => s.slug === slug);
const levelIn = (party, slug) => { const row = Array.isArray(party) ? party.find((s) => s && s.slug === slug) : null; return row && row.fields ? row.fields.level : undefined; };
const anon = async (env, path) => { await purgeWorkerCache(ORIGIN, [`/api${path}`]); const r = await call(env, "GET", path); return { status: r.status, json: await r.json() }; };

test("the level cap matches data/client.json (the game's cap, not a guess)", () => {
  const client = JSON.parse(readFileSync(new URL("../../data/client.json", import.meta.url), "utf8"));
  assert.equal(LEVEL_CAP, client.level);
  assert.equal(LEVEL_CAP, 60);
  assert.deepEqual(ADMIN_SHEET_FIELDS, ["level"]);
});

test("sheetValueProblem: level 0, cap + 1, 'abc', a float, a numeric string and a missing value are refused; 1, the cap and null pass", () => {
  for (const bad of [0, LEVEL_CAP + 1, "abc", 1.5, 34.2, "12", undefined, -3, NaN, Infinity, true, [12], { v: 12 }]) assert.ok(sheetValueProblem("level", bad), `refused: ${String(bad)}`);
  for (const ok of [1, LEVEL_CAP, 34, null]) assert.equal(sheetValueProblem("level", ok), null, `accepted: ${ok}`);
  assert.equal(sheetValueProblem("goals", "anything"), null, "fields without a server rule are unchanged");
});

test("POST /sheet: the friend's level write is validated on the server and stored with its own at stamp", async () => {
  const env = await makeEnv();
  for (const bad of [{ value: 0 }, { value: 61 }, { value: "abc" }, { value: 1.5 }, {}, { visible: false }]) {
    const r = await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", ...bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events WHERE field = 'level'").get().n, 0, "a refused write leaves no event");
  for (const lv of [1, LEVEL_CAP]) {
    const r = await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", value: lv } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.value, lv);
    const f = sheetOf(env, "red-fox").fields.level;
    assert.equal(f.value, lv);
    assert.equal(f.visible, true);
    assert.equal(f.source, "board");
    assert.equal(f.at, j.at, "the field carries the write's own at stamp");
    assert.ok(!Number.isNaN(Date.parse(f.at)));
  }
  const cleared = await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", value: null } });
  assert.equal(cleared.status, 200, "null clears the line");
  assert.equal(sheetOf(env, "red-fox").fields.level.value, null);
});

test("a hidden level reaches only its owner: never /state, /bootstrap, /data/party, the room, or another member's /sheet", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "POST", "/sheet", { auth: asMember("blue-owl"), body: { field: "level", value: 22 } })).status, 200);
  assert.equal((await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", value: 34, visible: false } })).status, 200);
  const st = await anon(env, "/state");
  assert.equal(st.status, 200);
  assert.equal(levelIn(st.json.party, "red-fox"), undefined, "/state");
  assert.equal(levelIn(st.json.party, "blue-owl").value, 22, "a visible level is public");
  const bs = await anon(env, "/bootstrap");
  assert.equal(bs.status, 200);
  assert.equal(levelIn(bs.json.partySheets, "red-fox"), undefined, "/bootstrap");
  assert.equal(levelIn(bs.json.partySheets, "blue-owl").value, 22);
  const pd = await anon(env, "/data/party");
  assert.equal(pd.status, 200);
  assert.ok(Array.isArray(pd.json.members) && pd.json.members.length === 2, "the fixture's party document");
  assert.ok(!JSON.stringify(pd.json).includes('"level"'), "the public party document never carries a sheet level");
  assert.ok(env.sent.length >= 2);
  for (const m of env.sent) if (Array.isArray(m.party)) assert.equal(levelIn(m.party, "red-fox"), undefined, "room message");
  const other = await (await call(env, "GET", "/sheet", { auth: asMember("blue-owl") })).json();
  assert.equal(levelIn(other.party, "red-fox"), undefined, "another member's /sheet");
  const own = await (await call(env, "GET", "/sheet", { auth: asMember("red-fox") })).json();
  assert.equal(own.sheet.fields.level.value, 34, "the owner sees their own hidden level");
  assert.equal(own.sheet.fields.level.visible, false);
});

test("POST /admin/sheet: admin token only; fills a friend's level with source admin and its own at stamp", async () => {
  const env = await makeEnv();
  const body = { slug: "red-fox", field: "level", value: 41 };
  assert.equal((await call(env, "POST", "/admin/sheet", { body })).status, 401, "anonymous");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asMember("blue-owl"), body })).status, 401, "a member key is not the admin");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: "Bearer wrong-token-0123456789", body })).status, 401, "a wrong token");
  for (const bad of [{ value: 0 }, { value: 61 }, { value: "abc" }, { value: 2.5 }, { value: undefined }]) {
    const b = { slug: "red-fox", field: "level", ...bad };
    if (bad.value === undefined) delete b.value;
    assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: b })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, field: "goals", value: "x" } })).status, 400, "only fields with a server rule");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, visible: true } })).status, 400, "the admin never shows a field");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, extra: 1 } })).status, 400, "unknown keys");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, slug: "green-elk" } })).status, 404, "not in the party");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: "not json" })).status, 400);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n, 0, "no refused call wrote anything");
  const r = await call(env, "POST", "/admin/sheet", { auth: asAdmin, body });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual([j.slug, j.field, j.value, j.visible], ["red-fox", "level", 41, true]);
  const f = sheetOf(env, "red-fox").fields.level;
  assert.deepEqual([f.value, f.visible, f.source, f.at], [41, true, "admin", j.at]);
  const ev = env.DB.raw.prepare("SELECT slug, field, value_json, visible, source FROM sheet_events").all();
  assert.deepEqual(ev.map((e) => ({ ...e })), [{ slug: "red-fox", field: "level", value_json: "41", visible: 1, source: "admin" }]);
  const st = await anon(env, "/state");
  assert.equal(levelIn(st.json.party, "red-fox").value, 41, "a filled, visible level flows into the public party sheets");
  assert.equal(levelIn(st.json.party, "red-fox").source, "admin");
});

test("POST /admin/sheet keeps a level the friend hid hidden, and may hide one", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", value: 12, visible: false } })).status, 200);
  const r = await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { slug: "red-fox", field: "level", value: 30 } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).visible, false, "the reply says the line stays hidden");
  const f = sheetOf(env, "red-fox").fields.level;
  assert.deepEqual([f.value, f.visible], [30, false]);
  assert.equal(env.DB.raw.prepare("SELECT visible FROM sheet_events ORDER BY id DESC LIMIT 1").get().visible, 0, "the event row records it hidden too");
  assert.equal(levelIn((await anon(env, "/state")).json.party, "red-fox"), undefined);
  assert.equal(levelIn((await anon(env, "/bootstrap")).json.partySheets, "red-fox"), undefined);
  for (const m of env.sent) if (Array.isArray(m.party)) assert.equal(levelIn(m.party, "red-fox"), undefined, "room message");
  // the admin may hide a visible one
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { slug: "blue-owl", field: "level", value: 18, visible: false } })).status, 200);
  assert.equal(sheetOf(env, "blue-owl").fields.level.visible, false);
  assert.equal(levelIn((await anon(env, "/state")).json.party, "blue-owl"), undefined);
});
