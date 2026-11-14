// Raid questions against the real data/library, offline: rank() then selectRelevant(), as /ask does. No network, no D1, no AI.
// Guards the Dec 9 raid facts: the specific fact ranks first for the common raid questions, the audit's good questions keep
// their answer, a Classic raid the Library has no page for abstains, and a Molten Core question lands on the sourced launch fact.
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

test("every library page is listed in index.json", () => {
  assert.deepEqual(Object.keys(byId).filter((id) => !index.pages.some((h) => h.id === id)), []);
});

for (const [q, want] of [
  ["when do raids open", "events/raids-dec-9~raids.open"],
  ["how many players Barrow Deeps", "events/raids-dec-9~barrow_deeps.size"],
  ["how many players does Barrow Deeps take", "events/raids-dec-9~barrow_deeps.size"],
  ["what level is Hyjal", "raids/hyjal-summit~hyjal_summit.entry_level"],
  ["what level do I need for Hyjal", "raids/hyjal-summit~hyjal_summit.entry_level"],
  ["what level do I need to raid", "events/raids-dec-9~raids.entry_level"],
  // the audit's good questions (2026-11-14) keep their answer
  ["do I need fire resistance for Onyxia", "raids/onyxias-lair~onyxia.fire_resistance"],
  ["is Onyxia attunement needed", "raids/onyxias-lair~onyxia.attunement"],
  ["what bosses are in Barrow Deeps", "events/raids-dec-9~barrow_deeps.bosses"],
  ["what is the raid lockout reset", "raids/barrow-deeps~barrow_deeps.lockout"],
  ["how many tanks do we need for Onyxia", "events/raids-dec-9~raids.tank_counts"],
]) {
  test(`"${q}" ranks ${want} first`, () => {
    const r = ask(q);
    assert.equal(r.abstain, false);
    assert.equal(r.top[0], want, r.top.slice(0, 3).join(" | "));
  });
}

test("a raid with no Library page abstains (Blackwing Lair)", () => {
  assert.equal(ask("is there Blackwing Lair").abstain, true);
});

test("a Molten Core question lands on the sourced launch fact, not on a raid fact", () => {
  for (const q of ["what level do I need for Molten Core", "when does Molten Core open"]) {
    const r = ask(q);
    assert.equal(r.top[0], "events/launch~launch.setting_sep_12", `${q}: ${r.top.slice(0, 3).join(" | ")}`);
  }
  const f = byId["events/launch"].facts.find((x) => x.key === "launch.setting_sep_12");
  assert.ok(f.refs.length > 0 && f.refs.every((r) => /^https:\/\//.test(r.url)));
});

test("raid facts dated 2026-11-14 carry an https source; secondary sources say so", () => {
  for (const id of ["events/raids-dec-9", "raids/barrow-deeps", "raids/hyjal-summit", "raids/onyxias-lair", "raids/raid-prep"]) {
    const p = byId[id];
    assert.ok(p, id);
    assert.match(p.as_of, /^\d{4}-\d{2}-\d{2}$/);
    for (const f of p.facts) {
      const fresh = (f.refs || []).some((r) => r.accessed === "2026-11-14");
      if (!fresh) continue;
      assert.ok(f.refs.every((r) => /^https:\/\//.test(r.url)), `${id}~${f.key}`);
      if (f.refs.every((r) => r.tier !== 1)) assert.match(f.value, /secondary|Wowhead|Warcraft Tavern/, `${id}~${f.key} cites only secondary sources and must say so`);
    }
  }
});

test("each raid page carries its own entry level fact for the readiness panel", () => {
  for (const [id, key] of [["raids/barrow-deeps", "barrow_deeps.entry_level"], ["raids/hyjal-summit", "hyjal_summit.entry_level"], ["raids/onyxias-lair", "onyxia.entry_level"]]) {
    const f = byId[id].facts.find((x) => x.key === key);
    assert.ok(f, `${id} has ${key}`);
    assert.match(f.value, /level 60/);
  }
});
