// q-20261114-22 "Sheet field, admin can fill": the level line of a friend's sheet. Server-side validation (an integer from 1 to the level cap),
// its own `at` stamp, the friend's write (POST /sheet), the admin's write (POST /admin/sheet), and the hidden-field rule: a hidden level never
// reaches GET /state, GET /bootstrap, GET /data/party or a room message. Real Worker over an in-memory SQLite D1. Fictional names, made-up keys.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { purgeWorkerCache, recordSheetEventInD1 } from "../../infrastructure/worker/index.js";
import { LEVEL_CAP, sheetValueProblem, ADMIN_SHEET_FIELDS } from "../../infrastructure/worker/sheet-values.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import vm from "node:vm";

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
// What an anonymous socket receives for one room message (the room redacts per audience).
const anonSocket = (msg) => { const got = []; const ctx2 = { getWebSockets: () => [{ deserializeAttachment: () => ({}), send: (m) => got.push(JSON.parse(m)) }], setWebSocketAutoResponse() {} }; new BoardRoom(ctx2, {}).broadcast(JSON.stringify(msg)); return got; };
const anon = async (env, path) => { await purgeWorkerCache(ORIGIN, [`/api${path}`]); const r = await call(env, "GET", path); return { status: r.status, json: await r.json() }; };

test("the level cap matches data/client.json (the game's cap, not a guess)", () => {
  const client = JSON.parse(readFileSync(new URL("../../data/client.json", import.meta.url), "utf8"));
  assert.equal(LEVEL_CAP, client.level);
  assert.equal(LEVEL_CAP, 60);
  assert.deepEqual(ADMIN_SHEET_FIELDS, ["level"]);
});

// Every value an adversarial caller tries. JSON cannot carry NaN or Infinity (JSON.stringify turns them into null), so they are checked on the
// pure function; over HTTP the same body arrives as null and is refused too.
const BAD = [0, LEVEL_CAP + 1, -1, 1.5, 34.2, "60", "60abc", "abc", "12", null, undefined, NaN, Infinity, -Infinity, true, [12], { v: 12 }, 1e21];
test("sheetValueProblem: level 0, cap + 1, -1, 1.5, '60', '60abc', null, an array, an object, NaN, Infinity and a missing value are refused; 1 and the cap pass", () => {
  for (const bad of BAD) assert.ok(sheetValueProblem("level", bad), `refused: ${String(bad)}`);
  for (const ok of [1, LEVEL_CAP, 34]) assert.equal(sheetValueProblem("level", ok), null, `accepted: ${ok}`);
  assert.equal(sheetValueProblem("goals", "anything"), null, "fields without a server rule are unchanged");
});

test("POST /sheet: the friend's level write is validated on the server and stored with its own at stamp", async () => {
  const env = await makeEnv();
  for (const bad of [...BAD.filter((v) => v !== undefined).map((value) => ({ value })), {}, { visible: false }]) {
    const r = await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", ...bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const big = await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", value: 12, pad: "x".repeat(70000) } });
  assert.equal(big.status, 413, "an oversized body is refused");
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
  const hide = await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", value: LEVEL_CAP, visible: false } });
  assert.equal(hide.status, 200, "hiding sends the current value with visible:false");
  assert.deepEqual([sheetOf(env, "red-fox").fields.level.value, sheetOf(env, "red-fox").fields.level.visible], [LEVEL_CAP, false]);
});

test("nobody writes another friend's level: no key, a wrong key, or a slug in the body all miss red-fox's sheet", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "POST", "/sheet", { body: { field: "level", value: 20 } })).status, 401, "no key");
  assert.equal((await call(env, "POST", "/sheet", { auth: "Board not-a-real-key-0123456789", body: { field: "level", value: 20 } })).status, 401, "wrong key");
  assert.equal((await call(env, "GET", "/sheet")).status, 401, "no unauthenticated view of a sheet");
  const r = await call(env, "POST", "/sheet", { auth: asMember("blue-owl"), body: { field: "level", value: 20, slug: "red-fox" } });
  assert.equal(r.status, 200);
  assert.equal(sheetOf(env, "blue-owl").fields.level.value, 20, "the write lands on the caller's own sheet");
  assert.equal(levelIn(sheets(env), "red-fox"), undefined, "red-fox's sheet has no level");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asMember("blue-owl"), body: { slug: "red-fox", field: "level", value: 20 } })).status, 401, "a member key on the admin route");
});

test("an older level write never overwrites a newer one (two overlapping requests)", async () => {
  const env = await makeEnv();
  const newer = "2026-11-14T10:00:05.000Z", older = "2026-11-14T10:00:01.000Z";
  await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name: "Red Fox", field: "level", value: 30, at: newer, newerWins: true }));
  const late = await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name: "Red Fox", field: "level", value: 29, at: older, newerWins: true }));
  assert.equal(late.stale, true);
  assert.deepEqual([late.kept.value, late.kept.at], [30, newer], "the caller is told what is stored");
  assert.deepEqual([sheetOf(env, "red-fox").fields.level.value, sheetOf(env, "red-fox").fields.level.at], [30, newer]);
  const after = await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name: "Red Fox", field: "level", value: 31, at: "2026-11-14T10:00:09.000Z", newerWins: true }));
  assert.equal(after.stale, false);
  assert.equal(sheetOf(env, "red-fox").fields.level.value, 31);
  // a hide always lands, even an older one: the friend's hide started before an admin fill that committed first
  const fill = "2026-11-14T10:00:20.000Z", hideAt = "2026-11-14T10:00:15.000Z";
  await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name: "Red Fox", field: "level", value: 40, source: "admin", at: fill, keepHidden: true, newerWins: true }));
  const hid = await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name: "Red Fox", field: "level", value: 31, visible: false, at: hideAt, newerWins: true }));
  assert.equal(hid.stale, true);
  assert.equal(hid.visible, false);
  assert.deepEqual([sheetOf(env, "red-fox").fields.level.value, sheetOf(env, "red-fox").fields.level.visible], [40, false], "newer value kept, hidden");
  assert.equal(levelIn((await anon(env, "/state")).json.party, "red-fox"), undefined);
  // the admin path uses the same rule
  const r = await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { slug: "red-fox", field: "level", value: 32 } });
  assert.equal(r.status, 200, "a write stamped now is newer than the fixed past stamps above");
  assert.equal(sheetOf(env, "red-fox").fields.level.value, 32);
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
  for (const value of BAD) {
    const b = { slug: "red-fox", field: "level", value };
    if (value === undefined) delete b.value;
    assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: b })).status, 400, String(value));
  }
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, field: "goals", value: "x" } })).status, 400, "only fields with a server rule");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, visible: true } })).status, 400, "the admin never shows a field");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, extra: 1 } })).status, 400, "unknown keys");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, slug: "green-elk" } })).status, 404, "not in the party");
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: "not json" })).status, 400);
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { ...body, pad: "x".repeat(70000) } })).status, 413, "an oversized body is refused");
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
  for (const m of env.sent) for (const a of anonSocket(m)) assert.equal(levelIn(a.party, "red-fox"), undefined, "anonymous socket");
  const pd = await anon(env, "/data/party");
  assert.equal(pd.status, 200);
  assert.ok(!JSON.stringify(pd.json).includes("\"level\""), "/data/party");
  // the admin may hide a visible one
  assert.equal((await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { slug: "blue-owl", field: "level", value: 18, visible: false } })).status, 200);
  assert.equal(sheetOf(env, "blue-owl").fields.level.visible, false);
  assert.equal(levelIn((await anon(env, "/state")).json.party, "blue-owl"), undefined);
});

test("POST /admin/sheet: a hide that commits between the admin's read and its commit survives the compare-and-set retry", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "POST", "/sheet", { auth: asMember("red-fox"), body: { field: "level", value: 12 } })).status, 200);
  const batch = env.DB.batch.bind(env.DB);
  let raced = 0, batches = 0;
  env.DB.batch = async (list) => {
    batches++;
    if (!raced) {
      raced++;
      // The friend's hide lands first: the stored sheets row changes under the admin's pending commit, so its guarded UPDATE matches nothing.
      const row = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json);
      const fox = row.find((s) => s.slug === "red-fox");
      fox.fields.level = { ...fox.fields.level, visible: false, at: new Date(Date.now() - 1).toISOString() };
      env.DB.raw.prepare("UPDATE kv_state SET json = ?, updated_at = 'hide' WHERE key = 'party_sheets'").run(JSON.stringify(row));
    }
    return batch(list);
  };
  const r = await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { slug: "red-fox", field: "level", value: 40 } });
  assert.equal(r.status, 200);
  assert.ok(batches >= 2, "the first commit lost the race and was retried");
  const j = await r.json();
  assert.equal(j.visible, false);
  assert.deepEqual([sheetOf(env, "red-fox").fields.level.value, sheetOf(env, "red-fox").fields.level.visible], [40, false]);
  assert.equal(env.DB.raw.prepare("SELECT visible FROM sheet_events WHERE source = 'admin'").get().visible, 0);
  assert.equal(levelIn((await anon(env, "/state")).json.party, "red-fox"), undefined);
});

test("POST /admin/sheet: an unknown slug is 404 and the reply names nobody", async () => {
  const env = await makeEnv();
  for (const slug of ["green-elk", "RED-FOX", "red fox", "../red-fox", "", 7]) {
    const r = await call(env, "POST", "/admin/sheet", { auth: asAdmin, body: { slug, field: "level", value: 20 } });
    assert.equal(r.status, 404, String(slug));
    const t = (await r.text()).toLowerCase();
    for (const n of ["red", "fox", "blue", "owl"]) assert.ok(!t.includes(n), `reply echoes ${n}: ${t}`);
  }
});

test("Discord /sheet cannot write level (a slash option is a string), even for an interaction built by hand", async () => {
  invalidateConfigCache();
  const env = await makeEnv();
  const signer = createDiscordSigner();
  Object.assign(env, { DISCORD_PUBLIC_KEY: signer.publicKeyHex });
  env.DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, 'x')").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", match: ["red fox"], id: "100000000000000001" }]));
  const send = (options) => quiet(() => handleDiscordInteraction(signer.signedRequest({
    type: 2, id: "1", application_id: "2", token: "t", channel_id: "3", member: { nick: "Red Fox", user: { id: "100000000000000001", username: "redfox" } },
    data: { name: "sheet", options },
  }), env, { waitUntil() {} }, ORIGIN));
  for (const value of ["34", "60", "0", "abc"]) {
    const res = await send([{ name: "field", type: 3, value: "level" }, { name: "value", type: 3, value }]);
    assert.equal(res.status, 200);
    assert.match(JSON.stringify(await res.json()), /set on the board/);
  }
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events").get().n, 0, "nothing written");
  const ok = await send([{ name: "field", type: 3, value: "goals" }, { name: "value", type: 3, value: "find a guild" }]);
  assert.equal(ok.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sheet_events WHERE field = 'goals'").get().n, 1, "other fields still write as before");
});

// The board client end to end: js/brain.js in a sandbox, its fetch routed into the Worker. setSheet("level", 34) is saved; hiding it is too.
test("the existing board client (js/brain.js setSheet) still saves and hides a level through the Worker", async () => {
  const env = await makeEnv();
  const src = readFileSync(new URL("../../js/brain.js", import.meta.url), "utf8");
  const store = new Map([["board-key", KEYS["red-fox"]]]);
  const win = {};
  const sandbox = {
    window: win, console: { ...console, error() {}, warn() {} }, URL, URLSearchParams, Date, JSON, Promise, Math, Request, Response, Headers,
    location: { hostname: "leeroy.party", protocol: "https:", href: "https://leeroy.party/", search: "", hash: "", pathname: "/", host: "leeroy.party" },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    fetch: (u, init = {}) => quiet(() => worker.fetch(new Request(u, { method: init.method || "GET", headers: { ...(init.headers || {}), "CF-Connecting-IP": "203.0.113.71" }, body: init.body }), env, ctx)),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(src, sandbox);
  const B = win.BoardBrain;
  B.start({});
  await B.me();
  assert.equal(B.status().me && B.status().me.slug, "red-fox", "the key resolves through GET /me");
  const r = await B.setSheet("level", 34);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([sheetOf(env, "red-fox").fields.level.value, sheetOf(env, "red-fox").fields.level.visible], [34, true]);
  const h = await B.setSheet("level", 34, false);
  assert.equal(h.ok, true);
  assert.equal(sheetOf(env, "red-fox").fields.level.visible, false);
  assert.equal((await B.setSheet("level", 0)).state, "refused", "the client refuses 0 before sending");
});