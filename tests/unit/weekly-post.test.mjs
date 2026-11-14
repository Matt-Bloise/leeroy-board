// Weekly board post (infrastructure/worker/weekly-post.js, flag WEEKLY_POST default off). Fictional party, sign-ups and library only.
// No AI, no network (Discord is a fake fetch). Findings F1 to F12 are from the outside review of the first version.
// Run: node --test tests/unit/weekly-post.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  composeWeeklyPost, planWeeklyPost, pickTip, subjectOf, plain, nameKey, isoWeek, runWeeklyPost, validateWeeklyConfig, sourcesOf,
  POST_MAX, TIP_MAX, WEEKLY_STATE_KEY, SUPPRESS_NOTIFICATIONS,
} from "../../infrastructure/worker/weekly-post.js";
import { validateConfigValue, isPrivateKvKey, invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ref = (n) => ({ id: `S${n}`, url: `https://example.test/source-${n}`, host: "example.test", label: `Source ${n}`, tier: 1 });
const fact = (key, value, depth, refs) => ({ key, value, depth, refs });
const CLASSES = {
  pages: [
    { id: "classes/paladin", facts: [
      fact("paladin.role", "tank, healer or damage dealer in the fictional realm of the test", "must", [ref(1)]),
      fact("paladin.holy.lay_on_hands", "heals the target for nine fictional units, once per hour", "good", [ref(2)]),
      fact("paladin.tank.taunt", "the fictional taunt holds three enemies for a few seconds", "good", [ref(3), ref(9), ref(3)]),
      fact("paladin.tank.shield_wall", "a fictional cooldown that halves damage taken while it lasts", "good", [ref(8)]),
      fact("paladin.tank.medal", "11-point medal, instant, a fictional talent tier for tanks", "good", [ref(8)]),
      fact("paladin.lore.quest", "a fictional quest at level twelve that nobody needs at all", "good", [ref(4)]),
      fact("paladin.long", "x ".repeat(TIP_MAX), "must", [ref(5)]),
      fact("paladin.short", "16-point medal", "must", [ref(5)]),
      fact("paladin.unsourced", "a perfectly good sentence with no source at all here", "must", []),
      fact("ogre.immune.fire", "takes double damage from fire in the fictional world here", "must", [ref(5)]),
    ] },
    { id: "classes/mage", facts: [fact("mage.role", "ranged damage and crowd control in the fictional realm", "must", [ref(6)])] },
    { id: "classes/priest", facts: [fact("priest.role", "the strongest fictional healer in the whole test world", "must", [ref(7)])] },
  ],
};
const PARTY = () => ({ members: [
  { name: "Red Fox", class_key: "paladin", class: "Paladin", race: "Human", role: "tank", spec: "Protection", board_line: "Human Protection Paladin", notes: "zqpn private note" },
  { name: "Blue Owl", class_key: "mage", class: "Mage", race: "Gnome", role: "damage", board_line: "Gnome Frost Mage" },
  { name: "Grey Cat", class_key: "priest", class: "Priest", race: "Dwarf", role: "healer", board_line: "Dwarf Holy Priest" },
] });
const FRESH = "2026-11-18T00:00:00.000Z"; // the sign-up card changed this week
const SIGNUPS = () => ({ updated: FRESH, entries: [
  { name: "=Red Fox=", rsvp: "in", when: "8pm", updated: FRESH }, { name: "Blue Owl", rsvp: "maybe", updated: FRESH }, { name: "Grey Cat", rsvp: "out", updated: FRESH }, { name: "Green Elk", rsvp: "late", updated: FRESH },
] });
const PLAY = Date.parse("2026-11-20T23:00:00Z");
const NOW = Date.parse("2026-11-19T23:30:00Z");
// a test's own sign-ups count as this week's unless it says otherwise: each entry without a time gets this week's
const stamp = (s) => ({ updated: FRESH, ...s, entries: (s.entries || []).map((e) => (e && typeof e === "object" && !("updated" in e) ? { ...e, updated: FRESH } : e)) });
const docs = (over = {}) => ({ party: PARTY(), classes: CLASSES, playAt: PLAY, now: NOW, ...over, signups: stamp(over.signups || SIGNUPS()) });

test("the post names who signed up (not who is out), with the board's names, and counts only those who are in", () => {
  const { text } = composeWeeklyPost(docs());
  assert.match(text, /^\*\*This week on the board\*\*\n/);
  assert.match(text, /Signed up \(3\): Red Fox, Blue Owl \(tentative\) and Green Elk \(running late\)\./);
  assert.doesNotMatch(text, /Grey Cat/, "an Out sign-up is not listed");
  assert.match(text, /Roles on the board for those who are in: tank 1, healer 0, damage dealer 0 \(1 with no role on the board\)\. No healer or damage dealer among them yet\./);
  assert.match(text, /Ask Leeroy with \/ask\./);
});

test("F3: no date or time from the private schedule appears in the post", () => {
  const { text } = composeWeeklyPost(docs());
  assert.doesNotMatch(text, /\b(PM|AM|ET|Nov|Fri)\b/);
});

test("facts composed by code: every URL is a quoted fact's own source, every fact is quoted whole, nothing unused leaks", () => {
  const { text, facts } = composeWeeklyPost(docs());
  const urls = [...text.matchAll(/<(https:[^>]+)>/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), facts.flatMap((f) => f.sources.map((s) => s.url)).sort());
  for (const f of facts) assert.ok(text.includes(plain(f.value)), `${f.key} is quoted whole`);
  const input = JSON.stringify([CLASSES, PARTY(), SIGNUPS()]);
  for (const n of (text.match(/\d+/g) || []).filter((x) => x.length > 1)) assert.ok(input.includes(n), `number ${n} is not in the documents`); // one-digit numbers are the post's own counts
  assert.doesNotMatch(text, /zqpn/, "a field the post does not use never appears");
});

test("F8: every distinct https source is cited, at most three", () => {
  assert.deepEqual(sourcesOf(CLASSES.pages[0].facts[2]).map((s) => s.id), ["S3", "S9"]);
  const many = fact("x.y", "v", "must", [ref(1), ref(2), ref(3), ref(4), { url: "http://plain.test" }]);
  assert.deepEqual(sourcesOf(many).map((s) => s.id), ["S1", "S2", "S3"]);
});

test("tip pool: the build's own actionable facts first, no jargon, never too long, too short, unsourced or another class's", () => {
  const keys = (m) => { const s = new Set(); for (let w = 0; w < 24; w++) s.add(pickTip(CLASSES, m, w).key); return [...s].sort(); };
  assert.deepEqual(keys(PARTY().members[0]), ["paladin.tank.shield_wall", "paladin.tank.taunt"], "the tank's own actionable facts; the medal fact is jargon");
  assert.deepEqual(keys({ ...PARTY().members[0], role: "healer", spec: "Holy" }), ["paladin.holy.lay_on_hands"]);
  assert.deepEqual(keys({ class_key: "mage", role: "damage" }), ["mage.role"], "no actionable fact: the core fact");
  assert.equal(pickTip(CLASSES, { class_key: "rogue", role: "damage" }, 1), null);
});

test("a tip reads as one plain sentence: the library's provenance at the end goes, the source link stays", async () => {
  const { plainValue, JARGON_RE } = await import("../../infrastructure/worker/weekly-post.js");
  assert.equal(plainValue("level 10, 20 minute cooldown (Oct 15 deep dive; client 70450)"), "level 10, 20 minute cooldown");
  assert.equal(plainValue("heals the party (rank 3) (Sep 24 notes)"), "heals the party (rank 3)", "only provenance is removed");
  assert.equal(plainValue("a value with (an aside) in the middle"), "a value with (an aside) in the middle");
  for (const j of ["16-point medal", "row 5, needs Ice Lance", "client 70450", "Blizzard has not said yet"]) assert.ok(JARGON_RE.test(j), j);
  assert.ok(!JARGON_RE.test("new trainer spell at 24, 1.5 s cast"));
  const { text } = composeWeeklyPost(docs());
  assert.match(text, /- Red Fox \(Human Protection Paladin\)\. Tank, (taunt|shield wall): [^\n]+\. \(Source \d/);
});

test("sign-ups from before last play night are not this week's: the post invites sign-ups, names them as earlier, and tips every build", () => {
  const old = "2026-11-01T00:00:00.000Z";
  const { text, facts } = composeWeeklyPost(docs({ signups: { updated: old, entries: SIGNUPS().entries.map((e) => ({ ...e, updated: old })) } }));
  assert.match(text, /Nobody has signed up for this week yet\. The sign-up card is in this channel: In, Tentative or Running late\./);
  assert.match(text, /Still on the card from an earlier week, not counted: Red Fox, Blue Owl and Green Elk\. Use \/signup to say you are coming this week\./);
  assert.doesNotMatch(text, /Signed up \(/);
  assert.doesNotMatch(text, /Roles on the board/);
  assert.match(text, /One tip for each build on the board, from the library:/);
  assert.equal(facts.length, 3, "one tip for each of the three builds");
  const noDate = composeWeeklyPost(docs({ signups: { entries: SIGNUPS().entries.map((e) => ({ ...e, updated: undefined })) } }));
  assert.match(noDate.text, /for this week yet/, "a sign-up with no time is not counted");
});

test("review F1: freshness is per sign-up, not the card's stamp; last week's replies do not count this week", () => {
  const old = "2026-10-27T00:00:00.000Z";
  // someone else's click an hour ago re-stamps the card; the two old sign-ups stay old
  const card = { updated: new Date(NOW - 3600e3).toISOString(), entries: [{ name: "Red Fox", rsvp: "in", updated: old }, { name: "Blue Owl", rsvp: "in", updated: old }, { name: "Grey Cat", rsvp: "out", updated: new Date(NOW - 3600e3).toISOString() }] };
  const a = composeWeeklyPost(docs({ signups: card }));
  assert.doesNotMatch(a.text, /Signed up \(/);
  assert.match(a.text, /from an earlier week, not counted: Red Fox and Blue Owl\./);
  // a sign-up an hour after last week's post (before last week's play night) is last week's
  const lastPost = PLAY - 7 * 86400e3 - 23 * 3600e3;
  const b = composeWeeklyPost(docs({ signups: { entries: [{ name: "Red Fox", rsvp: "in", updated: new Date(lastPost + 3600e3).toISOString() }] } }));
  assert.doesNotMatch(b.text, /Signed up \(/);
  // one made after last week's play night is this week's; mixed with an old one, only it is counted
  const c = composeWeeklyPost(docs({ signups: { entries: [{ name: "Red Fox", rsvp: "in", updated: new Date(PLAY - 7 * 86400e3 + 3600e3).toISOString() }, { name: "Blue Owl", rsvp: "in", updated: old }] } }));
  assert.match(c.text, /Signed up \(1\): Red Fox\./);
  assert.match(c.text, /not counted: Blue Owl\./);
});

test("review F6: a sign-up time must be a full ISO time, not in the future", async () => {
  const { entryIsCurrent } = await import("../../infrastructure/worker/weekly-post.js");
  const at = (u) => entryIsCurrent({ updated: u }, { playAt: PLAY, now: NOW });
  assert.equal(at(FRESH), true);
  for (const u of ["11/18/2026", "2026-11-18", "2026-11-18T00:00:00", ["2026-11-18T00:00:00Z"], 1763424000000, null, undefined, "", new Date(NOW + 86400e3).toISOString(), new Date(NOW + 365 * 86400e3).toISOString()]) assert.equal(at(u), false, String(u));
  assert.equal(entryIsCurrent({ updated: FRESH }, { playAt: PLAY, now: NaN }), false);
  assert.equal(entryIsCurrent({ updated: new Date(NOW - 6 * 86400e3).toISOString() }, { now: NOW }), true, "no play time: the last 7 days");
});

test("review F2-F4: a citation does not disqualify a fact; spec names match by prefix; another spec's or form's fact is never the tip; asides that say something stay", async () => {
  const { plainValue } = await import("../../infrastructure/worker/weekly-post.js");
  const classes = { pages: [{ id: "classes/priest", facts: [
    fact("priest.disc.shield", "level 6, absorbs fictional damage, 4 s cooldown (client 70450)", "good", [ref(1)]),
    fact("priest.shadow.form", "level 40, a fictional form that lasts until cancelled", "good", [ref(2)]),
    fact("priest.lore", "one tester called it a design conflict at level 20", "good", [ref(3)]),
  ] }, { id: "classes/druid", facts: [
    fact("druid.feral.shifting", "instant, a fictional shift that resets energy, Cat only", "good", [ref(4)]),
    fact("druid.bear.regen", "heals the bear over ten fictional seconds, 3 min cooldown", "good", [ref(5)]),
  ] }] };
  const keys = (m) => { const s = new Set(); for (let w = 0; w < 12; w++) { const t = pickTip(classes, m, w); if (t) s.add(t.key); } return [...s].sort(); };
  assert.deepEqual(keys({ class_key: "priest", role: "healer", spec: "Discipline" }), ["priest.disc.shield"], "Discipline matches disc; the citation does not count as jargon; shadow and trivia are out");
  assert.equal(pickTip(classes, { class_key: "priest", role: "healer", spec: "Discipline" }, 0).text, "Disc, shield: level 6, absorbs fictional damage, 4 s cooldown.");
  assert.deepEqual(keys({ class_key: "druid", role: "tank", spec: "Feral", board_line: "Feral Druid, bear tank" }), ["druid.bear.regen"], "a Cat only fact is not a bear's tip");
  assert.equal(plainValue("instant, absorbs damage (removed from the game in the Oct 15 notes)"), "instant, absorbs damage (removed from the game in the Oct 15 notes)");
  assert.equal(plainValue("cast it on the first pull (may miss; never on a boss)"), "cast it on the first pull (may miss; never on a boss)");
  assert.equal(plainValue("do not cast it before the pull (Method says otherwise)"), "do not cast it before the pull (Method says otherwise)");
  assert.equal(plainValue("(Oct 15 notes)"), "(Oct 15 notes)", "a value that is only a citation is kept whole");
  assert.equal(plainValue("24 s cooldown (Oct 15 notes; Wowhead tooltip)"), "24 s cooldown");
  assert.equal(plainValue("3 min cooldown (Sep 30 deep dive; Wowhead tooltip; fictional Gnome only)"), "3 min cooldown (fictional Gnome only)", "the citations go, the caveat stays");
  const { JARGON_RE } = await import("../../infrastructure/worker/weekly-post.js");
  for (const j of ["8 ranks rescaled to 25/29%", "ranks at 20 (-30), 30 (-45)", "the renamed Mangle", "was 25/25/30", "doubled Oct 1", "then vanished from the trainer"]) assert.ok(JARGON_RE.test(j), j);
});

test("F11: a role named after an object property does not throw", () => {
  for (const role of ["constructor", "__proto__", "toString"]) assert.ok(pickTip(CLASSES, { class_key: "paladin", role }, 1));
  const party = { members: [{ name: "Red Fox", class_key: "paladin", role: "constructor" }] };
  assert.doesNotThrow(() => composeWeeklyPost(docs({ party, signups: { entries: [{ name: "Red Fox", rsvp: "in" }] } })));
});

test("the tip changes with the week; its subject comes from the class's own key", () => {
  const a = composeWeeklyPost(docs()).facts.find((f) => f.page === "classes/paladin").key;
  const b = composeWeeklyPost(docs({ playAt: PLAY + 7 * 86400000 })).facts.find((f) => f.page === "classes/paladin").key;
  assert.notEqual(a, b);
  assert.equal(subjectOf("warlock.curse_of_elements.ranks", "warlock"), "Curse of elements, ranks");
  assert.equal(isoWeek(PLAY).key, "2026-W47");
});

test("F6, R1: exact names win, colliding names match nobody, a member signs up once, a name of symbols still counts", () => {
  const party = { members: [
    { name: "Red Fox", class_key: "paladin", role: "tank", board_line: "Tank build" },
    { name: "Redfox", class_key: "priest", role: "healer", board_line: "Healer build" },
    { name: "Twin", class_key: "mage", role: "damage" }, { name: "twin", class_key: "priest", role: "healer" },
  ] };
  const entries = [{ name: "Red Fox", rsvp: "in" }, { name: "RED FOX", rsvp: "maybe" }, { name: "Twin", rsvp: "in" }, { name: "???", rsvp: "in" }, { name: "!!!", rsvp: "in" }];
  const { text } = composeWeeklyPost(docs({ party, signups: { entries } }));
  assert.match(text, /Signed up \(4\): Red Fox, Twin, \?\?\? and !!!\./, "the sign-up card counts them, so the post does");
  assert.match(text, /- Red Fox \(Tank build\)/);
  assert.doesNotMatch(text, /Healer build/);
  assert.equal(nameKey("=Red Fox="), nameKey("red fox"));
});

test("F5 and F10: text is quoted as written but inert: no mention, link preview, masked link or direction trick", () => {
  const classes = { pages: [{ id: "classes/paladin", facts: [fact("paladin.role", "pulls threat when damage > 110% of the tank; do not attack at <3 stacks, see https://evil.test/x or discord.gg/abc", "must", [ref(1)])] }] };
  const party = { members: [{ name: "Red Fox", class_key: "paladin", role: "tank", board_line: "[click](https://evil.test) @everyone <@123456789012345678> ‮RTL" }] };
  const { text } = composeWeeklyPost(docs({ classes, party, signups: { entries: [{ name: "Red Fox", rsvp: "in" }, { name: "@everyone **Blue**", rsvp: "in" }] } }));
  assert.match(text, /- Red Fox \(/, "the tip under test is in the post");
  assert.match(text, /damage > 110%/, "a > in a fact is kept");
  assert.match(text, /at <​3 stacks/, "a < is kept, with a zero-width space after it");
  assert.doesNotMatch(text, /@everyone|<@\d|‮/);
  assert.doesNotMatch(text, /https:\/\/evil|(?<!\\)\[click/);
  assert.doesNotMatch(text, /discord\.gg\//);
  assert.equal(plain("a_b*c"), "a\\_b\\*c");
});

test("F7: any number of sign-ups fits one post; no tip heading without tips", () => {
  for (const n of [40, 90, 400]) {
    const members = [], entries = [];
    for (let i = 0; i < n; i++) { members.push({ name: `Member number ${i} long`, class_key: "paladin", role: "tank", board_line: `Fictional build ${i} with a long description` }); entries.push({ name: `Member number ${i} long`, rsvp: "in" }); }
    const { text } = composeWeeklyPost(docs({ party: { members }, signups: { entries } }));
    assert.ok(text.length <= POST_MAX, `${n}: ${text.length}`);
    if (/One fact per build/.test(text)) assert.match(text, /\n- /, "the heading has at least one tip under it");
  }
});

test("nobody signed up on a fresh card: one plain line, no roles, a tip for each build on the board", () => {
  const { text, facts } = composeWeeklyPost(docs({ signups: { entries: [] } }));
  assert.match(text, /Nobody has signed up for this week yet\./);
  assert.doesNotMatch(text, /earlier week/);
  assert.doesNotMatch(text, /Roles on the board/);
  assert.equal(facts.length, 3);
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

test("F2: a lead shorter than 24 hours is refused; config is a validated admin key and both rows are private", () => {
  assert.match(validateWeeklyConfig({ weekday: 5, hour: 23, lead_hours: 6 }), /lead_hours must be 24 to 72/);
  assert.equal(validateConfigValue("weekly_post", { weekday: 5, hour: 23, lead_hours: 48 }), null);
  assert.match(validateConfigValue("weekly_post", { weekday: 7, hour: 1 }), /weekday/);
  assert.match(validateWeeklyConfig({ weekday: 1, hour: 1, extra: 1 }), /unknown field/);
  assert.equal(isPrivateKvKey("weekly_post"), true);
  assert.equal(isPrivateKvKey(WEEKLY_STATE_KEY), true);
});

test("F2: with the default quiet hours, every weekday and hour posts within the window, every week", () => {
  const ticks = []; for (let t = Date.parse("2026-11-02T00:00:00Z"); t < Date.parse("2026-12-28T00:00:00Z"); t += 6 * 3600 * 1000) ticks.push(t);
  const quiet = (t) => { const h = Number(new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })) % 24; return h >= 1 && h < 9; };
  for (let weekday = 0; weekday < 7; weekday++) for (let hour = 0; hour < 24; hour++) {
    const config = { weekday, hour, lead_hours: 24 };
    const posted = new Set();
    let state = null;
    for (const t of ticks) { const p = planWeeklyPost({ config, state, now: t }); if (p.due && !quiet(t)) { state = { week: p.week }; posted.add(p.week); } }
    assert.ok(posted.size >= 7, `weekday ${weekday} hour ${hour}: posted ${posted.size} of 8 weeks`);
  }
});

function world({ flag = "on", config = { weekday: 5, hour: 23, channel: "123450000000000001" }, noise = null, cards = null } = {}) {
  const DB = schemaDb();
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, JSON.stringify(v), "2026-11-01T00:00:00.000Z");
  put("party", PARTY()); put("signups", SIGNUPS());
  if (config) put("weekly_post", config);
  if (noise) put("noise", noise);
  if (cards) put("cards", cards);
  DB.raw.prepare("INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('classes.json', 's', ?, 'x')").run(JSON.stringify(CLASSES));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: "m1" }), { status: 200 }); };
  for (const k of ["weekly_post", "noise", "discord_roster", "cards"]) invalidateConfigCache(k);
  return { env: { DB, WEEKLY_POST: flag, DISCORD_BOT_TOKEN: "test-token" }, calls, fetchImpl, DB };
}
const DUE = Date.parse("2026-11-19T23:30:00Z");
const stateRow = (DB) => DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(WEEKLY_STATE_KEY);

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

test("F1: a Discord error or a thrown call releases the week, so the next tick posts", async () => {
  for (const bad of [async () => new Response("{}", { status: 500 }), async () => { throw new Error("network down"); }]) {
    const w = world();
    assert.equal((await runWeeklyPost(w.env, { now: DUE, fetchImpl: bad })).status, "post_failed");
    assert.equal(stateRow(w.DB), undefined);
    assert.equal((await runWeeklyPost(w.env, { now: DUE + 60000, fetchImpl: w.fetchImpl })).status, "posted");
  }
});

test("two overlapping runs post once", async () => {
  const w = world();
  const [a, b] = await Promise.all([runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl }), runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl })]);
  assert.deepEqual([a.status, b.status].sort(), ["claimed_elsewhere", "posted"]);
  assert.equal(w.calls.length, 1);
});

test("the noise budget can hold the post (quiet hours); the window stays open", async () => {
  const w = world({ noise: { tz: "America/New_York", quiet: { start: 18, end: 20 } } });
  assert.equal((await runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl })).status, "held");
  assert.equal(w.calls.length, 0);
});

test("F12: a fallback channel that is not a channel id is not used", async () => {
  const w = world({ config: { weekday: 5, hour: 23 }, cards: { signups: { channel: "../../webhooks/1/x" } } });
  assert.equal((await runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl })).status, "no_channel");
  assert.equal(w.calls.length, 0);
});

test("F4: the dry-run plans with the same schedule and clock as the run, and refuses a schedule the Worker refuses", () => {
  const tool = fileURLToPath(new URL("../../tools/weekly-post-dry-run.mjs", import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [tool, "--config", '{"weekday":2,"hour":0,"minute":30}', "--now", "2026-11-23T12:00:00Z", "--json"], { encoding: "utf8" }));
  assert.equal(out.week, planWeeklyPost({ config: { weekday: 2, hour: 0, minute: 30 }, state: null, now: Date.parse("2026-11-23T12:00:00Z") }).week);
  const text = execFileSync(process.execPath, [tool, "--now", "2026-11-19T23:30:00Z"], { encoding: "utf8" });
  assert.match(text, /Nothing is posted\./);
  assert.match(text, /----- post -----\n\*\*This week on the board\*\*\n/);
  assert.throws(() => execFileSync(process.execPath, [tool, "--config", '{"weekday":5,"hour":23,"lead_hours":6}'], { encoding: "utf8", stdio: "pipe" }), /lead_hours/);
});

test("F4: for the same documents and play time, the dry-run's text is the run's text", async () => {
  const w = world();
  await runWeeklyPost(w.env, { now: DUE, fetchImpl: w.fetchImpl });
  const plan = planWeeklyPost({ config: { weekday: 5, hour: 23 }, state: null, now: DUE });
  assert.equal(w.calls[0].body.content, composeWeeklyPost({ ...docs(), playAt: plan.playAt }).text);
});

test("R2, R3: non-members are told apart by their exact name; combining marks are part of a name", () => {
  const { text } = composeWeeklyPost(docs({ party: { members: [{ name: "कमल", class_key: "mage", role: "damage" }] }, signups: { entries: [{ name: "Al", rsvp: "in" }, { name: "A.L.", rsvp: "maybe" }, { name: "कमला", rsvp: "in" }] } }));
  assert.match(text, /Signed up \(3\): Al, A\.L\. \(tentative\) and कमला\./);
  assert.doesNotMatch(text, /One fact per build/, "the near-match is not given the member's build");
});

test("R4, R5: a shortened name list keeps its markers; one oversized tip does not cost the others theirs", () => {
  const members = [{ name: "Red Fox", class_key: "paladin", role: "tank", board_line: "x".repeat(1900) }, { name: "Blue Owl", class_key: "mage", role: "damage", board_line: "Gnome Frost Mage" }];
  const one = composeWeeklyPost(docs({ party: { members }, signups: { entries: [{ name: "Red Fox", rsvp: "in" }, { name: "Blue Owl", rsvp: "in" }] } }));
  assert.match(one.text, /- Blue Owl \(Gnome Frost Mage\)/);
  assert.match(one.text, /\(and 1 more\)/);
  assert.equal(one.facts.length, 1);
  const entries = []; for (let i = 0; i < 120; i++) entries.push({ name: `Person number ${i} long name`, rsvp: i < 2 ? "maybe" : "in" });
  const many = composeWeeklyPost(docs({ party: { members: [] }, signups: { entries } }));
  assert.ok(many.text.length <= POST_MAX);
  assert.match(many.text, /Person number 0 [a-z ]+ \(tentative\)/, "the tentative marker survives the shortening (names are cut to 24 characters)");
});

test("a record or a report about other players is never the tip", async () => {
  const { TRIVIA_RE } = await import("../../infrastructure/worker/weekly-post.js");
  assert.ok(TRIVIA_RE.test("fastest reported level 30 was a fictional class at 21 hours"));
  assert.ok(TRIVIA_RE.test("beta played: a fictional record"));
  assert.ok(!TRIVIA_RE.test("level 10, 20 minute cooldown"));
  const classes = { pages: [{ id: "classes/mage", facts: [
    fact("mage.beta_played", "fastest reported level 30 was a mage at a fictional 21 hours, spec unstated", "good", [ref(1)]),
    fact("mage.frost_blast", "new trainer spell at 24, a fictional slow on the target for a short while", "good", [ref(2)]),
  ] }] };
  for (let w = 0; w < 8; w++) assert.equal(pickTip(classes, { class_key: "mage", role: "damage" }, w).key, "mage.frost_blast");
});
