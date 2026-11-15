// The intents mailbox must not reveal a value a member hid. Discord /intents is admin-only (Manage Server or Administrator, the rule
// /ack and /setup use); a hide intent stores no value; old rows that hold a hidden value are redacted on display (/intents and GET /intents).
// Real Worker code over an in-memory SQLite D1 built from schema.sql. Fictional members only; no network, no real keys.
// Run: node --test tests/unit/intents-privacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { handleDiscordInteraction, DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import * as privacy from "../../infrastructure/worker/sheet-privacy.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const AT = "2026-11-12T00:00:00.000Z";
const SLUG = "red-fox", NAME = "Red Fox", DISCORD_ID = "100000000000000042";
const MEMBER_KEY = "member-key-for-tests-0123456789ab", KEY_SALT = "salt-for-tests-0123456789", ADMIN_TOKEN = "admin-token-for-tests-0123456789";
const MARKER = "zqih";
const HIDDEN = `${MARKER}-secret-race`;

const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

async function makeEnv() {
  invalidateConfigCache();
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), AT);
  kv("party", { members: [{ name: NAME, class_key: "paladin", class: "Paladin", race: "Human" }] });
  kv("party_sheets", [{ slug: SLUG, name: NAME, fields: { class: { value: "paladin", visible: true, source: "board", at: AT } }, updated: AT }]);
  kv("discord_members", [{ slug: SLUG, name: NAME, match: ["red fox"], id: DISCORD_ID }]);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run(SLUG, await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`), AT);
  const room = { fetch: async () => new Response(JSON.stringify({ ok: true })) };
  const signer = createDiscordSigner();
  return { DB, signer, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: ADMIN_TOKEN, ALLOWED_ORIGINS: "", DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}

const intentRows = (env) => env.DB.raw.prepare("SELECT seq, kind, body FROM intents ORDER BY seq").all();
const addRow = (env, kind, body) => env.DB.raw.prepare("INSERT INTO intents (at, slug, kind, body, ver) VALUES (?, ?, ?, ?, 1)").run(AT, SLUG, kind, typeof body === "string" ? body : JSON.stringify(body));

async function discordCmd(env, name, permissions, options = []) {
  const member = { nick: NAME, user: { id: DISCORD_ID, username: "redfox" } };
  if (permissions !== undefined) member.permissions = permissions;
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest({ type: 2, id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: "4", member, data: { name, options } }), env, ctx, ORIGIN));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 4);
  assert.equal(body.data.flags & 64, 64, "ephemeral");
  return body;
}
const api = (env, token, method, path, body) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, { method, headers: { Authorization: `Board ${token}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx));
const memberApi = (env, method, path, body) => api(env, MEMBER_KEY, method, path, body);
const adminApi = (env, method, path, body) => api(env, ADMIN_TOKEN, method, path, body);

test("Discord /intents: a non-admin is refused and sees nothing from the mailbox", async () => {
  const env = await makeEnv();
  addRow(env, "sheet", { field: "race", value: HIDDEN, visible: false, source: "board" });
  addRow(env, "journey", { journey: "curious" });
  for (const permissions of [undefined, "0", "2048", "16", "not-a-number"]) {
    const text = (await discordCmd(env, "intents", permissions)).data.content;
    assert.ok(!text.includes(MARKER), `no hidden value for permissions=${permissions}`);
    assert.ok(!text.includes("Mailbox"), `no mailbox listing for permissions=${permissions}`);
    assert.ok(!text.includes("curious") && !text.includes(SLUG) && !/total pending/.test(text), `reveals nothing for permissions=${permissions}`);
    assert.match(text, /admin/i);
  }
});

test("Discord /intents: an admin (Manage Server or Administrator) lists the mailbox", async () => {
  const env = await makeEnv();
  addRow(env, "journey", { journey: "curious" });
  for (const permissions of ["32", "8"]) {
    const text = (await discordCmd(env, "intents", permissions)).data.content;
    assert.match(text, /Intents Mailbox/);
    assert.match(text, /curious/);
  }
});

test("Discord /intents: an admin never sees a hidden value, including in old rows", async () => {
  const env = await makeEnv();
  addRow(env, "sheet", { field: "race", value: HIDDEN, visible: false, source: "board" }); // written before the fix
  addRow(env, "sheet", { field: "race", value: HIDDEN, visible: false, source: "admin" });
  addRow(env, "sheet", { field: "class", value: "paladin", visible: true, source: "board" });
  addRow(env, "sheet", "not json " + HIDDEN);
  const text = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(!text.includes(MARKER), "no hidden value printed");
  assert.match(text, /paladin/, "a visible value still prints");
  assert.match(text, /"field":"race"/, "the hidden field name still prints");
  assert.match(text, /"visible":false/);
});

test("the manifest hides /intents from members without Manage Server", () => {
  const cmd = DISCORD_SLASH_COMMANDS_MANIFEST.find((c) => c.name === "intents");
  assert.equal(cmd.default_member_permissions, "32");
});

test("a hide through POST /sheet stores no value; the field and visibility stay", async () => {
  const env = await makeEnv();
  const res = await memberApi(env, "POST", "/sheet", { field: "race", value: "undead", visible: false });
  assert.equal(res.status, 200);
  const row = intentRows(env).find((r) => r.kind === "sheet");
  const body = JSON.parse(row.body);
  assert.deepEqual(Object.keys(body).sort(), ["field", "source", "visible"]);
  assert.equal(body.field, "race");
  assert.equal(body.visible, false);
  assert.ok(!row.body.includes("undead"));
  // A later value edit of the still-hidden field also carries no value.
  const res2 = await memberApi(env, "POST", "/sheet", { field: "race", value: "orc" });
  assert.equal(res2.status, 200);
  for (const r of intentRows(env)) assert.ok(!r.body.includes("orc") && !r.body.includes("undead"), "no hidden value in any intent");
});

test("a visibility-only hide (no value key) stores no value", async () => {
  const env = await makeEnv();
  await memberApi(env, "POST", "/sheet", { field: "race", value: "undead" });
  const res = await memberApi(env, "POST", "/sheet", { field: "race", visible: false });
  assert.equal(res.status, 200);
  const hide = JSON.parse(intentRows(env).at(-1).body);
  assert.equal(hide.visible, false);
  assert.equal("value" in hide, false);
});

test("an unhide intent and a normal write still carry the value", async () => {
  const env = await makeEnv();
  await memberApi(env, "POST", "/sheet", { field: "race", value: "undead", visible: false });
  const res = await memberApi(env, "POST", "/sheet", { field: "race", visible: true });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(intentRows(env).at(-1).body), { field: "race", value: "undead", visible: true, source: "board" });
  const res2 = await memberApi(env, "POST", "/sheet", { field: "class", value: "mage" });
  assert.equal(res2.status, 200);
  assert.deepEqual(JSON.parse(intentRows(env).at(-1).body), { field: "class", value: "mage", visible: true, source: "board" });
});

test("an admin hide through POST /admin/sheet stores no value", async () => {
  const env = await makeEnv();
  const res = await adminApi(env, "POST", "/admin/sheet", { slug: SLUG, field: "level", value: 37, visible: false });
  assert.equal(res.status, 200, await res.clone().text());
  const rows = intentRows(env).filter((r) => r.kind === "sheet");
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].body.includes("37"));
  const body = JSON.parse(rows[0].body);
  assert.equal(body.visible, false);
  assert.equal(body.source, "admin");
});

test("GET /intents redacts a hidden value in old rows and keeps everything else", async () => {
  const env = await makeEnv();
  addRow(env, "sheet", { field: "race", value: HIDDEN, visible: false, source: "board" });
  addRow(env, "sheet", { field: "class", value: "paladin", visible: true, source: "board" });
  addRow(env, "launch", { state: "in" });
  const res = await adminApi(env, "GET", "/intents?after=0");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(MARKER), "no hidden value in the admin API");
  const out = JSON.parse(text);
  assert.deepEqual(out.intents[0].body, { field: "race", visible: false, source: "board" });
  assert.deepEqual(out.intents[1].body, { field: "class", value: "paladin", visible: true, source: "board" });
  assert.deepEqual(out.intents[2].body, { state: "in" });
  assert.equal(out.pending, 3);
});

test("reads redact on display and never rewrite the stored rows", async () => {
  const env = await makeEnv();
  addRow(env, "sheet", { field: "race", value: HIDDEN, visible: false, source: "board" });
  await adminApi(env, "GET", "/intents?after=0");
  await discordCmd(env, "intents", "32");
  assert.ok(intentRows(env)[0].body.includes(HIDDEN), "old data is redacted on display, never deleted");
});

test("helpers: redactIntentBody and sheetIntentBody", () => {
  const { redactIntentBody, sheetIntentBody } = privacy;
  assert.deepEqual(redactIntentBody({ field: "a", value: "x", visible: false }), { field: "a", visible: false });
  assert.deepEqual(redactIntentBody('{"field":"a","value":"x","visible":false}'), { field: "a", visible: false });
  assert.deepEqual(redactIntentBody({ field: "a", value: "x", visible: true }), { field: "a", value: "x", visible: true });
  assert.deepEqual(redactIntentBody({ field: "a", value: "x" }), { field: "a", value: "x" });
  assert.equal(redactIntentBody("not json"), null);
  assert.deepEqual(redactIntentBody({ journey: "curious" }), { journey: "curious" });
  assert.deepEqual(sheetIntentBody("a", "x", false, "board"), { field: "a", visible: false, source: "board" });
  assert.deepEqual(sheetIntentBody("a", "x", true, "board"), { field: "a", value: "x", visible: true, source: "board" });
});
