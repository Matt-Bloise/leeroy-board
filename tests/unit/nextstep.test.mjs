// Q36 next-step engine (js/nextstep.js). Pure function; every rule, the tie-break order, the copy file and the voice rule.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { nextStep, RULES, SOON_MS } from "../../js/nextstep.js";

const cta = JSON.parse(fs.readFileSync(new URL("../../data/cta.json", import.meta.url), "utf8"));
const copy = Object.fromEntries(cta.filter((e) => e.id.startsWith("nextstep-")).map((e) => [e.id, e.new]));
const NOW = 1_800_000_000_000, fmt = () => "Thu 8:00 PM";
const build = { class_key: "mage", role: "dps", ruleset: "Normal", faction: "Horde" };
const group = (o = {}) => ({ name: "The Tipsy Gryphons", ruleset: "Normal", faction: "Horde", slots: [{ role: "tank", status: "filled" }, { role: "dps", status: "open" }], ...o });
const run = (o = {}) => nextStep({ build, group: group(), signups: { rsvp: null }, now: NOW, copy, fmt, ...o });

test("copy file holds title, why and cta for every rule", () => {
  for (const r of RULES) for (const k of ["title", "why", "cta"]) assert.ok(copy[`nextstep-${r}-${k}`], `${r}-${k}`);
});
test("rule 1: no build runs /build, whatever else is true", () => {
  const s = run({ build: null });
  assert.equal(s.id, "no-build"); assert.match(s.why, /\/build/);
  assert.equal(run({ build: null, group: null }).id, "no-build");
});
test("rule 2: a build with no group points at the groups", () => {
  assert.equal(run({ group: null }).id, "no-group");
});
test("rule 3: ruleset mismatch is explained with both values", () => {
  const s = run({ group: group({ ruleset: "Hardcore" }) });
  assert.equal(s.id, "mismatch"); assert.match(s.title, /ruleset/); assert.match(s.why, /Normal/); assert.match(s.why, /Hardcore/);
});
test("rule 3: faction mismatch is explained; own faction/ruleset inputs override the build", () => {
  assert.match(run({ group: group({ faction: "Alliance" }) }).why, /Horde.*Alliance/);
  assert.equal(run({ group: group({ faction: "Alliance" }), faction: "Alliance" }).id, "rsvp");
  assert.equal(run({ ruleset: "Hardcore" }).id, "mismatch");
});
test("rule 3: values are compared case-insensitively and a group without values never mismatches", () => {
  assert.equal(run({ group: group({ ruleset: "normal", faction: "HORDE" }) }).id, "rsvp");
  assert.equal(run({ group: group({ ruleset: null, faction: undefined }) }).id, "rsvp");
});
test("rule 4: RSVP in and the event within a day shows the time", () => {
  const s = run({ signups: { rsvp: "in" }, group: group({ event_epoch: (NOW + 3600_000) / 1000 }) });
  assert.equal(s.id, "event-soon"); assert.match(s.title, /Thu 8:00 PM/);
  assert.equal(run({ signups: { rsvp: "in" }, group: group({ event_epoch: NOW + SOON_MS }) }).id, "event-soon");
});
test("rule 4 does not fire for a far, past, missing or not-in event", () => {
  assert.equal(run({ signups: { rsvp: "in" }, group: group({ event_epoch: NOW + SOON_MS + 1 }) }), null);
  assert.equal(run({ signups: { rsvp: "in" }, group: group({ event_epoch: NOW - 1 }) }), null);
  assert.equal(run({ signups: { rsvp: "in" } }), null);
  assert.equal(run({ signups: { rsvp: "maybe" }, group: group({ event_epoch: NOW + 1000 }) }), null);
});
test("rule 5: an open seat for your role and no answer yet asks for an RSVP", () => {
  const s = run();
  assert.equal(s.id, "rsvp"); assert.match(s.title, /damage seat/); assert.match(s.title, /Tipsy Gryphons/);
  assert.equal(run({ build: { ...build, role: "damage" } }).id, "rsvp");
});
test("rule 5 needs an open seat of your role and no answer", () => {
  assert.equal(run({ build: { ...build, role: "healer" } }), null);
  assert.equal(run({ build: { ...build, role: "" } }), null);
  assert.equal(run({ signups: { rsvp: "out" } }), null);
  assert.equal(run({ group: group({ slots: [{ role: "dps", status: "filled" }] }) }), null);
});
test("tie-break order: build, group, mismatch, then event-soon, then rsvp", () => {
  const all = { signups: { rsvp: "in" }, group: group({ ruleset: "Hardcore", event_epoch: NOW + 1000 }) };
  assert.equal(run({ ...all, build: null, group: null }).id, "no-build");
  assert.equal(run({ ...all, group: null }).id, "no-group");
  assert.equal(run(all).id, "mismatch");
  assert.equal(run({ ...all, group: group({ event_epoch: NOW + 1000 }) }).id, "event-soon");
  assert.equal(run({ signups: { rsvp: null }, group: group({ event_epoch: NOW + 1000 }) }).id, "rsvp");
});
test("missing copy or junk input returns null, never throws", () => {
  assert.equal(run({ copy: {} }), null);
  assert.equal(nextStep(), null);
  assert.doesNotThrow(() => nextStep({ build: 1, group: "x", signups: 5, now: "no" }));
});
test("voice: no copy string tells anyone which class, race or role to pick", () => {
  const bad = /\b(you should|you must|pick (a|the) (class|race|role)|choose (a|the) (class|race|role)|play (a|an) \w+|best (class|race))\b/i;
  for (const [k, v] of Object.entries(copy)) assert.ok(!bad.test(v), `${k}: ${v}`);
  for (const [k, v] of Object.entries(copy)) assert.ok(!/[\u2014\u2013\u2018\u2019\u201c\u201d]/.test(v), `${k} has unicode punctuation`);
});
test("the module has no browser globals", () => {
  const src = fs.readFileSync(new URL("../../js/nextstep.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\b(window|document|localStorage|fetch|Date\.now)\b/.test(src));
});
