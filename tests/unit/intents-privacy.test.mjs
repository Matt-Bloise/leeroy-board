// The intents mailbox must not reveal a value a member hid. Discord /intents is admin-only (Manage Server or Administrator, the rule
// /ack and /setup use); a hide intent stores no value; old rows that hold a hidden value are redacted on display (/intents and GET /intents).
// Real Worker code over an in-memory SQLite D1 built from schema.sql. Fictional members only; no network, no real keys.
// Run: node --test tests/unit/intents-privacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { handleDiscordInteraction, DISCORD_SLASH_COMMANDS_MANIFEST, GATE_OFF_NOTE } from "../../infrastructure/worker/discord.js";
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
const GUILD = "400000000000000004";
const MARKER = "zqih";
const HIDDEN = `${MARKER}-secret-race`;

const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

async function makeEnv() {
  invalidateConfigCache();
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), AT);
  kv("party", { members: [{ name: NAME, class_key: "paladin", class: "Paladin", race: "Human" }] });
  kv("party_sheets", [{ slug: SLUG, name: NAME, fields: { class: { value: "paladin", visible: true, source: "board", at: AT } }, updated: AT }]);
  kv("discord_roster", { guildId: GUILD });
  kv("discord_members", [{ slug: SLUG, name: NAME, match: ["red fox"], id: DISCORD_ID }]);
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)").run(SLUG, await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`), AT);
  const room = { fetch: async () => new Response(JSON.stringify({ ok: true })) };
  const signer = createDiscordSigner();
  return { DB, signer, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: ADMIN_TOKEN, ALLOWED_ORIGINS: "", DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}

const intentRows = (env) => env.DB.raw.prepare("SELECT seq, kind, body FROM intents ORDER BY seq").all();
const addRow = (env, kind, body) => env.DB.raw.prepare("INSERT INTO intents (at, slug, kind, body, ver) VALUES (?, ?, ?, ?, 1)").run(AT, SLUG, kind, typeof body === "string" ? body : JSON.stringify(body));

async function discordCmd(env, name, permissions, options = [], { guild = GUILD, top = {} } = {}) {
  const member = { nick: NAME, user: { id: DISCORD_ID, username: "redfox" } };
  if (permissions !== undefined) member.permissions = permissions;
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest({ type: 2, id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: guild, member, ...top, data: { name, options } }), env, ctx, ORIGIN));
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

// ---- follow-ups: /sheet and /launch hides, guild binding, spoofed permissions, unparseable rows ----

test("Discord /sheet of an already-hidden field stores an intent with no value", async () => {
  const env = await makeEnv();
  await memberApi(env, "POST", "/sheet", { field: "race", value: "undead", visible: false });
  const res = await discordCmd(env, "sheet", undefined, [{ name: "field", type: 3, value: "race" }, { name: "value", type: 3, value: `orc ${HIDDEN}` }]);
  assert.ok(res.data.content);
  for (const r of intentRows(env)) assert.ok(!r.body.includes(MARKER) && !r.body.includes("orc") && !r.body.includes("undead"), `no hidden value in intent ${r.seq}`);
  const last = JSON.parse(intentRows(env).at(-1).body);
  assert.deepEqual(last, { field: "race", visible: false, source: "discord" });
  assert.ok(!(await (await adminApi(env, "GET", "/intents?after=0")).text()).includes(MARKER), "GET /intents");
  assert.ok(!(await discordCmd(env, "intents", "32")).data.content.includes(MARKER), "/intents");
});

test("Discord /sheet of a visible field still stores the value", async () => {
  const env = await makeEnv();
  await discordCmd(env, "sheet", undefined, [{ name: "field", type: 3, value: "race" }, { name: "value", type: 3, value: "orc" }]);
  assert.deepEqual(JSON.parse(intentRows(env).at(-1).body), { field: "race", value: "orc", visible: true, source: "discord" });
});

test("Discord /launch with a hidden launch_state stores an intent with no state", async () => {
  const env = await makeEnv();
  await memberApi(env, "POST", "/sheet", { field: "launch_state", value: "queue", visible: false });
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 1); // /launch only works before launch
  try {
    await discordCmd(env, "launch", undefined, [{ name: "state", type: 3, value: "done" }]);
  } finally { Date.now = realNow; }
  const row = intentRows(env).find((r) => r.kind === "launch");
  assert.ok(row, "a launch intent was stored");
  assert.ok(!row.body.includes("done") && !row.body.includes("queue"), row.body);
  assert.equal(JSON.parse(row.body).visible, false);
});

test("Discord /launch with a visible launch_state still stores the state", async () => {
  const env = await makeEnv();
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 1);
  try {
    await discordCmd(env, "launch", undefined, [{ name: "state", type: 3, value: "done" }]);
  } finally { Date.now = realNow; }
  assert.deepEqual(JSON.parse(intentRows(env).find((r) => r.kind === "launch").body), { state: "done" });
});

test("/intents and /ack admin rights are bound to the roster guild", async () => {
  const env = await makeEnv();
  addRow(env, "journey", { journey: "curious" });
  const other = { guild: "500000000000000005" };
  const text = (await discordCmd(env, "intents", "32", [], other)).data.content;
  assert.ok(!text.includes("Mailbox") && !text.includes("curious") && !/total pending/.test(text));
  assert.match(text, /admin/i);
  // /ack from another guild with Administrator does not clear the whole mailbox (the row is another member's).
  env.DB.raw.prepare("UPDATE intents SET slug = 'someone-else'").run();
  await discordCmd(env, "ack", "8", [{ name: "up_to", type: 4, value: 99 }], other);
  assert.equal(intentRows(env).length, 1, "foreign-guild admin cleared nothing");
  await discordCmd(env, "ack", "8", [{ name: "up_to", type: 4, value: 99 }]);
  assert.equal(intentRows(env).length, 0, "roster-guild admin clears the mailbox");
});

test("no roster guild configured: the server gate is off, admins keep /intents and are told so; non-admins are still refused", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("DELETE FROM kv_state WHERE key = 'discord_roster'").run();
  invalidateConfigCache();
  addRow(env, "journey", { journey: "curious" });
  const admin = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(admin.includes("curious"), "an admin still sees the mailbox");
  assert.ok(admin.includes(GATE_OFF_NOTE), "the reply says the server check is off");
  const nonAdmin = (await discordCmd(env, "intents", "0")).data.content;
  assert.ok(!nonAdmin.includes("curious"), "a non-admin is still refused");
  invalidateConfigCache();
});

const seedAsk = (env, id, by) => env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, status, share, created_at) VALUES (?, ?, 'a question', 'thinking', 1, ?)").run(id, by, AT);
const askAnswer = (env, id, permissions, opts) => discordCmd(env, "answer", permissions, [{ name: "id", type: 3, value: id }, { name: "answer", type: 3, value: "an answer" }], opts);
const askRow = (env, id) => env.DB.raw.prepare("SELECT answer, status FROM ask_turns WHERE id = ?").get(id);
const setRoster = (env, json) => { env.DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('discord_roster', ?, ?)").run(json, AT); invalidateConfigCache(); };

test("/answer admin rights are bound to the roster guild: a foreign-guild admin cannot answer another member's ask", async () => {
  const env = await makeEnv();
  seedAsk(env, "ask-g1", "Someone Else");
  const denied = (await askAnswer(env, "ask-g1", "32", { guild: "500000000000000005" })).data.content;
  assert.match(denied, /only answer your own/);
  assert.equal(askRow(env, "ask-g1").answer, null, "nothing written");
  const ok = (await askAnswer(env, "ask-g1", "32")).data.content;
  assert.match(ok, /Answer recorded/);
  assert.ok(!ok.includes(GATE_OFF_NOTE), "roster configured: no note");
  assert.equal(askRow(env, "ask-g1").answer, "an answer");
});

test("a malformed roster guildId refuses every admin command; it is not the gate-off case", async () => {
  for (const bad of ['{"guildId":"abc"}', '{"guildId":""}', '{"guildId":"1234"}', '{"guildId":400000000000000004}', '{"guildId":null}', '{"guildId":["400000000000000004"]}']) {
    const env = await makeEnv();
    setRoster(env, bad);
    addRow(env, "journey", { journey: "curious" });
    seedAsk(env, "ask-m1", "Someone Else");
    const intents = (await discordCmd(env, "intents", "32")).data.content;
    assert.ok(!intents.includes("curious") && !intents.includes(GATE_OFF_NOTE) && /admin/i.test(intents), `intents refused for ${bad}`);
    env.DB.raw.prepare("UPDATE intents SET slug = 'someone-else'").run();
    await discordCmd(env, "ack", "32", [{ name: "up_to", type: 4, value: 99 }]);
    assert.equal(intentRows(env).length, 1, `ack cleared nothing for ${bad}`);
    assert.match((await askAnswer(env, "ask-m1", "32")).data.content, /only answer your own/);
    assert.equal(askRow(env, "ask-m1").answer, null, `answer wrote nothing for ${bad}`);
  }
  invalidateConfigCache();
});

test("a corrupt or non-object roster row refuses admins", async () => {
  for (const bad of ["{not json", "null", "[]", '"400000000000000004"', "7"]) {
    const env = await makeEnv();
    setRoster(env, bad);
    addRow(env, "journey", { journey: "curious" });
    const text = (await discordCmd(env, "intents", "32")).data.content;
    assert.ok(!text.includes("curious") && !text.includes(GATE_OFF_NOTE), `refused for ${bad}`);
  }
  invalidateConfigCache();
});

test("a throwing roster read refuses admins and is not cached as absent", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("DELETE FROM kv_state WHERE key = 'discord_roster'").run();
  invalidateConfigCache();
  addRow(env, "journey", { journey: "curious" });
  const realPrepare = env.DB.prepare.bind(env.DB);
  let failing = true;
  env.DB.prepare = (sql) => { if (failing && /FROM kv_state WHERE key = \?/.test(sql)) throw new Error("D1 down"); return realPrepare(sql); };
  const down = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(!down.includes("curious") && !down.includes(GATE_OFF_NOTE), "read error refuses");
  const stillDown = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(!stillDown.includes("curious"), "a second call re-reads and still refuses");
  failing = false;
  invalidateConfigCache("discord_members"); // other callers keep their own 60 s null on a failed read; only the roster gate is under test
  const back = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(back.includes("curious") && back.includes(GATE_OFF_NOTE), "the failure was not cached: a clean absent row is gate-off");
  invalidateConfigCache();
});

test("a roster object with no guildId key is gate-off; a cleanly absent row is gate-off", async () => {
  const env = await makeEnv();
  setRoster(env, '{"buildThreads":{}}');
  addRow(env, "journey", { journey: "curious" });
  const text = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(text.includes("curious") && text.includes(GATE_OFF_NOTE));
  invalidateConfigCache();
});

test("gate-off note on /ack and /answer: shown to an admin, never to a non-admin", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("DELETE FROM kv_state WHERE key = 'discord_roster'").run();
  invalidateConfigCache();
  addRow(env, "journey", { journey: "curious" });
  const nonAdminAck = (await discordCmd(env, "ack", "0", [{ name: "up_to", type: 4, value: 99 }])).data.content;
  assert.ok(!nonAdminAck.includes(GATE_OFF_NOTE), "non-admin /ack: no note");
  seedAsk(env, "ask-n1", NAME);
  const nonAdminAnswer = (await askAnswer(env, "ask-n1", "0")).data.content;
  assert.match(nonAdminAnswer, /Answer recorded/);
  assert.ok(!nonAdminAnswer.includes(GATE_OFF_NOTE), "non-admin /answer: no note");
  const adminAnswer = (await askAnswer(env, "ask-n1", "32")).data.content;
  assert.ok(adminAnswer.includes(GATE_OFF_NOTE), "admin /answer: note");
  const adminAck = (await discordCmd(env, "ack", "32", [{ name: "up_to", type: 4, value: 99 }])).data.content;
  assert.ok(adminAck.includes(GATE_OFF_NOTE), "admin /ack: note");
  assert.equal(intentRows(env).length, 0, "admin cleared the mailbox");
  invalidateConfigCache();
});
test("roster guild configured: no gate-off note", async () => {
  const env = await makeEnv();
  addRow(env, "journey", { journey: "curious" });
  const admin = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(admin.includes("curious"));
  assert.ok(!admin.includes(GATE_OFF_NOTE));
});

test("a non-admin cannot supply permissions: an option or a top-level field is ignored", async () => {
  const env = await makeEnv();
  addRow(env, "journey", { journey: "curious" });
  addRow(env, "sheet", { field: "race", value: HIDDEN, visible: false, source: "board" });
  env.DB.raw.prepare("UPDATE intents SET slug = 'someone-else'").run();
  const forged = [
    { options: [{ name: "permissions", type: 3, value: "8" }], top: {} },
    { options: [{ name: "permissions", type: 3, value: "32" }], top: {} },
    { options: [], top: { permissions: "8" } },
    { options: [], top: { permissions: "4398046511103", app_permissions: "8" } },
  ];
  for (const { options, top } of forged) {
    const text = (await discordCmd(env, "intents", "0", options, { top })).data.content;
    assert.ok(!text.includes("Mailbox") && !text.includes("curious") && !text.includes(MARKER), JSON.stringify({ options, top }));
    assert.match(text, /admin/i);
    await discordCmd(env, "ack", "0", [...options, { name: "up_to", type: 4, value: 99 }], { top });
    assert.equal(intentRows(env).length, 2, "a forged permission cleared nothing");
  }
});

test("GET /intents never echoes an unparseable row", async () => {
  const env = await makeEnv();
  addRow(env, "sheet", `not json ${HIDDEN}`);
  const res = await adminApi(env, "GET", "/intents?after=0");
  const text = await res.text();
  assert.ok(!text.includes(MARKER) && !text.includes("raw"), text);
  assert.equal(JSON.parse(text).intents.length, 1);
});

// Review follow-ups (PR 344): a read failure limited to the roster key must keep refusing on every call, and a failure
// first seen by the ordinary loader (shared cache) must not later read as "no roster guild".
const KV_READ = "FROM kv_state WHERE key = ?";
function failRosterReads(env) {
  const realPrepare = env.DB.prepare.bind(env.DB);
  const state = { failing: true };
  env.DB.prepare = (sql) => {
    const p = realPrepare(sql);
    if (!sql.includes(KV_READ)) return p;
    return { bind: (k) => { if (state.failing && k === "discord_roster") throw new Error("D1 down"); return p.bind(k); } };
  };
  return state;
}

test("a roster-only read failure refuses on every call, never opens the gate from a cached failure, and recovers", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("DELETE FROM kv_state WHERE key = 'discord_roster'").run();
  invalidateConfigCache();
  addRow(env, "journey", { journey: "curious" });
  const state = failRosterReads(env);
  for (let i = 0; i < 3; i++) {
    const t = (await discordCmd(env, "intents", "32")).data.content;
    assert.ok(!t.includes("curious") && !t.includes(GATE_OFF_NOTE), `call ${i + 1} while the roster read fails`);
  }
  env.DB.raw.prepare("UPDATE intents SET slug = 'someone-else'").run(); // a refused admin may still clear only their OWN rows
  const before = intentRows(env).length;
  await discordCmd(env, "ack", "32", [{ name: "up_to", type: 4, value: 99 }]);
  assert.equal(intentRows(env).length, before, "/ack cleared no other member's row while the roster read fails");
  state.failing = false;
  const ok = (await discordCmd(env, "intents", "32")).data.content;
  assert.ok(ok.includes("curious") && ok.includes(GATE_OFF_NOTE), "after recovery the absent roster gives gate-off");
  invalidateConfigCache();
});

test("a roster failure first cached by loadConfigKey still refuses at the gate", async () => {
  const { loadConfigKey } = await import("../../infrastructure/worker/config.js");
  const env = await makeEnv();
  env.DB.raw.prepare("DELETE FROM kv_state WHERE key = 'discord_roster'").run();
  invalidateConfigCache();
  addRow(env, "journey", { journey: "curious" });
  failRosterReads(env);
  await loadConfigKey(env, "discord_roster");
  for (let i = 0; i < 2; i++) {
    const t = (await discordCmd(env, "intents", "32")).data.content;
    assert.ok(!t.includes("curious") && !t.includes(GATE_OFF_NOTE), `gate refuses after a failed ordinary read (${i + 1})`);
  }
  invalidateConfigCache();
});

test("a malformed roster guildId refuses even when the interaction carries the same string", async () => {
  for (const g of ["abc", "1234"]) {
    const env = await makeEnv();
    setRoster(env, JSON.stringify({ guildId: g }));
    addRow(env, "journey", { journey: "curious" });
    const t = (await discordCmd(env, "intents", "32", [], { guild: g })).data.content;
    assert.ok(!t.includes("curious"), `refused for guildId ${g}`);
  }
  invalidateConfigCache();
});
