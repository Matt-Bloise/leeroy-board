// Scheduled events: planner, executor with a fake Discord, idempotent re-run, dry-run default. Fakes only: no network, no real ids.
// Does not import index.js; the route is exercised through runSync with a fake D1.
import test from "node:test";
import assert from "node:assert/strict";
import {
  planEvents, applyPlan, runSync, validateSchedule, eventsEnabled, buildEventBody,
  PRIVACY_LEVEL_GUILD_ONLY, ENTITY_TYPE_EXTERNAL, PERMISSION_HELP, MAX_ACTIONS_PER_RUN,
} from "../../infrastructure/worker/scheduled-events.js";
import { validateConfigValue, CONFIG_KEYS, isPrivateKvKey } from "../../infrastructure/worker/config.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const ev = (key, over = {}) => ({ key, name: `Fixture ${key}`, location: "Fictional Hall", start: "2030-02-01T20:00:00Z", end: "2030-02-01T22:00:00Z", description: "", ...over });
const GUILD = "111111111111111111"; // fictional
const TOKEN = "fake-token-not-real";

test("planner creates an event that is not in the map", () => {
  const { actions, skipped } = planEvents({ desired: [ev("opening-night")], existing: {}, now: NOW });
  assert.equal(skipped.length, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "create");
  assert.equal(actions[0].key, "opening-night");
  assert.equal(actions[0].body.entity_type, ENTITY_TYPE_EXTERNAL);
  assert.equal(actions[0].body.privacy_level, PRIVACY_LEVEL_GUILD_ONLY);
  assert.equal(actions[0].body.privacy_level, 2);
  assert.deepEqual(actions[0].body.entity_metadata, { location: "Fictional Hall" });
  assert.equal(actions[0].body.scheduled_start_time, "2030-02-01T20:00:00.000Z");
  assert.equal(actions[0].body.scheduled_end_time, "2030-02-01T22:00:00.000Z");
});

test("planner updates an owned event when the time changed", () => {
  const owned = { id: "900", name: "Fixture a", location: "Fictional Hall", start: "2030-02-01T19:00:00.000Z", end: "2030-02-01T21:00:00.000Z", description: "" };
  const { actions } = planEvents({ desired: [ev("a")], existing: { a: owned }, now: NOW });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "update");
  assert.equal(actions[0].id, "900");
  assert.equal(actions[0].body.scheduled_start_time, "2030-02-01T20:00:00.000Z");
});

test("planner does nothing when the owned event already matches", () => {
  const owned = { id: "900", name: "Fixture a", location: "Fictional Hall", start: "2030-02-01T20:00:00.000Z", end: "2030-02-01T22:00:00.000Z", description: "" };
  const { actions, skipped } = planEvents({ desired: [ev("a")], existing: { a: owned }, now: NOW });
  assert.deepEqual(actions, []);
  assert.deepEqual(skipped, [{ key: "a", reason: "unchanged" }]);
});

test("planner never deletes: owned events missing from the schedule produce no action", () => {
  const owned = { id: "900", name: "Old", location: "Elsewhere", start: "2030-02-01T20:00:00.000Z", end: "2030-02-01T22:00:00.000Z", description: "" };
  const plan = planEvents({ desired: [], existing: { gone: owned }, now: NOW });
  assert.deepEqual(plan.actions, []);
  for (const a of planEvents({ desired: [ev("a")], existing: { gone: owned }, now: NOW }).actions) assert.ok(a.action === "create" || a.action === "update");
});

test("planner skips events whose start is in the past or now", () => {
  const desired = [ev("past", { start: "2029-12-31T20:00:00Z", end: "2029-12-31T22:00:00Z" }), ev("exactly-now", { start: "2030-01-01T00:00:00Z", end: "2030-01-01T01:00:00Z" })];
  const owned = { id: "900", name: "x", location: "y", start: "2029-12-01T20:00:00.000Z", end: "2029-12-01T22:00:00.000Z", description: "" };
  const plan = planEvents({ desired, existing: { past: owned }, now: NOW });
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["past", "past"]);
});

test("planner leaves unowned events alone: a key with no map entry is created, never patched", () => {
  // Only the map says what we own. A hand-made Discord event is invisible to the planner, so a new key never becomes a PATCH.
  const { actions } = planEvents({ desired: [ev("handmade-lookalike")], existing: { other: { id: "1", name: "n", location: "l", start: "s", end: "e" } }, now: NOW });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "create");
  assert.equal(actions[0].id, undefined);
  // a map entry without an id is not ownership either
  assert.equal(planEvents({ desired: [ev("k")], existing: { k: { name: "n" } }, now: NOW }).actions[0].action, "create");
});

test("planner skips invalid and duplicate entries instead of throwing", () => {
  const { actions, skipped } = planEvents({ desired: [{ key: "Bad Key" }, null, ev("dup"), ev("dup")], existing: {}, now: NOW });
  assert.equal(actions.length, 1);
  assert.equal(skipped.length, 3);
  assert.ok(skipped.every((s) => s.reason.startsWith("invalid")));
});

test("schedule validation: shape, unique keys, end after start, and the config key is registered and private", () => {
  assert.equal(validateSchedule([ev("a"), ev("b")]), null);
  assert.ok(validateSchedule({}));
  assert.ok(validateSchedule([ev("a"), ev("a")]));
  assert.ok(validateSchedule([ev("a", { end: "2030-02-01T19:00:00Z" })]));
  assert.ok(validateSchedule([ev("a", { start: "not a date" })]));
  assert.ok(validateSchedule([ev("a", { location: "x".repeat(101) })]));
  assert.ok(CONFIG_KEYS.includes("events_schedule"));
  assert.equal(validateConfigValue("events_schedule", [ev("a")]), null);
  assert.ok(validateConfigValue("events_schedule", "nope"));
  assert.equal(isPrivateKvKey("events_schedule"), true);
  assert.equal(isPrivateKvKey("scheduled_events"), true);
});

// ---- executor with a fake Discord
function fakeDiscord(script = []) {
  const calls = [];
  let nextId = 5000;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    const scripted = script.shift();
    if (scripted) return scripted();
    return new Response(JSON.stringify({ id: String(nextId++) }), { status: init.method === "POST" ? 200 : 200 });
  };
  return { fetchImpl, calls };
}
const noSleep = () => { const waits = []; return { sleep: async (ms) => { waits.push(ms); }, waits }; };

test("executor POSTs creates and PATCHes updates with the bot token and records the map", async () => {
  const owned = { id: "900", name: "old", location: "Fictional Hall", start: "2030-02-01T19:00:00.000Z", end: "2030-02-01T21:00:00.000Z", description: "" };
  const plan = planEvents({ desired: [ev("new"), ev("upd")], existing: { upd: owned }, now: NOW });
  const d = fakeDiscord();
  const r = await applyPlan({ plan, existing: { upd: owned }, guildId: GUILD, token: TOKEN, fetchImpl: d.fetchImpl, sleep: noSleep().sleep });
  assert.equal(r.ok, true);
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.url}`), [
    `POST https://discord.com/api/v10/guilds/${GUILD}/scheduled-events`,
    `PATCH https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/900`,
  ]);
  assert.equal(d.calls[0].headers.Authorization, `Bot ${TOKEN}`);
  assert.equal(d.calls[0].body.privacy_level, 2);
  assert.equal(r.map.new.id, "5000");
  assert.equal(r.map.upd.id, "900");
  assert.equal(r.map.upd.start, "2030-02-01T20:00:00.000Z");
  assert.ok(!JSON.stringify(r).includes(TOKEN), "the token must not appear in the result");
});

test("executor honours 429 retry_after, then succeeds", async () => {
  const plan = planEvents({ desired: [ev("a")], existing: {}, now: NOW });
  const d = fakeDiscord([() => new Response(JSON.stringify({ retry_after: 1.5, global: false }), { status: 429 })]);
  const s = noSleep();
  const r = await applyPlan({ plan, existing: {}, guildId: GUILD, token: TOKEN, fetchImpl: d.fetchImpl, sleep: s.sleep });
  assert.deepEqual(s.waits, [1500]);
  assert.equal(d.calls.length, 2);
  assert.equal(r.ok, true);
  assert.ok(r.map.a.id);
});

test("executor stops on a long 429 instead of sleeping through it, and saves nothing it did not do", async () => {
  const plan = planEvents({ desired: [ev("a"), ev("b")], existing: {}, now: NOW });
  const d = fakeDiscord([() => new Response(JSON.stringify({ retry_after: 120 }), { status: 429 })]);
  const s = noSleep();
  const r = await applyPlan({ plan, existing: {}, guildId: GUILD, token: TOKEN, fetchImpl: d.fetchImpl, sleep: s.sleep });
  assert.equal(r.ok, false);
  assert.equal(r.stopped, "rate_limited");
  assert.equal(r.retry_after_ms, 120000);
  assert.deepEqual(s.waits, []);
  assert.equal(d.calls.length, 1);
  assert.deepEqual(r.map, {});
});

test("executor turns a 403 into a clear permission message and stops", async () => {
  const plan = planEvents({ desired: [ev("a"), ev("b")], existing: {}, now: NOW });
  const d = fakeDiscord([() => new Response(JSON.stringify({ code: 50013, message: "Missing Permissions" }), { status: 403 })]);
  const r = await applyPlan({ plan, existing: {}, guildId: GUILD, token: TOKEN, fetchImpl: d.fetchImpl, sleep: noSleep().sleep });
  assert.equal(r.ok, false);
  assert.equal(r.stopped, "forbidden");
  assert.equal(r.error, PERMISSION_HELP);
  assert.match(r.error, /Manage Events/);
  assert.match(r.error, /Create Events/);
  assert.equal(d.calls.length, 1);
  assert.deepEqual(r.map, {});
});

test("executor never issues a DELETE and caps the actions per run", async () => {
  const many = Array.from({ length: MAX_ACTIONS_PER_RUN + 5 }, (_, i) => ev(`e${i}`));
  const plan = planEvents({ desired: many, existing: {}, now: NOW });
  const d = fakeDiscord();
  const r = await applyPlan({ plan, existing: {}, guildId: GUILD, token: TOKEN, fetchImpl: d.fetchImpl, sleep: noSleep().sleep });
  assert.equal(d.calls.length, MAX_ACTIONS_PER_RUN);
  assert.equal(r.deferred, 5);
  assert.ok(d.calls.every((c) => c.method === "POST" || c.method === "PATCH"));
});

test("a PATCH that finds the event gone forgets it, so the next sync creates it", async () => {
  const owned = { id: "900", name: "old", location: "Fictional Hall", start: "2030-02-01T19:00:00.000Z", end: "2030-02-01T21:00:00.000Z", description: "" };
  const plan = planEvents({ desired: [ev("upd")], existing: { upd: owned }, now: NOW });
  const d = fakeDiscord([() => new Response("{}", { status: 404 })]);
  const r = await applyPlan({ plan, existing: { upd: owned }, guildId: GUILD, token: TOKEN, fetchImpl: d.fetchImpl, sleep: noSleep().sleep });
  assert.equal(r.map.upd, undefined);
  assert.equal(planEvents({ desired: [ev("upd")], existing: r.map, now: NOW }).actions[0].action, "create");
});

// ---- route logic with a fake D1
function fakeEnv({ schedule, map, token = TOKEN } = {}) {
  const rows = new Map();
  if (schedule) rows.set("events_schedule", JSON.stringify(schedule));
  if (map) rows.set("scheduled_events", JSON.stringify(map));
  const writes = [];
  const DB = {
    prepare(sql) {
      let args = [];
      const o = {
        bind: (...a) => { args = a; return o; },
        first: async () => (rows.has(args[0]) ? { json: rows.get(args[0]) } : null),
        run: async () => { writes.push(args[0]); rows.set(args[0], args[1]); return { meta: {} }; },
      };
      return o;
    },
  };
  return { env: { DB, DISCORD_BOT_TOKEN: token, EVENTS_ENABLED: "on" }, rows, writes };
}

test("sync is a dry run by default: it returns the plan and calls neither Discord nor D1 writes", async () => {
  const { env, writes } = fakeEnv({ schedule: [ev("a")] });
  const d = fakeDiscord();
  const r = await runSync({ env, now: NOW, fetchImpl: d.fetchImpl, guildId: GUILD });
  assert.equal(r.status, 200);
  assert.equal(r.body.dry, true);
  assert.equal(r.body.summary.create, 1);
  assert.equal(d.calls.length, 0);
  assert.deepEqual(writes, []);
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
});

test("sync applies only with dry=false, and a second run is a no-op (idempotent)", async () => {
  const { env, rows, writes } = fakeEnv({ schedule: [ev("a"), ev("b")] });
  const d = fakeDiscord();
  const first = await runSync({ env, dry: false, now: NOW, fetchImpl: d.fetchImpl, sleep: noSleep().sleep, guildId: GUILD });
  assert.equal(first.status, 200);
  assert.equal(d.calls.length, 2);
  assert.deepEqual(writes, ["scheduled_events"]);
  assert.deepEqual(Object.keys(JSON.parse(rows.get("scheduled_events"))).sort(), ["a", "b"]);
  const second = await runSync({ env, dry: false, now: NOW, fetchImpl: d.fetchImpl, sleep: noSleep().sleep, guildId: GUILD });
  assert.equal(second.status, 200);
  assert.equal(second.body.actions.length, 0);
  assert.equal(d.calls.length, 2, "the re-run made no Discord call");
  assert.equal(writes.length, 1);
});

test("sync reports 403 with the permission message and keeps the map untouched", async () => {
  const { env, writes } = fakeEnv({ schedule: [ev("a")] });
  const d = fakeDiscord([() => new Response("{}", { status: 403 })]);
  const r = await runSync({ env, dry: false, now: NOW, fetchImpl: d.fetchImpl, sleep: noSleep().sleep, guildId: GUILD });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, PERMISSION_HELP);
  assert.deepEqual(writes, []);
});

test("sync apply needs the bot token and a guild id, and says so", async () => {
  const noToken = fakeEnv({ schedule: [ev("a")], token: "" });
  assert.equal((await runSync({ env: noToken.env, dry: false, now: NOW, guildId: GUILD })).status, 503);
  const ok = fakeEnv({ schedule: [ev("a")] });
  assert.equal((await runSync({ env: ok.env, dry: false, now: NOW, guildId: null })).status, 503);
});

test("sync with an empty or missing schedule is a quiet no-op", async () => {
  const { env } = fakeEnv({});
  const r = await runSync({ env, dry: false, now: NOW, guildId: GUILD });
  assert.equal(r.status, 200);
  assert.equal(r.body.actions.length, 0);
});

test("the flag defaults off", () => {
  assert.equal(eventsEnabled({}), false);
  assert.equal(eventsEnabled({ EVENTS_ENABLED: "off" }), false);
  assert.equal(eventsEnabled({ EVENTS_ENABLED: "on" }), true);
  assert.equal(buildEventBody(ev("a")).entity_type, 3);
});
