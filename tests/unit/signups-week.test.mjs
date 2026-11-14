// js/signups-week.js: only sign-ups stamped in the last 7 days count as this week's. After launch night the board kept showing those answers
// (and the server's tallies over every entry) as if they were for the next play night. Runs the real file in a vm. Fictional names only.
// Run: node --test tests/unit/signups-week.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const win = {};
vm.runInNewContext(read("js/signups-week.js"), { window: win, Intl, Date, Math, Number, Array, Object });
const W = win.BoardWeek;
const plain = (x) => JSON.parse(JSON.stringify(x)); // values made inside the vm have its own Array and Object

const NOW = Date.parse("2026-11-14T18:00:00.000Z"), DAY = 24 * 3600 * 1000;
const LAUNCH = Date.parse("2026-11-04T23:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const entry = (name, rsvp, updated, more = {}) => ({ name, rsvp, updated, when: "8pm", pack: null, meet: null, ...more });

test("a stamp from the last 7 days is current", () => {
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW - 2 * DAY)), NOW), true);
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW - 7 * DAY + 60e3)), NOW), true, "just inside the window");
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW)), NOW), true, "right now");
  assert.equal(W.isCurrent(entry("Ada", "in", "2026-11-13T09:15+01:00"), NOW), true, "an offset and no seconds is still a full ISO time");
});

test("a stamp older than 7 days is stale", () => {
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW - 7 * DAY)), NOW), false, "exactly 7 days is out");
  assert.equal(W.isCurrent(entry("Ada", "in", "2026-10-29T02:42:02.549Z"), NOW), false, "a launch-night answer");
});

test("a stamp in the future is not current (one minute of clock skew is allowed)", () => {
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW + 30e3)), NOW), true, "30 s ahead: skew");
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW + 5 * 60e3)), NOW), false, "5 minutes ahead");
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW + 3 * DAY)), NOW), false);
});

test("a malformed or missing stamp is never current", () => {
  for (const bad of [undefined, null, "", "2026-11-13", "2026-11-13 10:00:00Z", "yesterday", "2026-11-13T10:00:00", "2026-13-45T99:99:99Z", 1763000000000, {}]) {
    assert.equal(W.isCurrent(entry("Ada", "in", bad), NOW), false, `stamp ${JSON.stringify(bad)}`);
  }
  assert.equal(W.isCurrent({ name: "Ada", rsvp: "in" }, NOW), false, "no updated field");
  assert.equal(W.isCurrent(null, NOW), false, "no entry");
  assert.equal(W.isCurrent(entry("Ada", "in", iso(NOW)), NaN), false, "no clock");
});

test("only current entries are counted; the server's tallies over every entry are not used", () => {
  const S = {
    updated: iso(NOW - 3600e3), // the document moved an hour ago; that alone makes nothing current
    options: { when: ["6pm", "8pm", "later"] },
    entries: [
      entry("Ada", "in", iso(NOW - 1 * DAY), { when: "6pm" }),
      entry("Bram", "late", iso(NOW - 2 * DAY), { when: "later" }),
      entry("Cleo", "in", "2026-10-29T02:42:02.549Z"),
      entry("Dov", "maybe", "not a date"),
      entry("Esk", "out", iso(NOW + 2 * DAY)),
    ],
    tallies: { rsvp: { in: { count: 2, names: ["Ada", "Cleo"] } } },
  };
  const w = W.week(S, NOW, LAUNCH);
  assert.deepEqual(plain(w.current.map((e) => e.name)), ["Ada", "Bram"]);
  assert.deepEqual(plain(w.earlier.map((e) => e.name)), ["Cleo", "Dov", "Esk"], "older entries are listed as from an earlier week");
  assert.equal(w.total, 2);
  assert.deepEqual(plain(Object.fromEntries(Object.entries(w.rsvp).map(([k, v]) => [k, v.count]))), { in: 1, maybe: 0, late: 1, out: 0 });
  assert.deepEqual(plain(w.rsvp.in.names), ["Ada"]);
  assert.deepEqual(plain(Object.fromEntries(Object.entries(w.when).map(([k, v]) => [k, v.count]))), { "6pm": 1, "8pm": 0, later: 1 });
  assert.equal(w.empty, null, "someone answered this week");
  assert.equal(w.last, NOW - 1 * DAY, "a future stamp is not the last answer");
});

test("the launch-night document (3 in, all from Oct 27 to Oct 29) reads as nobody answered this week", () => {
  const S = {
    generated: "2026-11-01T22:54:51.764Z", updated: "2026-10-29T02:42:02.549Z", options: { when: ["6pm", "8pm", "later"] },
    entries: [entry("Ada", "in", "2026-10-29T02:42:02.549Z"), entry("Bram", "in", "2026-10-27T00:45:52.346Z", { when: "6pm" }), entry("Cleo", "in", "2026-10-27T00:40:36.565Z")],
    tallies: { rsvp: { in: { count: 3, names: ["Ada", "Bram", "Cleo"] } } },
  };
  const w = W.week(S, NOW, LAUNCH);
  assert.equal(w.total, 0);
  assert.equal(w.rsvp.in.count, 0, "not 3");
  assert.equal(w.earlier.length, 3);
  assert.ok(w.empty);
  assert.equal(w.empty.nobody, "Nobody has answered for this week yet.");
  assert.equal(w.empty.last, "Last answers: Oct 28, for launch night.", "02:42Z on Oct 29 is the evening of Oct 28 in Eastern time");
  assert.match(w.empty.how, /Sign-ups card in Discord/);
  assert.match(w.empty.how, /\/signup/);
});

test("the empty-week message names the last answers, and says launch night only when they came before it", () => {
  assert.equal(W.emptyWeek(Date.parse("2026-11-06T20:00:00Z"), LAUNCH).last, "Last answers: Nov 6.");
  assert.equal(W.emptyWeek(Date.parse("2026-11-05T02:00:00Z"), LAUNCH).last, "Last answers: Nov 4, for launch night.", "during launch night");
  assert.equal(W.emptyWeek(Date.parse("2026-10-20T20:00:00Z"), NaN).last, "Last answers: Oct 20.", "no launch date known");
  assert.equal(W.emptyWeek(null, LAUNCH).last, "Nobody has answered the card yet.");
  assert.equal(W.emptyWeek(null, LAUNCH).nobody, "Nobody has answered for this week yet.");
});

test("a current click on pack alone is not an answer for the week", () => {
  const w = W.week({ entries: [entry("Ada", null, iso(NOW - DAY), { pack: "yes", when: null }), entry("Bram", "in", "2026-10-27T00:40:36.565Z")] }, NOW, LAUNCH);
  assert.equal(w.total, 0);
  assert.ok(w.empty);
  assert.deepEqual(plain(w.earlier.map((e) => e.name)), ["Bram"]);
});

test("no entries, odd entries and no options do not throw", () => {
  for (const S of [null, {}, { entries: null }, { entries: [null, 3, "x", { name: "Ada" }] }]) {
    const w = W.week(S, NOW, LAUNCH);
    assert.equal(w.total, 0); assert.ok(w.empty); assert.deepEqual(plain(Object.keys(w.when)), ["6pm", "8pm", "later"]);
  }
});

test("the board reads the week from this file, and loads it before js/board.js", () => {
  const html = read("index.html"), a = html.indexOf("js/signups-week.js?v="), b = html.indexOf("js/board.js?v=");
  assert.ok(a > 0 && a < b, "signups-week.js loads before board.js");
  const board = read("js/board.js");
  assert.match(board, /window\.BoardWeek/);
  for (const fn of ["renderTiles", "renderSeats", "renderDiscordSignups", "renderTonight"]) {
    const at = board.indexOf(`function ${fn}(`), end = board.slice(at + 10).search(/\n(?:async function|function|const|let) /);
    const body = board.slice(at, at + 10 + end);
    assert.match(body, /\bwk\(\)|weekMine\(/, `${fn} uses this week's answers`);
    assert.doesNotMatch(body, /S\.tallies\.rsvp|T = S\.tallies;|\(S\.entries \|\| \[\]\)\.find|S\.entries \? S\.entries/, `${fn} does not count every entry`);
  }
  assert.match(read("js/v13d.js"), /K\.week\(\)/);
  assert.match(read("js/next.js"), /K\.week \? K\.week\(\)/);
});

test("adversarial stamps: no time zone, date only, future, non-string, missing", () => {
  const cases = { "no zone": "2026-11-13T10:00:00", "no zone, ms": "2026-11-13T10:00:00.000", "date only": "2026-11-13", future: iso(NOW + DAY), number: NOW - DAY, boolean: true, array: [iso(NOW)], missing: undefined };
  for (const [what, stamp] of Object.entries(cases)) {
    const e = entry("Ada", "in", stamp); if (stamp === undefined) delete e.updated;
    assert.equal(W.isCurrent(e, NOW), false, what);
    assert.equal(W.week({ entries: [e] }, NOW, LAUNCH).total, 0, `${what}: not counted`);
  }
});

test("bad rows: null, non-object rows and a document with no entries never throw or count", () => {
  const w = W.week({ entries: [null, undefined, 7, "Ada", [], true, entry("Bram", "in", iso(NOW - DAY))] }, NOW, LAUNCH);
  assert.equal(w.total, 1);
  assert.deepEqual(plain(w.current.map((e) => e.name)), ["Bram"]);
  assert.ok(W.week({ options: { when: ["8pm"] } }, NOW, LAUNCH).empty, "no entries field at all");
  assert.ok(W.week({ entries: "not a list" }, NOW, LAUNCH).empty);
});

test("an Out answer is an answer but never a sign-up, and never counted as in", () => {
  const w = W.week({ entries: [entry("Ada", "out", iso(NOW - DAY)), entry("Bram", "in", iso(NOW - DAY))] }, NOW, LAUNCH);
  assert.equal(w.rsvp.in.count, 1);
  assert.equal(w.rsvp.out.count, 1);
  assert.equal(w.signed, 1, "Out is not signed up");
  const only = W.week({ entries: [entry("Ada", "out", iso(NOW - DAY))] }, NOW, LAUNCH);
  assert.equal(only.signed, 0);
  assert.equal(only.rsvp.in.count, 0);
  assert.equal(only.empty, null, "someone did answer this week (Out), so the board does not say nobody answered");
});

test("recomputed RSVP and time-slot counts match the current rows exactly, for many random documents", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const RS = ["in", "maybe", "late", "out", null, "yes", "constructor", "__proto__"], WS = ["6pm", "8pm", "later", null, "noon", "toString"];
  for (let run = 0; run < 300; run++) {
    const entries = Array.from({ length: Math.floor(rnd() * 8) }, (_, i) => entry(`P${i}`, RS[Math.floor(rnd() * RS.length)], rnd() < 0.15 ? "bad" : iso(NOW - Math.floor(rnd() * 14 * DAY) + 2 * 60e3), { when: WS[Math.floor(rnd() * WS.length)] }));
    const w = W.week({ entries, options: { when: ["6pm", "8pm", "later"] } }, NOW, LAUNCH);
    const cur = entries.filter((e) => W.isCurrent(e, NOW));
    for (const k of ["in", "maybe", "late", "out"]) {
      const want = cur.filter((e) => e.rsvp === k).map((e) => e.name);
      assert.equal(w.rsvp[k].count, want.length, `run ${run} rsvp ${k}`); assert.deepEqual(plain(w.rsvp[k].names), want);
    }
    for (const k of ["6pm", "8pm", "later"]) assert.equal(w.when[k].count, cur.filter((e) => e.when === k).length, `run ${run} when ${k}`);
    assert.deepEqual(plain(Object.keys(w.rsvp)), ["in", "maybe", "late", "out"], "no stray keys such as constructor");
    assert.equal(w.total, cur.filter((e) => ["in", "maybe", "late", "out"].includes(e.rsvp)).length);
    for (const e of w.earlier) assert.ok(!W.isCurrent(e, NOW), "an earlier entry is never current");
  }
});

test("pack and meeting-point tallies are left as the server sent them; the document is not changed", () => {
  const S = { entries: [entry("Ada", "in", "2026-10-29T02:42:02.549Z", { pack: "yes", meet: "Valley of Strength" })], options: { when: ["6pm", "8pm", "later"] },
    tallies: { pack: { yes: { count: 1, names: ["Ada"] }, no: { count: 0, names: [] } }, meet: { "Valley of Strength": { count: 1, names: ["Ada"] } }, rsvp: { in: { count: 1, names: ["Ada"] } } } };
  const before = JSON.stringify(S);
  const w = W.week(S, NOW, LAUNCH);
  assert.equal(JSON.stringify(S), before, "week() does not mutate the document or its tallies");
  assert.equal(w.pack, undefined, "week() has no pack tally of its own");
  assert.equal(w.rsvp.in.count, 0);
});

test("a person with an old entry and a new one shows once, as this week's", () => {
  const w = W.week({ entries: [entry("Ada", "in", "2026-10-29T02:42:02.549Z"), entry("ada ", "late", iso(NOW - DAY))] }, NOW, LAUNCH);
  assert.equal(w.total, 1);
  assert.equal(w.earlier.length, 0);
});

test("an older document never replaces a newer one; unknown stamps are not compared", () => {
  const a = { updated: "2026-11-13T10:00:00.000Z" }, b = { updated: "2026-11-12T10:00:00.000Z" };
  assert.equal(W.older(b, a), true);
  assert.equal(W.older(a, b), false);
  assert.equal(W.older(a, a), false, "same stamp: take it");
  assert.equal(W.older(b, null), false, "nothing shown yet");
  assert.equal(W.older({ updated: "junk" }, a), false);
  assert.equal(W.older(b, { updated: 5 }), false);
  const board = read("js/board.js");
  assert.match(board, /signupsOk\(su\) && !\(window\.BoardWeek && BoardWeek\.older\(su, D\.signups\)\)/, "reloadOpt keeps the newer document");
  assert.match(board, /ev\.key === "signups" && window\.BoardWeek && !BoardWeek\.accept\(val, D\.signups\)\) return;/, "the live data handler keeps the newer document");
  assert.equal(W.accept(b, a), false, "accept() refuses the older one");
  assert.equal(W.accept(null, a), false);
  assert.equal(W.accept(b, null), true, "the first document is taken");
});

test("names and words are rendered as plain text through h(), never as markup", () => {
  const board = read("js/board.js");
  const lines = board.split("\n").filter((l) => /^const (emptyWeekEls|earlierLine|weekMine) =/.test(l));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.doesNotMatch(l, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(lines.find((l) => l.startsWith("const earlierLine")), /h\("p", \{ class: `\$\{cls\} su-earlier`, text: /, "the earlier-week names go in as textContent");
  const w = W.week({ entries: [entry("<b>@everyone</b>", "in", "2026-10-29T02:42:02.549Z")] }, NOW, LAUNCH);
  assert.equal(w.earlier[0].name, "<b>@everyone</b>", "the helper passes the name through untouched; the board's text: escapes it");
  assert.doesNotMatch(JSON.stringify(plain(w.empty)), /[<>@]/, "the empty-week words carry no markup or mention");
});

test("rule edges, none counted: exactly 7 days ago, 61 s in the future, a date-only stamp, no stamp", () => {
  const edges = [entry("Ada", "in", iso(NOW - 7 * DAY)), entry("Bram", "in", iso(NOW + 61e3)), entry("Cleo", "in", "2026-11-14"), { name: "Dov", rsvp: "in", when: "8pm" }];
  for (const e of edges) assert.equal(W.isCurrent(e, NOW), false, e.name);
  const w = W.week({ entries: edges }, NOW, LAUNCH);
  assert.equal(w.total, 0); assert.equal(w.rsvp.in.count, 0); assert.ok(w.empty);
  assert.equal(W.isCurrent(entry("Eve", "in", iso(NOW + 60e3)), NOW), true, "60 s ahead is the last moment of allowed skew");
});

test("robustness: null entries and entries without rsvp do not throw; a pack-only click is not an answer", () => {
  const S = { entries: [null, { name: "Ada", updated: iso(NOW - DAY) }, { name: "Bram", pack: "yes", updated: iso(NOW - DAY) }, { rsvp: "in", updated: iso(NOW - DAY) }] };
  const w = W.week(S, NOW, LAUNCH);
  assert.equal(w.total, 1, "only the row with an rsvp answers (a nameless one is still an answer)");
  assert.equal(w.rsvp.in.names[0], "Someone");
  const pack = W.week({ entries: [{ name: "Bram", pack: "yes", rsvp: null, updated: iso(NOW - DAY) }] }, NOW, LAUNCH);
  assert.equal(pack.total, 0); assert.ok(pack.empty, "a pack-only click leaves the week empty");
});

test("the empty-week text carries no name", () => {
  const names = ["Ada Quill", "Bram Ostler", "Cleo Fenwick"];
  const w = W.week({ entries: names.map((n, i) => entry(n, "in", iso(Date.parse("2026-10-27T00:00:00Z") + i * 3600e3))) }, NOW, LAUNCH);
  const text = JSON.stringify(plain(w.empty));
  for (const n of names) for (const part of n.split(" ")) assert.ok(!text.includes(part), `${part} is not in the empty-week words`);
});

// The board's data paths, played through the real accept() in the order the board sees them. Each path in js/board.js and js/v13d.js asks
// accept() before it writes D.signups and renders (pinned by source below), so a path that accept() refuses renders nothing.
function boardModel() {
  const m = { doc: null, renders: 0 };
  m.take = (next) => { if (!W.accept(next, m.doc)) return false; m.doc = next; m.renders++; return true; };
  m.tally = () => (m.doc ? W.week(m.doc, NOW, LAUNCH).rsvp.in.count : null);
  return m;
}
const docAt = (updated, entries) => ({ updated, entries, tallies: { rsvp: {} } });

test("rollback: a late socket document older than the one in hand does not change this week's tallies", () => {
  const m = boardModel();
  const newer = docAt(iso(NOW - 3600e3), [entry("Ada", "in", iso(NOW - 3600e3)), entry("Bram", "in", iso(NOW - 2 * DAY))]);
  const older = docAt(iso(NOW - 2 * DAY), [entry("Bram", "in", iso(NOW - 2 * DAY))]);
  m.take(newer); assert.equal(m.tally(), 2);
  assert.equal(m.take(older), false); assert.equal(m.tally(), 2, "still 2"); assert.equal(m.doc, newer);
});

test("rollback: a slow bootstrap that arrives after /state does not roll the tallies back", () => {
  const m = boardModel();
  const state = docAt(iso(NOW - 600e3), [entry("Ada", "in", iso(NOW - 600e3)), entry("Bram", "late", iso(NOW - DAY))]);
  const bootstrap = docAt(iso(NOW - DAY), [entry("Bram", "late", iso(NOW - DAY))]); // cached: the edge copy from before the last click
  m.take(state); m.take(bootstrap);
  assert.equal(m.doc, state); assert.equal(m.tally(), 1);
  const board = read("js/board.js");
  assert.match(board, /if \(!\(signupsOk\(D\.signups\) && window\.BoardWeek && BoardWeek\.older\(su, D\.signups\)\)\) D\.signups = su;/, "the boot load keeps a newer document /state already brought");
});

test("double render: the socket's sign-ups document is rendered once, not twice", () => {
  const m = boardModel(), doc = docAt(iso(NOW - 600e3), [entry("Ada", "in", iso(NOW - 600e3))]);
  m.take(doc); // the socket's state message (js/v13d.js mirrorIn)
  m.take(JSON.parse(JSON.stringify(doc))); // the same document as a data message (js/board.js data listener)
  assert.equal(m.renders, 1);
  m.take(docAt(iso(NOW - 60e3), [entry("Ada", "out", iso(NOW - 60e3))])); // a real change renders
  assert.equal(m.renders, 2);
  m.take(docAt(iso(NOW - 60e3), [entry("Ada", "in", iso(NOW - 60e3))])); // same stamp, different answer: taken
  assert.equal(m.renders, 3);
  const board = read("js/board.js"), v13d = read("js/v13d.js");
  const listener = board.slice(board.indexOf('window.BoardBrain.on("data"'), board.indexOf("window.__boardKit = KIT;"));
  const guard = listener.indexOf('ev.key === "signups" && window.BoardWeek && !BoardWeek.accept(val, D.signups)) return;'), write = listener.indexOf("D[ev.key] = val;");
  assert.ok(guard > 0 && guard < write, "the data listener asks accept() before it writes and renders");
  const mirror = v13d.slice(v13d.indexOf("function mirrorIn("), v13d.indexOf("function startBrain("));
  assert.ok(mirror.indexOf("!BoardWeek.accept(sig, D.signups)) return;") > 0 && mirror.indexOf("!BoardWeek.accept(sig, D.signups)) return;") < mirror.indexOf("D.signups = {"), "mirrorIn asks accept() before it writes and renders");
});

test("before launch the board takes every entry and the server's tallies, as it did before this change", () => {
  const board = read("js/board.js"), body = board.slice(board.indexOf("function wk() {"), board.indexOf("const weekMine"));
  assert.match(body, /if \(W && launchPast\(\)\) return W\.week\(/, "the 7-day rule applies only once launch is past");
  assert.match(body, /current: all, earlier: \[\], rsvp: T\.rsvp \|\| \{\}, when: T\.when,/, "otherwise: all entries, the server's tallies");
});

// Shared vector with the weekly post (infrastructure/worker/weekly-post.js entryIsCurrent, PR 313). With no play time the two rules are the same
// (same ISO pattern, now - 7 days exclusive, now + 60 s). They differ by design when the post knows the play time: its window starts at last week's
// play night plus 6 hours (playAt - 7 days + 6 h), so it drops a click from early in the week before last week's night ended, and keeps one the
// board drops only if playAt is in the future. The board has no public play-night schedule, so it keeps the rolling 7 days.
const PLAY = Date.parse("2026-11-20T23:00:00Z"); // Fri Nov 20, 6 PM ET
const VECTOR = [
  // [stamp, at NOW (board and post without playAt), post with playAt = PLAY]
  [iso(NOW - 3 * 3600e3), true, true],
  [iso(NOW - 1 * DAY), true, false], // Nov 13: before last week's night ended (Nov 13 23:00 + 6 h): the post drops it, the board keeps it
  [iso(NOW - 6 * DAY), true, false],
  [iso(PLAY - 7 * DAY + 3 * 3600e3), true, false], // during last week's play night: the post counts it for that night
  [iso(PLAY - 7 * DAY + 7 * 3600e3), true, true], // after last week's night ended
  [iso(NOW - 7 * DAY), false, false],
  [iso(NOW - 7 * DAY + 1), true, false],
  [iso(NOW + 60e3), true, true],
  [iso(NOW + 61e3), false, false],
  ["2026-11-13", false, false], ["2026-11-13T10:00:00", false, false], ["2026-11-13T10:00:00+05:00", true, false], [null, false, false], [NOW, false, false],
];
test("shared vector: the board's rule on the entries and times shared with the weekly post", () => {
  for (const [stamp, board] of VECTOR) assert.equal(W.isCurrent({ name: "Ada", rsvp: "in", updated: stamp }, NOW), board, String(stamp));
});
const POST = process.env.WEEKLY_POST_JS || path.join(ROOT, "infrastructure/worker/weekly-post.js"); // WEEKLY_POST_JS: run against PR 313's file before it lands
test("shared vector: entryIsCurrent agrees with the board without a play time, and differs only as documented with one", { skip: !fs.existsSync(POST) && "weekly-post.js is not on this branch yet (PR 313)" }, async () => {
  const { entryIsCurrent } = await import(new URL(`file:///${POST.replace(/\\/g, "/")}`).href);
  for (const [stamp, board, withPlay] of VECTOR) {
    const e = { name: "Ada", rsvp: "in", updated: stamp };
    assert.equal(entryIsCurrent(e, { now: NOW }), board, `no play time: ${stamp}`);
    assert.equal(W.isCurrent(e, NOW), board);
    assert.equal(entryIsCurrent(e, { now: NOW, playAt: PLAY }), withPlay, `play time ${iso(PLAY)}: ${stamp}`);
  }
});
