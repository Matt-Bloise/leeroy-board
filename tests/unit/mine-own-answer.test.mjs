// js/mine.js after launch: your own answer is this week's only. Runs the real file in a vm with a small stand-in for the board kit and the brain.
// 1) seeding: an entry older than 7 days presses nothing, and an earlier seed is cleared; 2) the "6 PM ET" label drops ", at launch" once launch has passed;
// 3) the seal shelf repaints on the brain's "me" event; 4) the tally name wraps instead of widening the row. Fictional names only.
// Run: node --test tests/unit/mine-own-answer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const NOW = Date.parse("2026-11-14T18:00:00.000Z"), DAY = 24 * 3600 * 1000, iso = (ms) => new Date(ms).toISOString();

const weekWin = {};
vm.runInNewContext(read("js/signups-week.js"), { window: weekWin, Intl, Date, Math, Number, Array, Object });
const W = weekWin.BoardWeek;

// A board where `past` says whether launch has happened and `entry` is what the brain's mine() returns. weekOwn is the board's own rule (js/board.js).
function board({ past, entry, local = {}, send, now = NOW }) {
  const labels = {}, pressed = [], click = {}, typed = [];
  const node = () => ({ append() {}, appendChild() {}, addEventListener() {}, parentNode: null });
  const act = node();
  const K = {
    $: (sel) => (sel === "#dsu-act" ? act : null),
    h: (tag, attrs, ...kids) => { if (attrs && attrs.class === "mine-place") { const n = { ...node(), value: "", addEventListener: (ev, fn) => { if (ev === "input") typed.push((v) => { n.value = v; fn(); }); } }; return n; } if (attrs && attrs["data-when"]) { labels[attrs["data-when"]] = kids[0]; click["when:" + attrs["data-when"]] = attrs.onclick; } return node(); },
    on() {}, launchPast: () => past,
    weekOwn: (e) => (!e || !past ? e : W.isCurrent(e, now) ? e : null),
  };
  const brain = { status: () => ({ base: "https://api.test", key: true }), mine: () => entry.v, mineLocal: () => local, setWhen: (k) => send(k), cleanPlace: (t) => String(t) };
  const documentElement = { classList: { contains: () => false } };
  const win = { __boardKit: K, BoardBrain: brain };
  vm.runInNewContext(read("js/mine.js"), { window: win, document: { documentElement, querySelectorAll: () => [] }, addEventListener() {}, setTimeout, clearTimeout, console, Array, String, Object, Promise, MutationObserver: undefined });
  return { mine: win.__mine, labels, pressed, entry, click, typed };
}
const row = (updated, more = {}) => ({ name: "Ada", slug: "ada", rsvp: "in", when: "8pm", pack: "yes", meet: "The Crossroads", updated, ...more });
const state = (b) => JSON.parse(JSON.stringify(b.mine.state()));

test("before launch a stored answer seeds the pressed slots as it always did", () => {
  const b = board({ past: false, entry: { v: row(iso(NOW - 8 * DAY)) } });
  b.mine.render();
  assert.equal(state(b).when, "8pm"); assert.equal(state(b).pack, "yes"); assert.equal(state(b).meet, "xroads");
});

test("after launch an answer 8 days old presses no time slot, but keeps pack, meeting point and place (launch-night questions)", () => {
  const b = board({ past: true, entry: { v: row(iso(NOW - 8 * DAY)) } });
  b.mine.render();
  const s = state(b); assert.equal(s.when, null); assert.equal(s.pack, "yes"); assert.equal(s.meet, "xroads"); assert.equal(s.place, "");
  const o = board({ past: true, entry: { v: row(iso(NOW - 8 * DAY), { meet: "By the old mill" }) } }); o.mine.render();
  assert.equal(state(o).meet, "other"); assert.equal(state(o).place, "By the old mill");
});

test("after launch an answer from this week still presses its slots", () => {
  const b = board({ past: true, entry: { v: row(iso(NOW - 2 * DAY), { meet: "By the old mill" }) } });
  b.mine.render();
  const s = state(b); assert.equal(s.when, "8pm"); assert.equal(s.pack, "yes"); assert.equal(s.meet, "other"); assert.equal(s.place, "By the old mill");
});

test("the time slot seeded from this week's answer is cleared when the entry turns out to be an earlier week's; pack and meeting point stay", () => {
  const entry = { v: row(iso(NOW - 2 * DAY)) };
  const b = board({ past: true, entry });
  b.mine.render(); assert.equal(state(b).when, "8pm");
  entry.v = row(iso(NOW - 9 * DAY)); // the same entry, a week on
  b.mine.render();
  assert.equal(state(b).when, null); assert.equal(state(b).pack, "yes"); assert.equal(state(b).meet, "xroads");
});

test("no entry at all leaves the slots as they are (a first answer being sent is not wiped)", () => {
  const entry = { v: row(iso(NOW - DAY)) };
  const b = board({ past: true, entry });
  b.mine.render(); entry.v = null; b.mine.render();
  assert.equal(state(b).when, "8pm");
});

test("an answer kept on this device still shows after launch", () => {
  const b = board({ past: true, entry: { v: row(iso(NOW - 8 * DAY)) }, local: { when: { value: "later" } } });
  b.mine.render();
  assert.equal(state(b).when, "later");
});

const later = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };

test("a re-render while a time-slot write is in flight keeps the slot pressed", async () => {
  const gate = later(), b = board({ past: true, entry: { v: row(iso(NOW - 8 * DAY)) }, send: () => gate.p });
  b.mine.render();
  const sent = b.click["when:6pm"](); assert.equal(state(b).when, "6pm");
  b.mine.render(); assert.equal(state(b).when, "6pm", "in flight");
  gate.res({ ok: true }); await sent;
  b.mine.render(); assert.equal(state(b).when, "6pm", "after ok, before the new document arrives");
  b.mine.render(); assert.equal(state(b).when, "6pm");
});

test("once the document shows the saved answer as this week's, the flag lets go and a later stale week resets the slot", async () => {
  const entry = { v: row(iso(NOW - 8 * DAY)) }, b = board({ past: true, entry, send: async () => ({ ok: true }) });
  b.mine.render(); await b.click["when:later"]();
  b.mine.render(); assert.equal(state(b).when, "later");
  entry.v = row(iso(NOW - DAY), { when: "later" }); b.mine.render(); assert.equal(state(b).when, "later");
  entry.v = row(iso(NOW - 9 * DAY)); b.mine.render(); assert.equal(state(b).when, null);
});

test("a failed write puts the slot back, and the stale reset then applies", async () => {
  const b = board({ past: true, entry: { v: row(iso(NOW - 8 * DAY)) }, send: async () => ({ ok: false, why: "busy" }) });
  b.mine.render(); await b.click["when:8pm"]();
  assert.equal(state(b).when, null); b.mine.render(); assert.equal(state(b).when, null);
});

test("a failed write does not count as answered: the restored old slot is still reset when its entry is an earlier week's", async () => {
  const entry = { v: row(iso(NOW - 2 * DAY)) }, b = board({ past: true, entry, send: async () => ({ ok: false, why: "busy" }) });
  b.mine.render(); assert.equal(state(b).when, "8pm");
  entry.v = row(iso(NOW - 9 * DAY)); // the week turns before the next render
  await b.click["when:later"]();
  assert.equal(state(b).when, "8pm", "put back");
  b.mine.render(); assert.equal(state(b).when, null);
});
test("a device clock more than a minute slow does not unpress a saved slot (the server stamp reads as the future)", async () => {
  const slow = NOW - 5 * 60 * 1000, entry = { v: row(iso(NOW - 8 * DAY)) }, b = board({ past: true, entry, now: slow, send: async () => ({ ok: true }) });
  b.mine.render(); await b.click["when:8pm"]();
  entry.v = row(iso(NOW), { when: "8pm" }); // the echoed document, stamped by the server clock
  assert.equal(W.isCurrent(entry.v, slow), false, "the slow clock rejects the stamp");
  b.mine.render(); assert.equal(state(b).when, "8pm"); b.mine.render(); assert.equal(state(b).when, "8pm");
});

test("typed but unsubmitted \"Somewhere else\" text survives a re-render on a stale entry", () => {
  const b = board({ past: true, entry: { v: row(iso(NOW - 8 * DAY), { meet: null }) } });
  b.mine.render();
  b.typed[b.typed.length - 1]("By the old mill");
  assert.equal(state(b).place, "By the old mill");
  b.mine.render(); b.mine.render();
  assert.equal(state(b).place, "By the old mill");
});
test("the 6 PM label says \"at launch\" only before launch", () => {
  const before = board({ past: false, entry: { v: null } }); before.mine.render();
  assert.equal(before.labels["6pm"], "6 PM ET, at launch");
  const after = board({ past: true, entry: { v: null } }); after.mine.render();
  assert.equal(after.labels["6pm"], "6 PM ET");
  assert.equal(after.labels["8pm"], "Around 8 PM ET"); assert.equal(after.labels.later, "Later than that");
});

test("the seal shelf repaints on the brain's me event, and the brain emits that event when /me answers", () => {
  const seals = read("js/seals.js");
  assert.match(seals, /K\.on\("signups", shelf\);/);
  assert.match(seals, /bb\.on\("me", shelf\)/);
  const brain = read("js/brain.js");
  assert.match(brain, /async function me\(\) \{[\s\S]*?emit\("me", B\.me\);/, "brain.js emits me after /me");
  assert.match(brain, /window\.BoardBrain = Object\.freeze\(\{ start, lockLayout, on,/, "the brain exports on()");
});

test("a long unbroken name wraps inside the tally row", () => {
  const css = read("css/v13d.css");
  const rule = /#dsu-body \.trow-who \.who \{([^}]*)\}/.exec(css);
  assert.ok(rule, "rule present");
  assert.match(rule[1], /overflow-wrap:\s*anywhere/); assert.match(rule[1], /min-width:\s*0/); assert.doesNotMatch(rule[1], /nowrap/);
  assert.match(rule[1], /max-width:\s*calc\(100% - 20px\)/, "leaves room for the name's own margin and the row's");
});
