// Weekly board post (infrastructure/worker/weekly-post.js, flag WEEKLY_POST default off). Fictional party, sign-ups and library only.
// No AI, no network (Discord is a fake fetch). Run: node --test tests/unit/weekly-post.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  composeWeeklyPost, planWeeklyPost, pickTip, subjectOf, plain, nameKey, isoWeek, runWeeklyPost, validateWeeklyConfig,
  POST_MAX, TIP_MAX, WEEKLY_STATE_KEY, SUPPRESS_NOTIFICATIONS,
} from "../../infrastructure/worker/weekly-post.js";
import { validateConfigValue, isPrivateKvKey, invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ref = (n) => [{ id: `S${n}`, url: `https://example.test/source-${n}`, host: "example.test", label: `Source ${n}`, tier: 1 }];
const CLASSES = {
  pages: [
    { id: "classes/paladin", facts: [
      { key: "paladin.role", value: "tank, healer or damage dealer in the fictional realm", depth: "must", refs: ref(1) },
      { key: "paladin.holy.lay_on_hands", value: "heals for 9 units, once per 60 minutes", depth: "good", refs: ref(2) },
      { key: "paladin.tank.taunt", value: "the fictional taunt holds 3 enemies", depth: "good", refs: ref(3) },
      { key: "paladin.lore.quest", value: "a fictional quest at level 12", depth: "good", refs: ref(4) },
      { key: "paladin.long", value: "x".repeat(TIP_MAX + 1), depth: "must", refs: ref(5) },
      { key: "paladin.unsourced", value: "no source here", depth: "must", refs: [] },
    ] },
    { id: "classes/mage", facts: [{ key: "mage.role", value: "ranged damage and crowd control", depth: "must", refs: ref(6) }] },
    { id: "classes/priest", facts: [{ key: "priest.role", value: "the strongest fictional healer", depth: "must", refs: ref(7) }] },
  ],
};
const DUNGEONS = { pages: [{ id: "dungeons/overview", facts: [{ key: "dungeons.people_per_group", value: "five people in a fictional dungeon", depth: "good", refs: ref(8) }] }] };
const PARTY = () => ({ members: [
  { name: "Red Fox", class_key: "paladin", class: "Paladin", race: "Human", role: "tank", spec: "Protection", board_line: "Human Protection Paladin", notes: "canary-private-note-n9" },
  { name: "Blue Owl", class_key: "mage", class: "Mage", race: "Gnome", role: "damage", board_line: "Gnome Frost Mage" },
  { name: "Grey Cat", class_key: "priest", class: "Priest", race: "Dwarf", role: "healer", board_line: "Dwarf Holy Priest" },
] });
const SIGNUPS = () => ({ entries: [
  { name: "=Red Fox=", rsvp: "in" }, { name: "Blue Owl", rsvp: "maybe" }, { name: "Grey Cat", rsvp: "out" }, { name: "Green Elk", rsvp: "late" },
] });
const PLAY = Date.parse("2026-11-20T23:00:00Z");
const docs = (over = {}) => ({ signups: SIGNUPS(), party: PARTY(), classes: CLASSES, dungeons: DUNGEONS, playAt: PLAY, ...over });

test("the post names who signed up (not who is out), counts roles and says which nobody covers", () => {
  const { text } = composeWeeklyPost(docs());
  assert.match(text, /play night Fri, Nov 20, 6:00 PM ET/);
  assert.match(text, /Signed up \(3\): Red Fox, Blue Owl \(tentative\) and Green Elk \(running late\)\./);
  assert.doesNotMatch(text, /Grey Cat/, "an Out sign-up is not listed");
  assert.match(text, /Roles signed up: tank 1, healer 0, damage 1, no build on the board 1\. Nobody has signed up as healer yet\./);
  assert.match(text, /Ask Leeroy with \/ask\./);
});

test("facts composed by code: every URL is a quoted fact's own source, every tip and number comes from the library", () => {
  const { text, facts } = composeWeeklyPost(docs());
  const urls = [...text.matchAll(/<(https:[^>]+)>/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), facts.map((f) => f.source.url).sort());
  const input = JSON.stringify([CLASSES, DUNGEONS, PARTY(), SIGNUPS()]);
  for (const n of text.match(/\d+/g) || []) assert.ok(input.includes(n) || ["20", "6", "00", "3", "1", "0"].includes(n), `number ${n} is not in the documents`);
  for (const f of facts) assert.ok(text.includes(f.value), `${f.key} is quoted whole`);
  assert.doesNotMatch(text, /canary-private/, "a field the post does not use never appears");
});

test("a sign-up written with decorations finds its build ('=Red Fox=' is Red Fox)", () => {
  assert.equal(nameKey("=Red Fox="), nameKey("red fox"));
  const { text, skipped } = composeWeeklyPost(docs());
  assert.match(text, /- Red Fox \(Human Protection Paladin\)\./);
  assert.deepEqual(skipped.map((s) => s.name), ["Green Elk"]);
});

test("tip pool: core facts plus good facts whose key names the role or spec; never too long, never unsourced", () => {
  const seen = new Set();
  for (let w = 0; w < 12; w++) seen.add(pickTip(CLASSES, PARTY().members[0], w).key);
  assert.deepEqual([...seen].sort(), ["paladin.role", "paladin.tank.taunt"]);
  const healer = { ...PARTY().members[0], role: "healer", spec: "Holy" };
  const hs = new Set(); for (let w = 0; w < 12; w++) hs.add(pickTip(CLASSES, healer, w).key);
  assert.deepEqual([...hs].sort(), ["paladin.holy.lay_on_hands", "paladin.role"]);
  assert.equal(pickTip(CLASSES, { class_key: "rogue", role: "damage" }, 1), null);
});

test("the tip changes with the week, and its subject comes from the fact key", () => {
  const a = composeWeeklyPost(docs()).facts.find((f) => f.page === "classes/paladin").key;
  const b = composeWeeklyPost(docs({ playAt: PLAY + 7 * 86400000 })).facts.find((f) => f.page === "classes/paladin").key;
  assert.notEqual(a, b);
  assert.equal(subjectOf("warlock.curse_of_elements.ranks", "warlock"), "Curse of elements, ranks");
  assert.equal(isoWeek(PLAY).key, "2026-W47");
});

test("names and facts cannot ping, link or format", () => {
  const party = PARTY(); party.members[0].board_line = "[click](https://evil.test) @everyone <@123456789012345678>";
  const { text } = composeWeeklyPost(docs({ party, signups: { entries: [{ name: "@everyone **Red Fox**", rsvp: "in" }] } }));
  assert.doesNotMatch(text, /@everyone/);
  assert.doesNotMatch(text, /<@\d/);
  assert.doesNotMatch(text, /(?<!\\)\[click(?<!\\)\]/);
  assert.equal(plain("a_b*c"), "a\\_b\\*c");
});

test("a long party: the post stays under the limit and says how many tips were left out", () => {
  const members = [], entries = [];
  for (let i = 0; i < 40; i++) { members.push({ name: `Member ${i}`, class_key: "paladin", class: "Paladin", role: "tank", board_line: `Fictional build number ${i} with a long description` }); entries.push({ name: `Member ${i}`, rsvp: "in" }); }
  const { text, facts } = composeWeeklyPost(docs({ party: { members }, signups: { entries } }));
  assert.ok(text.length <= POST_MAX, String(text.length));
  assert.match(text, /\(and \d+ more\)/);
  assert.ok(facts.length < 40);
});

test("nobody signed up: one plain line, no roles, no tips", () => {
  const { text, facts } = composeWeeklyPost(docs({ signups: { entries: [] } }));
  assert.match(text, /Nobody has signed up yet\./);
  assert.equal(facts.length, 0);
});

test("schedule: early, due, already posted, and next week", () => {
  const config = { weekday: 5, hour: 23, lead_hours: 24 };
  assert.equal(planWeeklyPost({ config, state: null, now: Date.parse("2026-11-19T12:00:00Z") }).why, "early");
  const due = planWeeklyPost({ config, state: null, now: Date.parse("2026-11-19T23:30:00Z") });
  assert.equal(due.due, true); assert.equal(due.playAt, PLAY); assert.equal(due.week, "2026-W47");
  assert.equal(planWeeklyPost({ config, state: { week: "2026-W47" }, now: Date.parse("2026-11-20T06:00:00Z") }).why, "posted");
  assert.equal(planWeeklyPost({ config, state: { week: "2026-W47" }, now: Date.parse("2026-11-21T00:00:00Z") }).playAt, PLAY + 7 * 86400000);
  assert.equal(planWeeklyPost({ config: { weekday: 9, hour: 1 }, state: null, now: PLAY }).due, false);
});

test("config: weekly_post is a validated admin key, and both its rows are private", () => {
  assert.equal(validateConfigValue("weekly_post", { weekday: 5, hour: 23 }), null);
  assert.match(validateConfigValue("weekly_post", { weekday: 7, hour: 1 }), /weekday/);
  assert.match(validateWeeklyConfig({ weekday: 1, hour: 1, extra: 1 }), /unknown field/);
  assert.equal(isPrivateKvKey("weekly_post"), true);
  assert.equal(isPrivateKvKey(WEEKLY_STATE_KEY), true);
});

function world({ flag = "on", config = { weekday: 5, hour: 23, channel: "123450000000000001" }, noise = null } = {}) {
  const DB = schemaDb();
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), "2026-11-01T00:00:00.000Z");
  put("party", PARTY()); put("signups", SIGNUPS());
  if (config) put("weekly_post", config);
  if (noise) put("noise", noise);
  DB.raw.prepare("INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('classes.json', 's', ?, 'x'), ('dungeons.json', 's', ?, 'x')").run(JSON.stringify(CLASSES), JSON.stringify(DUNGEONS));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: "m1" }), { status: 200 }); };
  for (const k of ["weekly_post", "noise", "discord_roster"]) invalidateConfigCache(k);
  return { env: { DB, WEEKLY_POST: flag, DISCORD_BOT_TOKEN: "test-token" }, calls, fetchImpl, DB };
}
const DUE = Date.parse("2026-11-19T23:30:00Z");

test("flag off: nothing is read and nothing is posted", async () => {
  const env = { WEEKLY_POST: "off", DB: { prepare() { throw new Error("D1 read while off"); } } };
  assert.deepEqual(await runWeeklyPost(env, { now: DUE, fetchImpl: () => { throw new Error("fetch while off"); } }), { status: "off" });
  assert.equal((await runWeeklyPost({ DB: env.DB }, { now: DUE })).status, "off", "an unset flag is off");
});

test("flag on: one quiet post per play week, no mentions, the exact composed text", async () => {
  const w = world();
  const r1 = await runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl });
  assert.equal(r1.status, "posted", JSON.stringify(r1));
  assert.equal(w.calls.length, 1);
  assert.match(w.calls[0].url, /\/channels\/123450000000000001\/messages$/);
  assert.deepEqual(w.calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(w.calls[0].body.flags, SUPPRESS_NOTIFICATIONS);
  assert.equal(w.calls[0].body.content, composeWeeklyPost(docs()).text);
  const r2 = await runWeeklyPost(w.env, { now: DUE + 6 * 3600 * 1000, fetchImpl: w.fetchImpl });
  assert.equal(r2.status, "not_due"); assert.equal(r2.why, "posted");
  assert.equal(w.calls.length, 1);
});

test("flag on without the config row, or before the window: nothing is posted", async () => {
  const w = world({ config: null });
  assert.equal((await runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl })).status, "unconfigured");
  const w2 = world();
  assert.equal((await runWeeklyPost(w2.env, { now: Date.parse("2026-11-18T00:00:00Z"), fetchImpl: w2.fetchImpl })).why, "early");
  assert.equal(w.calls.length + w2.calls.length, 0);
});

test("a failed post releases the week so the next tick can try again", async () => {
  const w = world();
  const fail = async () => new Response("{}", { status: 500 });
  assert.equal((await runWeeklyPost(w.env, { now: DUE, fetchImpl: fail })).status, "post_failed");
  assert.equal(w.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(WEEKLY_STATE_KEY), undefined);
  assert.equal((await runWeeklyPost(w.env, { now: DUE + 60000, fetchImpl: w.fetchImpl })).status, "posted");
});

test("two overlapping runs post once", async () => {
  const w = world();
  const [a, b] = await Promise.all([runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl }), runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl })]);
  assert.deepEqual([a.status, b.status].sort(), ["claimed_elsewhere", "posted"]);
  assert.equal(w.calls.length, 1);
});

test("the noise budget can hold the post (quiet hours); the window stays open", async () => {
  const w = world({ noise: { tz: "America/New_York", quiet: { start: 18, end: 20 } } });
  const r = await runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl });
  assert.equal(r.status, "held", JSON.stringify(r));
  assert.equal(w.calls.length, 0);
});

test("the dry-run tool prints the post from repo data and says nothing is posted", () => {
  const tool = fileURLToPath(new URL("../../tools/weekly-post-dry-run.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [tool, "--play", "2026-11-20T23:00:00Z"], { encoding: "utf8" });
  assert.match(out, /Nothing is posted\./);
  assert.match(out, /----- post -----\n\*\*This week on the board\*\*: play night Fri, Nov 20, 6:00 PM ET/);
  assert.match(out, /Ask Leeroy with \/ask\./);
});
