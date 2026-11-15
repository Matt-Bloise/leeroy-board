// A sheet write keeps each field's visibility unless the request itself changes it. A value-only write (the Discord /sheet command, the
// launch state from Discord or the board, a web POST /sheet without `visible`) never un-hides a field the member hid. After any such write a
// hidden value reaches no anonymous read: GET /api/state, /api/bootstrap, /api/data/party.json and the live socket.
// Real Worker code over an in-memory SQLite D1 built from schema.sql. Fictional members only; no network, no real keys.
// Run: node --test tests/unit/sheet-visibility-preserve.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { purgeWorkerCache, recordSheetEventInD1, buildPartySheetsFromD1 } from "../../infrastructure/worker/index.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { LAUNCH_EPOCH } from "../../infrastructure/worker/tonight-copy.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const AT = "2026-11-12T00:00:00.000Z";
const SLUG = "red-fox", NAME = "Red Fox", DISCORD_ID = "100000000000000042";
const MEMBER_KEY = "member-key-for-tests-0123456789ab", KEY_SALT = "salt-for-tests-0123456789";
// Hidden values. Each starts with the marker "zqhv", and a leak is that marker anywhere in a public body or socket message.
const HIDDEN_RACE = "zqhv-hidden-race", HIDDEN_GOALS = "zqhv hidden goal", HIDDEN_EDIT = "orc", HIDDEN_LAUNCH = "zqhv-launch";
const MARKER = "zqhv";
const NEEDLES = [MARKER, '"orc"']; // a race typed in Discord must be on the board's list (sheet-vocab.js), so the edited value is the real one, "orc", not a marker

const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

async function makeEnv() {
  invalidateConfigCache();
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), AT);
  kv("party", { members: [{ name: NAME, class_key: "paladin", class: "Paladin", race: "Human" }, { name: "Blue Owl", class_key: "mage", class: "Mage", race: "Gnome" }] });
  kv("party_sheets", [{ slug: SLUG, name: NAME, fields: { class: { value: "paladin", visible: true, source: "board", at: AT } }, updated: AT }]);
  kv("discord_members", [{ slug: SLUG, name: NAME, match: ["red fox"], id: DISCORD_ID }]);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run(SLUG, await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`), AT);
  const sent = [];
  const room = { fetch: async (_u, init) => { if (init && init.body) sent.push(String(init.body)); return new Response(JSON.stringify({ ok: true })); } };
  const signer = createDiscordSigner();
  return { DB, sent, signer, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}

const sheets = (env) => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json);
const field = (env, f) => sheets(env).find((s) => s.slug === SLUG).fields[f];
const lastEvent = (env, f) => env.DB.raw.prepare("SELECT visible, value_json FROM sheet_events WHERE slug = ? AND field = ? ORDER BY id DESC LIMIT 1").get(SLUG, f);

// The member hides a field (the owner's explicit choice, as the board's sheet does it).
const hide = (env, f, value) => quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: SLUG, name: NAME, field: f, value, visible: false, visibleGiven: true, source: "board", at: AT }));

// The Discord /sheet command, signed as Discord sends it, by the member themself.
async function discordSheet(env, f, value) {
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest({
    type: 2, id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: "4",
    member: { nick: NAME, user: { id: DISCORD_ID, username: "redfox" } },
    data: { name: "sheet", options: [{ name: "field", type: 3, value: f }, { name: "value", type: 3, value }] },
  }), env, ctx, ORIGIN));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 4);
  return body;
}
async function discordLaunch(env, state) {
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest({
    type: 2, id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: "4",
    member: { nick: NAME, user: { id: DISCORD_ID, username: "redfox" } },
    data: { name: "launch", options: [{ name: "state", type: 3, value: state }] },
  }), env, ctx, ORIGIN));
  assert.equal(res.status, 200);
}
async function memberApi(env, method, path, body) {
  const init = { method, headers: { Authorization: `Board ${MEMBER_KEY}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, init), env, ctx));
}

// Every anonymous read the task names, plus each message the Worker handed the room, as an anonymous socket receives it.
const anonSocket = (payload) => {
  const got = [];
  new BoardRoom({ getWebSockets: () => [{ deserializeAttachment: () => ({}), send: (m) => got.push(m) }], setWebSocketAutoResponse() {} }, {}).broadcast(payload);
  return got.join("\n");
};
async function anonymousLeaks(env) {
  const found = [];
  for (const p of ["/state", "/bootstrap", "/data/party.json", "/data/party"]) {
    await purgeWorkerCache(ORIGIN, [`/api${p}`]);
    const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api${p}`, { headers: { "CF-Connecting-IP": "203.0.113.40" } }), env, ctx));
    const text = `${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${await res.text()}`;
    if (res.status !== 200) found.push(`${p}: status ${res.status}`);
    if (NEEDLES.some((n) => text.toLowerCase().includes(n))) found.push(`${p}: hidden value`);
  }
  env.sent.forEach((m, i) => { if (NEEDLES.some((n) => anonSocket(m).toLowerCase().includes(n))) found.push(`socket message ${i}: hidden value`); });
  // The slow path (sheets rebuilt from sheet_events alone) must agree: the event rows carry the visibility that was kept.
  const { party } = await quiet(() => buildPartySheetsFromD1(env, { persist: false }));
  for (const s of party) for (const [k, f] of Object.entries(s.fields || {})) {
    if (f && typeof f.value === "string" && f.value.includes(MARKER) && f.visible !== false) found.push(`rebuild from events: ${s.slug}.${k} visible`);
  }
  return found;
}
const publicPartyDoc = async (env) => { await purgeWorkerCache(ORIGIN, ["/api/data/party"]); const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/data/party`, { headers: { "CF-Connecting-IP": "203.0.113.41" } }), env, ctx)); return JSON.parse(await res.text()); };

test("hide a field, then /sheet edits ANOTHER field: the hidden field stays hidden everywhere", async () => {
  const env = await makeEnv();
  await hide(env, "race", HIDDEN_RACE);
  await hide(env, "goals", HIDDEN_GOALS);
  await discordSheet(env, "plan_zone", "elwynn-forest");
  assert.equal(field(env, "race").visible, false);
  assert.equal(field(env, "goals").visible, false);
  assert.equal(field(env, "plan_zone").visible, true, "a new field with no earlier visibility is visible, as before");
  assert.equal(lastEvent(env, "plan_zone").visible, 1);
  assert.deepEqual(await anonymousLeaks(env), []);
});

test("hide a field, then /sheet edits the SAME field's value: the field stays hidden, the new value is stored", async () => {
  const env = await makeEnv();
  await hide(env, "race", HIDDEN_RACE);
  await discordSheet(env, "race", HIDDEN_EDIT);
  const f = field(env, "race");
  assert.equal(f.value, HIDDEN_EDIT, "the value was updated");
  assert.equal(f.visible, false, "a value-only write never un-hides");
  assert.equal(f.source, "discord");
  assert.equal(lastEvent(env, "race").visible, 0, "the event row keeps the visibility too, so a rebuild from events agrees");
  const doc = await publicPartyDoc(env);
  assert.equal("race" in doc.members[0], false, "the public party document still has no race for the member");
  assert.deepEqual(await anonymousLeaks(env), []);
});

test("/sheet view by the owner still shows their own hidden field (owner-only view is unchanged)", async () => {
  const env = await makeEnv();
  await hide(env, "race", HIDDEN_RACE);
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest({
    type: 2, id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: "4",
    member: { nick: NAME, user: { id: DISCORD_ID, username: "redfox" } }, data: { name: "sheet", options: [] },
  }), env, ctx, ORIGIN));
  const body = await res.json();
  assert.equal(body.data.flags, 64, "ephemeral");
  assert.ok(body.data.content.includes(HIDDEN_RACE));
});

test("web POST /sheet: a value-only write keeps the field hidden; only an explicit visible:true un-hides", async () => {
  const env = await makeEnv();
  await hide(env, "goals", HIDDEN_GOALS);
  const r1 = await memberApi(env, "POST", "/sheet", { field: "goals", value: HIDDEN_EDIT });
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.visible, false, "the response tells the board the field is still hidden");
  assert.equal(field(env, "goals").visible, false);
  assert.equal(field(env, "goals").value, HIDDEN_EDIT);
  assert.deepEqual(await anonymousLeaks(env), []);
  const r2 = await memberApi(env, "POST", "/sheet", { field: "goals", value: "public goal", visible: true });
  assert.equal((await r2.json()).visible, true);
  assert.equal(field(env, "goals").visible, true, "the owner's explicit choice un-hides");
  const r3 = await memberApi(env, "POST", "/sheet", { field: "goals", value: HIDDEN_GOALS, visible: false });
  assert.equal((await r3.json()).visible, false);
  assert.equal(field(env, "goals").visible, false, "an explicit visible:false hides");
});

test("launch state from Discord /launch or the board's launch intent never un-hides a hidden launch_state", async () => {
  const env = await makeEnv();
  await hide(env, "launch_state", HIDDEN_LAUNCH);
  // Discord /launch only records a state before launch (after launch it answers one line and records nothing), so pin the clock before it.
  const realNow = Date.now;
  Date.now = () => LAUNCH_EPOCH * 1000 - 3600000;
  try { await discordLaunch(env, "queue"); } finally { Date.now = realNow; }
  assert.equal(field(env, "launch_state").value, "queue");
  assert.equal(field(env, "launch_state").visible, false, "Discord /launch");
  const res = await memberApi(env, "POST", "/intent", { kind: "launch", patch: { state: "in" } });
  assert.equal(res.status, 200);
  assert.equal(field(env, "launch_state").value, "in");
  assert.equal(field(env, "launch_state").visible, false, "board launch intent");
  assert.equal(lastEvent(env, "launch_state").visible, 0);
});

// Wraps env.DB so that the first read of the commit's two documents (kv-cas.js: key IN ('party_sheets', 'party')) is followed by `after()`,
// which commits something to the DB before that attempt writes. The attempt's compare-and-set then loses and the commit recomputes.
function afterFirstSheetRead(env, after) {
  let fired = false;
  const DB = env.DB;
  const wrapped = new Proxy(DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql) => {
          const stmt = target.prepare(sql);
          if (fired || !/key IN \('party_sheets',\s*'party'\)/.test(sql)) return stmt;
          return new Proxy(stmt, {
            get(s, p) {
              if (p !== "all") { const v = s[p]; return typeof v === "function" ? v.bind(s) : v; }
              return async (...a) => { const r = await s.all(...a); if (!fired) { fired = true; after(); } return r; };
            },
          });
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...env, DB: wrapped, raw: DB, wasFired: () => fired };
}
const setSheets = (env, rows) => env.DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, ?)").run(JSON.stringify(rows), AT);
const countOf = (env, table) => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("a hide committed between the read and the write of a Discord value edit: the field stays hidden, the retry sees the hide", async () => {
  const env0 = await makeEnv();
  setSheets(env0, [{ slug: SLUG, name: NAME, fields: { race: { value: "human", visible: true, source: "board", at: AT } }, updated: AT }]);
  const hideNow = () => setSheets(env0, [{ slug: SLUG, name: NAME, fields: { race: { value: HIDDEN_RACE, visible: false, source: "board", at: AT } }, updated: "2026-11-12T00:00:01.000Z" }]);
  const env = afterFirstSheetRead(env0, hideNow);
  env.DB.raw = env0.DB.raw;
  const body = await discordSheet(env, "race", HIDDEN_EDIT);
  assert.ok(env.wasFired(), "the hide was committed after the attempt's read");
  assert.equal(body.data.flags, 64);
  const f = field(env0, "race");
  assert.equal(f.value, HIDDEN_EDIT, "the edit landed");
  assert.equal(f.visible, false, "the hide that committed during the attempt was not undone");
  assert.equal(lastEvent(env0, "race").visible, 0);
  assert.deepEqual(await anonymousLeaks(env0), []);
});

test("web POST /sheet with only { field, visible } changes the visibility and keeps the stored value, for every field", async () => {
  const env = await makeEnv();
  await memberApi(env, "POST", "/sheet", { field: "race", value: "dwarf", visible: true });
  const r1 = await memberApi(env, "POST", "/sheet", { field: "race", visible: false });
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.value, "dwarf", "the reply carries the kept value");
  assert.equal(b1.visible, false);
  assert.equal(field(env, "race").value, "dwarf", "the value was not replaced by null");
  assert.equal(field(env, "race").visible, false);
  assert.equal(JSON.parse(lastEvent(env, "race").value_json), "dwarf", "the event row carries the kept value, so a rebuild agrees");
  assert.equal(lastEvent(env, "race").visible, 0);
  const r2 = await memberApi(env, "POST", "/sheet", { field: "race", visible: true });
  assert.equal((await r2.json()).value, "dwarf");
  assert.equal(field(env, "race").value, "dwarf");
  assert.equal(field(env, "race").visible, true);
  const { party } = await quiet(() => buildPartySheetsFromD1(env, { persist: false }));
  assert.equal(party.find((s) => s.slug === SLUG).fields.race.value, "dwarf", "rebuilt from events");
  // An explicit null still clears the value.
  const r3 = await memberApi(env, "POST", "/sheet", { field: "race", value: null, visible: true });
  assert.equal((await r3.json()).value, null);
  assert.equal(field(env, "race").value, null, "{ value: null } clears");
});

test("an empty party_sheets row ([]) is rebuilt from sheet_events: a hidden field stays hidden after a Discord edit", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) VALUES (?, ?, 'race', ?, 0, 'board', ?)").run(SLUG, NAME, JSON.stringify(HIDDEN_RACE), AT);
  setSheets(env, []);
  await discordSheet(env, "plan_zone", "elwynn-forest");
  const race = field(env, "race");
  assert.ok(race, "the hidden field was rebuilt from the events, not dropped");
  assert.equal(race.visible, false);
  const doc = await publicPartyDoc(env);
  assert.equal("race" in doc.members[0], false, "the public party document has no race for a member whose race is hidden");
  assert.deepEqual(await anonymousLeaks(env), []);
});

test("Discord /sheet refuses a field name that is not a sheet field: ephemeral refusal, nothing written", async () => {
  const env = await makeEnv();
  const before = { sheets: JSON.stringify(sheets(env)), events: countOf(env, "sheet_events"), intents: countOf(env, "intents") };
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "no_such_field"]) {
    const body = await discordSheet(env, name, "zqhv-should-not-store");
    assert.equal(body.data.flags, 64, `${name}: ephemeral`);
    assert.ok(/not a sheet field/i.test(body.data.content), `${name}: refusal text`);
  }
  assert.equal(JSON.stringify(sheets(env)), before.sheets, "no sheet changed");
  assert.equal(countOf(env, "sheet_events"), before.events, "no event");
  assert.equal(countOf(env, "intents"), before.intents, "no intent");
  assert.deepEqual(await anonymousLeaks(env), []);
});