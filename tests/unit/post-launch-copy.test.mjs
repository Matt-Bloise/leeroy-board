// Post-launch copy (PR claude/post-launch-copy-js): the board's launch wording flips at the launch epoch and does not change before it.
// Runs the real functions from js/board.js (extracted as source, as data-contract.test.mjs does) with a faked clock on each side of launch, and reads the other files' guards as source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync("js/board.js", "utf8").replace(/\r\n/g, "\n");
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, `function ${name} not found`);
  const eol = src.indexOf("\n", i), first = src.slice(i, eol);
  if (first.trimEnd().endsWith("{")) return src.slice(i, src.indexOf("\n}\n", i) + 2);
  return first;
};
const TL = JSON.parse(fs.readFileSync("data/timeline.json", "utf8"));
const LAUNCH = TL.events.find((e) => e.key === "launch").epoch;
const NAMES = TL.events.find((e) => e.key === "names_open");
const DAY = 86400;

function load(nowS, events = TL.events) {
  const ctx = {
    D: { timeline: { events } }, Date: class extends Date { static now() { return nowS * 1000; } }, Intl, Object, Number, String, Math, JSON, Array,
    MON: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    fmtDay: (s) => `DAY(${s})`,
    dtf: (l, o) => new Intl.DateTimeFormat(l, o),
    viewerZone: () => "America/New_York", ET_ZONE: "America/New_York",
  };
  const code = ["rtfEn = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })"].join("");
  vm.runInNewContext(`var ${code};\n${["relWhen", "fmtWhen", "withWhen", "launchEvent", "launchPast", "launchSay", "namesLine", "cardDates"].map(grab).join("\n")}\nthis.o={relWhen,fmtWhen,launchEvent,launchPast,launchSay,namesLine};`, ctx);
  return ctx.o;
}

test("launchSay: before launch the wording is the old future tense", () => {
  const o = load(LAUNCH - 5 * DAY), l = o.launchEvent();
  assert.equal(o.launchPast(), false);
  assert.equal(o.launchSay(l, LAUNCH - 5 * DAY), `Launch is in 5 days, ${o.fmtWhen(LAUNCH)}.`);
});
test("launchSay: after launch it is past tense, never 'Launch is N days ago', and the date comes from the data", () => {
  const now = LAUNCH + 5 * DAY, o = load(now), l = o.launchEvent();
  assert.equal(o.launchPast(), true);
  const t = o.launchSay(l, now);
  assert.equal(t, `Launched ${o.fmtWhen(LAUNCH, { time: false })}, 5 days ago.`);
  assert.doesNotMatch(t, /Launch is/);
  const other = LAUNCH + 40 * DAY, o2 = load(other + 2 * DAY, [{ key: "launch", epoch: other }]);
  assert.match(o2.launchSay(o2.launchEvent(), other + 2 * DAY), /^Launched \w{3}, \w{3} \d+, 2 days ago\.$/);
});
test("launchSay: the flip is exactly at the launch epoch", () => {
  assert.match(load(LAUNCH - 1).launchSay(load(LAUNCH - 1).launchEvent(), LAUNCH - 1), /^Launch is /);
  assert.match(load(LAUNCH).launchSay(load(LAUNCH).launchEvent(), LAUNCH), /^Launched /);
});
test("namesLine: open window reads from the event data, closed window gives no line", () => {
  const open = load(NAMES.epoch + DAY), mid = open.namesLine(NAMES, NAMES, NAMES.epoch + DAY);
  assert.match(mid, /^Names: open now for pack holders, until the end of Nov 3 Pacific/);
  const moved = { ...NAMES, until: "Dec 9", until_epoch: NAMES.until_epoch + 36 * DAY };
  assert.match(open.namesLine(moved, moved, NAMES.epoch + DAY), /until Dec 9 \(Pacific\)|Dec 9/);
  const fromTonight = { key: "names_open", until_epoch: NAMES.until_epoch, open_when: "Open now, until the end of Nov 3, Pacific time" };
  assert.equal(open.namesLine(fromTonight, null, NAMES.epoch + DAY), "Names: open now, until the end of Nov 3, Pacific time.");
  assert.equal(open.namesLine(NAMES, NAMES, NAMES.until_epoch), "");
  assert.equal(open.namesLine(NAMES, NAMES, LAUNCH + DAY), "");
  assert.equal(open.namesLine(null, null, 0), "");
});
test("guards: every retired pre-launch surface checks launchPast, and the sheet field and API stay", () => {
  const rd = (f) => fs.readFileSync(f, "utf8");
  assert.match(grab("renderBefore").replace(/\n/g, " "), /if \(launchPast\(\)\) \{ box\.replaceChildren\(\); box\.hidden = true; return; \}/);
  const v15 = rd("js/v15.js"); assert.match(v15, /if \(L\.phase === "live" \|\| K\.launchPast\(\)\) \{ det\.hidden = true; return; \}/);
  const v13 = rd("js/v13d.js");
  assert.match(v13, /go: K\.launchPast\(\) \? null : \["Add launch to my calendar"/);
  assert.match(v13, /if \(e && e\.key === "launch" && K\.launchPast\(\)\) \{ const old = st\.querySelector\("\.ics"\); if \(old\) old\.remove\(\); continue; \}/);
  assert.match(v13, /earned \$\{K\.launchPast\(\) \? "so far" : "before launch"\}/);
  assert.match(rd("scenes/guided-atlas.js"), /K\.launchPast\(\) \? "Your map\. Your route through the world\." : "Your map\. Your route to launch night\."/);
  const sh = rd("scenes/sheet.js");
  assert.match(sh, /f === "launch_state" && !F\[f\]\.text && K\.launchPast\(\)/);
  assert.match(sh, /launch_state: "Launch night"/); assert.match(sh, /"launch_state", "plan_zone"/);
});

test("calendar button: an existing launch .ics node is removed once the clock crosses launch; before launch it stays", () => {
  const v13 = fs.readFileSync("js/v13d.js", "utf8"), i = v13.indexOf('if (e && e.key === "launch" && K.launchPast())');
  assert.ok(i >= 0, "removal branch present");
  const branch = v13.slice(i, v13.indexOf("continue; }", i) + "continue; }".length);
  for (const [nowS, removedExpected] of [[LAUNCH - DAY, false], [LAUNCH + 1, true]]) {
    const o = load(nowS); let removed = false, reachedRest = false;
    const st = { querySelector: () => ({ remove: () => { removed = true; } }) };
    const mark = { set() { reachedRest = true; } };
    vm.runInNewContext(`for (const _ of [1]) { ${branch}\n mark.set(); }`, { e: { key: "launch" }, st, K: { launchPast: o.launchPast }, mark });
    assert.equal(removed, removedExpected); assert.equal(reachedRest, !removedExpected);
  }
});
