import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tonightLines, LAUNCH_EPOCH, NEXT_DATED, nextDated } from "../../infrastructure/worker/tonight-copy.js";

const party = { members: [{ name: "Aa", race: "Orc", class: "Warrior" }] };
const signups = { entries: [{ name: "Aa", rsvp: "in" }] };
const base = { byName: "Aa", party, signups, boardUrl: "https://leeroy.party" };

test("dates match data/tonight.json", () => {
  const ev = JSON.parse(fs.readFileSync("data/tonight.json", "utf8")).events;
  assert.equal(ev.find((e) => e.key === "launch").epoch, LAUNCH_EPOCH);
  assert.equal(ev.find((e) => e.key === "raids").epoch, NEXT_DATED.epoch);
});
test("after launch: past tense, next dated event, no sign-up prompt", () => {
  const t = tonightLines({ ...base, now: LAUNCH_EPOCH + 3 * 86400 }).join("\n");
  assert.match(t, /Launch night was Wed Nov 4/);
  assert.match(t, /Raids open, Wed, Dec 9/);
  assert.match(t, /as they stood \(1 in\)/);
  assert.doesNotMatch(t, /\/signup|Say whether/);
});
test("after the last dated event: no 'days ago', says none posted yet", () => {
  const t = tonightLines({ ...base, now: NEXT_DATED.epoch + 5 * 86400 }).join("\n");
  assert.doesNotMatch(t, /Raids open, Wed, Dec 9/);
  assert.match(t, /Next dated event:\*\* none posted yet/);
  assert.equal(nextDated(NEXT_DATED.epoch - 1).label, "Raids open");
  assert.equal(nextDated(NEXT_DATED.epoch + 1), null);
});
test("before launch: keeps the sign-up prompt", () => {
  const t = tonightLines({ ...base, now: LAUNCH_EPOCH - 60, signups: { entries: [] } }).join("\n");
  assert.match(t, /Launch Night: Wed Nov 4/);
  assert.match(t, /Say whether you are \*\*in\*\*/);
});

// The Ledger move runs in the browser; run the real functions from js/board.js against the repo's own data.
import vm from "node:vm";
const src = fs.readFileSync("js/board.js", "utf8");
const grab = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); const eol = src.indexOf("\n", i); return src.slice(i, src.slice(i, eol).trimEnd().endsWith("{") ? src.indexOf("\n}", i) + 2 : eol); };
function boardFns(nowSec, timelineFile = "data/tonight.json") {
  const D = { party: JSON.parse(fs.readFileSync("data/party.json", "utf8")), timeline: JSON.parse(fs.readFileSync(timelineFile, "utf8")) };
  const ctx = { D, Date: { now: () => nowSec * 1000 }, fmtWhen: (epoch) => `WHEN(${epoch})` };
  vm.runInNewContext(["withWhen", "launchEvent", "launchPast", "nextDated", "settleLaunch"].map(grab).join("\n") + "\nthis.out={settleLaunch,nextDated,launchPast};", ctx);
  return { D, ...ctx.out };
}
test("Ledger: after launch, launch-night items leave Still open and land in Settled with the date", () => {
  const { D, settleLaunch, launchPast } = boardFns(LAUNCH_EPOCH + 86400 * 3);
  assert.ok(launchPast());
  assert.ok(D.party.open.some((o) => /^launch[- ]night/i.test(o.title)));
  assert.equal(settleLaunch(), true);
  assert.ok(!D.party.open.some((o) => /^launch[- ]night/i.test(o.title)));
  assert.ok(D.party.settled_extra.some((x) => /Launch night happened: Wed, Nov 4, 6 PM ET/.test(x.text)));
  assert.equal(settleLaunch(), false, "idempotent");
});
test("Ledger: before launch nothing moves; next dated event after launch is Raids open", () => {
  const b = boardFns(LAUNCH_EPOCH - 60);
  assert.equal(b.settleLaunch(), false);
  assert.equal(boardFns(LAUNCH_EPOCH + 60).nextDated().label, "Raids open");
});
test("Timeline events without a when text get one: 'Launch night was undefined' reached production on Nov 8", () => {
  const b = boardFns(LAUNCH_EPOCH + 86400, "data/timeline.json");
  assert.ok(b.launchPast());
  assert.match(String(b.nextDated().when), /^WHEN\(\d+\)$/);
  assert.equal(b.settleLaunch(), true);
  assert.ok(!JSON.stringify(b.D.party.settled_extra).includes("undefined"));
  assert.ok(b.D.party.settled_extra.some((x) => x.text.includes(`WHEN(${LAUNCH_EPOCH})`)));
});
