// /member add and /member list: admin roster entries written through the SAME code path as POST /api/admin/members (member-write.js).
// Real Worker code over an in-memory SQLite D1. Fictional names only; no live Discord.
// Run: node --test tests/unit/discord-member.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { handleDiscordInteraction, DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache, loadConfigKey } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const AT = "2026-11-12T00:00:00.000Z";
const GUILD = "400000000000000004";
const OTHER_GUILD = "999999999999999999";
const ADMIN_TOKEN = "admin-token-for-tests-0123456789ab";
const ALDOUS = "100000000000000101", BRISEIS = "100000000000000102", CORVIN = "100000000000000103";
const BOT = ["bot", "token", "built", "at", "runtime"].join("-") + "." + "x".repeat(24);
const ROSTER = { guildId: GUILD, channels: {} };

const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };
const readRow = (env) => { const r = env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'discord_members'").get(); return r ? JSON.parse(r.json) : null; };
const seed = (env, members) => env.DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run("discord_members", JSON.stringify(members), AT);

function makeEnv({ roster = ROSTER } = {}) {
  invalidateConfigCache();
  const DB = schemaDb();
  if (roster !== null) DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run("discord_roster", JSON.stringify(roster), AT);
  const signer = createDiscordSigner();
  const room = { fetch: async () => new Response(JSON.stringify({ ok: true })) };
  return { DB, signer, DISCORD_BOT_TOKEN: BOT, BOARD_ADMIN_TOKEN: ADMIN_TOKEN, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "salt-for-tests-0123456789", DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
async function run(env, interaction) {
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest(interaction), env, ctx, ORIGIN));
  assert.equal(res.status, 200);
  return res.json();
}
const base = (permissions, guild = GUILD) => ({ id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: guild, member: { nick: "Adm", user: { id: "100000000000000042", username: "adm" }, ...(permissions === undefined ? {} : { permissions }) } });
let calls = [];
const inGuild = async () => new Response(JSON.stringify({ user: { id: "x" } }), { status: 200 });
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return impl(url, init); };
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const add = (env, permissions, o = {}, guild, impl = inGuild) => withFetch(impl, () => addRaw(env, permissions, o, guild));
const audit = (env) => env.DB.raw.prepare("SELECT * FROM audit_log").all();
const addRaw = (env, permissions, { user, name, match } = {}, guild) => run(env, {
  ...base(permissions, guild), type: 2,
  data: { name: "member", options: [{ name: "add", type: 1, options: [
    ...(user === undefined ? [] : [{ name: "user", type: 6, value: user }]),
    ...(name === undefined ? [] : [{ name: "name", type: 3, value: name }]),
    ...(match === undefined ? [] : [{ name: "match", type: 3, value: match }]),
  ] }] },
});
const list = (env, permissions, guild) => run(env, { ...base(permissions, guild), type: 2, data: { name: "member", options: [{ name: "list", type: 1 }] } });
const ephemeral = (r) => { assert.equal(r.type, 4); assert.equal(r.data.flags & 64, 64); assert.deepEqual(r.data.allowed_mentions, { parse: [] }); };

test("non-admin and wrong-guild get the admin-only reply and nothing is written", async () => {
  const env = makeEnv();
  for (const [perms, guild] of [[undefined, GUILD], ["0", GUILD], ["2048", GUILD], ["32", OTHER_GUILD]]) {
    for (const r of [await add(env, perms, { user: ALDOUS, name: "Aldous Thorne" }, guild), await list(env, perms, guild)]) {
      ephemeral(r);
      assert.equal(r.data.content, "That command is for server admins.");
    }
  }
  assert.equal(readRow(env), null);
});

test("add writes exactly one entry: slug from the name, id from the user, match split and lowercased", async () => {
  const env = makeEnv();
  const r = await add(env, "32", { user: ALDOUS, name: "Aldous Thorne", match: "Aldo, ALDOUS  thorne aldo" });
  ephemeral(r);
  assert.deepEqual(readRow(env), [{ slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldo", "aldous", "thorne"], id: ALDOUS }]);
  assert.match(r.data.content, /aldous-thorne/);
  assert.ok(!r.data.content.includes("<@"));
  assert.equal((await loadConfigKey(env, "discord_members")).length, 1);
});

test("cache invalidation: a stale cached read is replaced by the write", async () => {
  const env = makeEnv();
  seed(env, []);
  assert.deepEqual(await loadConfigKey(env, "discord_members"), []);
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  assert.equal((await loadConfigKey(env, "discord_members")).length, 1);
});

test("add with no match defaults to the lowercased display-name tokens; adding a second keeps the first", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  await add(env, "32", { user: BRISEIS, name: "Briseis Vane", match: "bri" });
  const rows = readRow(env);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].match, ["aldous", "thorne"]);
  assert.deepEqual(rows[1], { slug: "briseis-vane", name: "Briseis Vane", match: ["bri"], id: BRISEIS });
});

test("re-adding the SAME id updates name and match (upsert), one row per slug", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne", match: "aldo" });
  const r = await add(env, "32", { user: ALDOUS, name: "Aldous Thorne", match: "alder" });
  ephemeral(r);
  assert.deepEqual(readRow(env), [{ slug: "aldous-thorne", name: "Aldous Thorne", match: ["alder"], id: ALDOUS }]);
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  assert.deepEqual(readRow(env)[0].match, ["alder"], "an update with no match keeps the existing list");
  seed(env, [{ slug: "aldous-thorne", name: "Aldous Thorne", match: [], id: ALDOUS }]);
  invalidateConfigCache();
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  assert.deepEqual(readRow(env)[0].match, ["aldous", "thorne"], "an update with no match fills an empty list from the name");
});

test("an existing slug is never rebound to a different user: refused, nothing written, no audit row", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne", match: "aldo" });
  const before = JSON.stringify(readRow(env));
  const r = await add(env, "32", { user: CORVIN, name: "Aldous Thorne", match: "al" });
  ephemeral(r);
  assert.equal(r.data.content, "Nothing added: that name is already on the roster; use a different name.");
  assert.equal(JSON.stringify(readRow(env)), before);
  assert.equal(audit(env).length, 1, "only the first add was audited");
  // a prior entry with no id is also not claimable
  seed(env, [{ slug: "briseis-vane", name: "Briseis Vane", match: [] }]);
  invalidateConfigCache();
  const r2 = await add(env, "32", { user: BRISEIS, name: "Briseis Vane" });
  assert.equal(r2.data.content, "Nothing added: that name is already on the roster; use a different name.");
  assert.equal(readRow(env)[0].id, undefined);
  assert.equal(audit(env).length, 1);
});

test("the rebind refusal is atomic: it is judged on the row at write time, not on an earlier read", async () => {
  const env = makeEnv();
  seed(env, []);
  invalidateConfigCache();
  const real = env.DB;
  let raced = false;
  env.DB = { raw: real.raw, batch: (...a) => real.batch(...a), prepare: (sql) => {
    if (/^UPDATE kv_state|^INSERT OR IGNORE INTO kv_state/.test(sql) && !raced) {
      raced = true; // another admin claims the slug between our read and our write
      real.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'discord_members'").run(JSON.stringify([{ slug: "aldous-thorne", name: "Aldous Thorne", match: [], id: CORVIN }]));
    }
    return real.prepare(sql);
  } };
  const r = await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  assert.equal(r.data.content, "Nothing added: that name is already on the roster; use a different name.");
  assert.equal(readRow(env)[0].id, CORVIN);
});

test("an id already held by another slug is refused with the validator's message and never names the other member", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  const r = await add(env, "32", { user: ALDOUS, name: "Briseis Vane" });
  ephemeral(r);
  assert.match(r.data.content, /id already belongs to a different member/);
  assert.equal(readRow(env).length, 1);
  assert.ok(!r.data.content.includes("aldous-thorne") && !r.data.content.includes("Aldous"));
});

test("invalid input writes nothing: empty name, name with no slug, long name, bad id, too many match tokens, missing options", async () => {
  const env = makeEnv();
  const cases = [
    { user: ALDOUS, name: "   " },
    { user: ALDOUS, name: "!!!" },
    { user: ALDOUS, name: "x".repeat(41) },
    { user: "123", name: "Aldous Thorne" },
    { user: ALDOUS, name: "Aldous Thorne", match: Array.from({ length: 400 }, (_, i) => `tok${i}`).join(" ") },
    { user: ALDOUS },
    { name: "Aldous Thorne" },
  ];
  for (const c of cases) {
    const r = await add(env, "32", c);
    ephemeral(r);
    assert.ok(r.data.content.length > 0);
    assert.ok(!r.data.content.includes("<@"));
  }
  assert.equal(readRow(env), null);
});

test("list is ephemeral, shows slug, name and plain-digit id per entry, and mentions nothing", async () => {
  const env = makeEnv();
  seed(env, [
    { slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldo"], id: ALDOUS },
    { slug: "briseis-vane", name: "Briseis Vane", match: [] },
  ]);
  const r = await list(env, "32");
  ephemeral(r);
  for (const s of ["aldous-thorne", "Aldous Thorne", ALDOUS, "briseis-vane", "Briseis Vane"]) assert.ok(r.data.content.includes(s), s);
  assert.ok(!r.data.content.includes("<@") && !r.data.content.includes("@everyone") && !r.data.content.includes("@here"));
  assert.ok(r.data.content.length <= 2000);
});

test("list on an empty roster says so; a long roster is cut under the 2000 character limit", async () => {
  const env = makeEnv();
  assert.match((await list(env, "32")).data.content, /No members/i);
  invalidateConfigCache();
  seed(env, Array.from({ length: 80 }, (_, i) => ({ slug: `member-${i}`, name: `Member Number ${i}`, match: [], id: `1000000000000002${String(i).padStart(2, "0")}` })));
  const r = await list(env, "32");
  ephemeral(r);
  assert.ok(r.data.content.length <= 2000);
  assert.match(r.data.content, /more/);
});

test("a name that looks like a mention is rendered inert", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Aldous @everyone" });
  assert.equal(readRow(env).length, 1);
  const r = await list(env, "32");
  ephemeral(r);
  assert.ok(!/@everyone|@here|<@/.test(r.data.content), r.data.content);
});

test("manifest: /member is hidden (Manage Server), guild-only, add and list subcommands", () => {
  const cmd = DISCORD_SLASH_COMMANDS_MANIFEST.find((c) => c.name === "member");
  assert.ok(cmd);
  assert.equal(cmd.default_member_permissions, "32");
  assert.equal(cmd.dm_permission, false);
  const [a, l] = cmd.options;
  assert.deepEqual([a.name, a.type, l.name, l.type], ["add", 1, "list", 1]);
  const o = Object.fromEntries(a.options.map((x) => [x.name, x]));
  assert.equal(o.user.type, 6); assert.equal(o.user.required, true);
  assert.equal(o.name.type, 3); assert.equal(o.name.required, true);
  assert.equal(o.match.type, 3); assert.ok(!o.match.required);
});

test("static: the /member handler calls rosterAdminCheck", () => {
  const src = fs.readFileSync(new URL("../../infrastructure/worker/discord.js", import.meta.url), "utf8");
  const at = src.lastIndexOf('cmd === "member"');
  assert.ok(at > 0 && /rosterAdminCheck/.test(src.slice(at, at + 400)));
});

// ---- the route: same statuses and bodies before and after the refactor ----
async function post(env, body, token = ADMIN_TOKEN) {
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api/admin/members`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body }), env, ctx));
  return { status: res.status, text: await res.text() };
}
test("route POST /api/admin/members: same statuses and bodies", async () => {
  const env = makeEnv();
  assert.deepEqual(await post(env, "{}", "wrong"), { status: 401, text: JSON.stringify({ error: "Unauthorized" }) });
  assert.deepEqual(await post(env, "x".repeat(2001)), { status: 413, text: JSON.stringify({ error: "Body too large" }) });
  assert.deepEqual(await post(env, "{nope"), { status: 400, text: JSON.stringify({ error: "Body must be valid JSON" }) });
  assert.deepEqual(await post(env, "[]"), { status: 400, text: JSON.stringify({ error: "member must be an object" }) });
  assert.deepEqual(await post(env, JSON.stringify({ slug: "BAD", name: "A", match: [] })), { status: 400, text: JSON.stringify({ error: "slug must be 1 to 32 lowercase letters, digits or dashes" }) });
  assert.equal(readRow(env), null);
  assert.deepEqual(await post(env, JSON.stringify({ slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldo"], id: ALDOUS })), { status: 200, text: JSON.stringify({ ok: true, slug: "aldous-thorne", entries: 1 }) });
  assert.deepEqual(await post(env, JSON.stringify({ slug: "briseis-vane", name: "Briseis", match: [], id: ALDOUS })), { status: 400, text: JSON.stringify({ error: "id already belongs to a different member" }) });
  assert.deepEqual(readRow(env), [{ slug: "aldous-thorne", name: "Aldous Thorne", match: ["aldo"], id: ALDOUS }]);
  env.DB.raw.prepare("UPDATE kv_state SET json = 'not json' WHERE key = 'discord_members'").run();
  assert.deepEqual(await post(env, JSON.stringify({ slug: "x", name: "X", match: [] })), { status: 500, text: JSON.stringify({ error: "Could not read the roster" }) });
});

// ---- guild membership check (GET /guilds/{id}/members/{id}, bot token, no privileged intent) ----
const status = (s) => async () => new Response("{}", { status: s });
const NOT_IN = "That user is not in this server.";
const UNSURE = "Could not confirm membership with Discord; nothing was written.";

test("guild check: a 200 lets the add through; the request is a bot-token GET for the roster guild and the picked user", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://discord.com/api/v10/guilds/${GUILD}/members/${ALDOUS}`);
  assert.equal(calls[0].init.method || "GET", "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bot ${BOT}`);
  assert.equal(readRow(env).length, 1);
});

test("guild check: 404 says the user is not in the server and writes nothing", async () => {
  const env = makeEnv();
  const r = await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" }, undefined, status(404));
  ephemeral(r);
  assert.equal(r.data.content, NOT_IN);
  assert.equal(readRow(env), null);
  assert.equal(audit(env).length, 0);
});

test("guild check fails closed: 500, 403, 429, a thrown fetch, a timeout and no bot token all write nothing", async () => {
  for (const impl of [status(500), status(403), status(429), async () => { throw new Error("net"); },
    (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))]) {
    const env = makeEnv();
    const r = await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" }, undefined, impl);
    ephemeral(r);
    assert.equal(r.data.content, UNSURE);
    assert.equal(readRow(env), null);
    assert.equal(audit(env).length, 0);
  }
  const env = makeEnv();
  delete env.DISCORD_BOT_TOKEN;
  const r = await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  assert.equal(r.data.content, UNSURE);
  assert.equal(calls.length, 0);
  assert.equal(readRow(env), null);
});

test("guild check is not reached for invalid input or a refused caller", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "   " });
  await add(env, "0", { user: ALDOUS, name: "Aldous Thorne" });
  assert.equal(calls.length, 0);
});

// ---- audit row (existing audit_log table) ----
test("a successful add writes exactly one audit_log row: actor, added id, slug, time; no name or match text", async () => {
  const env = makeEnv();
  env.DB.raw.prepare("INSERT INTO users (discord_user_id, created_at) VALUES (?, ?)").run("100000000000000042", AT);
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne", match: "secretword" });
  const rows = audit(env);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.action, "member.add");
  assert.equal(row.target, "aldous-thorne");
  assert.equal(row.actor_discord_user_id, "100000000000000042");
  assert.deepEqual(JSON.parse(row.detail_json), { added: ALDOUS });
  assert.ok(!Number.isNaN(Date.parse(row.at)));
  assert.ok(!JSON.stringify(row).includes("Thorne") && !JSON.stringify(row).includes("secretword"));
});

test("an admin who is not in users still gets the audit row (actor column empty, no admin id in detail)", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  const rows = audit(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_discord_user_id, null);
  assert.deepEqual(JSON.parse(rows[0].detail_json), { added: ALDOUS });
  assert.ok(!JSON.stringify(rows[0]).includes("100000000000000042"));
});

test("failed adds write no audit row: gate, validation, taken id", async () => {
  const env = makeEnv();
  await add(env, "0", { user: ALDOUS, name: "Aldous Thorne" });
  await add(env, "32", { user: ALDOUS, name: "x".repeat(41) });
  assert.equal(audit(env).length, 0);
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  await add(env, "32", { user: ALDOUS, name: "Briseis Vane" });
  assert.equal(audit(env).length, 1);
});

// ---- no roster server set: the command does nothing ----
test("with no roster guildId (gate off) add and list refuse and touch nothing", async () => {
  for (const roster of [{ channels: {} }, null]) {
    const env = makeEnv({ roster });
    seed(env, [{ slug: "aldous-thorne", name: "Aldous Thorne", match: [], id: ALDOUS }]);
    invalidateConfigCache();
    const a = await add(env, "32", { user: BRISEIS, name: "Briseis Vane" }, "777777777777777777");
    const l = await list(env, "32", "777777777777777777");
    for (const r of [a, l]) { ephemeral(r); assert.equal(r.data.content, "Set the roster server first."); }
    assert.equal(calls.length, 0);
    assert.equal(readRow(env).length, 1);
    assert.equal(audit(env).length, 0);
  }
});

// ---- the small things ----
test("default match drops display-name words shorter than 3 characters", async () => {
  const env = makeEnv();
  await add(env, "32", { user: ALDOUS, name: "Al Thorne of Oz" });
  assert.deepEqual(readRow(env)[0].match, ["thorne"]);
  await add(env, "32", { user: BRISEIS, name: "Bo Vi" });
  assert.deepEqual(readRow(env)[1].match, []);
});

test("list and add replies neutralise markdown and line breaks in stored names", async () => {
  const env = makeEnv();
  seed(env, [{ slug: "x-y", name: "A*b_c[d](e)`f~g|h\nZ\r\nW", match: [], id: ALDOUS }]);
  const r = await list(env, "32");
  const body = r.data.content.split("\n").slice(1).join("\n");
  assert.equal(body.split("\n").filter((l) => l.startsWith("x-y")).length, 1, "one line per entry: no CR or LF from a name");
  assert.ok(!r.data.content.includes("\r"));
  const nameCell = body.split(" | ")[1];
  for (const ch of ["*", "_", "[", "]", "(", ")", "`", "~", "|"]) {
    const bare = [...nameCell].some((c, i) => c === ch && nameCell[i - 1] !== "\\");
    assert.ok(!bare, `${ch} is escaped`);
  }
});

test("the roster write is compare-and-set: a concurrent change between read and write is not lost", async () => {
  const env = makeEnv();
  seed(env, [{ slug: "briseis-vane", name: "Briseis Vane", match: [], id: BRISEIS }]);
  invalidateConfigCache();
  const real = env.DB;
  let raced = false;
  env.DB = { raw: real.raw, batch: (...a) => real.batch(...a), prepare: (sql) => {
    if (/^UPDATE kv_state/.test(sql) && !raced) {
      raced = true;
      real.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'discord_members'").run(JSON.stringify([{ slug: "briseis-vane", name: "Briseis Vane", match: [], id: BRISEIS }, { slug: "corvin-ash", name: "Corvin Ash", match: [], id: CORVIN }]));
    }
    return real.prepare(sql);
  } };
  await add(env, "32", { user: ALDOUS, name: "Aldous Thorne" });
  assert.deepEqual(readRow(env).map((m) => m.slug).sort(), ["aldous-thorne", "briseis-vane", "corvin-ash"]);
});
