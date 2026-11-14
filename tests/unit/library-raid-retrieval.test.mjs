// Raid questions against the real data/library, offline: rank() then selectRelevant(), as /ask does. No network, no D1, no AI.
// Guards the Dec 9 raid facts: the specific fact is found for the common raid questions, the audit's good questions keep their
// answer, tank-class questions still reach the class role facts, a Classic raid the Library has no page for abstains, and a
// Molten Core question is not answered by a raid-prep or other raid fact.
// Membership in the top 3 is asserted where the order is not the point; the first place only where the question was broken.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rank, factHays } from "../../infrastructure/worker/rank-core.js";
import { selectRelevant, cleanQuestion } from "../../infrastructure/worker/self-rag.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lib = path.join(root, "data", "library");
const index = JSON.parse(fs.readFileSync(path.join(lib, "index.json"), "utf8"));
const byId = {};
for (const c of index.categories) for (const p of JSON.parse(fs.readFileSync(path.join(lib, `${c.key}.json`), "utf8")).pages) byId[p.id] = p;
const pages = index.pages.map((h) => byId[h.id]).filter(Boolean);
const hays = factHays(pages);
const ask = (q) => {
  const r = rank(cleanQuestion(q, []), pages, { hays });
  const rel = selectRelevant(r.hits, r.words, hays);
  return { abstain: rel.abstain, top: rel.hits.map((h) => `${h.page}~${h.key || "OPEN"}`) };
};
const top3 = (q) => ask(q).top.slice(0, 3);

test("every library page is listed in index.json", () => {
  assert.deepEqual(Object.keys(byId).filter((id) => !index.pages.some((h) => h.id === id)), []);
});

// the three questions the Nov 14 audit found broken: the right fact must now be first
for (const [q, want] of [
  ["when do raids open", "events/raids-dec-9~raids.open"],
  ["how many players Barrow Deeps", "events/raids-dec-9~barrow_deeps.size"],
  ["what level is Hyjal", "raids/hyjal-summit~hyjal_summit.entry_level"],
]) {
  test(`"${q}" ranks ${want} first`, () => {
    const r = ask(q);
    assert.equal(r.abstain, false);
    assert.equal(r.top[0], want, r.top.slice(0, 3).join(" | "));
  });
}

// order not the point: the fact must be among the first three
for (const [q, any] of [
  ["how many players does Barrow Deeps take", ["events/raids-dec-9~barrow_deeps.size"]],
  ["what level do I need for Hyjal", ["raids/hyjal-summit~hyjal_summit.entry_level"]],
  ["what level do I need to raid", ["events/raids-dec-9~raids.entry_level", "raids/raid-prep~raid_prep.level"]],
  ["what time do raids open on December 9", ["events/raids-dec-9~raids.open_hour"]],
  ["which flasks should I use for raiding", ["raids/raid-prep~raid_prep.flasks", "raids/level-60-gear~flasks.natural"]],
  ["do world buffs work in raids", ["raids/raid-prep~raid_prep.world_buffs", "raids/level-60-gear~world_buffs.raiding"]],
  // the audit's good questions (2026-11-14) keep their answer
  ["do I need fire resistance for Onyxia", ["raids/onyxias-lair~onyxia.fire_resistance"]],
  ["is Onyxia attunement needed", ["raids/onyxias-lair~onyxia.attunement"]],
  ["what bosses are in Barrow Deeps", ["events/raids-dec-9~barrow_deeps.bosses"]],
  ["what is the raid lockout reset", ["raids/barrow-deeps~barrow_deeps.lockout", "events/raids-dec-9~raids.reset"]],
  ["how many tanks do we need for Onyxia", ["events/raids-dec-9~raids.tank_counts"]],
  // a raid fact that mentions roles must not push the tank classes out (review of PR 321, M2)
  ["which class is the best tank", ["classes/overview~roster.role", "classes/warrior~warrior.role", "classes/paladin~paladin.role", "classes/druid~druid.role"]],
  ["best tank class", ["classes/overview~roster.role", "classes/warrior~warrior.role", "classes/paladin~paladin.role", "classes/druid~druid.role", "classes/tanking~tanking.full_tanks"]],
]) {
  test(`"${q}" has one of ${any.join(", ")} in its top 3`, () => {
    const t = top3(q);
    assert.ok(t.some((x) => any.includes(x)), t.join(" | "));
  });
}

test("a raid with no Library page abstains (Blackwing Lair)", () => {
  assert.equal(ask("is there Blackwing Lair").abstain, true);
});

test("a Molten Core question is not answered first by a raid page or a raid-prep fact", () => {
  for (const q of ["what level do I need for Molten Core", "when does Molten Core open"]) {
    const r = ask(q);
    if (r.abstain) continue;
    assert.ok(!/^(raids\/|events\/raids-dec-9)/.test(r.top[0]), `${q}: ${r.top.slice(0, 3).join(" | ")}`);
  }
});

test("raid facts read on 2026-11-14 carry an https source; secondary sources say so", () => {
  for (const id of ["events/raids-dec-9", "raids/barrow-deeps", "raids/hyjal-summit", "raids/onyxias-lair", "raids/raid-prep", "raids/level-60-gear"]) {
    const p = byId[id];
    assert.ok(p, id);
    assert.match(p.as_of, /^\d{4}-\d{2}-\d{2}$/);
    for (const f of p.facts) {
      if (!(f.refs || []).some((r) => r.accessed === "2026-11-14")) continue;
      assert.ok(f.refs.every((r) => /^https:\/\//.test(r.url)), `${id}~${f.key}`);
      if (f.refs.every((r) => r.tier !== 1)) assert.match(f.value, /secondary|third-hand|Wowhead|Warcraft Tavern/, `${id}~${f.key} cites only secondary sources and must say so`);
    }
  }
});

test("a page labelled confirmed cites no secondary source on a fact read 2026-11-14", () => {
  const p = byId["events/raids-dec-9"];
  assert.equal(p.confidence, "confirmed");
  for (const f of p.facts) if ((f.refs || []).some((r) => r.accessed === "2026-11-14")) assert.ok(f.refs.every((r) => r.tier === 1), f.key);
});

test("each raid page carries its own entry level fact for the readiness panel", () => {
  for (const [id, key] of [["raids/barrow-deeps", "barrow_deeps.entry_level"], ["raids/hyjal-summit", "hyjal_summit.entry_level"], ["raids/onyxias-lair", "onyxia.entry_level"]]) {
    const f = byId[id].facts.find((x) => x.key === key);
    assert.ok(f, `${id} has ${key}`);
    assert.match(f.value, /level 60/);
  }
});

test("ref ids on a page are not reused for a different url", () => {
  for (const p of pages) {
    const seen = new Map();
    for (const f of p.facts) for (const r of f.refs || []) {
      if (seen.has(r.id)) assert.equal(seen.get(r.id), r.url, `${p.id} ${r.id}`);
      else seen.set(r.id, r.url);
    }
  }
});
