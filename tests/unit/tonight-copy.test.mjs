import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const rp = (p) => fileURLToPath(new URL("../../" + p, import.meta.url)); // repo-root path, independent of cwd and of Windows separators
import { tonightLines, LAUNCH_EPOCH, NEXT_DATED, nextDated } from "../../infrastructure/worker/tonight-copy.js";

const party = { members: [{ name: "Aa", race: "Orc", class: "Warrior" }] };
const signups = { entries: [{ name: "Aa", rsvp: "in" }] };
const base = { byName: "Aa", party, signups, boardUrl: "https://leeroy.party" };

test("dates match data/tonight.json", () => {
  const ev = JSON.parse(fs.readFileSync(rp("data/tonight.json"), "utf8")).events;
  assert.equal(ev.find((e) => e.key === "launch").epoch, LAUNCH_EPOCH);
  assert.equal(ev.find((e) => e.key === "raids").epoch, NEXT_DATED.epoch);
});
test("after launch: past tense, next dated event, no sign-up prompt", () => {
  const t = tonightLines({ ...base, now: LAUNCH_EPOCH + 3 * 86400 }).join("\n");
  assert.match(t, /Launch night was Wed Nov 4/);
  assert.match(t, /Raids open, Wed, Dec 9/);
  assert.match(t, /as they stood \(1 in\)/);
  assert.doesNotMatch(t, /\/signup|not recorded yet/);
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
  assert.match(t, /RSVP is not recorded yet; `\/signup rsvp:in`/);
});

// The Ledger move runs in the browser; run the real functions from js/board.js against the repo's own data.
import vm from "node:vm";
const src = fs.readFileSync(rp("js/board.js"), "utf8");
const grab = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); const eol = src.indexOf("\n", i); return src.slice(i, src.slice(i, eol).trimEnd().endsWith("{") ? src.indexOf("\n}", i) + 2 : eol); };
function boardFns(nowSec, timelineFile = "data/tonight.json") {
  const D = { party: JSON.parse(fs.readFileSync(rp("data/party.json"), "utf8")), timeline: JSON.parse(fs.readFileSync(rp(timelineFile), "utf8")) };
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

// /tonight roster: a hidden or odd sheet field must never print as text, and the reply must fit Discord's 2000-char content limit.
const BAD = /undefined|null|\[object/;
const pre = LAUNCH_EPOCH - 60, post = LAUNCH_EPOCH + 86400;
const rosterOf = (members, now) => tonightLines({ ...base, now, party: { members } }).find((l) => l.startsWith("• **Party"));
test("roster: missing or odd race/class never prints as text, before and after launch", () => {
  const cases = [
    [{ name: "Aa", class: "Druid" }, "Aa (Druid)"],
    [{ name: "Aa", race: "Orc" }, "Aa (Orc)"],
    [{ name: "Aa" }, "Aa"],
    [{ name: "Aa", race: "", class: "" }, "Aa"],
    [{ name: "Aa", race: 5, class: { x: 1 } }, "Aa"],
    [{ name: "Aa", race: null, class: ["Druid"] }, "Aa"],
    [{ name: "Aa", race: "constructor", class: "__proto__" }, "Aa (constructor __proto__)"],
    [{ name: "toString", race: "valueOf", class: "Druid" }, "toString (valueOf Druid)"],
  ];
  for (const now of [pre, post]) for (const [m, want] of cases) {
    const lines = tonightLines({ ...base, now, party: { members: [m] } });
    assert.ok(!lines.some((l) => BAD.test(l)), JSON.stringify(m));
    assert.equal(lines.find((l) => l.startsWith("• **Party")), `• **Party (1):** ${want}`);
  }
});
test("roster: members without a string name are skipped; junk rows and containers do not throw", () => {
  for (const now of [pre, post]) {
    const r = rosterOf([{ name: 7, race: "Orc", class: "Druid" }, null, 5, "x", [], { race: "Orc" }, { name: "" }, { name: "Aa", race: "Orc", class: "Druid" }], now);
    assert.equal(r, "• **Party (1):** Aa (Orc Druid)");
    for (const members of [null, undefined, 5, "x", {}, []]) assert.ok(!BAD.test(rosterOf(members, now)));
  }
});
test("roster: a normal party is unchanged", () => {
  const members = [{ name: "Aa", race: "Orc", class: "Warrior" }, { name: "Bb", race: "Troll", class: "Mage" }];
  assert.equal(rosterOf(members, pre), "• **Party (2):** Aa (Orc Warrior) · Bb (Troll Mage)");
  assert.equal(rosterOf(members, post), "• **Party (2):** Aa (Orc Warrior) · Bb (Troll Mage)");
});
test("roster: 60 members with 32-char names are capped with 'and N more' and the reply fits 2000", () => {
  const members = Array.from({ length: 60 }, (_, i) => ({ name: String(i).padStart(2, "0") + "x".repeat(30), race: "Orc", class: "Warrior" }));
  for (const now of [pre, post]) {
    const lines = tonightLines({ ...base, now, party: { members } });
    const text = lines.join("\n");
    assert.ok(text.length <= 2000, String(text.length));
    const r = lines.find((l) => l.startsWith("• **Party"));
    const m = r.match(/and (\d+) more$/);
    assert.ok(m, r);
    assert.equal(r.split(" · ").length - 1 + Number(m[1]), 60);
    assert.ok(!r.includes("·  "));
  }
});
