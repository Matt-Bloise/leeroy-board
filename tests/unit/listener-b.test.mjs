// THE LISTENER, PART B (flag LISTENER_UNTAGGED, off by default): the signing key derived from the bot token, the untagged-text classifier, the wiki feed and the privacy paragraph.
// Real Worker code over an in-memory SQLite D1; Discord and Anthropic are fakes; names and text are fictional; token-shaped fixtures are built at run time.
//   key        HMAC-SHA256(bot token, "leeroy-listener-v1") -> 32 raw bytes; the request signature is hex HMAC-SHA256 of `${timestamp}.${body}` keyed with those bytes. No LISTENER_SECRET exists any more.
//   rules      empty, short, command and personal-life text are never candidates and never stored; chatter with no question skips the model.
//   classifier paid Claude only (the group-wiki path), a roster member only, fails closed; 'answer' needs the confidence threshold and the soft daily cap.
//   wiki       unanswered untagged text feeds group_log through the group-memory appender, never for a stranger, a quiet channel, a personal topic or a secret.
//   off        with LISTENER_UNTAGGED off, 'chatter' is exactly what part A did (a differential test).
// Run: node --test tests/unit/listener-b.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { resetResearchClaudeForTests, privacyBudget, counterKey, subCounterKey } from "../../infrastructure/worker/research/claude.js";
import { signListen, verifyListen, listenerKey, listenerKeyFor, resetListenerKeyCacheForTests, LISTEN_KEY_LABEL } from "../../infrastructure/worker/listener-config.js";
import { processListenEvent } from "../../infrastructure/worker/listener.js";
import {
  untaggedOn, untaggedRules, personalLife, parseVerdict, classifyUntagged, untaggedCapReached, listenSubCounterKey,
  UNTAGGED_MIN_CONFIDENCE, UNTAGGED_DAILY_CAP, UNTAGGED_MIN_CHARS, CLASSIFY_SYSTEM,
} from "../../infrastructure/worker/listener-untagged.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const OLD_SECRET = ["LISTENER", "SECRET"].join("_"); // the name of the secret part B removed
const FAKE_KEY = ["sk", "ant", "FAKE", "TEST", "0000"].join("-");
const BOT = ["bot", "token", "for", "tests", "9f3c1a"].join("-");
const GUILD = "800000000000000001", CH = "900000000000000001", OTHER_GUILD = "800000000000000009";
const FOX = "700000000000000001", OWL = "700000000000000002", STRANGER = "700000000000000099";
const realFetch = globalThis.fetch;
let anth = [], classify = [], posts = [], reply = null, anthStatus = 200;
const verdict = (decision, reason, confidence) => JSON.stringify({ decision, reason, confidence });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("anthropic")) {
    const body = JSON.parse(init.body);
    const isClassifier = JSON.stringify(body).includes("triage ONE message");
    (isClassifier ? classify : anth).push(body);
    if (isClassifier) {
      if (anthStatus !== 200) return new Response("{}", { status: anthStatus });
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify({ content: [{ type: "text", text: reply ?? verdict("answer", "direct_fact", 0.95) }], usage: { input_tokens: 150, output_tokens: 20 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("discord.com")) { posts.push({ url: u, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }
  return new Response("{}", { status: 599 });
};
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { resetListenerKeyCacheForTests(); resetKeyCacheForTests(); resetResearchClaudeForTests(); invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache(); privacyBudget.ms = 1000; anth = []; classify = []; posts = []; reply = null; anthStatus = 200; });

const roomStub = { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) };
const fakeAi = { run: async () => { throw new Error("Workers AI must not be called for a member"); } };
function mkEnv(DB, extra = {}) {
  return { DB, AI: fakeAi, USER_SALT: "user-salt-for-tests-0123456789", ANTHROPIC_API_KEY: FAKE_KEY, ASK_RESEARCH: "on", RESEARCH_NAMES: "real", GROUP_MEMORY: "on", LISTENER: "live", LISTENER_UNTAGGED: "on", DISCORD_BOT_TOKEN: BOT, DISCORD_WEBHOOK_URL: "https://hooks.test/w", BOARD_ROOM: roomStub, ...extra };
}
function seed(DB) {
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  put("discord_roster", { guildId: GUILD, channels: { general: CH } });
  put("discord_members", [{ id: FOX, slug: "red-fox", name: "Red Fox", match: ["red fox"] }, { id: OWL, slug: "blue-owl", name: "Blue Owl", match: ["blue owl"] }]);
  const f = (value) => ({ value, visible: true, source: "board", at: "2026-11-01T00:00:00.000Z" });
  put("party_sheets", [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin") }, updated: "x" }]);
}
let n = 0;
const ev = (o = {}) => ({ id: `6100000000${String(++n).padStart(9, "0")}`, guild_id: GUILD, channel_id: CH, author_id: FOX, kind: "chatter", content: "what is the cooldown on Divine Shield", ...o });
const count = (DB, sql, ...a) => DB.raw.prepare(sql).get(...a).c;
const quiet = async (fn) => { const real = { log: console.log, warn: console.warn, error: console.error }; for (const k of Object.keys(real)) console[k] = () => {}; try { return await fn(); } finally { Object.assign(console, real); } };
const run = (env, e, mode = "live", opts) => quiet(() => processListenEvent(env, "https://worker.test", e, mode, opts));
const decisions = (DB) => DB.raw.prepare("SELECT decision FROM listen_events ORDER BY rowid").all().map((r) => r.decision);
async function signedPost(env, obj, { key, ts = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(obj);
  const signature = await signListen(key ?? (await listenerKey(env.DISCORD_BOT_TOKEN)), String(ts), body);
  const waits = [];
  const res = await worker.fetch(new Request("https://worker.test/api/listen", { method: "POST", headers: { "Content-Type": "application/json", "X-Listen-Timestamp": String(ts), "X-Listen-Signature": signature }, body }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}
const dumpAll = (DB) => DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => `${t.name}: ${JSON.stringify(DB.raw.prepare(`SELECT * FROM "${t.name}"`).all())}`).join("\n");

// ---- part 1: the signing key -----------------------------------------------------------------------------------------------------------------------
test("listenerKey: 32 raw bytes of HMAC-SHA256(bot token, 'leeroy-listener-v1'), equal to an independent WebCrypto derivation", async () => {
  const token = ["fake", "bot", "token", crypto.randomUUID()].join("."); // built at run time, never a real token
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode("leeroy-listener-v1")));
  const got = await listenerKey(token);
  assert.ok(got instanceof Uint8Array);
  assert.equal(got.length, 32);
  assert.equal(hex(got), hex(want));
  assert.equal(LISTEN_KEY_LABEL, "leeroy-listener-v1");
  assert.notEqual(hex(await listenerKey(token + "x")), hex(want), "a different token derives a different key");
});
test("the request signature is hex HMAC-SHA256 of `timestamp.body` keyed with the RAW key bytes, not their hex text", async () => {
  const token = ["fake", "bot", crypto.randomUUID()].join("-"), ts = "1800000000", body = '{"id":"1"}';
  const key = await listenerKey(token);
  const sign = async (keyBytes) => hex(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(`${ts}.${body}`)));
  const independent = await sign(key);
  assert.equal(await signListen(key, ts, body), independent);
  assert.match(independent, /^[0-9a-f]{64}$/);
  const asHexText = await sign(new TextEncoder().encode(hex(key)));
  const asToken = await sign(new TextEncoder().encode(token));
  assert.notEqual(asHexText, independent);
  assert.notEqual(asToken, independent);
  assert.equal(await verifyListen(key, ts, body, independent, 1_800_000_010), true);
  assert.equal(await verifyListen(key, ts, body, asHexText, 1_800_000_010), false, "hex-text key signatures are refused");
  assert.equal(await verifyListen(key, ts, body, asToken, 1_800_000_010), false, "token-as-key signatures are refused");
});
test("the documented test vector in the runbook is what the code produces", async () => {
  const rb = read("docs/runbooks/listener.md");
  const field = (name) => { const m = rb.match(new RegExp(`${name}\\s*=\\s*\`([^\`]+)\``)); assert.ok(m, `runbook vector field ${name}`); return m[1]; };
  const token = field("vector token"), keyHex = field("vector key"), ts = field("vector timestamp"), body = field("vector body"), sig = field("vector signature");
  const key = await listenerKey(token);
  assert.equal(hex(key), keyHex);
  assert.equal(await signListen(key, ts, body), sig);
  // computed here by an independent call, so the document cannot drift from the code
  const raw = (b) => crypto.subtle.importKey("raw", b, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const k2 = new Uint8Array(await crypto.subtle.sign("HMAC", await raw(new TextEncoder().encode(token)), new TextEncoder().encode("leeroy-listener-v1")));
  assert.equal(hex(k2), keyHex);
  assert.equal(hex(await crypto.subtle.sign("HMAC", await raw(k2), new TextEncoder().encode(`${ts}.${body}`))), sig);
});
test("listenerKey: a missing, empty or short token derives nothing", async () => {
  for (const t of [undefined, null, "", "short", 12345678901234567890, {}, "x".repeat(15)]) assert.equal(await listenerKey(t), null, String(t));
  assert.ok(await listenerKey("x".repeat(16)));
  assert.equal(await listenerKeyFor({}), null);
  assert.equal(await listenerKeyFor({ DISCORD_BOT_TOKEN: "short" }), null);
});
test("the key is derived from env.DISCORD_BOT_TOKEN on each verify (cached per token): a rotated token changes the key at once", async () => {
  const a = await listenerKeyFor({ DISCORD_BOT_TOKEN: BOT });
  assert.equal(hex(a), hex(await listenerKey(BOT)));
  assert.equal(await listenerKeyFor({ DISCORD_BOT_TOKEN: BOT }), a, "same token, cached key");
  const rotated = BOT + "-rotated";
  assert.equal(hex(await listenerKeyFor({ DISCORD_BOT_TOKEN: rotated })), hex(await listenerKey(rotated)));
  assert.notEqual(hex(await listenerKeyFor({ DISCORD_BOT_TOKEN: rotated })), hex(a));
});
test("route: a request signed with the derived key is accepted; one signed with the token, the hex text of the key, or another token is 401; a missing token is 404", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  const e = () => ev({ kind: "chatter", content: "we should farm herbs after the raid tonight" });
  assert.equal((await quiet(() => signedPost(env, e()))).status, 202);
  const enc = (s) => new TextEncoder().encode(s);
  const key = await listenerKey(BOT);
  assert.equal((await signedPost(env, e(), { key: enc(BOT) })).status, 401);
  assert.equal((await signedPost(env, e(), { key: enc(hex(key)) })).status, 401);
  assert.equal((await signedPost(env, e(), { key: await listenerKey(BOT + "x") })).status, 401);
  assert.equal((await signedPost({ ...env, DISCORD_BOT_TOKEN: undefined }, e(), { key })).status, 404);
  assert.equal((await signedPost({ ...env, DISCORD_BOT_TOKEN: "" }, e(), { key })).status, 404);
  assert.equal(count(DB, "SELECT count(*) c FROM listen_events"), 1);
});
test("the old separate listener secret is gone from the Worker, the config, the docs and the tests' env", () => {
  for (const f of ["infrastructure/worker/listener.js", "infrastructure/worker/listener-config.js", "infrastructure/wrangler.toml", "docs/runbooks/secrets.md", "docs/runbooks/flags.md", "docs/runbooks/listener.md", "tests/unit/wrangler-flags.test.mjs", "tests/unit/authz.test.mjs"]) {
    assert.ok(!read(f).includes(OLD_SECRET), f);
  }
});

// ---- part 2: the flag and the rules ----------------------------------------------------------------------------------------------------------------
test("LISTENER_UNTAGGED ships off, is declared in wrangler.toml and the flags runbook, and only 'on' turns it on", () => {
  const t = read("infrastructure/wrangler.toml");
  assert.match(t.slice(t.indexOf("[vars]")), /^LISTENER_UNTAGGED = "off"/m);
  assert.ok(read("docs/runbooks/flags.md").includes("`LISTENER_UNTAGGED`"));
  for (const v of [undefined, "", "off", "dry", "live", "true", "1", "yes", {}]) assert.equal(untaggedOn({ LISTENER_UNTAGGED: v }), false, String(v));
  assert.equal(untaggedOn({ LISTENER_UNTAGGED: " On " }), true);
});
test("rules: empty, short, commands and personal-life text are never candidates; no question is wiki-only; a question is a candidate", () => {
  const r = (t) => untaggedRules(t);
  assert.deepEqual(r(""), { verdict: "ignore", reason: "empty" });
  assert.deepEqual(r("   \u200b  "), { verdict: "ignore", reason: "empty" });
  assert.equal(r("x".repeat(UNTAGGED_MIN_CHARS - 1)).reason, "short");
  assert.equal(r("what is up?").reason, "short");
  for (const c of ["/quiet state:on please", "!roll 100 for the loot", ".gg invite for everyone"]) assert.deepEqual(r(c), { verdict: "ignore", reason: "command" }, c);
  assert.equal(r("we should farm herbs after the raid tonight").verdict, "wiki_only");
  assert.equal(r("lol that boss was so easy tonight").reason, "no-question");
  for (const q of ["what is the cooldown on Divine Shield", "does anyone know the Scarlet Monastery entrance", "the raid starts at eight, right?", "wait how do I get to Stormwind"]) assert.equal(r(q).verdict, "candidate", q);
});
test("rules: personal-life topics (health, family, work, location, money, schedule beyond the game) are never candidates, even as a question", () => {
  const personal = [
    "my doctor says I need surgery next week", "how do I tell my wife about the raid schedule?", "my dad is in the hospital, can we skip tonight?",
    "my boss moved the meeting so I am late", "I am moving to a new apartment this month", "where I live there is no good internet?",
    "I can not pay my rent this month", "how much money do I owe you for the pizza?", "I have a dentist appointment on Thursday",
    "my kids have school so I am out friday", "happy birthday to my brother today", "Ｍｙ ｗｉｆｅ is coming home soon", "my d\u200bad called about the wedding",
  ];
  for (const t of personal) { assert.equal(personalLife(t), true, t); assert.deepEqual(untaggedRules(t), { verdict: "ignore", reason: "personal" }, t); }
  for (const t of ["what is the cooldown on Divine Shield", "does the raid start at eight tonight", "how many talent points at level 40", "we should farm herbs after the raid tonight"]) assert.equal(personalLife(t), false, t);
});
test("parseVerdict: strict JSON, whitelisted decision and reason, a bounded confidence; anything else is ignore; a personal reason is always ignore", () => {
  assert.deepEqual(parseVerdict(verdict("answer", "direct_fact", 0.9)), { decision: "answer", reason: "direct_fact", confidence: 0.9 });
  assert.deepEqual(parseVerdict(`Sure! ${verdict("wiki_only", "planning", 0.4)} done`), { decision: "wiki_only", reason: "planning", confidence: 0.4 });
  assert.deepEqual(parseVerdict(verdict("answer", "made_up", 7)), { decision: "answer", reason: "other", confidence: 1 });
  assert.equal(parseVerdict(JSON.stringify({ decision: "answer", reason: "direct_fact", confidence: "high" })).confidence, 0);
  assert.deepEqual(parseVerdict(verdict("answer", "personal", 0.99)), { decision: "ignore", reason: "personal", confidence: 0.99 });
  assert.deepEqual(parseVerdict(verdict("wiki_only", "personal", 0.99)), { decision: "ignore", reason: "personal", confidence: 0.99 });
  for (const bad of [undefined, "", "no json", "{", "[]", '{"decision":"post","reason":"direct_fact","confidence":1}', '{"decision":null}', "null"]) assert.equal(parseVerdict(bad).decision, "ignore", String(bad));
});

// ---- part 2: the classifier ------------------------------------------------------------------------------------------------------------------------
test("classifyUntagged: a stranger (not a roster member) never reaches the model; neither does a personal or non-candidate text, or tokenised names, or the flag off", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  const call = async () => { throw new Error("must not be called"); };
  const ok = "what is the cooldown on Divine Shield";
  assert.equal((await classifyUntagged(env, { text: ok, isMember: false, call })).reason, "not-member");
  assert.equal((await classifyUntagged(env, { text: ok, call })).reason, "not-member");
  assert.equal((await classifyUntagged(env, { text: "how do I tell my wife about the raid?", isMember: true, call })).reason, "personal");
  assert.equal((await classifyUntagged(env, { text: "we should farm herbs after the raid tonight", isMember: true, call })).reason, "not-candidate");
  assert.equal((await classifyUntagged(mkEnv(DB, { RESEARCH_NAMES: "tokenised" }), { text: ok, isMember: true, call })).reason, "names-tokenised");
  assert.equal((await classifyUntagged(mkEnv(DB, { LISTENER_UNTAGGED: "off" }), { text: ok, isMember: true, call })).reason, "flag-off");
  assert.equal((await classifyUntagged(mkEnv(DB, { ANTHROPIC_API_KEY: undefined }), { text: ok, isMember: true, call })).reason, "claude:no-key");
  assert.equal(classify.length, 0);
});
test("classifyUntagged: one Haiku-class call on Anthropic only, the message fenced as data with no author or channel; the classifier's own sub-cap counter is used", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  const hosts = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (u, i) => { hosts.push(new URL(String(u)).host); return prev(u, i); };
  let v;
  try { v = await quiet(() => processListenEvent(env, "https://worker.test", ev({ content: "what is the cooldown on Divine Shield" }), "dry")); } finally { globalThis.fetch = prev; }
  assert.equal(v, "dry");
  assert.deepEqual(hosts, ["api.anthropic.com"]);
  assert.equal(classify.length, 1);
  const body = JSON.stringify(classify[0]);
  assert.match(body, /haiku/i);
  assert.ok(body.includes("<<<MESSAGE") && body.includes("what is the cooldown on Divine Shield"));
  assert.ok(!/Red Fox|red-fox|Blue Owl|900000000000000001|700000000000000001/.test(body), "no author, no channel, no ids");
  assert.ok(body.includes(CLASSIFY_SYSTEM.slice(0, 60)));
  const at = new Date();
  assert.ok(Number(DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(listenSubCounterKey(at)).json) > 0, "own sub-cap counter");
  assert.equal(listenSubCounterKey(at).startsWith("claude_tokens_listen_"), true);
  assert.equal(DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(subCounterKey(at)), undefined, "the wiki refresher's sub-cap is untouched");
  assert.ok(Number(DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(counterKey(at)).json) > 0, "the monthly counter is charged too");
});
test("classifier fails closed: an error, a 529, a timeout-shaped throw, a spent cap, junk output and a secret in the text all mean ignore, nothing posted, nothing stored", async () => {
  const cases = [
    ["claude 529", () => { anthStatus = 529; }, {}],
    ["claude 500", () => { anthStatus = 500; }, {}],
    ["network error", () => { reply = new Error("boom"); }, {}],
    ["junk output", () => { reply = "I think you should answer this one!"; }, {}],
    ["spent monthly cap", () => {}, { RESEARCH_CLAUDE_MONTHLY_TOKENS: "0" }],
  ];
  for (const [name, arm, extra] of cases) {
    const DB = schemaDb(); seed(DB); const env = mkEnv(DB, extra);
    resetResearchClaudeForTests(); anthStatus = 200; reply = null; arm();
    const e = ev();
    const d = await run(env, e, "live");
    assert.equal(posts.length, 0, name);
    assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0, name);
    assert.match(decisions(DB)[0], /^u:ignore:/, `${name}: ${decisions(DB)[0]}`);
    assert.ok(d.startsWith("u:ignore:"), name);
  }
  const DB = schemaDb(); seed(DB); classify = [];
  const secret = ["sk", "ant", "api03"].join("-") + "-" + "Z9".repeat(24);
  const d = await run(mkEnv(DB), ev({ content: `how do I use this key ${secret}?` }));
  assert.equal(d, "u:ignore:guard:secret"); assert.equal(classify.length, 0); assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});
test("classifier is paid Claude only: Workers AI is never called and the answer path stays on Anthropic and Discord", async () => {
  const DB = schemaDb(); seed(DB);
  const hosts = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (u, i) => { hosts.push(new URL(String(u)).host); return prev(u, i); };
  try { await run(mkEnv(DB), ev(), "live"); } finally { globalThis.fetch = prev; }
  for (const h of hosts) assert.ok(/anthropic\.com$|discord\.com$/.test(h), h);
  assert.equal(classify.length, 1); assert.ok(anth.length >= 1); assert.equal(posts.length, 1);
});

// ---- part 2: the decision --------------------------------------------------------------------------------------------------------------------------
test("dry: a direct-answer candidate is recorded as a would-be decision only; no text, no author, no turn, no post, no group_log row, nothing else stored", async () => {
  const DB = schemaDb(); seed(DB);
  const marker = "zanzibar cooldown";
  const e = ev({ content: `what is the ${marker} on Divine Shield` });
  const before = dumpAll(DB);
  assert.equal(await run(mkEnv(DB, { LISTENER: "dry" }), e, "dry"), "dry");
  assert.equal(posts.length, 0); assert.equal(anth.length, 0); assert.equal(classify.length, 1);
  assert.deepEqual(decisions(DB), ["u:answer-dry:direct_fact"]);
  const row = DB.raw.prepare("SELECT * FROM listen_events").get();
  assert.equal(row.posted, 0); assert.equal(row.ask_id, null);
  const after = dumpAll(DB);
  assert.ok(!after.includes(marker) && !after.includes(e.content), "the message text is stored nowhere");
  assert.ok(!after.includes("red-fox") || before.includes("red-fox"), "the author is not added by the decision");
  assert.equal(count(DB, "SELECT count(*) c FROM ask_turns"), 0);
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
  assert.deepEqual(DB.raw.prepare("PRAGMA table_info(listen_events)").all().map((c) => c.name), ["msg_id", "at", "channel", "kind", "decision", "ask_id", "posted"]);
});
test("live: a confident direct answer goes through part A's answer path: one reply, every ping off, a shared turn; the decision is u:posted and counts as posted", async () => {
  const DB = schemaDb(); seed(DB); const e = ev();
  assert.equal(await run(mkEnv(DB), e, "live"), "posted");
  assert.equal(classify.length, 1); assert.ok(anth.length >= 1);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith(`/channels/${CH}/messages`));
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(posts[0].body.message_reference.message_id, e.id);
  const row = DB.raw.prepare("SELECT decision, posted, ask_id FROM listen_events").get();
  assert.equal(row.decision, "u:posted"); assert.equal(row.posted, 1); assert.ok(row.ask_id);
});
test("live: when Claude cannot compose the answer nothing is posted (no in-voice filler for an unprompted reply)", async () => {
  const DB = schemaDb(); seed(DB);
  const prev = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes("anthropic") && !JSON.stringify(JSON.parse(i.body)).includes("triage ONE message") ? new Response("{}", { status: 529 }) : prev(u, i));
  try { assert.equal(await run(mkEnv(DB), ev(), "live"), "no-answer"); } finally { globalThis.fetch = prev; }
  assert.equal(posts.length, 0);
  assert.equal(decisions(DB)[0], "u:no-answer");
});
test("confidence: at the threshold it answers, just under it is wiki-only", async () => {
  assert.equal(UNTAGGED_MIN_CONFIDENCE, 0.8);
  for (const [c, want] of [[UNTAGGED_MIN_CONFIDENCE, "u:answer-dry:direct_fact"], [UNTAGGED_MIN_CONFIDENCE - 0.01, "u:wiki:lowconf"], [0, "u:wiki:lowconf"]]) {
    const DB = schemaDb(); seed(DB); reply = verdict("answer", "direct_fact", c);
    await run(mkEnv(DB, { LISTENER: "dry" }), ev(), "dry");
    assert.equal(decisions(DB)[0], want, String(c));
    assert.equal(posts.length, 0);
  }
});
test("soft daily cap: after UNTAGGED_DAILY_CAP answers (would-be ones in a dry run count) in a channel, the next 'answer' becomes wiki-only; another channel is not affected; old rows do not count", async () => {
  assert.ok(Number.isInteger(UNTAGGED_DAILY_CAP) && UNTAGGED_DAILY_CAP >= 1 && UNTAGGED_DAILY_CAP <= 5, "a small default");
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB, { LISTENER: "dry" });
  for (let i = 0; i < UNTAGGED_DAILY_CAP; i++) await run(env, ev(), "dry");
  assert.deepEqual(decisions(DB), Array(UNTAGGED_DAILY_CAP).fill("u:answer-dry:direct_fact"));
  assert.equal(await untaggedCapReached(env, CH), true);
  await run(env, ev({ content: "what is the cooldown on Lay on Hands" }), "dry");
  assert.equal(decisions(DB).at(-1), "u:wiki:cap");
  assert.equal(count(DB, "SELECT count(*) c FROM group_log WHERE source = 'listener'"), 1);
  await run(env, ev({ channel_id: "900000000000000002" }), "dry");
  assert.equal(decisions(DB).at(-1), "u:answer-dry:direct_fact");
  DB.raw.prepare("UPDATE listen_events SET at = ?").run(new Date(Date.now() - 25 * 3600 * 1000).toISOString());
  assert.equal(await untaggedCapReached(env, CH), false, "rows older than a day do not count");
  const broken = { ...env, DB: { ...DB, prepare: () => { throw new Error("bad day"); } } };
  assert.equal(await untaggedCapReached(broken, CH), true, "an unreadable count is silence");
});
test("cap counts only unprompted answers: mentions, wiki rows and failed posts do not use it up", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  for (let i = 0; i < UNTAGGED_DAILY_CAP + 1; i++) await run(env, ev({ kind: "mention", content: "who tanks tonight" }), "live");
  for (let i = 0; i < 3; i++) await run(env, ev({ content: "we should farm herbs after the raid tonight" }), "live");
  assert.equal(await untaggedCapReached(env, CH), false);
  await run(env, ev(), "live", { fetchImpl: async () => new Response("{}", { status: 403 }) });
  assert.equal(decisions(DB).at(-1), "u:post-failed:403");
  assert.equal(await untaggedCapReached(env, CH), false);
});
test("a stranger and a foreign guild never reach the classifier, the wiki or listen_events", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  assert.equal(await run(env, ev({ author_id: STRANGER }), "live"), "ignored:non-member");
  assert.equal(await run(env, ev({ guild_id: OTHER_GUILD }), "live"), "ignored:guild");
  assert.equal(classify.length, 0); assert.equal(anth.length, 0); assert.equal(posts.length, 0);
  assert.equal(count(DB, "SELECT count(*) c FROM listen_events"), 0);
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
  // through the signed route as well
  assert.equal((await quiet(() => signedPost(env, ev({ author_id: STRANGER })))).status, 202);
  assert.equal(classify.length, 0); assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});
test("a quiet channel (or a thread under one) is neither classified nor stored, even with the flag on", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  DB.raw.prepare("INSERT INTO listen_quiet (channel, at) VALUES (?, 'x')").run(CH);
  assert.equal(await run(env, ev(), "live"), "quiet");
  assert.equal(await run(env, ev({ channel_id: "900000000000000777", parent_id: CH, content: "we should farm herbs after the raid tonight" }), "live"), "quiet");
  assert.equal(classify.length, 0); assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});

// ---- part 3: the wiki feed -------------------------------------------------------------------------------------------------------------------------
test("wiki feed: no-question chatter and classifier 'wiki_only' are filed as the author's message row (source listener) through group-memory's appender; no answer, no post", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  const e1 = ev({ author_id: OWL, content: "we should farm herbs after the raid tonight" });
  assert.equal(await run(env, e1, "live"), "logged");
  reply = verdict("wiki_only", "planning", 0.9);
  const e2 = ev({ content: "does the paladin quest chain matter for us" });
  assert.equal(await run(env, e2, "live"), "logged");
  const rows = DB.raw.prepare("SELECT author_slug, kind, source, channel, text, reply_to FROM group_log ORDER BY id").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { author_slug: "blue-owl", kind: "message", source: "listener", channel: CH, text: e1.content, reply_to: e1.id },
    { author_slug: "red-fox", kind: "message", source: "listener", channel: CH, text: e2.content, reply_to: e2.id },
  ]);
  assert.deepEqual(decisions(DB), ["u:wiki:no-question", "u:wiki:planning"]);
  assert.equal(posts.length, 0); assert.equal(anth.length, 0); assert.equal(classify.length, 1);
});
test("wiki feed: GROUP_MEMORY off stores nothing (u:memory-off); ignore verdicts and every rule-ignored text are not stored", async () => {
  const DB = schemaDb(); seed(DB);
  assert.equal(await run(mkEnv(DB, { GROUP_MEMORY: "off" }), ev({ content: "we should farm herbs after the raid tonight" }), "live"), "u:memory-off");
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
  reply = verdict("ignore", "social", 0.9);
  assert.equal(await run(mkEnv(DB), ev({ content: "does anyone want to hear a joke about gnomes" }), "live"), "u:ignore:social");
  for (const t of ["lol", "/quiet state:on", "x".repeat(UNTAGGED_MIN_CHARS - 1)]) await run(mkEnv(DB), ev({ content: t }), "live");
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});
test("wiki feed: a personal-life text is never stored and never sent to the model, with or without a question", async () => {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB);
  for (const t of ["my wife and I are moving to a new apartment next week", "how do I tell my wife about the raid schedule?", "my boss fired half the office today"]) {
    assert.equal(await run(env, ev({ content: t }), "live"), "u:ignore:personal", t);
  }
  assert.equal(classify.length, 0); assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0); assert.equal(posts.length, 0);
});
test("wiki feed: a classifier verdict of personal is ignore: nothing stored, nothing posted", async () => {
  const DB = schemaDb(); seed(DB); reply = verdict("wiki_only", "personal", 0.9);
  assert.equal(await run(mkEnv(DB), ev({ content: "does anyone know a good way to cope with stress" }), "live"), "u:ignore:personal");
  assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
  reply = verdict("answer", "personal", 0.99);
  await run(mkEnv(DB), ev({ content: "does anybody know how to handle burnout" }), "live");
  assert.equal(decisions(DB).at(-1), "u:ignore:personal"); assert.equal(posts.length, 0);
});
test("wiki feed: a secret typed into untagged chat is never stored", async () => {
  const DB = schemaDb(); seed(DB);
  const secret = ["sk", "ant", "api03"].join("-") + "-" + "Z9".repeat(24);
  const d = await run(mkEnv(DB), ev({ content: `my key is ${secret} for the bot` }), "live");
  assert.equal(d, "u:not-stored"); assert.equal(count(DB, "SELECT count(*) c FROM group_log"), 0);
});

// ---- the flag gate: with LISTENER_UNTAGGED off, 'chatter' is exactly part A ---------------------------------------------------------------------------
async function chatterRun(extra) {
  const DB = schemaDb(); seed(DB); const env = mkEnv(DB, extra);
  const secret = ["sk", "ant", "api03"].join("-") + "-" + "Z9".repeat(24);
  const texts = ["what is the cooldown on Divine Shield", "my wife is in the hospital again", "lol", "we should farm herbs after the raid tonight", `my key is ${secret}`, "/quiet state:on", "does anyone know the Scarlet Monastery entrance?", ""];
  const results = [];
  const fixed = [];
  for (const [i, t] of texts.entries()) {
    const e = { id: `62000000000000${String(i).padStart(4, "0")}`, guild_id: GUILD, channel_id: CH, author_id: i % 2 ? OWL : FOX, kind: "chatter", content: t };
    results.push(await run(env, e, i % 3 ? "live" : "dry"));
    fixed.push(e);
  }
  const listen = DB.raw.prepare("SELECT kind, decision, ask_id, posted, channel FROM listen_events ORDER BY rowid").all().map((r) => ({ ...r }));
  const log = DB.raw.prepare("SELECT author_slug, kind, source, channel, text, reply_to FROM group_log ORDER BY id").all().map((r) => ({ ...r }));
  const tables = DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('listen_events', 'group_log') ORDER BY name").all().map((t) => `${t.name}:${DB.raw.prepare(`SELECT count(*) c FROM "${t.name}"`).get().c}`);
  return { results, listen, log, tables, anth: anth.length + classify.length, posts: posts.length, secret };
}
test("LISTENER_UNTAGGED off (unset, off or any other value): chatter responses and writes are byte-identical to part A, with no classifier call and no post (differential)", async () => {
  const base = await chatterRun({ LISTENER_UNTAGGED: undefined });
  // what part A did: every non-empty text stored as the author's message row, a secret refused, empty is 'empty'; nothing answered
  assert.deepEqual(base.results, ["logged", "logged", "logged", "logged", "not-stored", "logged", "logged", "empty"]);
  assert.deepEqual(base.listen.map((r) => r.decision), ["logged", "logged", "logged", "logged", "not-stored", "logged", "logged", "empty"]);
  assert.equal(base.log.length, 6);
  assert.ok(base.log.every((r) => r.kind === "message" && r.source === "listener" && r.channel === CH));
  assert.ok(base.log.some((r) => r.text === "my wife is in the hospital again"), "part A stores personal text too: it is the owner's earlier decision and this flag does not touch it");
  assert.ok(!base.log.some((r) => r.text.includes(base.secret)));
  assert.equal(base.anth, 0); assert.equal(base.posts, 0);
  for (const v of ["off", "", "dry", "live", "true", "1", "maybe"]) {
    const other = await chatterRun({ LISTENER_UNTAGGED: v });
    assert.deepEqual(other, base, `LISTENER_UNTAGGED=${JSON.stringify(v)}`);
  }
});
test("LISTENER_UNTAGGED on does not change mention or reply handling at all", async () => {
  const one = async (extra, kind) => {
    const DB = schemaDb(); seed(DB); posts = []; anth = [];
    const e = { id: "63000000000000001" + kind.length, guild_id: GUILD, channel_id: CH, author_id: FOX, kind, content: "who tanks tonight", ref_text: kind === "reply" ? "Tank is Red Fox." : "" };
    const d = await run(mkEnv(DB, extra), e, "live");
    return { d, decisions: decisions(DB), posts: posts.length, calls: anth.length, classify: classify.length, asks: count(DB, "SELECT count(*) c FROM ask_turns WHERE share = 1"), log: count(DB, "SELECT count(*) c FROM group_log") };
  };
  for (const kind of ["mention", "reply"]) {
    const off = await one({ LISTENER_UNTAGGED: "off" }, kind), on = await one({ LISTENER_UNTAGGED: "on" }, kind);
    assert.deepEqual(on, off, kind);
    assert.deepEqual(on.decisions, ["posted"]);
    assert.equal(on.classify, 0);
  }
});

// ---- part 4: documents ------------------------------------------------------------------------------------------------------------------------------
test("docs/privacy.md has a plain paragraph on listening: what is read and when, what is kept and for how long, who sees it, how to stop, never published; it says the listening is off until announced", () => {
  const md = read("docs/privacy.md");
  const at = md.indexOf("**Listening in Discord**");
  assert.ok(at > 0, "the paragraph exists");
  const para = md.slice(at, md.indexOf("\n", at));
  assert.match(para, /off today/i);
  assert.match(para, /until (?:the owner|we|Matt) (?:announce|say)/i, "off until announced");
  assert.match(para, /Message Content/i);
  assert.match(para, /only .*members/i);
  assert.match(para, /\/quiet/);
  assert.match(para, /admin/i);
  assert.match(para, /never published|never put on any public page|never public/i);
  assert.match(para, /private database|private D1|private/i);
  assert.match(para, /(?:until you ask|stay until|kept until)/i, "retention is stated");
  assert.ok(!/(?:Matt Bloise|Jimmy)/.test(para), "no names in the paragraph");
  assert.ok(read("privacy/index.html").includes("Listening in Discord"), "the rendered page carries it");
  assert.ok(md.includes("Last changed: 15 November 2026") || /Last changed: \d+ November 2026/.test(md));
});
test("the runbooks and the data inventory describe part B: the key derivation, the flag, the decisions and the cap", () => {
  const rb = read("docs/runbooks/listener.md");
  for (const k of ["LISTENER_UNTAGGED", "leeroy-listener-v1", "listenerKey", "X-Listen-Signature", "X-Listen-Timestamp", "raw", "u:answer-dry", "UNTAGGED_DAILY_CAP", "UNTAGGED_MIN_CONFIDENCE", "claude_tokens_listen"]) assert.ok(rb.includes(k), k);
  assert.ok(read("docs/runbooks/secrets.md").includes("DISCORD_BOT_TOKEN"));
  assert.ok(!read("docs/runbooks/secrets.md").includes(OLD_SECRET));
  assert.match(read("docs/data-inventory.md"), /u:/);
});
test("the untagged code path never logs message text and no public route reads it", () => {
  const src = read("infrastructure/worker/listener-untagged.js") + read("infrastructure/worker/listener.js");
  assert.ok(!/console\.\w+\([^)]*(content|text)\b/.test(src.replace(/evt: "listen[^}]*}/g, "")), "a console call carries message text");
  assert.ok(!/LISTENER_UNTAGGED/.test(read("infrastructure/worker/index.js")));
});
