// Board decision lines: diffing, batching, the 120-character cap, the quiet window, the noise budget, flags and shadow mode. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { diffRsvp, recordChanges, isDue, composeLine, noteSignupChange, flushBoardLines, QUIET_WINDOW_MS, LINE_MAX } from "../../infrastructure/worker/board-lines.js";
import { invalidateConfigCache, isPrivateKvKey, CONFIG_KEYS, validateConfigValue } from "../../infrastructure/worker/config.js";
import { fakeD1, fakeFetch } from "./fake-d1.mjs";

const CH = "100000000000000001";
const T0 = Date.UTC(2026, 10, 3, 18, 0, 0); // 1 PM EST, Nov 3
const doc = (...e) => ({ entries: e.map(([name, rsvp]) => ({ name, rsvp })) });

test("diff: new, changed and unchanged people; no state means nothing to say", () => {
  const d = diffRsvp(doc(["Ada", "in"], ["Bo", "in"]), doc(["Ada", "maybe"], ["Bo", "in"], ["Cy", "out"], ["Di", null]));
  assert.deepEqual(d.map((c) => [c.name, c.from, c.to]), [["Ada", "in", "maybe"], ["Cy", null, "out"]]);
  assert.deepEqual(diffRsvp(doc(["Ada", "in"]), doc()), []);
  assert.deepEqual(diffRsvp(null, null), []);
});

test("batching: first 'from' kept, last 'to' wins, a round trip cancels", () => {
  let p = recordChanges(null, diffRsvp(doc(["Ada", "in"]), doc(["Ada", "maybe"])), T0);
  p = recordChanges(p, diffRsvp(doc(["Ada", "maybe"]), doc(["Ada", "late"], ["Bo", "in"])), T0 + 1000);
  assert.deepEqual(Object.values(p.changes), [{ name: "Ada", from: "in", to: "late" }, { name: "Bo", from: null, to: "in" }]);
  assert.equal(p.lastChangeAt, T0 + 1000);
  p = recordChanges(p, diffRsvp(doc(["Ada", "late"]), doc(["Ada", "in"])), T0 + 2000);
  assert.deepEqual(Object.values(p.changes).map((c) => c.name), ["Bo"]);
  assert.equal(recordChanges(null, diffRsvp(doc(["Ada", "in"]), doc(["Ada", "out"])).concat(diffRsvp(doc(["Ada", "out"]), doc(["Ada", "in"]))), T0), null);
});

test("quiet window: due only 5 minutes after the LAST change", () => {
  const p = { lastChangeAt: T0, changes: { ada: { name: "Ada", from: null, to: "in" } } };
  assert.equal(isDue(p, T0 + QUIET_WINDOW_MS - 1), false);
  assert.equal(isDue(p, T0 + QUIET_WINDOW_MS), true);
  assert.equal(isDue({ ...p, notBefore: T0 + 9e6 }, T0 + 9e5), false);
  assert.equal(isDue(null, T0), false);
  assert.equal(isDue({ lastChangeAt: T0, changes: {} }, T0 + 9e9), false);
});

test("line: single, several, exact wording", () => {
  assert.equal(composeLine({ a: { name: "Ada", to: "maybe" } }), "From the board: Ada is tentative.");
  assert.equal(composeLine({ a: { name: "Ada", to: "in" }, b: { name: "Bo", to: "late" } }), "From the board: Ada is in and Bo is running late.");
  assert.equal(composeLine({ a: { name: "Ada", to: "in" }, b: { name: "Bo", to: "out" }, c: { name: "Cy", to: "maybe" } }), "From the board: Ada is in, Bo is out and Cy is tentative.");
  assert.equal(composeLine({}), "");
  assert.equal(composeLine({ a: { name: "Ada", to: "weird" } }), "");
});

test("line: never over 120 characters, tail becomes 'and N more', names cannot ping", () => {
  const many = {};
  for (let i = 0; i < 40; i++) many[`k${i}`] = { name: `Player-${i}-with-a-long-name`, to: "late" };
  const line = composeLine(many);
  assert.ok(line.length <= LINE_MAX, String(line.length));
  assert.match(line, /^From the board: .* and \d+ more\.$/);
  const longName = composeLine({ a: { name: "N".repeat(200), to: "running" in {} ? "in" : "in" } });
  assert.ok(longName.length <= LINE_MAX);
  const evil = composeLine({ a: { name: "@everyone <@123456789012345678>", to: "out" } });
  assert.ok(!/[@<>]/.test(evil), evil);
  for (let n = 1; n <= 12; n++) {
    const c = {};
    for (let i = 0; i < n; i++) c[`k${i}`] = { name: "N".repeat(24), to: "maybe" };
    assert.ok(composeLine(c).length <= LINE_MAX, `n=${n}`);
  }
});

test("config keys: cards and noise are admin config, validated, and never served by the public data route", () => {
  assert.ok(CONFIG_KEYS.includes("cards") && CONFIG_KEYS.includes("noise"));
  for (const k of ["cards", "cards_edit", "board_lines_pending", "noise"]) assert.equal(isPrivateKvKey(k), true, k);
  assert.equal(validateConfigValue("cards", { signups: { channel: CH, message: "200000000000000002" } }), null);
  assert.ok(validateConfigValue("cards", { signups: { channel: "x" } }));
  assert.equal(validateConfigValue("noise", { perDay: 2 }), null);
  assert.ok(validateConfigValue("noise", { perDay: "2" }));
});

function setup({ env = {}, kv = {} } = {}) {
  invalidateConfigCache();
  const DB = fakeD1({ cards: { signups: { channel: CH, message: "200000000000000002" } }, ...kv });
  return { DB, env: { CARDS_ENABLED: "on", BOARD_LINES_ENABLED: "on", DISCORD_BOT_TOKEN: "test-token", DB, ...env } };
}
const note = (s, b, a, t = T0) => noteSignupChange(s.env, doc(...b), doc(...a), t);

test("flags: nothing is recorded or posted unless CARDS_ENABLED and (BOARD_LINES_ENABLED or shadow)", async () => {
  const f = fakeFetch(() => ({ status: 200 }));
  for (const env of [{ CARDS_ENABLED: "off" }, { BOARD_LINES_ENABLED: "off" }]) {
    const s = setup({ env });
    await note(s, [["Ada", "in"]], [["Ada", "out"]]);
    assert.equal(s.DB.kv.has("board_lines_pending"), false, JSON.stringify(env));
    assert.notEqual((await flushBoardLines(s.env, { now: T0 + 9e5, fetchImpl: f })).status, "posted");
  }
  assert.equal(f.calls.length, 0);
});

test("flush: waits for the window, then posts ONE silent line with no mentions and counts it", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 200, json: { id: "1" } }));
  await note(s, [["Ada", "in"], ["Bo", "in"]], [["Ada", "maybe"], ["Bo", "out"]]);
  await note(s, [["Ada", "maybe"]], [["Ada", "maybe"], ["Cy", "in"]], T0 + 60_000);
  assert.equal((await flushBoardLines(s.env, { now: T0 + 60_000 + QUIET_WINDOW_MS - 1, fetchImpl: f })).status, "waiting");
  const r = await flushBoardLines(s.env, { now: T0 + 60_000 + QUIET_WINDOW_MS, fetchImpl: f });
  assert.equal(r.status, "posted");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { content: "From the board: Ada is tentative, Bo is out and Cy is in.", flags: 4096, allowed_mentions: { parse: [] } });
  assert.equal(f.calls[0].path, `/channels/${CH}/messages`);
  assert.equal(s.DB.kv.has("board_lines_pending"), false);
  assert.equal([...s.DB.ledger.values()][0], 1);
  assert.equal((await flushBoardLines(s.env, { now: T0 + 9e6, fetchImpl: f })).status, "none");
  assert.equal(f.calls.length, 1);
});

test("flush: two racing flushes post the line once", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 200, json: {} }));
  await note(s, [], [["Ada", "in"]]);
  const rs = await Promise.all([flushBoardLines(s.env, { now: T0 + 9e5, fetchImpl: f }), flushBoardLines(s.env, { now: T0 + 9e5, fetchImpl: f })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ["claimed_elsewhere", "posted"]);
  assert.equal(f.calls.length, 1);
});

test("noise budget: the 4th line of a day is held until the next day; edits never count", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 200, json: {} }));
  let t = T0;
  for (let i = 0; i < 3; i++) {
    await note(s, [], [[`P${i}`, "in"]], t);
    assert.equal((await flushBoardLines(s.env, { now: t + QUIET_WINDOW_MS, fetchImpl: f })).status, "posted");
    t += 3_600_000;
  }
  await note(s, [], [["P9", "in"]], t);
  const held = await flushBoardLines(s.env, { now: t + QUIET_WINDOW_MS, fetchImpl: f });
  assert.deepEqual([held.status, held.reason], ["held", "budget"]);
  assert.equal(held.notBefore, Date.UTC(2026, 10, 4, 5, 0)); // midnight Nov 4 New York
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.parse(s.DB.kv.get("board_lines_pending")).notBefore, held.notBefore);
  assert.equal((await flushBoardLines(s.env, { now: held.notBefore - 1, fetchImpl: f })).status, "waiting");
  // next day, inside quiet hours: still held, with notBefore 9 AM
  const q = await flushBoardLines(s.env, { now: held.notBefore + 3_600_000, fetchImpl: f });
  assert.deepEqual([q.status, q.reason], ["held", "quiet_hours"]);
  assert.equal(q.notBefore, Date.UTC(2026, 10, 4, 14, 0));
  assert.equal((await flushBoardLines(s.env, { now: q.notBefore, fetchImpl: f })).status, "posted");
  assert.equal(f.calls.length, 4);
});

test("noise budget: a D1 'noise' override raises the limit for that day", async () => {
  const s = setup({ kv: { noise: { perDay: 1, overrides: { "2026-11-03": 2 } } } });
  const f = fakeFetch(() => ({ status: 200, json: {} }));
  let t = T0;
  const out = [];
  for (let i = 0; i < 3; i++) {
    await note(s, [], [[`P${i}`, "in"]], t);
    out.push((await flushBoardLines(s.env, { now: t + QUIET_WINDOW_MS, fetchImpl: f })).status);
    t += 3_600_000;
  }
  assert.deepEqual(out, ["posted", "posted", "held"]);
});

test("quiet hours: a change at 2 AM New York is held and goes out at 9 AM", async () => {
  const s = setup();
  const f = fakeFetch(() => ({ status: 200, json: {} }));
  const night = Date.UTC(2026, 10, 3, 7, 0, 0); // 2 AM EST
  await note(s, [], [["Ada", "in"]], night);
  const r = await flushBoardLines(s.env, { now: night + QUIET_WINDOW_MS, fetchImpl: f });
  assert.deepEqual([r.status, r.reason, r.notBefore], ["held", "quiet_hours", Date.UTC(2026, 10, 3, 14, 0)]);
  assert.equal(f.calls.length, 0);
  assert.equal((await flushBoardLines(s.env, { now: r.notBefore, fetchImpl: f })).status, "posted");
});

test("Discord failure puts the line back with a back-off, so every interaction does not hit a refusing channel", async () => {
  const s = setup();
  let status = 500;
  const f = fakeFetch(() => (status === 200 ? { status, json: {} } : { status, headers: status === 429 ? { "retry-after": "120" } : {} }));
  await note(s, [], [["Ada", "in"]]);
  const due = T0 + QUIET_WINDOW_MS;
  const first = await flushBoardLines(s.env, { now: due, fetchImpl: f });
  assert.deepEqual([first.status, first.http, first.retryInMs], ["failed", 500, 60000]);
  assert.equal(s.DB.ledger.size, 0);
  assert.equal((await flushBoardLines(s.env, { now: due + 30_000, fetchImpl: f })).status, "waiting");
  assert.equal(f.calls.length, 1, "no second Discord call inside the back-off");
  status = 429;
  const limited = await flushBoardLines(s.env, { now: due + 60_000, fetchImpl: f });
  assert.deepEqual([limited.status, limited.retryInMs], ["failed", 120_000]);
  status = 403;
  const forbidden = await flushBoardLines(s.env, { now: due + 60_000 + 120_000, fetchImpl: f });
  assert.deepEqual([forbidden.status, forbidden.retryInMs], ["failed", 3_600_000]);
  assert.equal((await flushBoardLines(s.env, { now: due + 600_000, fetchImpl: f })).status, "waiting");
  status = 200;
  assert.equal((await flushBoardLines(s.env, { now: due + 60_000 + 120_000 + 3_600_000, fetchImpl: f })).status, "posted");
});

test("no sign-ups channel known: nothing is posted and the changes stay queued", async () => {
  const s = setup({ kv: { cards: { allowedChannels: [CH] } } });
  const f = fakeFetch(() => ({ status: 200 }));
  await note(s, [], [["Ada", "in"]]);
  assert.equal((await flushBoardLines(s.env, { now: T0 + 9e5, fetchImpl: f })).status, "no_channel");
  assert.equal(f.calls.length, 0);
  assert.ok(s.DB.kv.has("board_lines_pending"));
});

test("shadow: records 'would post' apart from the real budget, never calls Discord, even with BOARD_LINES_ENABLED off", async () => {
  const s = setup({ env: { CARDS_SHADOW: "1", BOARD_LINES_ENABLED: "off", DISCORD_BOT_TOKEN: "" } });
  const f = fakeFetch(() => ({ status: 200 }));
  await note(s, [], [["Ada", "in"]]);
  const r = await flushBoardLines(s.env, { now: T0 + 9e5, fetchImpl: f });
  assert.deepEqual([r.status, r.line], ["shadow", "From the board: Ada is in."]);
  assert.equal(f.calls.length, 0);
  assert.deepEqual([...s.DB.ledger.keys()].map((k) => k.split("|")[1]), [`shadow:post:${CH}`]);
  for (const k of s.DB.ledger.keys()) assert.ok(!/Ada/.test(k)); // no names or text in the ledger
});
