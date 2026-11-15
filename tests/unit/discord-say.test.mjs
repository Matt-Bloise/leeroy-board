// /say: an admin posts a message as the Leeroy bot, no token typed. Admin gate = rosterAdminCheck (same as /intents); the channel comes only
// from discord_roster.channels by key; the post carries allowed_mentions {parse: []}. Real Worker code over an in-memory SQLite D1.
// Stubs only: no live Discord, no real ids or tokens (the bot token is built at runtime).
// Run: node --test tests/unit/discord-say.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleDiscordInteraction, DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const AT = "2026-11-12T00:00:00.000Z";
const GUILD = "400000000000000004";
const OTHER_GUILD = "999999999999999999";
const CH_GENERAL = "500000000000000001", CH_RAIDS = "500000000000000002";
const ROLE_ID = "600000000000000006";
const TOKEN = ["bot", "token", "built", "at", "runtime"].join("-") + "." + "x".repeat(24); // token-shaped, assembled at runtime
const ROSTER = { guildId: GUILD, channels: { general: CH_GENERAL, raids: CH_RAIDS }, roles: { raiders: ROLE_ID } };

const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

function makeEnv({ roster = ROSTER, token = TOKEN } = {}) {
  invalidateConfigCache();
  const DB = schemaDb();
  if (roster !== null) DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run("discord_roster", JSON.stringify(roster), AT);
  const signer = createDiscordSigner();
  const room = { fetch: async () => new Response(JSON.stringify({ ok: true })) };
  const env = { DB, signer, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "salt-for-tests-0123456789", DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_ROOM: { idFromName: () => "r", get: () => room } };
  if (token) env.DISCORD_BOT_TOKEN = token;
  return env;
}

// Replaces global fetch for one call; records every outbound request.
async function withFetch(impl, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return impl(url, init); };
  try { return { result: await fn(), calls }; } finally { globalThis.fetch = real; }
}
const ok200 = async () => new Response(JSON.stringify({ id: "700000000000000007" }), { status: 200 });

async function run(env, interaction) {
  const res = await quiet(() => handleDiscordInteraction(env.signer.signedRequest(interaction), env, ctx, ORIGIN));
  assert.equal(res.status, 200);
  return res.json();
}
const base = (permissions, guild = GUILD) => ({ id: "1", application_id: "2", token: "t", channel_id: "3", guild_id: guild, member: { nick: "Adm", user: { id: "100000000000000042", username: "adm" }, ...(permissions === undefined ? {} : { permissions }) } });
const say = (env, permissions, channel, text, guild) => run(env, { ...base(permissions, guild), type: 2, data: { name: "say", options: [...(channel === undefined ? [] : [{ name: "channel", type: 3, value: channel }]), { name: "text", type: 3, value: text }] } });
const complete = (env, permissions, typed) => run(env, { ...base(permissions), type: 4, data: { name: "say", options: [{ name: "channel", type: 3, value: typed, focused: true }] } });

test("non-admin is refused and nothing is posted", async () => {
  const env = makeEnv();
  for (const perms of [undefined, "0", "2048"]) {
    const { result, calls } = await withFetch(ok200, () => say(env, perms, "general", "hello"));
    assert.equal(result.type, 4);
    assert.equal(result.data.flags & 64, 64);
    assert.equal(result.data.content, "That command is for server admins.");
    assert.equal(calls.length, 0);
  }
});

test("admin from another server is refused and nothing is posted", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "32", "general", "hello", OTHER_GUILD));
  assert.equal(result.data.content, "That command is for server admins.");
  assert.equal(calls.length, 0);
});

test("admin with an unknown key is refused, lists valid keys, no ids", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "32", "nope", "hello"));
  assert.equal(result.data.flags & 64, 64);
  assert.match(result.data.content, /Unknown channel/);
  assert.match(result.data.content, /general/);
  assert.match(result.data.content, /raids/);
  assert.ok(!result.data.content.includes(CH_GENERAL) && !result.data.content.includes(CH_RAIDS));
  assert.equal(calls.length, 0);
});

test("a raw channel id typed as the key is not accepted", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "32", CH_GENERAL, "hello"));
  assert.match(result.data.content, /Unknown channel/);
  assert.equal(calls.length, 0);
});

test("admin posts: one fetch to the right channel with Bot auth and no pings", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "32", "raids", "hello raid"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://discord.com/api/v10/channels/${CH_RAIDS}/messages`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bot ${TOKEN}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.content, "hello raid");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.components, undefined);
  assert.equal(result.data.content, "Posted to raids.");
  assert.equal(result.data.flags & 64, 64);
});

test("Administrator bit alone also passes the gate", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "8", "general", "hi"));
  assert.equal(calls.length, 1);
  assert.equal(result.data.content, "Posted to general.");
});

test("@everyone and role mention text is posted with parse empty (no ping)", async () => {
  const text = `@everyone @here <@&${ROLE_ID}> <@123456789012345678>`;
  const { calls } = await withFetch(ok200, () => say(makeEnv(), "32", "general", text));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.content, text);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.allowed_mentions.roles, undefined);
});

test("text over 2000 is rejected with a clear ephemeral error, nothing posted; exactly 2000 posts", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "32", "general", "a".repeat(2001)));
  assert.equal(result.data.flags & 64, 64);
  assert.match(result.data.content, /2000/);
  assert.equal(calls.length, 0);
  const exact = await withFetch(ok200, () => say(makeEnv(), "32", "general", "a".repeat(2000)));
  assert.equal(JSON.parse(exact.calls[0].init.body).content.length, 2000);
});

test("empty text is rejected, nothing posted", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "32", "general", "   "));
  assert.equal(result.data.flags & 64, 64);
  assert.equal(calls.length, 0);
});

test("missing channel option is treated as unknown channel", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv(), "32", undefined, "hello"));
  assert.match(result.data.content, /Unknown channel/);
  assert.equal(calls.length, 0);
});

test("missing bot token: ephemeral reply, no fetch", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv({ token: null }), "32", "general", "hello"));
  assert.equal(result.data.content, "Discord bot token not configured");
  assert.equal(result.data.flags & 64, 64);
  assert.equal(calls.length, 0);
});

test("Discord refusing or failing: generic reply, no token, no ids, no text echo", async () => {
  const refuse = async () => new Response("{\"message\":\"Missing Access\"}", { status: 403 });
  const boom = async () => { throw new Error("boom " + TOKEN); };
  for (const impl of [refuse, boom]) {
    const { result } = await withFetch(impl, () => say(makeEnv(), "32", "general", "secret-text-zz"));
    assert.equal(result.data.content, "Discord refused the post");
    assert.equal(result.data.flags & 64, 64);
    const s = JSON.stringify(result);
    assert.ok(!s.includes(TOKEN) && !s.includes(CH_GENERAL) && !s.includes("secret-text-zz") && !s.includes("Missing Access"));
  }
});

test("a hung Discord request is cut short and answered inside 3 s", async () => {
  const hang = (url, init) => new Promise((_, rej) => { if (init && init.signal) init.signal.addEventListener("abort", () => rej(new Error("aborted"))); });
  const t0 = Date.now();
  const { result } = await withFetch(hang, () => say(makeEnv(), "32", "general", "hello"));
  // CHANGED (Fable read): a timeout is not a refusal: the post may have landed, so the admin is told to check before retrying.
  assert.match(result.data.content, /slow to answer/i);
  assert.match(result.data.content, /check the channel/i);
  assert.ok(!/refused/i.test(result.data.content));
  assert.ok(Date.now() - t0 < 2900, "answers inside Discord's 3 s");
});

test("success reply never contains an id, the token or the text", async () => {
  const { result } = await withFetch(ok200, () => say(makeEnv(), "32", "general", "private-body-qq"));
  const s = JSON.stringify(result);
  assert.ok(!s.includes(TOKEN) && !s.includes(CH_GENERAL) && !s.includes("private-body-qq") && !s.includes("700000000000000007"));
  assert.doesNotMatch(s, /\d{17,}/);
});

test("gateOff (roster has no guildId) behaves like /intents: admin bit still required, any guild passes", async () => {
  const env = makeEnv({ roster: { channels: { general: CH_GENERAL } } });
  const denied = await withFetch(ok200, () => say(env, "0", "general", "hi"));
  assert.equal(denied.result.data.content, "That command is for server admins.");
  assert.equal(denied.calls.length, 0);
  const posted = await withFetch(ok200, () => say(env, "32", "general", "hi", OTHER_GUILD));
  assert.equal(posted.calls.length, 1);
  // CHANGED (Fable read): gateOff means any server admin can post into the roster channels, so the reply says so, as /intents does.
  assert.ok(posted.result.data.content.startsWith("Posted to general."));
  assert.match(posted.result.data.content, /Server check is off/);
});

test("with a guildId set the success reply carries no gate-off note", async () => {
  const { result } = await withFetch(ok200, () => say(makeEnv(), "32", "general", "hi"));
  assert.equal(result.data.content, "Posted to general.");
});

test("roster absent: admin passes the gate but has no channels (unknown channel, no post)", async () => {
  const { result, calls } = await withFetch(ok200, () => say(makeEnv({ roster: null }), "32", "general", "hi"));
  assert.match(result.data.content, /Unknown channel/);
  assert.equal(calls.length, 0);
});

test("autocomplete: admin gets keys only, filtered by prefix, never ids", async () => {
  const env = makeEnv();
  const all = await complete(env, "32", "");
  assert.equal(all.type, 8);
  assert.deepEqual(all.data.choices.map((c) => c.value).sort(), ["general", "raids"]);
  assert.ok(all.data.choices.every((c) => c.name === c.value));
  assert.doesNotMatch(JSON.stringify(all), /\d{5,}/);
  const some = await complete(env, "32", "RA");
  assert.deepEqual(some.data.choices.map((c) => c.value), ["raids"]);
});

test("autocomplete: capped at 25 choices", async () => {
  const channels = {};
  for (let i = 0; i < 40; i++) channels[`chan-${String(i).padStart(2, "0")}`] = `5000000000000001${String(i).padStart(2, "0")}`;
  const res = await complete(makeEnv({ roster: { guildId: GUILD, channels } }), "32", "chan");
  assert.equal(res.data.choices.length, 25);
});

test("autocomplete: non-admin and foreign guild get an empty list", async () => {
  const env = makeEnv();
  assert.deepEqual((await complete(env, "0", "")).data.choices, []);
  assert.deepEqual((await complete(env, undefined, "")).data.choices, []);
  const foreign = await run(env, { ...base("32", OTHER_GUILD), type: 4, data: { name: "say", options: [{ name: "channel", type: 3, value: "", focused: true }] } });
  assert.deepEqual(foreign.data.choices, []);
});

test("manifest: /say is hidden (Manage Server), guild-only, channel autocomplete, text required", () => {
  const cmd = DISCORD_SLASH_COMMANDS_MANIFEST.find((c) => c.name === "say");
  assert.ok(cmd, "say is in the manifest");
  assert.equal(cmd.default_member_permissions, "32");
  assert.equal(cmd.dm_permission, false);
  const channel = cmd.options.find((o) => o.name === "channel");
  const text = cmd.options.find((o) => o.name === "text");
  assert.equal(channel.type, 3);
  assert.equal(channel.autocomplete, true);
  assert.equal(text.type, 3);
  assert.equal(text.required, true);
  assert.equal(text.max_length, 2000);
});

test("static: the source definition carries default_member_permissions \"32\"", () => {
  const src = fs.readFileSync(new URL("../../infrastructure/worker/discord.js", import.meta.url), "utf8");
  const at = src.indexOf('name: "say"');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 600), /default_member_permissions: "32"/);
});
