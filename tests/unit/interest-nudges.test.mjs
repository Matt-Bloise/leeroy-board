// INTEREST_NUDGES (worker/interest.js and its wiring in discord.js and index.js). Fictional data only: made-up names, ids built
// at run time, a fake Discord API and an in-memory D1 built from schema.sql. No network, no AI, no real keys.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { LAUNCH_EPOCH } from "../../infrastructure/worker/tonight-copy.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { isPrivateKvKey, isDeniedKvKey } from "../../infrastructure/worker/config.js";
import {
  collectInterest, reactionCounts, eventCounts, ownPosts, countsReply, askLevelModal, questionFromModal, MAX_EMOJI,
  INTEREST_COUNTS_KEY, ASK_LEVEL_BUTTON_ID, ASK_LEVEL_MODAL_ID, COUNTS_BUTTON_ID, ASK_LEVEL_PREFILL, MAX_POSTS, RECENT_MS,
} from "../../infrastructure/worker/interest.js";

const id = (d, n = 18) => String(d).repeat(n);
const GUILD = id(2), CHAN = id(3), CARD_MSG = id(4), MOMENT_MSG = id(5), OLD_MSG = id(6), OUR_EVENT = id(7), HAND_EVENT = id(8), FRIEND = id(9);
const NOW = Date.parse("2026-11-14T18:00:00Z");
const TOKEN = "fake-bot-token-not-real";
const SECRET_TEXT = "fictional post text that must never be stored";

function seed(db, rows) {
  for (const [k, v] of Object.entries(rows)) db.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), "2026-11-01T00:00:00Z");
}
const kv = (db, k) => {
  const r = db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(k);
  return r ? JSON.parse(r.json) : null;
};
const SIGNUPS = { entries: [{ slug: "zib", name: "Zib Fizzlecog", rsvp: "maybe", updated: "2026-11-01T00:00:00Z" }] };
function seeded() {
  const db = schemaDb();
  seed(db, {
    discord_roster: { guildId: GUILD },
    scheduled_events: { "raid-night": { id: OUR_EVENT, name: "Raid night", location: "Stormwind", start: "2026-11-20T00:00:00Z", end: "2026-11-20T03:00:00Z", description: "" } },
    events_schedule: [{ key: "raid-night", name: "Raid night", location: "Stormwind", start: "2026-11-20T00:00:00Z", end: "2026-11-20T03:00:00Z" }],
    cards: { signups: { channel: CHAN, message: CARD_MSG } },
    moments: [
      { id: "hype-post", at: "2026-11-13T18:00:00Z", channelId: CHAN, kind: "text", content: "x" },
      { id: "old-post", at: "2026-10-01T18:00:00Z", channelId: CHAN, kind: "text", content: "x" },
    ],
    moments_state: { moments: { "hype-post": { status: "done", messageId: MOMENT_MSG, postedAt: NOW - 86400000 }, "old-post": { status: "done", messageId: OLD_MSG, postedAt: NOW - RECENT_MS - 1 } } },
    signups: SIGNUPS,
  });
  return db;
}

// Fake Discord REST: answers the two GET shapes and records every call.
function fakeDiscord({ status = {}, authorBot = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", auth: init.headers && init.headers.Authorization, body: init.body });
    const u = new URL(url);
    const forced = Object.entries(status).find(([frag]) => u.pathname.includes(frag));
    if (forced) return new Response(JSON.stringify({ message: "no", retry_after: 1 }), { status: forced[1], headers: { "Content-Type": "application/json" } });
    if (u.pathname === `/api/v10/guilds/${GUILD}/scheduled-events`) {
      return Response.json([
        { id: OUR_EVENT, name: "Raid night", user_count: 4, creator_id: id(1), creator: { id: id(1), username: "leeroy-bot" } },
        { id: HAND_EVENT, name: "Someone's own event", user_count: 9, creator_id: FRIEND, creator: { id: FRIEND, username: "a-friend" } },
      ]);
    }
    const m = /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)$/.exec(u.pathname);
    if (m) {
      const reactions = m[2] === CARD_MSG ? [{ count: 5, me: false, emoji: { id: null, name: "👍" } }, { count: 2, emoji: { id: id(1, 19), name: "partyhat" } }] : [{ count: 3, emoji: { id: null, name: "🎉" } }];
      return Response.json({ id: m[2], channel_id: m[1], content: SECRET_TEXT, author: { id: id(1), username: "leeroy-bot", bot: authorBot }, mentions: [{ id: FRIEND, username: "a-friend" }], reactions });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}

// Counts every SQL statement, to prove the flag-off path reads nothing.
function counting(db) {
  const seen = [];
  return { seen, db: { ...db, prepare: (sql) => (seen.push(sql), db.prepare(sql)) } };
}

// ---- the cron collector ---------------------------------------------------------------------------------------------------------
test("flag off (unset, off, and a Flagship binding answering false): no D1 read, no Discord call, nothing written", async () => {
  for (const flags of [{}, { INTEREST_NUDGES: "off" }, { INTEREST_NUDGES: "on", FLAGS: { getBooleanValue: async () => false } }]) {
    const { db, seen } = counting(seeded());
    const d = fakeDiscord();
    const r = await collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, ...flags }, fetchImpl: d.fetchImpl, now: NOW });
    assert.equal(r.skipped, "off");
    assert.equal(d.calls.length, 0);
    assert.equal(seen.length, 0);
  }
});

test("flag on: GET only, our event's Interested count, our card and recent post reaction counts; the hand-made event and the old post are never read", async () => {
  const db = seeded();
  const d = fakeDiscord();
  const r = await collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl: d.fetchImpl, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.ok(d.calls.every((c) => c.method === "GET" && c.body === undefined), "every Discord call is a GET with no body");
  assert.ok(d.calls.every((c) => c.auth === `Bot ${TOKEN}`), "the existing bot token, in the Authorization header only");
  assert.deepEqual(d.calls.map((c) => new URL(c.url).pathname).sort(), [
    `/api/v10/channels/${CHAN}/messages/${CARD_MSG}`,
    `/api/v10/channels/${CHAN}/messages/${MOMENT_MSG}`,
    `/api/v10/guilds/${GUILD}/scheduled-events`,
  ].sort());
  assert.equal(new URL(d.calls.find((c) => c.url.includes("scheduled-events")).url).searchParams.get("with_user_count"), "true");
  assert.deepEqual(kv(db, INTEREST_COUNTS_KEY), {
    at: new Date(NOW).toISOString(),
    events: { "raid-night": { interested: 4 } },
    posts: { "card:signups": { total: 7, emoji: { "👍": 5, partyhat: 2 } }, "moment:hype-post": { total: 3, emoji: { "🎉": 3 } } },
  });
});

test("counts only: the stored row holds no message text, no author, no user id, no event name of someone else's and no token", async () => {
  const db = seeded();
  await collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl: fakeDiscord().fetchImpl, now: NOW });
  const raw = db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(INTEREST_COUNTS_KEY).json;
  for (const bad of [SECRET_TEXT, FRIEND, id(1), "a-friend", "leeroy-bot", "Someone's own event", HAND_EVENT, TOKEN, CHAN, CARD_MSG, MOMENT_MSG]) assert.ok(!raw.includes(bad), `stored row must not contain ${bad}`);
});

test("never writes a sign-up: the signups row, the intents and every other table are untouched; interest_counts is the only new row", async () => {
  const db = seeded();
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  const snap = () => Object.fromEntries(tables.map((t) => [t, JSON.stringify(db.raw.prepare(`SELECT * FROM "${t}"`).all())]));
  const before = snap();
  const keysBefore = db.raw.prepare("SELECT key FROM kv_state ORDER BY key").all().map((r) => r.key);
  await collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl: fakeDiscord().fetchImpl, now: NOW });
  const after = snap();
  for (const t of tables) if (t !== "kv_state") assert.equal(after[t], before[t], `table ${t} unchanged`);
  assert.deepEqual(kv(db, "signups"), SIGNUPS);
  const keysAfter = db.raw.prepare("SELECT key FROM kv_state ORDER BY key").all().map((r) => r.key);
  assert.deepEqual(keysAfter.filter((k) => !keysBefore.includes(k)), [INTEREST_COUNTS_KEY]);
});

test("401, 403 and 429 stop the run and keep the last stored counts; a deleted message is left out", async () => {
  for (const [frag, code, stopped] of [["scheduled-events", 403, "forbidden"], ["scheduled-events", 401, "unauthorized"], [`/messages/${MOMENT_MSG}`, 429, "rate_limited"]]) {
    const db = seeded();
    seed(db, { [INTEREST_COUNTS_KEY]: { at: "2026-11-14T12:00:00Z", events: { "raid-night": { interested: 1 } }, posts: {} } });
    const r = await collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl: fakeDiscord({ status: { [frag]: code } }).fetchImpl, now: NOW });
    assert.equal(r.stopped, stopped);
    assert.equal(r.wrote, false);
    assert.equal(kv(db, INTEREST_COUNTS_KEY).at, "2026-11-14T12:00:00Z");
  }
  const db = seeded();
  await collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl: fakeDiscord({ status: { [`/messages/${CARD_MSG}`]: 404 } }).fetchImpl, now: NOW });
  assert.deepEqual(Object.keys(kv(db, INTEREST_COUNTS_KEY).posts), ["moment:hype-post"]);
});

test("no token, no guild or no map: nothing is asked of Discord that cannot be ours", async () => {
  const d = fakeDiscord();
  assert.equal((await collectInterest({ env: { DB: seeded(), INTEREST_NUDGES: "on" }, fetchImpl: d.fetchImpl, now: NOW })).skipped, "no_token");
  const db = seeded();
  seed(db, { scheduled_events: {}, cards: {}, moments_state: { moments: {} } });
  await collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl: d.fetchImpl, now: NOW });
  assert.equal(d.calls.length, 0);
  assert.deepEqual(kv(db, INTEREST_COUNTS_KEY).events, {});
});

// ---- pure helpers ---------------------------------------------------------------------------------------------------------------
test("reactionCounts: a message not written by a bot gives nothing; bad counts and nameless emoji are dropped", () => {
  assert.equal(reactionCounts({ author: { bot: false }, reactions: [{ count: 3, emoji: { name: "👍" } }] }), null);
  assert.equal(reactionCounts({ reactions: [] }), null);
  assert.deepEqual(reactionCounts({ author: { bot: true }, reactions: [{ count: -1, emoji: { name: "a" } }, { count: 2, emoji: {} }, { count: 1.5, emoji: { name: "b" } }, { count: 2, emoji: { name: "c" } }] }), { total: 2, emoji: { c: 2 } });
});

test("eventCounts keeps only events in our own map, by id", () => {
  assert.deepEqual(eventCounts([{ id: "11111", user_count: 3 }, { id: "22222", user_count: 8 }, { id: "33333" }], { a: { id: "11111" }, c: { id: "33333" } }), { a: { interested: 3 }, c: { interested: 0 } });
  assert.deepEqual(eventCounts({ message: "not a list" }, { a: { id: "11111" } }), {});
});

test("ownPosts: cards first, then recent timed posts newest first, at most MAX_POSTS", () => {
  const moments = {}, schedule = [];
  for (let i = 0; i < 12; i += 1) {
    moments[`m${i}`] = { messageId: id(5, 17) + i, postedAt: NOW - i * 1000 };
    schedule.push({ id: `m${i}`, channelId: CHAN });
  }
  moments.unknown = { messageId: id(6), postedAt: NOW }; // not in the schedule: no channel, not read
  const list = ownPosts({ cards: { signups: { channel: CHAN, message: CARD_MSG }, broken: { channel: "x", message: CARD_MSG } }, momentsState: { moments }, momentsSchedule: schedule, now: NOW });
  assert.equal(list.length, MAX_POSTS);
  assert.deepEqual(list.slice(0, 3).map((p) => p.ref), ["card:signups", "moment:m0", "moment:m1"]);
  assert.ok(!list.some((p) => p.ref === "moment:unknown" || p.ref === "card:broken"));
});

test("countsReply names our own events, shows reaction counts and says no sign-up is made; empty says so plainly", () => {
  const text = countsReply({ at: new Date(NOW).toISOString(), events: { "raid-night": { interested: 4 } }, posts: { "card:signups": { total: 7, emoji: { "👍": 5, partyhat: 2 } } } }, [{ key: "raid-night", name: "Raid night" }]);
  assert.match(text, /\*\*Raid night\*\*: 4 interested/);
  assert.match(text, /Sign-up card \(signups\): 7 reactions \(👍 5, partyhat 2\)/);
  assert.match(text, /nobody is signed up by a click/);
  assert.match(text, new RegExp(`<t:${NOW / 1000}:R>`));
  assert.match(countsReply(null, null), /^Nothing counted yet/);
});

test("the ask form: prefilled with the level question, capped at the /ask limit; the question is read back from either layout", () => {
  const m = askLevelModal();
  assert.equal(m.type, 9);
  assert.equal(m.data.custom_id, ASK_LEVEL_MODAL_ID);
  assert.equal(m.data.components[0].component.value, ASK_LEVEL_PREFILL);
  assert.ok(m.data.components[0].component.max_length > 0);
  assert.equal(questionFromModal([{ type: 18, component: { type: 4, custom_id: "question", value: "  What now at 23?  " } }]), "What now at 23?");
  assert.equal(questionFromModal([{ type: 1, components: [{ type: 4, custom_id: "question", value: "Hi" }] }]), "Hi");
  assert.equal(questionFromModal([]), "");
});

test("interest_counts is a private row: the public document routes neither serve nor accept it", () => {
  assert.equal(isDeniedKvKey(INTEREST_COUNTS_KEY), true);
  assert.equal(isPrivateKvKey(INTEREST_COUNTS_KEY), true);
});

test("the 6-hour cron (not the every-minute tick) runs the collector", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("../../infrastructure/worker/index.js", import.meta.url)), "utf8");
  const sched = src.slice(src.indexOf("async scheduled("));
  const minuteBranch = sched.slice(0, sched.indexOf("return;"));
  assert.ok(!minuteBranch.includes("collectInterest"), "not on the every-minute trigger");
  assert.ok(sched.slice(sched.indexOf("return;")).includes("collectInterest({ env })"), "on the source-sweep trigger");
});

// ---- the Discord interactions ---------------------------------------------------------------------------------------------------
const signer = createDiscordSigner();
const USER = id(1);
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, init = {}) => (outbound.push({ url: String(url), method: init.method || "GET" }), new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
test.after(() => { globalThis.fetch = realFetch; });

let seq = 0;
function interaction(type, data) {
  seq += 1;
  return { id: `fixture-interaction-${seq}1`, application_id: "fixture-app-0001", token: "fixture-token-not-real", version: 1, guild_id: GUILD, channel_id: CHAN, member: { user: { id: USER, username: "zib", global_name: "Zib Fizzlecog" }, nick: null, roles: [] }, type, data };
}
function chatEnv(flag, db = seeded()) {
  seed(db, { discord_members: [{ slug: "zib", name: "Zib Fizzlecog", match: ["zib fizzlecog"], id: USER }], party: { members: [{ name: "Zib Fizzlecog", race: "Gnome", class: "Mage" }] } });
  const room = { fetch: async () => new Response("ok") };
  return { DB: db, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://board.test", USER_SALT: "fixture-salt-0123456789", BOARD_ROOM: { idFromName: () => "room", get: () => room }, ...(flag ? { INTEREST_NUDGES: flag } : {}) };
}
async function send(i, env) {
  const pending = [];
  const res = await handleDiscordInteraction(signer.signedRequest(i), env, { waitUntil: (p) => pending.push(p) }, "https://worker.test");
  await Promise.allSettled(pending);
  return res.json();
}
// Runs fn with Date.now() fixed, so the tests do not depend on today being before or after launch night.
async function atTime(epochSec, fn) {
  const real = Date.now;
  Date.now = () => epochSec * 1000;
  try { return await fn(); } finally { Date.now = real; }
}
const BEFORE_LAUNCH = LAUNCH_EPOCH - 3 * 86400, AFTER_LAUNCH = LAUNCH_EPOCH + 3 * 86400;
const ids = (body) => (body.data.components || []).flatMap((r) => r.components || []).map((c) => c.custom_id || c.url);

test("flag off: /tonight and /signup keep exactly the old buttons and words", async () => {
  const t = await send(interaction(2, { id: "c1", name: "tonight", type: 1 }), chatEnv("off"));
  assert.deepEqual(ids(t), ["https://board.test/#tonight"]);
  const s = await send(interaction(2, { id: "c2", name: "signup", type: 1 }), chatEnv(null));
  assert.deepEqual(ids(s), ["signup:rsvp:in", "signup:rsvp:maybe", "signup:rsvp:out", "https://board.test/#signups"]);
  assert.doesNotMatch(s.data.content, /One tap/);
});

test("flag on: /tonight offers I'm in (RSVP empty), the ask button and the counts button; /signup gets the ask and counts row", async () => {
  const db = seeded();
  seed(db, { signups: { entries: [] } });
  const t = await atTime(BEFORE_LAUNCH, () => send(interaction(2, { id: "c1", name: "tonight", type: 1 }), chatEnv("on", db)));
  assert.deepEqual(ids(t), ["https://board.test/#tonight", "signup:rsvp:in", ASK_LEVEL_BUTTON_ID, COUNTS_BUTTON_ID]);
  const s = await send(interaction(2, { id: "c2", name: "signup", type: 1 }), chatEnv("on", db));
  assert.deepEqual(ids(s), ["signup:rsvp:in", "signup:rsvp:maybe", "signup:rsvp:out", "https://board.test/#signups", ASK_LEVEL_BUTTON_ID, COUNTS_BUTTON_ID]);
  assert.match(s.data.content, /^One tap answers it/);
  for (const b of [t, s]) assert.ok(b.data.components.every((r) => r.components.length <= 5), "at most five buttons per row");
  // RSVP already given: no I'm in button on /tonight, no nudge line on /signup
  const t2 = await atTime(BEFORE_LAUNCH, () => send(interaction(2, { id: "c3", name: "tonight", type: 1 }), chatEnv("on")));
  assert.ok(!ids(t2).includes("signup:rsvp:in"));
  const s2 = await send(interaction(2, { id: "c4", name: "signup", type: 1 }), chatEnv("on"));
  assert.doesNotMatch(s2.data.content, /One tap/);
});

test("flag on: the ask button opens the prefilled form; the form submit takes the /ask path, privately", async () => {
  const open = await send(interaction(3, { custom_id: ASK_LEVEL_BUTTON_ID, component_type: 2 }), chatEnv("on"));
  assert.equal(open.type, 9);
  assert.equal(open.data.custom_id, ASK_LEVEL_MODAL_ID);
  const db = seeded();
  const env = chatEnv("on", db);
  const before = db.raw.prepare("SELECT COUNT(*) AS n FROM intents").get().n;
  const res = await send(interaction(5, { custom_id: ASK_LEVEL_MODAL_ID, components: [{ type: 18, component: { type: 4, custom_id: "question", value: "What should I do next at my level? I am level 23" } }] }), env);
  assert.ok(res.type === 5 || res.type === 4);
  assert.equal(res.data.flags & 64, 64, "the answer is private");
  const rows = db.raw.prepare("SELECT kind, body FROM intents").all();
  assert.equal(rows.length, before + 1);
  assert.equal(rows.at(-1).kind, "ask");
  assert.equal(JSON.parse(rows.at(-1).body).private, true);
  assert.deepEqual(kv(db, "signups"), SIGNUPS, "asking never writes a sign-up");
  const empty = await send(interaction(5, { custom_id: ASK_LEVEL_MODAL_ID, components: [{ type: 18, component: { type: 4, custom_id: "question", value: "   " } }] }), chatEnv("on"));
  assert.match(empty.data.content, /Type a question/);
});

test("flag on: the counts button shows the stored counts and writes nothing; flag off it is an unknown button", async () => {
  const db = seeded();
  seed(db, { [INTEREST_COUNTS_KEY]: { at: new Date(NOW).toISOString(), events: { "raid-night": { interested: 4 } }, posts: {} } });
  const env = chatEnv("on", db);
  const snap = JSON.stringify(db.raw.prepare("SELECT key, json FROM kv_state WHERE key != 'replay' ORDER BY key").all());
  outbound.length = 0;
  const res = await send(interaction(3, { custom_id: COUNTS_BUTTON_ID, component_type: 2 }), env);
  assert.equal(res.type, 4);
  assert.equal(res.data.flags & 64, 64);
  assert.match(res.data.content, /Raid night\*\*: 4 interested/);
  assert.equal(JSON.stringify(db.raw.prepare("SELECT key, json FROM kv_state WHERE key != 'replay' ORDER BY key").all()), snap);
  assert.equal(outbound.length, 0, "no Discord call to show counts");
  const off = await send(interaction(3, { custom_id: COUNTS_BUTTON_ID, component_type: 2 }), chatEnv("off"));
  assert.equal(off.data.content, "Command received by Leeroy.");
});

// ---- review fixes (PR 326 review) -----------------------------------------------------------------------------------------------
test("flag on, after launch night: /tonight has no I'm in button (it would write rsvp:in into a record the copy calls history), only the ask and counts buttons", async () => {
  const db = seeded();
  seed(db, { signups: { entries: [] } });
  const t = await atTime(AFTER_LAUNCH, () => send(interaction(2, { id: "c1", name: "tonight", type: 1 }), chatEnv("on", db)));
  assert.deepEqual(ids(t), ["https://board.test/#tonight", ASK_LEVEL_BUTTON_ID, COUNTS_BUTTON_ID]);
});

test("flag on: a sign-up row whose name is not a string does not break /tonight", async () => {
  const db = seeded();
  seed(db, { signups: { entries: [{ name: 5, rsvp: "in" }, { name: { a: 1 } }, { name: null, rsvp: "maybe" }, { rsvp: "in" }] } });
  const t = await atTime(AFTER_LAUNCH, () => send(interaction(2, { id: "c1", name: "tonight", type: 1 }), chatEnv("on", db)));
  assert.equal(t.type, 4);
  assert.deepEqual(ids(t), ["https://board.test/#tonight", ASK_LEVEL_BUTTON_ID, COUNTS_BUTTON_ID]);
});

test("flag off, empty RSVP: /signup shows no nudge line and no second button row (removing `nudge &&` must be caught)", async () => {
  for (const flag of [null, "off"]) {
    const db = seeded();
    seed(db, { signups: { entries: [] } });
    const s = await send(interaction(2, { id: "c2", name: "signup", type: 1 }), chatEnv(flag, db));
    assert.deepEqual(ids(s), ["signup:rsvp:in", "signup:rsvp:maybe", "signup:rsvp:out", "https://board.test/#signups"]);
    assert.doesNotMatch(s.data.content, /One tap/);
  }
});

test("reactionCounts: emoji named constructor, toString, valueOf or __proto__ are counted as numbers and respect MAX_EMOJI", () => {
  const word = (name, count) => ({ count, emoji: { name } });
  const r = reactionCounts({ author: { bot: true }, reactions: [word("constructor", 2), word("toString", 3), word("valueOf", 4), word("__proto__", 5), word("constructor", 1)] });
  assert.equal(r.total, 15);
  assert.deepEqual(Object.entries(r.emoji).sort(), [["__proto__", 5], ["constructor", 3], ["toString", 3], ["valueOf", 4]].sort());
  assert.ok(Object.values(r.emoji).every((n) => typeof n === "number"));
  const many = [];
  for (let i = 0; i < MAX_EMOJI; i += 1) many.push(word(`e${i}`, 1));
  const capped = reactionCounts({ author: { bot: true }, reactions: [...many, word("constructor", 1), word("e0", 1)] });
  assert.equal(Object.keys(capped.emoji).length, MAX_EMOJI, "a word that is not yet counted does not get past the cap");
  assert.equal(capped.emoji.e0, 2);
  assert.ok(!Object.hasOwn(capped.emoji, "constructor"));
});

// A failed read must not overwrite the stored counts or their `at`.
const PREV = { at: "2026-11-14T12:00:00Z", events: { "raid-night": { interested: 1 } }, posts: { "card:signups": { total: 2, emoji: { x: 2 } } } };
const withPrev = (db) => (seed(db, { [INTEREST_COUNTS_KEY]: PREV }), db);
const run = (db, fetchImpl) => collectInterest({ env: { DB: db, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl, now: NOW });
function breakFetch(frag, how) {
  const d = fakeDiscord();
  return async (url, init) => {
    if (!String(url).includes(frag)) return d.fetchImpl(url, init);
    if (how === "throw") throw new Error("network down");
    if (how === "500") return new Response("oops", { status: 500 });
    if (how === "502") return new Response("<html>bad gateway</html>", { status: 502 });
    if (how === "garbage") return new Response("<html>not json</html>", { status: 200 });
    if (how === "wrong-shape") return Response.json({ message: "an object, not a list" });
    throw new Error(how);
  };
}

test("a failed Discord read (network throw, 500, 502, malformed success body) keeps the previous counts and their `at`, and marks the run failed", async () => {
  const cases = [["scheduled-events", "throw"], ["scheduled-events", "500"], ["scheduled-events", "garbage"], ["scheduled-events", "wrong-shape"], [`/messages/${CARD_MSG}`, "throw"], [`/messages/${MOMENT_MSG}`, "502"], [`/messages/${CARD_MSG}`, "garbage"]];
  for (const [frag, how] of cases) {
    const db = withPrev(seeded());
    const r = await run(db, breakFetch(frag, how));
    assert.equal(r.ok, false, `${how} ${frag}`);
    assert.equal(r.wrote, false);
    const row = kv(db, INTEREST_COUNTS_KEY);
    assert.equal(row.at, PREV.at, `${how} ${frag}: at kept`);
    assert.deepEqual(row.events, PREV.events);
    assert.deepEqual(row.posts, PREV.posts);
    assert.equal(row.failedAt, new Date(NOW).toISOString());
    assert.match(countsReply(row, null), /last count run failed/);
    assert.match(countsReply(row, null), /\*\*raid-night\*\*: 1 interested/);
  }
  // a good run afterwards clears the mark
  const db = withPrev(seeded());
  await run(db, breakFetch("scheduled-events", "500"));
  await run(db, fakeDiscord().fetchImpl);
  assert.equal(kv(db, INTEREST_COUNTS_KEY).failedAt, undefined);
  assert.equal(kv(db, INTEREST_COUNTS_KEY).at, new Date(NOW).toISOString());
});

test("a failed first run (no stored counts): nothing is invented, and the reply says unavailable, not 'Nothing counted yet'", async () => {
  const db = seeded();
  await run(db, breakFetch("scheduled-events", "500"));
  const row = kv(db, INTEREST_COUNTS_KEY);
  assert.deepEqual([row.events, row.posts, row.at], [{}, {}, null]);
  assert.match(countsReply(row, null), /^Counts are unavailable/);
  assert.doesNotMatch(countsReply(row, null), /Nothing counted yet/);
});

test("a stopped run (401/403/429) also marks the stored counts stale while keeping them", async () => {
  const db = withPrev(seeded());
  await run(db, fakeDiscord({ status: { "scheduled-events": 403 } }).fetchImpl);
  const row = kv(db, INTEREST_COUNTS_KEY);
  assert.equal(row.at, PREV.at);
  assert.deepEqual(row.events, PREV.events);
  assert.ok(row.failedAt);
});

test("a D1 read error or corrupt JSON in an input row keeps the stored counts (it is not read as 'no events, no posts')", async () => {
  for (const mode of ["throw", "corrupt"]) {
    const db = withPrev(seeded());
    let env;
    if (mode === "corrupt") {
      db.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run("cards", "{not json", "2026-11-01T00:00:00Z");
      env = { DB: db };
    } else {
      env = { DB: { ...db, prepare: (sql) => { const st = db.prepare(sql); return { bind: (...a) => (a[0] === "cards" ? { first: async () => { throw new Error("d1 down"); } } : st.bind(...a)) }; } } };
    }
    const r = await collectInterest({ env: { ...env, DISCORD_BOT_TOKEN: TOKEN, INTEREST_NUDGES: "on" }, fetchImpl: fakeDiscord().fetchImpl, now: NOW });
    assert.equal(r.ok, false, mode);
    assert.equal(r.wrote, false);
    const row = kv(db, INTEREST_COUNTS_KEY);
    assert.equal(row.at, PREV.at, mode);
    assert.deepEqual(row.posts, PREV.posts);
    assert.ok(row.failedAt);
  }
});

test("the counts button: an unreadable counts row says unavailable, not 'Nothing counted yet'", async () => {
  const db = seeded();
  db.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(INTEREST_COUNTS_KEY, "{broken", "2026-11-01T00:00:00Z");
  const res = await send(interaction(3, { custom_id: COUNTS_BUTTON_ID, component_type: 2 }), chatEnv("on", db));
  assert.match(res.data.content, /unavailable/);
  assert.doesNotMatch(res.data.content, /Nothing counted yet/);
});

test("countsReply stays under Discord's 2000-character limit at every size, with complete lines only, ending 'and N more'", () => {
  const longName = "N".repeat(100);
  for (const n of [0, 1, 5, 12, 20, 40, 80]) {
    const events = {}, sched = [];
    for (let i = 0; i < n; i += 1) { events[`key-${i}`] = { interested: i }; sched.push({ key: `key-${i}`, name: `${longName}${i}` }); }
    const posts = {};
    for (let i = 0; i < n; i += 1) {
      const emoji = {};
      for (let j = 0; j < MAX_EMOJI; j += 1) emoji[`${"E".repeat(31)}${j}`] = j + 1;
      posts[`moment:post-${i}`] = { total: 55, emoji };
    }
    const text = countsReply({ at: new Date(NOW).toISOString(), events, posts }, sched);
    assert.ok(text.length <= 2000, `${n}: ${text.length}`);
    const lines = text.split("\n");
    const bullets = lines.filter((l) => l.startsWith("\u2022"));
    const total = n * 2;
    if (bullets.length < total) assert.equal(lines.at(-1), `and ${total - bullets.length} more`, `${n}`);
    else assert.ok(!lines.some((l) => /^and \d+ more$/.test(l)));
    for (const l of lines.slice(1)) assert.ok(l.startsWith("\u2022") || /^and \d+ more$/.test(l), `a complete line only: ${l.slice(0, 40)}`);
    for (const l of bullets) assert.ok(/ (interested|reactions( \(.*\))?)$/.test(l), `line not cut: ${l.slice(-30)}`);
  }
});
