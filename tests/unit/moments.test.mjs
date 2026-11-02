// Unit tests for infrastructure/worker/moments.js. No network, no real D1, no AI; Discord is a fake fetch. Ids below are made up.
// Run: node --test tests/unit/moments.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  planMoments, validateSchedule, runMoments, memoryStore, momentsStatus, nonceFor, buildMomentBody, normalizeMoment, discordCall,
  CLAIM_WAIT_MS, CLAIM_RETRY_MS,
} from "../../infrastructure/worker/moments.js";
import { validateConfigValue, CONFIG_KEYS, isPrivateKvKey } from "../../infrastructure/worker/config.js";

const T0 = Date.parse("2026-11-03T20:00:00Z");
const MIN = 60000;
const CH = "100000000000000001";
const USER = "200000000000000002";

const text = (over = {}) => ({ id: "names-1h", at: "2026-11-03T20:00:00Z", channelId: CH, kind: "text", content: "Names open <t:1793833200:F>", ...over });
const card = (over = {}) => ({ id: "launch-24h", at: "2026-11-03T20:00:00Z", channelId: CH, kind: "card", content: "Tomorrow", imageUrl: "https://leeroy.party/img/x.png", boardToken: "tonight", ...over });
const countdown = (over = {}) => ({ id: "launch-1h", at: "2026-11-03T20:00:00Z", channelId: CH, kind: "countdown", content: "Launch", ...over });
const ping = (over = {}) => ({ id: "launch-0", at: "2026-11-03T20:00:00Z", channelId: CH, kind: "text", content: "Go", allowPing: true, ping: [USER], ...over });
const st = (moments = {}) => ({ moments });

// ---- planner
test("not yet due: nothing", () => {
  assert.deepEqual(planMoments({ schedule: [text()], state: st(), now: T0 - 1 }), []);
});

test("due: one post, mentions none, nonce set", () => {
  const [a] = planMoments({ schedule: [text()], state: st(), now: T0 });
  assert.equal(a.type, "post");
  assert.equal(a.channelId, CH);
  assert.deepEqual(a.body.allowed_mentions, { parse: [] });
  assert.equal(a.body.nonce, nonceFor("names-1h"));
  assert.equal(a.body.enforce_nonce, true);
  assert.ok(a.body.nonce.length <= 25);
  assert.match(a.body.content, /<t:1793833200:F>/);
});

test("late beyond the default 30 minute cutoff: skipped, never posted", () => {
  const [a] = planMoments({ schedule: [text()], state: st(), now: T0 + 31 * MIN });
  assert.deepEqual(a, { type: "skip", id: "names-1h", reason: "late", persist: true });
  const [b] = planMoments({ schedule: [text()], state: st(), now: T0 + 30 * MIN });
  assert.equal(b.type, "post");
  const [c] = planMoments({ schedule: [text({ lateCutoffMinutes: 2 })], state: st(), now: T0 + 3 * MIN });
  assert.equal(c.reason, "late");
});

test("already done or skipped: nothing", () => {
  assert.deepEqual(planMoments({ schedule: [text()], state: st({ "names-1h": { status: "done" } }), now: T0 + MIN }), []);
  assert.deepEqual(planMoments({ schedule: [text()], state: st({ "names-1h": { status: "skipped" } }), now: T0 + MIN }), []);
});

test("moments are planned in time order", () => {
  const later = text({ id: "b-later", at: "2026-11-03T20:05:00Z" });
  const first = text({ id: "a-first", at: "2026-11-03T20:00:00Z" });
  const acts = planMoments({ schedule: [later, first], state: st(), now: T0 + 6 * MIN });
  assert.deepEqual(acts.map((a) => a.id), ["a-first", "b-later"]);
});

test("card: embed with the site image and a converted board link", () => {
  const [a] = planMoments({ schedule: [card()], state: st(), now: T0 });
  assert.equal(a.body.embeds[0].image.url, "https://leeroy.party/img/x.png");
  assert.match(a.body.embeds[0].description, /https:\/\/leeroy\.party\/#tonight/);
  assert.doesNotMatch(a.body.embeds[0].description, /\{board:/);
});

test("countdown: posts once, then edits once per minute, final edit at T-0, then left alone", () => {
  const sched = [countdown()];
  const [post] = planMoments({ schedule: sched, state: st(), now: T0 });
  assert.equal(post.type, "post");
  assert.match(post.body.embeds[0].description, /Starts in \*\*1h\*\*/);
  const base = { status: "counting", messageId: "999", lastEditAt: T0 };
  assert.deepEqual(planMoments({ schedule: sched, state: st({ "launch-1h": base }), now: T0 + 30000 }), [], "same minute: no edit");
  const [e1] = planMoments({ schedule: sched, state: st({ "launch-1h": base }), now: T0 + MIN });
  assert.equal(e1.type, "edit");
  assert.equal(e1.messageId, "999");
  assert.equal(e1.final, false);
  assert.match(e1.body.embeds[0].description, /Starts in \*\*59m\*\*/);
  assert.deepEqual(e1.body.allowed_mentions, { parse: [] });
  const [fin] = planMoments({ schedule: sched, state: st({ "launch-1h": { ...base, lastEditAt: T0 + 59 * MIN } }), now: T0 + 60 * MIN });
  assert.equal(fin.final, true);
  assert.match(fin.body.embeds[0].description, /\*\*Now\.\*\*/);
  assert.deepEqual(planMoments({ schedule: sched, state: st({ "launch-1h": { status: "done", messageId: "999" } }), now: T0 + 61 * MIN }), []);
});

test("countdown: a missed minute still gets one edit; a late final edit still happens", () => {
  const sched = [countdown()];
  const s = st({ "launch-1h": { status: "counting", messageId: "9", lastEditAt: T0 } });
  assert.equal(planMoments({ schedule: sched, state: s, now: T0 + 7 * MIN })[0].type, "edit");
  assert.equal(planMoments({ schedule: sched, state: s, now: T0 + 90 * MIN })[0].final, true);
  assert.equal(planMoments({ schedule: sched, state: s, now: T0 + 7 * 3600000 })[0].reason, "abandoned");
});

test("countdown whose end passed before it was ever posted is skipped", () => {
  const [a] = planMoments({ schedule: [countdown({ lateCutoffMinutes: 600 })], state: st(), now: T0 + 61 * MIN });
  assert.equal(a.reason, "ended");
});

test("only launch-0 pings, and only with allowPing", () => {
  const [a] = planMoments({ schedule: [ping()], state: st(), now: T0 });
  assert.deepEqual(a.body.allowed_mentions, { parse: [], users: [USER] });
  assert.match(a.body.content, new RegExp(`<@${USER}>`));
  // not allowPing: ignored
  const [b] = planMoments({ schedule: [ping({ allowPing: false })], state: st(), now: T0 });
  assert.deepEqual(b.body.allowed_mentions, { parse: [] });
  // another moment id with allowPing: invalid, so skipped (not posted) and refused by validation
  const other = text({ allowPing: true, ping: [USER] });
  assert.match(validateSchedule([other]), /only launch-0 may ping/);
  assert.equal(planMoments({ schedule: [other], state: st(), now: T0 })[0].type, "skip");
  assert.equal(normalizeMoment({ ...other }), null);
  // an edit never pings
  assert.deepEqual(buildMomentBody(normalizeMoment(ping()), T0, { edit: true }).allowed_mentions, { parse: [] });
});

test("clock skew: a claim stamped in the future waits; lastEditAt in the future does not edit; a negative lateness is not late", () => {
  const claimed = st({ "names-1h": { status: "claimed", claimedAt: T0 + 5 * MIN, attempts: 1 } });
  assert.deepEqual(planMoments({ schedule: [text()], state: claimed, now: T0 + 1000 }), []);
  const future = st({ "launch-1h": { status: "counting", messageId: "9", lastEditAt: T0 + 10 * MIN } });
  assert.deepEqual(planMoments({ schedule: [countdown()], state: future, now: T0 + 2 * MIN }), []);
  assert.deepEqual(planMoments({ schedule: [text()], state: st(), now: T0 - 5000 }), []);
});

test("claimed: waits when fresh, retries inside the nonce window, gives up after it", () => {
  const claimed = (at) => st({ "names-1h": { status: "claimed", claimedAt: at, attempts: 1 } });
  assert.deepEqual(planMoments({ schedule: [text()], state: claimed(T0), now: T0 + CLAIM_WAIT_MS - 1 }), []);
  assert.equal(planMoments({ schedule: [text()], state: claimed(T0), now: T0 + CLAIM_WAIT_MS })[0].type, "post");
  assert.equal(planMoments({ schedule: [text()], state: claimed(T0), now: T0 + CLAIM_RETRY_MS + 1 })[0].reason, "claim_stale");
});

test("failed posts retry, but only a few times", () => {
  const retry = (n) => st({ "names-1h": { status: "retry", attempts: n } });
  assert.equal(planMoments({ schedule: [text()], state: retry(2), now: T0 + MIN })[0].type, "post");
  assert.equal(planMoments({ schedule: [text()], state: retry(5), now: T0 + MIN })[0].reason, "too_many_failures");
});

test("a malformed moment is skipped without persisting, and does not block the others", () => {
  const acts = planMoments({ schedule: [{ id: "bad", at: "nope" }, text()], state: st(), now: T0 });
  assert.equal(acts.find((a) => a.id === "bad").persist, false);
  assert.equal(acts.find((a) => a.id === "names-1h").type, "post");
});

// ---- schedule validation and config wiring
test("validateSchedule accepts the fictional example and rejects bad input", () => {
  assert.equal(validateSchedule([text(), card(), countdown(), ping()]), null);
  assert.match(validateSchedule({}), /array/);
  assert.match(validateSchedule([text({ at: "2026-11-03 20:00" })]), /ISO/);
  assert.match(validateSchedule([text({ channelId: "abc" })]), /channelId/);
  assert.match(validateSchedule([text({ kind: "poll" })]), /kind/);
  assert.match(validateSchedule([text({ imageUrl: "http://leeroy.party/a.png" })]), /imageUrl/);
  assert.match(validateSchedule([text({ imageUrl: "https://example.com/a.png" })]), /imageUrl/);
  assert.match(validateSchedule([text({ boardToken: "BAD TOKEN" })]), /boardToken/);
  assert.match(validateSchedule([text(), text()]), /duplicate/);
  assert.match(validateSchedule([countdown({ endsAt: "2026-11-03T19:00:00Z" })]), /endsAt/);
  assert.match(validateSchedule([text({ lateCutoffMinutes: -1 })]), /lateCutoffMinutes/);
});

test("moments is a config key, validated, and its rows are private", () => {
  assert.ok(CONFIG_KEYS.includes("moments"));
  assert.equal(validateConfigValue("moments", [text()]), null);
  assert.ok(validateConfigValue("moments", "x"));
  assert.equal(isPrivateKvKey("moments"), true);
  assert.equal(isPrivateKvKey("moments_state"), true);
});

// ---- executor
function fakeDiscord(script = []) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, body, auth: init.headers.Authorization });
    const step = script.shift();
    if (step) return step(url, init);
    n += 1;
    return new Response(JSON.stringify({ id: `msg${n}` }), { status: 200 });
  };
  return { fetchImpl, calls };
}
const ledgerStore = () => memoryStore(null, { entries: [] });
const ENV = { MOMENTS_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token" };
const noLog = () => {};

test("disabled by default: no read, no post", async () => {
  const { fetchImpl, calls } = fakeDiscord();
  let loaded = false;
  const r = await runMoments({}, { fetchImpl, store: memoryStore(), loadSchedule: async () => { loaded = true; return [text()]; }, clock: () => T0, log: noLog });
  assert.equal(r.ran, false);
  assert.equal(loaded, false);
  assert.equal(calls.length, 0);
});

test("posts a due moment once and records the message id; the same minute twice never double-posts", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeDiscord();
  const opts = { fetchImpl, store, loadSchedule: async () => [text()], clock: () => T0 + 5000, log: noLog };
  await runMoments(ENV, opts);
  await runMoments(ENV, opts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `https://discord.com/api/v10/channels/${CH}/messages`);
  assert.equal(calls[0].auth, "Bot test-token");
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(store.snapshot().moments["names-1h"].status, "done");
  assert.equal(store.snapshot().moments["names-1h"].messageId, "msg1");
});

test("two runs racing in the same minute: exactly one post", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeDiscord();
  const opts = { fetchImpl, store, loadSchedule: async () => [text()], clock: () => T0, log: noLog };
  await Promise.all([runMoments(ENV, opts), runMoments(ENV, opts)]);
  assert.equal(calls.length, 1);
});

test("the claim is written before the Discord call", async () => {
  const store = memoryStore();
  let seen = null;
  const fetchImpl = async () => {
    seen = store.snapshot().moments["names-1h"];
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  };
  await runMoments(ENV, { fetchImpl, store, loadSchedule: async () => [text()], clock: () => T0, log: noLog });
  assert.equal(seen.status, "claimed");
  assert.equal(seen.attempts, 1);
});

test("429: one retry honouring retry_after, then success", async () => {
  const slept = [];
  const { fetchImpl, calls } = fakeDiscord([() => new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 })]);
  const store = memoryStore();
  await runMoments(ENV, { fetchImpl, store, sleep: async (ms) => slept.push(ms), loadSchedule: async () => [text()], clock: () => T0, log: noLog });
  assert.deepEqual(slept, [1500]);
  assert.equal(calls.length, 2);
  assert.equal(store.snapshot().moments["names-1h"].status, "done");
});

test("429 twice: left retryable, not marked done", async () => {
  const limited = () => new Response(JSON.stringify({ retry_after: 0.1 }), { status: 429 });
  const { fetchImpl, calls } = fakeDiscord([limited, limited]);
  const store = memoryStore();
  await runMoments(ENV, { fetchImpl, store, sleep: async () => {}, loadSchedule: async () => [text()], clock: () => T0, log: noLog });
  assert.equal(calls.length, 2, "exactly one retry");
  const e = store.snapshot().moments["names-1h"];
  assert.equal(e.status, "retry");
  assert.equal(e.lastError, "http_429");
  // next minute posts it (inside the cutoff)
  const next = fakeDiscord();
  await runMoments(ENV, { fetchImpl: next.fetchImpl, store, loadSchedule: async () => [text()], clock: () => T0 + MIN, log: noLog });
  assert.equal(next.calls.length, 1);
  assert.equal(store.snapshot().moments["names-1h"].status, "done");
});

test("a long retry_after is not slept on; and an HTTP error or network failure leaves state retryable", async () => {
  const slept = [];
  const r = await discordCall(async () => new Response(JSON.stringify({ retry_after: 60 }), { status: 429 }), "t", "POST", "/x", {}, async (ms) => slept.push(ms));
  assert.equal(r.ok, false);
  assert.deepEqual(slept, []);
  for (const script of [[() => new Response("{}", { status: 500 })], [() => { throw new Error("boom"); }]]) {
    const { fetchImpl } = fakeDiscord(script);
    const store = memoryStore();
    await runMoments(ENV, { fetchImpl, store, loadSchedule: async () => [text()], clock: () => T0, log: noLog });
    assert.equal(store.snapshot().moments["names-1h"].status, "retry");
  }
});

test("a late moment is recorded as skipped and nothing is posted", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeDiscord();
  const lines = [];
  await runMoments(ENV, { fetchImpl, store, loadSchedule: async () => [text()], clock: () => T0 + 45 * MIN, log: (s) => lines.push(s) });
  assert.equal(calls.length, 0);
  assert.equal(store.snapshot().moments["names-1h"].status, "skipped");
  assert.ok(lines.some((l) => l.includes('"skip"') && l.includes("late")));
});

test("countdown end to end: post, per-minute edits, final edit, then nothing", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeDiscord();
  let now = T0;
  const opts = { fetchImpl, store, loadSchedule: async () => [countdown()], clock: () => now, log: noLog };
  await runMoments(ENV, opts);
  await runMoments(ENV, opts); // same minute: nothing more
  assert.equal(calls.length, 1);
  now = T0 + MIN;
  await runMoments(ENV, opts);
  await runMoments(ENV, opts);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].url, `https://discord.com/api/v10/channels/${CH}/messages/msg1`);
  now = T0 + 60 * MIN;
  await runMoments(ENV, opts);
  assert.equal(calls.length, 3);
  assert.match(calls[2].body.embeds[0].description, /Now\./);
  assert.equal(store.snapshot().moments["launch-1h"].status, "done");
  now = T0 + 61 * MIN;
  await runMoments(ENV, opts);
  assert.equal(calls.length, 3);
});

test("countdown edit of a deleted message (404) is marked deleted and never edited again", async () => {
  const store = memoryStore({ moments: { "launch-1h": { status: "counting", messageId: "gone", lastEditAt: T0 } } });
  const { fetchImpl, calls } = fakeDiscord([() => new Response("{}", { status: 404 })]);
  let now = T0 + 2 * MIN;
  const opts = { fetchImpl, store, ledger: ledgerStore(), loadSchedule: async () => [countdown()], clock: () => now, log: noLog };
  await runMoments(ENV, opts);
  assert.equal(store.snapshot().moments["launch-1h"].status, "deleted");
  for (const m of [3, 4, 30, 60, 61]) {
    now = T0 + m * MIN;
    await runMoments(ENV, opts);
  }
  assert.equal(calls.length, 1, "no further call after the 404");
  assert.deepEqual(momentsStatus({ schedule: [countdown()], state: store.snapshot(), now: T0 + 5 * MIN }).deleted, ["launch-1h"]);
});

test("a missed tick is caught up with ONE edit, never two in a row", async () => {
  const store = memoryStore({ moments: { "launch-1h": { status: "counting", messageId: "m", lastEditAt: T0 } } });
  const { fetchImpl, calls } = fakeDiscord();
  let now = T0 + 7 * MIN; // five ticks missed
  const opts = { fetchImpl, store, ledger: ledgerStore(), loadSchedule: async () => [countdown()], clock: () => now, log: noLog };
  await runMoments(ENV, opts);
  await runMoments(ENV, opts); // same minute again
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.embeds[0].description, /Starts in \*\*53m\*\*/, "the one edit shows the current time left");
  now = T0 + 7 * MIN + 59000; // still the same minute
  await runMoments(ENV, opts);
  assert.equal(calls.length, 1);
  now = T0 + 8 * MIN;
  await runMoments(ENV, opts);
  assert.equal(calls.length, 2, "back on the one-per-minute cadence");
  // planner level: any gap yields a single edit action
  for (const gap of [1, 2, 5, 40]) {
    const acts = planMoments({ schedule: [countdown()], state: st({ "launch-1h": { status: "counting", messageId: "m", lastEditAt: T0 } }), now: T0 + gap * MIN });
    assert.equal(acts.length, 1);
  }
});

test("content is clamped to the Discord limit", async () => {
  const long = "x".repeat(3400);
  const body = buildMomentBody(normalizeMoment(text({ content: long })), T0);
  assert.ok(body.content.length <= 2000);
});

test("dry run: logs the plan, posts nothing, writes no state, needs no token or enable flag", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeDiscord();
  const lines = [];
  const r = await runMoments({ MOMENTS_DRY_RUN: "1" }, { fetchImpl, store, loadSchedule: async () => [text(), ping()], clock: () => T0, log: (s) => lines.push(s) });
  assert.equal(r.dry, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(store.snapshot(), { moments: {} });
  assert.equal(lines.filter((l) => l.includes("dry_run")).length, 2);
});

test("enabled with no bot token: does nothing and writes nothing", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeDiscord();
  const r = await runMoments({ MOMENTS_ENABLED: "on" }, { fetchImpl, store, loadSchedule: async () => [text()], clock: () => T0, log: noLog });
  assert.equal(r.reason, "no_token");
  assert.equal(calls.length, 0);
  assert.deepEqual(store.snapshot(), { moments: {} });
});

test("launch-0 posts with exactly the listed user allowed to be pinged; every other post pings nobody", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeDiscord();
  await runMoments(ENV, { fetchImpl, store, loadSchedule: async () => [text(), ping()], clock: () => T0, log: noLog });
  const byContent = (s) => calls.find((c) => c.body.content.includes(s)).body;
  assert.deepEqual(byContent("Go").allowed_mentions, { parse: [], users: [USER] });
  assert.deepEqual(byContent("Names open").allowed_mentions, { parse: [] });
});

// ---- status for mission control
test("status lists next due and done, with no ids or content", () => {
  const sched = [text(), card({ at: "2026-11-04T20:00:00Z" }), ping({ at: "2026-11-04T21:00:00Z" })];
  const s = momentsStatus({ schedule: sched, state: st({ "names-1h": { status: "done", messageId: "777" } }), now: T0 + 10 * MIN, enabled: true });
  assert.deepEqual(s.done, ["names-1h"]);
  assert.equal(s.next.id, "launch-24h");
  assert.equal(s.enabled, true);
  const json = JSON.stringify(s);
  for (const secret of [CH, USER, "777", "Names open", "https://leeroy.party/img"]) assert.ok(!json.includes(secret), `leaked ${secret}`);
});

// ---- ledger and shadow mode
test("every real Discord call lands in the ledger with its status and rate-limit headers, 429 included", async () => {
  const ledger = ledgerStore();
  const hdr = (h) => ({ headers: h });
  const { fetchImpl } = fakeDiscord([
    () => new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429, ...hdr({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.5" }) }),
    () => new Response(JSON.stringify({ id: "m1" }), { status: 200, ...hdr({ "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "2.25" }) }),
  ]);
  const slept = [];
  await runMoments(ENV, { fetchImpl, store: memoryStore(), ledger, sleep: async (ms) => slept.push(ms), loadSchedule: async () => [text()], clock: () => T0, log: noLog });
  assert.deepEqual(slept, [500], "429 retry_after honoured");
  const rows = ledger.snapshot().entries;
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].status, rows[0].remaining, rows[0].resetAfter, rows[0].retryAfter], [429, 0, 0.5, 0.5]);
  assert.deepEqual([rows[1].status, rows[1].remaining, rows[1].resetAfter, rows[1].op, rows[1].mode], [200, 4, 2.25, "post", "live"]);
  assert.ok(!JSON.stringify(rows).includes(CH), "no channel id in the ledger");
});

test("a failing ledger never blocks or changes a post", async () => {
  const { fetchImpl, calls } = fakeDiscord();
  const broken = { read: async () => { throw new Error("db down"); }, cas: async () => false };
  const store = memoryStore();
  await runMoments(ENV, { fetchImpl, store, ledger: broken, loadSchedule: async () => [text()], clock: () => T0, log: noLog });
  assert.equal(calls.length, 1);
  assert.equal(store.snapshot().moments["names-1h"].status, "done");
});

test("shadow: never calls Discord, writes would_post / would_edit rows with hashes only, needs no bot token", async () => {
  const { fetchImpl, calls } = fakeDiscord();
  const shadowState = memoryStore();
  const ledger = ledgerStore();
  let now = T0;
  const opts = { fetchImpl, store: shadowState, ledger, loadSchedule: async () => [text(), countdown({ id: "launch-1h" })], clock: () => now, log: noLog };
  const env = { MOMENTS_SHADOW: "1" };
  await runMoments(env, opts);
  now = T0 + MIN;
  await runMoments(env, opts);
  now = T0 + 60 * MIN;
  await runMoments(env, opts);
  assert.equal(calls.length, 0);
  const rows = ledger.snapshot().entries;
  assert.deepEqual(rows.map((r) => r.op), ["would_post", "would_post", "would_edit", "would_edit"]);
  const first = rows[0];
  assert.equal(first.mode, "shadow");
  assert.equal(first.id, "names-1h");
  assert.equal(first.plannedAt, "2026-11-03T20:00:00.000Z");
  assert.match(first.channelHash, /^[0-9a-f]{16}$/);
  assert.match(first.contentHash, /^[0-9a-f]{16}$/);
  assert.equal(first.chars, text().content.length);
  assert.equal(rows[3].final, true);
  const json = JSON.stringify(rows);
  for (const secret of [CH, "Names open", "Launch"]) assert.ok(!json.includes(secret), `ledger leaked ${secret}`);
  // running again in the same minute adds nothing: shadow keeps its own state
  const before = ledger.snapshot().entries.length;
  await runMoments(env, opts);
  assert.equal(ledger.snapshot().entries.length, before);
});

test("shadow and live are mutually exclusive: both on means nothing runs", async () => {
  const { fetchImpl, calls } = fakeDiscord();
  const store = memoryStore();
  const ledger = ledgerStore();
  const lines = [];
  const r = await runMoments({ ...ENV, MOMENTS_SHADOW: "on" }, { fetchImpl, store, ledger, loadSchedule: async () => [text()], clock: () => T0, log: (l) => lines.push(l) });
  assert.equal(r.reason, "flags_conflict");
  assert.equal(calls.length, 0);
  assert.deepEqual(store.snapshot(), { moments: {} });
  assert.deepEqual(ledger.snapshot(), { entries: [] });
  assert.ok(lines.some((l) => l.includes("flags_conflict")));
});

test("shadow late skip is a would_skip row; the shadow ledger and state keys are private", async () => {
  const ledger = ledgerStore();
  await runMoments({ MOMENTS_SHADOW: "1" }, { store: memoryStore(), ledger, loadSchedule: async () => [text()], clock: () => T0 + 45 * MIN, log: noLog });
  assert.equal(ledger.snapshot().entries[0].op, "would_skip");
  assert.equal(isPrivateKvKey("moments_shadow_state"), true);
  assert.equal(isPrivateKvKey("moments_ledger"), true);
});
