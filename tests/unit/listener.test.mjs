// THE LISTENER (flag LISTENER = off | dry | live; POST /api/listen, /quiet). Real Worker code over an in-memory SQLite D1; Discord and Anthropic are fakes; names are fictional.
//   gate     off (default) is a 404 and /quiet is not in the manifest; it needs ASK_RESEARCH on and is never on in a PR preview.
//   auth     HMAC over timestamp.body with a key derived from the bot token (part B: no separate secret); a stale or wrong signature is 401, a missing bot token is a 404 like the flag off, an oversized body 413, a bad event 400.
//   who      only the roster guild and a roster member (by Discord id); anyone else leaves nothing behind.
//   answers  a mention or a reply goes through the /ask research path; dry posts nothing and keeps the turn private; live posts one reply with every ping off.
//   chatter  filed as the author's 'message' row only with GROUP_MEMORY on and the channel not quiet; /quiet is for roster members.
// Run: node --test tests/unit/listener.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget } from "../../infrastructure/worker/research/claude.js";
import { listenerMode, signListen, verifyListen, parseListenEvent, LISTEN_MAX_BODY, listenerKey, resetListenerKeyCacheForTests } from "../../infrastructure/worker/listener-config.js";
import { processListenEvent, setQuiet, isQuiet, readBounded } from "../../infrastructure/worker/listener.js";
import { manifestFor } from "../../infrastructure/worker/setup-command.js";
import { DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const FAKE_KEY = ["sk", "ant", "FAKE", "TEST", "0000"].join("-");
const BOT = "bot-token-for-tests", OTHER_BOT = "another-bot-token-for-tests";
const KEY = await listenerKey(BOT);
const GUILD = "800000000000000001", CH = "900000000000000001", OTHER_GUILD = "800000000000000009";
const FOX = "700000000000000001", OWL = "700000000000000002", STRANGER = "700000000000000099";
const realFetch = globalThis.fetch;
let anth = [], posts = [], webhook = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("anthropic")) {
    anth.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("hooks.test")) { webhook.push(u); return new Response("{}", { status: 204 }); }
  if (u.includes("discord.com")) { posts.push({ url: u, body: JSON.parse(init.body), auth: init.headers.Authorization }); return new Response("{}", { status: 200 }); }
  return new Response("{}", { status: 599 });
};
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetListenerKeyCacheForTests(); resetKeyCacheForTests(); resetResearchClaudeForTests(); invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache(); privacyBudget.ms = 1000; anth = []; posts = []; webhook = []; });

const roomStub = { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) };
const fakeAi = { run: async () => { throw new Error("Workers AI must not be called for a member"); } };
function mkEnv(DB, extra = {}) {
  return { DB, AI: fakeAi, USER_SALT: "user-salt-for-tests-0123456789", ANTHROPIC_API_KEY: FAKE_KEY, ASK_RESEARCH: "on", RESEARCH_NAMES: "real", GROUP_MEMORY: "on", LISTENER: "live", DISCORD_BOT_TOKEN: BOT, DISCORD_WEBHOOK_URL: "https://hooks.test/w", BOARD_ROOM: roomStub, ...extra };
}
function seed(DB) {
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  put("discord_roster", { guildId: GUILD, channels: { general: CH } });
  put("discord_members", [{ id: FOX, slug: "red-fox", name: "Red Fox", match: ["red fox"] }, { id: OWL, slug: "blue-owl", name: "Blue Owl", match: ["blue owl"] }]);
  const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
  put("party_sheets", [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin") }, updated: "x" }]);
}
const ev = (o = {}) => ({ id: `6000000000000${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`, guild_id: GUILD, channel_id: CH, author_id: FOX, kind: "mention", content: "who tanks tonight", ...o });
const key = async (id) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`listen:user-salt-for-tests-0123456789:${id}`)))].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
const count = (DB, sql, ...a) => DB.raw.prepare(sql).get(...a).c;
const quiet = async (fn) => { const real = { log: console.log, warn: console.warn, error: console.error }; for (const k of Object.keys(real)) console[k] = () => {}; try { return await fn(); } finally { Object.assign(console, real); } };
async function signedPost(env, obj, { key = KEY, ts = Math.floor(Date.now() / 1000), sig = null, raw = null } = {}) {
  const body = raw ?? JSON.stringify(obj);
  const signature = sig ?? (await signListen(key, String(ts), body));
  const waits = [];
  const res = await worker.fetch(new Request("https://worker.test/api/listen", { method: "POST", headers: { "Content-Type": "application/json", "X-Listen-Timestamp": String(ts), "X-Listen-Signature": signature }, body }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}

// ---- the flag and the pure parts -----------------------------------------------------------------------------------------------------------------
test("LISTENER ships off, is documented, and only dry or live turn it on", () => {
  assert.match((() => { const t = read("infrastructure/wrangler.toml"); return t.slice(t.indexOf("[vars]")); })(), /^LISTENER = "off"/m);
  assert.ok(read("docs/runbooks/flags.md").includes("`LISTENER`"));
  for (const v of [undefined, "", "on", "true", "1", "OFF", {}]) assert.equal(listenerMode({ LISTENER: v }), "off", String(v));
  assert.equal(listenerMode({ LISTENER: " Dry " }), "dry");
  assert.equal(listenerMode({ LISTENER: "LIVE" }), "live");
});
test("/quiet is in the manifest only while the listener is not off", () => {
  const names = (env) => manifestFor(env, DISCORD_SLASH_COMMANDS_MANIFEST).map((c) => c.name);
  assert.ok(!names({}).includes("quiet"));
  assert.ok(!names({ LISTENER: "off" }).includes("quiet"));
  assert.ok(names({ LISTENER: "dry" }).includes("quiet"));
  assert.ok(names({ LISTENER: "live" }).includes("quiet"));
});
test("signature: right key and fresh time verify; wrong key, no key, a string for a key, stale time, wrong length and tampered body do not", async () => {
  const body = '{"a":1}', ts = 1_800_000_000;
  const sig = await signListen(KEY, String(ts), body);
  assert.equal(await verifyListen(KEY, String(ts), body, sig, ts + 5), true);
  assert.equal(await verifyListen(KEY, String(ts), body, sig.toUpperCase(), ts + 5), true);
  const other = await listenerKey(OTHER_BOT);
  assert.equal(await verifyListen(other, String(ts), body, sig, ts), false);
  assert.equal(await verifyListen(other, String(ts), body, await signListen(other, String(ts), body), ts), true);
  assert.equal(await verifyListen(undefined, String(ts), body, sig, ts), false);
  assert.equal(await verifyListen(null, String(ts), body, sig, ts), false);
  assert.equal(await verifyListen(BOT, String(ts), body, sig, ts), false, "the bot token itself is not the key");
  assert.equal(await verifyListen(new Uint8Array(8), String(ts), body, sig, ts), false);
  assert.equal(await verifyListen(KEY, String(ts), body, sig, ts + 121), false);
  assert.equal(await verifyListen(KEY, String(ts), body, sig, ts - 121), false);
  assert.equal(await verifyListen(KEY, String(ts), body, sig.slice(2), ts), false);
  assert.equal(await verifyListen(KEY, String(ts), body + " ", sig, ts), false);
  assert.equal(await verifyListen(KEY, "abc", body, sig, ts), false);
  assert.equal(await verifyListen(KEY, String(ts), body, null, ts), false);
});
test("parseListenEvent: strict ids and kinds, bots refused, every ping and channel link removed, lengths bounded", () => {
  assert.equal(parseListenEvent(null).ok, false);
  assert.equal(parseListenEvent([]).ok, false);
  assert.equal(parseListenEvent({ ...ev(), id: "abc" }).ok, false);
  assert.equal(parseListenEvent({ ...ev(), kind: "dm" }).ok, false);
  assert.equal(parseListenEvent({ ...ev(), bot: true }).ok, false);
  const r = parseListenEvent({ ...ev({ content: "hey <@1234567890123456> and <@&1234567890123456> @everyone @here <#1234567890123456> ok" + "x".repeat(5000), kind: "reply" }), ref_text: "earlier <@123456789012345> line" });
  assert.equal(r.ok, true);
  assert.ok(!/<@|<#|@everyone|@here/.test(r.ev.content + r.ev.ref_text));
  assert.ok(r.ev.content.length <= 2000);
  assert.equal(r.ev.ref_text, "earlier line");
});

// ---- the route ---------------------------------------------------------------------------------------------------------------------------------
test("off: the route is a 404 and nothing is read or written, even with a valid signature", async () => {
  const DB = schemaDb(); seed(DB);
  for (const extra of [{ LISTENER: "off" }, { LISTENER: undefined }, { ASK_RESEARCH: "off" }, { DISCORD_BOT_TOKEN: undefined }, { DISCORD_BOT_TOKEN: "" }, { DISCORD_BOT_TOKEN: "short" }]) {
    const res = await signedPost(mkEnv(DB, extra), ev());
    assert.equal(res.status, 404);
  }
  assert.equal(count(DB, "SELECT count(*) c FROM listen_events"), 0);
  assert.equal(anth.length, 0); assert.equal(posts.length, 0);
});
test("never in a PR preview", async () => {
  const DB = schemaDb(); seed(DB);
  for (const extra of [{ IS_PR_PREVIEW: "true" }, { PR_NUMBER: "375" }, { WORKER_NAME: "leeroy-brain-pr-375" }]) {
    assert.equal((await signedPost(mkEnv(DB, extra), ev())).status, 404);
  }
  assert.equal(count(DB, "SELECT count(*) c FROM listen_events"), 0);
  assert.equal(anth.length, 0); assert.equal(posts.length, 0);
});
test("auth: bad signature 401, stale 401, a signature from another bot token 401, oversized 413, bad json 400, bad event 400; nothing stored", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  assert.equal((await signedPost(env, ev(), { sig: "0".repeat(64) })).status, 401);
  assert.equal((await signedPost(env, ev(), { ts: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  assert.equal((await signedPost(env, ev(), { key: await listenerKey(OTHER_BOT) })).status, 401);
  assert.equal((await signedPost(env, null, { raw: "x".repeat(LISTEN_MAX_BODY + 1) })).status, 413);
  assert.equal((await signedPost(env, null, { raw: "not json" })).status, 400);
  assert.equal((await signedPost(env, { ...ev(), kind: "nope" })).status, 400);
  assert.equal(count(DB, "SELECT count(*) c FROM listen_events"), 0);
  assert.equal(anth.length, 0); assert.equal(posts.length, 0);
});
test("a stranger and a foreign guild are ignored and leave nothing behind", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  for (const e of [ev({ author_id: STRANGER }), ev({ guild_id: OTHER_GUILD })]) {
    assert.equal((await quiet(() => signedPost(env, e))).status, 202);
  }
  assert.equal(count(DB, "SELECT count(*) c FROM listen_events"), 0);
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
  assert.equal(anth.length, 0); assert.equal(posts.length, 0);
});
test("fail closed: no roster guildId means every event is ignored", async () => {
  const DB = schemaDb(); seed(DB);
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('discord_roster', ?, 'x')").run(JSON.stringify({ channels: { general: CH } }));
  const d = await quiet(() => processListenEvent(mkEnv(DB), "https://worker.test", ev(), "live"));
  assert.equal(d, "ignored:guild"); assert.equal(posts.length, 0);
});

// ---- answers -------------------------------------------------------------------------------------------------------------------------------------
test("live mention: one Claude call, one reply post with every ping off, a public turn, the ask and the answer filed", async () => {
  const DB = schemaDb(); seed(DB);
  const e = ev({ content: "who tanks tonight" });
  const res = await quiet(() => signedPost(mkEnv(DB), e));
  assert.equal(res.status, 202);
  assert.ok(anth.length >= 1);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith(`/channels/${CH}/messages`));
  assert.equal(posts[0].auth, "Bot bot-token-for-tests");
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(posts[0].body.message_reference.message_id, e.id);
  assert.equal(posts[0].body.message_reference.fail_if_not_exists, false);
  assert.ok(posts[0].body.content.length > 0 && posts[0].body.content.length <= 2000);
  const row = DB.raw.prepare("SELECT e.decision, e.posted, t.answer FROM listen_events e JOIN ask_turns t ON t.id = e.ask_id WHERE e.channel = ?").get(CH);
  assert.equal(row.decision, "posted"); assert.equal(row.posted, 1); assert.ok(row.answer);
  assert.equal(row.answer.slice(0, 20), posts[0].body.content.slice(0, 20));
  assert.equal(count(DB, "SELECT count(*) c FROM ask_turns WHERE share = 1"), 1);
  assert.equal(webhook.length, 0, "no webhook copy of a member's message");
  assert.equal(count(DB, "SELECT count(*) c FROM kv_state WHERE key = 'stats' AND json LIKE '%who tanks%'"), 0, "no stats.recent entry");
  assert.equal(count(DB, "SELECT count(*) c FROM group_log WHERE kind = 'ask' AND author_slug = 'red-fox' AND channel = ?", CH), 1);
});
test("dry mention: answered into a PRIVATE turn, nothing posted, the would-be reply stored, the ask filed ask-private", async () => {
  const DB = schemaDb(); seed(DB);
  const e = ev();
  await quiet(() => signedPost(mkEnv(DB, { LISTENER: "dry" }), e));
  assert.equal(posts.length, 0);
  const row = DB.raw.prepare("SELECT e.decision, e.posted, t.answer, t.share FROM listen_events e JOIN ask_turns t ON t.id = e.ask_id WHERE e.channel = ?").get(CH);
  assert.equal(row.decision, "dry:answered"); assert.equal(row.posted, 0); assert.ok(row.answer); assert.equal(row.share, 0);
  assert.equal(count(DB, "SELECT count(*) c FROM ask_turns WHERE share = 1"), 0);
  assert.ok(count(DB, "SELECT count(*) c FROM group_log WHERE source = 'ask-private' AND kind = 'ask'") === 1);
  assert.equal(count(DB, "SELECT count(*) c FROM group_log WHERE source = 'ask'"), 0);
});
test("a repeated delivery of the same message answers once", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB); const e = ev();
  await quiet(() => signedPost(env, e));
  await quiet(() => signedPost(env, e));
  assert.equal(posts.length, 1);
  assert.equal(count(DB, "SELECT count(*) c FROM listen_events WHERE msg_id = ?", await key(e.id)), 1);
});
test("a reply carries the earlier line into the question; an empty mention is not answered", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  await quiet(() => signedPost(env, { ...ev({ kind: "reply", content: "and the healer?" }), ref_text: "Tank is Red Fox." }));
  const turn = DB.raw.prepare("SELECT question FROM ask_turns").get();
  assert.match(turn.question, /replying to Leeroy's earlier line: "Tank is Red Fox\."/);
  const before = anth.length;
  const e2 = ev({ content: "<@1234567890123456>" });
  await quiet(() => signedPost(env, e2));
  assert.equal(anth.length, before);
  assert.equal(DB.raw.prepare("SELECT decision FROM listen_events WHERE msg_id = ?").get(await key(e2.id)).decision, "empty");
});
test("friend text only ever reaches Anthropic: no other host is called for a member", async () => {
  const DB = schemaDb(); seed(DB);
  const hosts = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (u, i) => { hosts.push(new URL(String(u)).host); return prev(u, i); };
  try { await quiet(() => signedPost(mkEnv(DB), ev())); } finally { globalThis.fetch = prev; }
  for (const h of hosts) assert.ok(/anthropic\.com$|discord\.com$/.test(h), h);
});
test("a failed Discord post is recorded, never thrown, and the turn survives", async () => {
  const DB = schemaDb(); seed(DB); const e = ev();
  const d = await quiet(() => processListenEvent(mkEnv(DB), "https://worker.test", e, "live", { fetchImpl: async () => new Response("{}", { status: 403 }) }));
  assert.equal(d, "post-failed");
  assert.equal(DB.raw.prepare("SELECT decision, posted FROM listen_events WHERE msg_id = ?").get(await key(e.id)).decision, "post-failed:403");
});
test("no bot token: the answer is kept in listen_events and nothing is posted", async () => {
  const DB = schemaDb(); seed(DB); const e = ev();
  const d = await quiet(() => processListenEvent(mkEnv(DB, { DISCORD_BOT_TOKEN: undefined }), "https://worker.test", e, "live"));
  assert.equal(d, "no-token"); assert.equal(posts.length, 0);
});

// ---- chatter and /quiet --------------------------------------------------------------------------------------------------------------------------
test("chatter: filed as the author's message row (source listener) with GROUP_MEMORY on; no answer, no post, no Claude call", async () => {
  const DB = schemaDb(); seed(DB); const e = ev({ kind: "chatter", author_id: OWL, content: "I will be late on Thursday" });
  await quiet(() => signedPost(mkEnv(DB), e));
  const r = DB.raw.prepare("SELECT author_slug, kind, source, channel, text, reply_to FROM group_log").get();
  assert.deepEqual({ ...r }, { author_slug: "blue-owl", kind: "message", source: "listener", channel: CH, text: "I will be late on Thursday", reply_to: e.id });
  assert.equal(anth.length, 0); assert.equal(posts.length, 0);
});
test("chatter with GROUP_MEMORY off is not stored", async () => {
  const DB = schemaDb(); seed(DB); const e = ev({ kind: "chatter" });
  const d = await quiet(() => processListenEvent(mkEnv(DB, { GROUP_MEMORY: "off" }), "https://worker.test", e, "live"));
  assert.equal(d, "memory-off"); assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});
test("a secret typed into chat is never stored", async () => {
  const DB = schemaDb(); seed(DB); const key = ["sk", "ant", "api03"].join("-") + "-" + "Z9".repeat(24);
  const d = await quiet(() => processListenEvent(mkEnv(DB), "https://worker.test", ev({ kind: "chatter", content: `my key is ${key}` }), "live"));
  assert.equal(d, "not-stored"); assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});
test("a thread under a quiet channel is quiet too; the stored key is not the Discord message id", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB); const THREAD = "900000000000000777";
  await setQuiet(env, CH, true);
  assert.equal(await quiet(() => processListenEvent(env, "https://worker.test", { ...ev({ kind: "chatter", channel_id: THREAD }), parent_id: CH }, "live")), "quiet");
  const e = ev({ kind: "chatter" }); await setQuiet(env, CH, false);
  await quiet(() => processListenEvent(env, "https://worker.test", e, "live"));
  const row = DB.raw.prepare("SELECT msg_id FROM listen_events").get();
  assert.ok(row.msg_id !== e.id && !row.msg_id.includes(e.id) && /^[0-9a-f]{32}$/.test(row.msg_id));
});
test("quiet channel: chatter is neither read nor stored; a tag still gets an answer; /quiet off lets chatter in again", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  assert.equal(await setQuiet(env, CH, true), true);
  assert.equal(await isQuiet(env, CH), true);
  assert.equal(await quiet(() => processListenEvent(env, "https://worker.test", ev({ kind: "chatter" }), "live")), "quiet");
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
  await quiet(() => processListenEvent(env, "https://worker.test", ev({ kind: "mention" }), "live"));
  assert.equal(posts.length, 1);
  assert.equal(await setQuiet(env, CH, false), true);
  assert.equal(await isQuiet(env, CH), false);
  assert.equal(await quiet(() => processListenEvent(env, "https://worker.test", ev({ kind: "chatter" }), "live")), "logged");
  assert.equal(await setQuiet(env, "not-a-channel", true), false);
});
test("a failing quiet lookup fails closed (the channel counts as quiet); only a missing table means not quiet", async () => {
  const DB = schemaDb(); seed(DB);
  const broken = { ...DB, prepare: (sql) => { if (/listen_quiet/.test(sql)) throw new Error("D1 is having a bad day"); return DB.prepare(sql); } };
  assert.equal(await isQuiet(mkEnv(broken), CH), true);
  assert.equal(await quiet(() => processListenEvent(mkEnv(broken), "https://worker.test", ev({ kind: "chatter" }), "live")), "quiet");
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});
test("the body limit counts bytes and stops reading: multi-byte text over 12 KiB is 413 without being buffered", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  const big = "é".repeat(LISTEN_MAX_BODY / 2 + 10); // 2 bytes each: under the limit in characters, over it in bytes
  assert.ok(big.length < LISTEN_MAX_BODY);
  assert.equal((await signedPost(env, null, { raw: big })).status, 413);
  const req = new Request("https://worker.test/api/listen", { method: "POST", headers: { "Content-Length": String(LISTEN_MAX_BODY + 1) }, body: "x" });
  assert.equal(await readBounded(req, LISTEN_MAX_BODY), null);
  assert.equal(await readBounded(new Request("https://worker.test/api/listen", { method: "POST", body: "ok" }), LISTEN_MAX_BODY), "ok");
});
test("every /quiet description fits Discord's 100 character limit", () => {
  const cmd = manifestFor({ LISTENER: "dry" }, DISCORD_SLASH_COMMANDS_MANIFEST).find((c) => c.name === "quiet");
  assert.ok(cmd.description.length <= 100, String(cmd.description.length));
  for (const o of cmd.options) { assert.ok(o.description.length <= 100); for (const c of o.choices) assert.ok(c.name.length <= 100 && c.value.length <= 100); }
});
test("a missing listener table never breaks anything and never answers twice", async () => {
  const DB = schemaDb(); seed(DB);
  DB.raw.exec("DROP TABLE listen_events; DROP TABLE listen_quiet;");
  assert.equal(await isQuiet(mkEnv(DB), CH), false);
  const d = await quiet(() => processListenEvent(mkEnv(DB), "https://worker.test", ev(), "live"));
  assert.equal(d, "duplicate"); assert.equal(posts.length, 0);
});

// ---- the documents -------------------------------------------------------------------------------------------------------------------------------
test("listen_events holds no message text and no author", () => {
  const cols = schemaDb().raw.prepare("PRAGMA table_info(listen_events)").all().map((c) => c.name);
  assert.deepEqual(cols, ["msg_id", "at", "channel", "kind", "decision", "ask_id", "posted"]);
});
test("migration 0012 and schema.sql carry the same two tables; the migration is idempotent", () => {
  const mig = read("infrastructure/migrations/0012_listener.sql"), schema = read("infrastructure/schema.sql");
  for (const sql of [mig, schema]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS listen_events/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS listen_quiet/);
    assert.match(sql, /msg_id TEXT PRIMARY KEY/);
  }
  const DB = schemaDb(); DB.raw.exec(mig); DB.raw.exec(mig);
});
test("the runbook exists and covers the flag, the key derivation, dry run, quiet, rollback and the forwarder", () => {
  const rb = read("docs/runbooks/listener.md").toLowerCase();
  for (const k of ["listener", "listenerkey", "leeroy-listener-v1", "dry", "live", "/quiet", "rollback", "forwarder", "listen_events", "ask_id"]) assert.ok(rb.includes(k), k);
});
test("no public GET route reads the listener tables; the route and the handler never log message text", () => {
  const src = read("infrastructure/worker/listener.js");
  assert.ok(!/console\.\w+\([^)]*(content|ev\.content|text)\b/.test(src.replace(/evt: "listen[^}]*}/g, "")), "a console call carries message text");
  for (const f of ["infrastructure/worker/index.js"]) assert.ok(!/listen_events|listen_quiet/.test(read(f)), f);
});
