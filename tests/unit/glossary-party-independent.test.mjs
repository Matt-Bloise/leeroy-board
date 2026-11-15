// The party glossary is public whatever a member hides, so nothing in it may depend on who is at the table (PR 333 withheld it whole because three examples did).
// Two jobs: (1) guard: no glossary text names a race or class of the game's vocabulary, nor any member's spec; (2) projectForAnonymous keeps the glossary, byte for byte,
// while a member hides every field. Fictional members only.
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { projectForAnonymous, WITHHELD_LINE } from "../../infrastructure/worker/public-party.js";
import { SHEET_VOCAB } from "../../infrastructure/worker/sheet-vocab.js";

const load = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));
const DOCS = ["data/party.json", "tests/fixtures/six-members/party.json", "tests/fixtures/six-members/party-seven.json"];
const esc = (s) => s.replace(/[^a-z0-9 ]/gi, (c) => "\\" + c);
const SPEC_LABELS = new Set(Object.values(SHEET_VOCAB.spec).map((s) => s.toLowerCase()));
const specsOf = (m) => String(m.spec || "").split(/[^A-Za-z]+/).filter((w) => SPEC_LABELS.has(w.toLowerCase()));
const wordIn = (text, w) => new RegExp(`(^|[^a-z0-9])${esc(w.toLowerCase())}s?([^a-z0-9]|$)`).test(text.toLowerCase());

for (const p of DOCS) {
  test(`${p}: no glossary text names a race or a class, or a spec of any member`, () => {
    const doc = load(p);
    assert.ok(Array.isArray(doc.glossary) && doc.glossary.length >= 15, "the glossary is there");
    const members = doc.members || [];
    const specWords = new Set(members.flatMap(specsOf));
    const named = [...Object.values(SHEET_VOCAB.race), ...Object.values(SHEET_VOCAB.class), ...specWords, ...members.flatMap((m) => [m.race, m.class])].filter(Boolean);
    for (const g of doc.glossary) {
      const text = [g.term, ...(g.forms || []), g.def].join(" \n ");
      for (const w of new Set(named)) assert.ok(!wordIn(text, w), `glossary term "${g.term}" names "${w}"`);
    }
  });
}

test("the glossary's examples are not the table's set: no race, class or spec value of any member appears in any definition", () => {
  const doc = load("data/party.json");
  const own = new Set(doc.members.flatMap((m) => [m.race, m.class, ...specsOf(m)]).filter((w) => w && w.length >= 3).map((w) => w.toLowerCase()));
  const defs = doc.glossary.map((g) => g.def.toLowerCase());
  for (const w of own) assert.ok(!defs.some((d) => wordIn(d, w)), `"${w}" in a definition`);
});

test("a member who hides every field: the glossary stays whole, the member-derived lines are withheld", () => {
  const doc = { generated: "2026-01-01T00:00:00Z", party: "Fictional Two", faction: "Horde", ruleset: "Normal",
    members: [{ name: "Alder Testwright", class: "Mage", race: "Undead", spec: "Frost", role: "damage" }, { name: "Birch Testwright", class: "Priest", race: "Troll", spec: "Holy", role: "healer" }],
    settled: ["Invented"], settled_extra: [], open: ["Invented"], polls: [], glossary: load("data/party.json").glossary };
  const F = ["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone", "level", "launch_state", "goals"];
  const sheet = (slug, name, visible) => ({ slug, name, updated: "2026-01-01T00:00:00Z", fields: Object.fromEntries(F.map((f) => [f, { value: "x", visible, source: "board", at: "2026-01-01T00:00:00Z" }])) });
  const before = JSON.stringify(doc.glossary);
  const out = projectForAnonymous(doc, [sheet("alder-testwright", "Alder Testwright", false), sheet("birch-testwright", "Birch Testwright", true)]);
  assert.equal(out.withheld, WITHHELD_LINE);
  assert.deepEqual([out.settled, out.settled_extra, out.open], [[], [], []]);
  assert.equal(JSON.stringify(out.glossary), before, "glossary is served as stored");
  assert.equal(JSON.stringify(doc.glossary), before, "the stored document is not touched");
});
