// door/model.js: the reimagined first screen's pure rules (who this browser is, the next date, the sign-up count, the party's roles, the roads), checked
// against the board's own rules they copy, plus static checks on the door's sources: no animation loop, no interval timer, nothing written anywhere.
// Fictional names only. Run: node --test tests/unit/door-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as M from "../../door/model.js";
import { buildGraph, makePlan } from "../../atlas/routes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const win = {};
vm.runInNewContext(read("js/signups-week.js"), { window: win, Intl, Date, Math, Number, Array, Object });
const week = win.BoardWeek.week;

const LAUNCH_S = 1793833200; // 2026-11-04T23:00:00Z, 6 PM ET
const party = (over = {}) => ({ members: [
  { name: "Ada Vale", class_key: "druid", class: "Druid", race: "Tauren", role: "tank" },
  { name: "Bram Oak", class_key: "priest", class: "Priest", race: "Undead", role: "healer" },
  { name: "Cato Reed", class_key: "paladin", class: "Paladin", race: "Undead", role: "healer", role_detail: "damage until 40, healer from level 40" },
  { name: "Dree Ash", class_key: "mage", class: "Mage", race: "Undead", role: "damage" },
  { name: "Elm Fenn", class_key: "warlock", class: "Warlock", race: "Troll", role: "damage" },
], ...over });
const timeline = { events: [
  { key: "names_open", epoch: LAUNCH_S - 8 * 86400, until_epoch: LAUNCH_S - 15 * 3600, label: "Names open: people who bought a pack create characters" },
  { key: "launch", epoch: LAUNCH_S, label: "Launch", format: "F" },
  { key: "raids", epoch: LAUNCH_S + 35 * 86400, label: "Raids open", format: "D" },
] };
const tonight = { events: [{ key: "names_open", label: "Names open", open_when: "Open now, until the end of Nov 3, Pacific time" }, { key: "launch", label: "Launch" }] };

test("names match as the board matches them: marks at the ends and case do not count", () => {
  assert.equal(M.cleanName("=Ada Vale="), "Ada Vale");
  assert.equal(M.sameName("=ada vale=", "Ada Vale"), true);
  assert.equal(M.sameName("Ada", "Ada Vale"), false);
  assert.equal(M.slug("Ada Vale"), "ada-vale");
});

test("who this browser is: board-me (a slug) first, then board-as (a name); just-looking and strangers are nobody", () => {
  const get = (o) => (k) => (k in o ? o[k] : null);
  assert.equal(M.meFrom(get({ "board-me": "bram-oak" }), party()).name, "Bram Oak");
  assert.equal(M.meFrom(get({ "board-me": "just-looking", "board-as": "=Cato Reed=" }), party()).name, "Cato Reed");
  assert.equal(M.meFrom(get({ "board-as": "Someone Else" }), party()), null);
  assert.equal(M.meFrom(get({}), party()), null);
  assert.equal(M.meFrom(get({ "board-me": "ada-vale" }), null), null);
});

test("the next date: an open window wins, then the first event ahead, then nothing", () => {
  const during = (LAUNCH_S - 2 * 86400) * 1000;
  const open = M.nextEvent(timeline, during);
  assert.equal(open.key, "names_open"); assert.equal(open.isOpen, true);
  assert.equal(M.openWords(open, tonight), "Open now, until the end of Nov 3, Pacific time", "the board's own words for an open window");
  assert.equal(M.eventLabel(open, tonight), "Names open", "the tonight document's short label");
  const after = M.nextEvent(timeline, (LAUNCH_S - 10 * 3600) * 1000);
  assert.equal(after.key, "launch"); assert.equal(after.isOpen, false);
  assert.equal(M.nextEvent(timeline, (LAUNCH_S + 40 * 86400) * 1000), null);
  assert.equal(M.nextEvent({ events: [{ key: "x", epoch: "soon" }] }, 0), null, "a malformed epoch is ignored");
});

test("date words are coarse, in the viewer's zone, and never tick", () => {
  assert.equal(M.relWords(30), "starting now");
  assert.equal(M.relWords(45 * 60), "in 45 minutes");
  assert.equal(M.relWords(70 * 60), "in an hour");
  assert.equal(M.relWords(5 * 3600), "in 5 hours");
  assert.equal(M.relWords(30 * 3600), "in 30 hours");
  assert.equal(M.relWords(17 * 86400 + 3000), "in 17 days");
  assert.equal(M.relWords(NaN), "");
  const launch = M.whenWords({ ...timeline.events[1], isOpen: false }, (LAUNCH_S - 3 * 86400) * 1000, "America/New_York");
  assert.deepEqual(launch, { date: "Wed, Nov 4", time: "6 PM", rel: "in 3 days" });
  const raids = M.whenWords({ ...timeline.events[2], isOpen: false }, LAUNCH_S * 1000, "America/New_York");
  assert.equal(raids.time, "", "a date-only event has no time of day");
});

test("sign-ups before launch: the server's tallies, seats in party order, your own answer", () => {
  const S = { entries: [{ name: "=Bram Oak=", rsvp: "in", when: "8pm", updated: "2026-10-29T02:42:02.549Z" }, { name: "Elm Fenn", rsvp: "maybe", when: "6pm", updated: "2026-10-27T00:00:00.000Z" }],
    tallies: { rsvp: { in: { count: 1, names: ["=Bram Oak="] }, maybe: { count: 1, names: ["Elm Fenn"] }, late: { count: 0, names: [] }, out: { count: 0, names: [] } } } };
  const v = M.signupView(S, party(), timeline, (LAUNCH_S - 86400) * 1000, week);
  assert.equal(v.phase, "launch");
  assert.deepEqual(v.counts, { in: 1, maybe: 1, late: 0, out: 0, none: 3 });
  assert.deepEqual(v.seats.map((s) => s.state), [null, "in", null, null, "maybe"]);
  assert.deepEqual(v.mine(party().members[1]), { state: "in", when: "8 PM ET" });
  assert.deepEqual(v.mine(party().members[0]), { state: null, when: null });
  assert.equal(M.signupView(null, party(), timeline, 0, week), null);
});

test("sign-ups after launch: only this week's entries count (js/signups-week.js, the board's rule)", () => {
  const now = (LAUNCH_S + 10 * 86400) * 1000, iso = (ms) => new Date(ms).toISOString();
  const S = { options: { when: ["6pm", "8pm", "later"] }, entries: [
    { name: "Ada Vale", rsvp: "in", when: "8pm", updated: iso(now - 2 * 86400e3) },
    { name: "Bram Oak", rsvp: "in", when: "6pm", updated: iso(now - 9 * 86400e3) },
  ], tallies: { rsvp: { in: { count: 2, names: ["Ada Vale", "Bram Oak"] } } } };
  const v = M.signupView(S, party(), timeline, now, week);
  assert.equal(v.phase, "week");
  assert.equal(v.counts.in, 1, "last week's answer does not count");
  assert.equal(v.mine(party().members[1]).state, null);
  const empty = M.signupView({ ...S, entries: [S.entries[1]] }, party(), timeline, now, week);
  assert.equal(empty.counts.in, 0); assert.ok(empty.empty && /Nobody has answered for this week yet/.test(empty.empty.nobody));
});

test("the party: the board's role line, plurals, the later role, hidden fields and the five/party title", () => {
  const v = M.partyView(party());
  assert.equal(v.title, "The five");
  assert.equal(v.roleLine, "1 tank, 1 healer, 3 damage (a second healer from 40).", "the Five tile's exact words (js/board.js)");
  assert.equal(v.list[2].role, "damage to 40, then healer", "the board's roleWords");
  const six = M.partyView(party({ members: [...party().members, { name: "Fern Hale", role: "tank" }] }));
  assert.equal(six.title, "The party");
  assert.ok(six.roleLine.startsWith("2 tanks, 1 healer, 3 damage"));
  assert.equal(six.list[5].cls, "Class hidden");
  assert.equal(M.partyView({ members: [] }), null);
});

test("the roads from the real routes.json: one group per start, the people on each, and plain words", () => {
  const routes = JSON.parse(read("data/atlas/routes.json")), world = JSON.parse(read("data/atlas/world.json"));
  const graph = buildGraph(routes), plan = makePlan(graph), pos = new Map();
  for (const e of graph.edges.values()) { if (!pos.has(e.from)) pos.set(e.from, e.a_path[0]); if (!pos.has(e.to)) pos.set(e.to, e.a_path[e.a_path.length - 1]); }
  const groups = M.roadGroups(plan, graph, party(), (id) => M.zoneAt(world.zones, pos.get(id)));
  assert.ok(groups.length >= 1);
  for (const g of groups) {
    assert.ok(g.zone, `${g.from} is named by its zone`);
    assert.ok(g.people.every((n) => party().members.some((m) => m.name === n)), "only party names");
    const line = M.roadLine(g, "Orgrimmar");
    assert.match(line, /^[A-Z].* to Orgrimmar\.( About \d+ minutes on foot\.)?$/);
    assert.ok(!/zeppelin tower/i.test(line), "towers become the zeppelin, not stops");
  }
  // every class that starts somewhere is in exactly one group
  const classes = groups.flatMap((g) => g.classes);
  assert.equal(new Set(classes).size, classes.length);
  assert.equal(M.zoneAt([{ name: "Big", a_rect: [0, 0, 100, 100] }, { name: "Small", a_rect: [10, 10, 20, 20] }], [15, 15]), "Small", "the smallest zone that holds the point");
  assert.equal(M.zoneAt([], [1, 1]), "");
});

test("a link from the data is used only when it is a Discord address over https", () => {
  const fake = "https://discord.com/channels/10000/20000/30000"; // made-up numbers, not ids
  assert.equal(M.discordUrl(fake), fake);
  for (const bad of ["javascript:alert(1)", "http://discord.com/channels/12345/12345", "https://discord.com.example/channels/12345/12345", "https://example.com/channels/12345/12345", "https://discord.com/channels/12345/12345?x=1", null, 42])
    assert.equal(M.discordUrl(bad), null, String(bad));
});

test("the door's sources: no animation loop, no interval timer, nothing written to storage or the API", () => {
  const css = read("door/door.css");
  assert.ok(!/infinite/.test(css), "no infinite CSS animation");
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{[^}]*--t-open:\s*1ms/, "every duration collapses to 1 ms under reduced motion");
  for (const f of ["door.js", "model.js", "map.js", "room.js"]) {
    const js = read("door", f);
    assert.ok(!/setInterval\s*\(/.test(js), `${f}: no setInterval`);
    assert.ok(!/(localStorage|sessionStorage)\s*\.\s*(setItem|removeItem|clear)\s*\(/.test(js), `${f}: writes no storage`);
    assert.ok(!/method\s*:\s*["'](POST|PUT|PATCH|DELETE)/i.test(js), `${f}: no API write`);
  }
  // the WebGL room is imported only from the dialog module, behind the press of Step inside
  assert.ok(!/room\/room\.js/.test(read("door", "door.js")) && !/three\.module/.test(read("door", "index.html")));
  assert.match(read("door", "room.js"), /import\("\.\.\/room\/room\.js\?v=[0-9a-f]{10}"\)/);
  assert.match(read("door", "room.js"), /tier: "medium"/, "the 30 fps tier");
  assert.match(read("room", "room.js"), /medium:\s*\{[^}]*fps:\s*30\b/, "the board's medium tier is the 30 draws a second cap (a software GPU is too slow to show the cap, so it is pinned here)");
});
