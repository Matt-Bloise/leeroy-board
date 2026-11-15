// The party glossary is public whatever a member hides, so nothing in it may depend on who is at the table (PR 333 withheld it whole because three examples did).
// Jobs: (1) the Worker serves the BUNDLED glossary (party-glossary.js), never the stored row's, hiding or not; (2) the guard: no glossary text, in any copy of it
// (bundle, data/party.json, the fixtures, the API snapshot, the library glossary file), names a race, class, spec, profession, plan or start zone, spell, racial
// ability, member or a headcount, and the guard is itself tested by mutation; (3) the library edit is not inert: its `generated` moved and index.json's stamps match.
// Fictional members only. Failure messages carry indexes and terms, never a member's name.
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { projectForAnonymous, projectDataDoc, projectBroadcast, WITHHELD_LINE } from "../../infrastructure/worker/public-party.js";
import { SHEET_VOCAB } from "../../infrastructure/worker/sheet-vocab.js";
import { bundledGlossary, servedGlossary, filterGlossary, namesVocabulary, entryNamesVocabulary, normaliseText, ALLOWED, EXTRA_TERMS } from "../../infrastructure/worker/party-glossary.js";

const load = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));
const raw = (p) => readFileSync(new URL(`../../${p}`, import.meta.url));
const FIXTURE_DOCS = ["tests/fixtures/six-members/party.json", "tests/fixtures/six-members/party-seven.json"];
const PARTY_DOCS = ["data/party.json", ...FIXTURE_DOCS];
const CLIENT = load("data/client.json");
const BUNDLE = bundledGlossary();

// ---- the guard ---------------------------------------------------------------------------------------------------------------------------------------------------
// What the guard knows beyond the vocabulary and EXTRA_TERMS: every spell and racial ability in data/client.json, every member's own race, class and spec words, every member's name.
const spellNames = Object.values(CLIENT.classes).flat().map((s) => s.name);
const racialNames = Object.values(CLIENT.racials).flat().map((r) => r.name);
const SPEC_LABELS = new Set(Object.values(SHEET_VOCAB.spec).map((s) => s.toLowerCase()));
const specsOf = (m) => String(m.spec || "").split(/[^A-Za-z]+/).filter((w) => SPEC_LABELS.has(w.toLowerCase()));
const membersOf = () => PARTY_DOCS.flatMap((p) => load(p).members || []);
const memberTerms = () => membersOf().flatMap((m) => [m.name, m.race, m.class, ...specsOf(m)]).filter((w) => typeof w === "string" && w.trim().length >= 3);
const HEADCOUNT = /\b(?:the )?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+) (?:of )?(?:this|our|the) (?:board|party|table|group|five)\b|\bthe five of\b|\ball (?:play|are) (?:Horde|Alliance)\b/i;
const EXTRA = [...spellNames, ...racialNames, ...memberTerms()];
const findings = (entries, names = []) => entries.flatMap((g, i) => {
  const text = [g.term, ...(g.forms || []), g.def].join(" \n ");
  const hits = namesVocabulary(text, [...EXTRA, ...names], ALLOWED);
  if (HEADCOUNT.test(text)) hits.push("a headcount");
  return hits.map((h) => `entry ${i}: ${h}`);
});

const SOURCES = {
  "the bundled glossary": () => BUNDLE,
  "data/party.json": () => load("data/party.json").glossary,
  "the six-members fixture": () => load(FIXTURE_DOCS[0]).glossary,
  "the seven-members fixture": () => load(FIXTURE_DOCS[1]).glossary,
  "the library glossary file": () => load("data/library/glossary.json").terms,
};

for (const [name, get] of Object.entries(SOURCES)) {
  test(`${name}: no text names a race, class, spec, profession, zone, spell, racial, member or headcount`, () => {
    const g = get();
    assert.ok(Array.isArray(g) && g.length >= 15, "the glossary is there");
    assert.deepEqual(findings(g), []);
  });
}

test("the copies of the party glossary are the bundle, byte for byte", () => {
  for (const p of PARTY_DOCS) assert.deepEqual(load(p).glossary, BUNDLE, `${p} glossary equals party-glossary.js`);
});

test("the API snapshot's party glossaries are the bundle", () => {
  const snap = load("tests/fixtures/api-snapshot/snapshot.json");
  let seen = 0;
  for (const [route, r] of Object.entries(snap.routes)) {
    let body; try { body = JSON.parse(r.body); } catch { continue; }
    const doc = body && body.party && Array.isArray(body.party.glossary) ? body.party : body && Array.isArray(body.glossary) ? body : null;
    if (!doc) continue;
    seen++;
    assert.deepEqual(doc.glossary, BUNDLE, `${route}: snapshot glossary equals the bundle`);
  }
  assert.ok(seen >= 1, "at least one snapshot route carries the party glossary");
});

// ---- the guard, tested by mutation: each text below is put into a definition of each copy; the guard must name it -------------------------------------------------------
const MEMBER = "Alder Testwright";
const MUTATIONS = {
  "a profession": "such as Tailoring",
  "a second profession": "or Mining",
  "a plan zone": "near Durotar",
  "a start zone": "starting in Tirisfal Glades",
  "a start zone (two words)": "Coldridge Valley",
  "a city plan zone": "in Orgrimmar",
  "a spec abbreviation: Ret": "a Ret one",
  "a spec abbreviation: Disc": "a Disc one",
  "a spec abbreviation: Demo": "a Demo one",
  "a class spell: Frostbolt": "like Frostbolt",
  "a class spell: Polymorph": "like Polymorph",
  "a class spell: Shadow Bolt": "like Shadow Bolt",
  "a racial: War Stomp": "like War Stomp",
  "a racial: Will of the Forsaken": "like Will of the Forsaken",
  "a racial: Berserking": "such as Berserking",
  "a race synonym: Forsaken": "the Forsaken",
  "a race synonym: Darkspear": "the Darkspear",
  "a vocabulary race": "a Tauren",
  "a vocabulary race, plural": "the Gnomes",
  "a vocabulary class": "a Warlock",
  "a vocabulary spec: Retribution": "a Retribution one",
  "a vocabulary spec: Affliction": "an Affliction one",
  "a vocabulary spec: Subtlety": "a Subtlety one",
  "a vocabulary spec: Beast Mastery": "Beast Mastery",
  "a derived word: Druidic": "a Druidic form",
  "a derived word: Shamanic": "Shamanic magic",
  "a derived word: Orcish": "Orcish blood",
  "a zero-width space inside a race": "an Und​ead",
  "a zero-width joiner inside a class": "a Ma‍ge",
  "a soft hyphen inside a class": "a War­lock",
  "a BOM inside a spec": "Fr﻿ost",
  "fullwidth letters": "Ｕｎｄｅａｄ",
  "accents": "a M\u00E4ge",
  "a member name": MEMBER,
  "a headcount": "the five of this board",
  "all of them play Horde": "all play Horde",
};
const withText = (list, extraText, where) => list.map((g, i) => (i === 0 ? (where === "forms" ? { ...g, forms: [...(g.forms || []), extraText] } : where === "term" ? { ...g, term: `${g.term} ${extraText}` } : { ...g, def: `${g.def} ${extraText}` }) : g));
const guardCatches = (list, extraText, where) => findingsWith(withText(list, extraText, where)).length > 0;
const findingsWith = (entries) => findings(entries, [MEMBER]);

test("sanity: the guard raises nothing on the clean copies", () => {
  for (const get of Object.values(SOURCES)) assert.deepEqual(findingsWith(get()), []);
});

test("mutation: every mutation is caught in every copy, in the definition, the forms and the term", () => {
  const survived = [];
  let n = 0;
  for (const [sname, get] of Object.entries(SOURCES)) {
    for (const [mname, mtext] of Object.entries(MUTATIONS)) {
      for (const where of ["def", "forms", "term"]) { n++; if (!guardCatches(get(), mtext, where)) survived.push(`${sname} / ${mname} / ${where}`); }
    }
  }
  assert.ok(n >= Object.keys(MUTATIONS).length * 3 * 5);
  assert.deepEqual(survived, [], `${survived.length} of ${n} mutations survived`);
});

test("mutation: the vocabulary itself: every value of every list, and every spell and racial of data/client.json, is caught", () => {
  const survived = [];
  const bundle = BUNDLE;
  for (const list of ["race", "class", "spec", "professions", "plan_zone"]) {
    for (const label of Object.values(SHEET_VOCAB[list])) if (!ALLOWED.includes(normaliseText(label)) && !guardCatches(bundle, `like ${label}`, "def")) survived.push(`${list}: ${label}`);
  }
  for (const s of [...spellNames, ...racialNames]) if (!guardCatches(bundle, `like ${s}`, "def")) survived.push(`spell or racial: ${s}`);
  for (const w of EXTRA_TERMS) if (!guardCatches(bundle, `a ${w}`, "def")) survived.push(`extra: ${w}`);
  assert.deepEqual(survived, []);
});

test("the one allowed name is the meeting place, and nothing else slips through its allowance", () => {
  assert.deepEqual([...ALLOWED], ["valley of strength"]);
  assert.deepEqual(namesVocabulary("Valley of Strength", [], ALLOWED), []);
  assert.ok(namesVocabulary("Valley of Strength in Orgrimmar", [], ALLOWED).includes("orgrimmar"));
});

// ---- the Worker serves the bundle, never the stored row's glossary ------------------------------------------------------------------------------------------------
const F = ["race", "class", "spec_path", "spec_at_40", "professions", "plan_zone", "level", "launch_state", "goals"];
const sheet = (slug, name, visible) => ({ slug, name, updated: "2026-01-01T00:00:00Z", fields: Object.fromEntries(F.map((f) => [f, { value: "x", visible, source: "board", at: "2026-01-01T00:00:00Z" }])) });
// what production still stores: the four definitions that name the table's own examples
const OLD_GLOSSARY = [
  { term: "racial", forms: ["racial", "racials"], def: "A special ability every character of one race gets for free, like a Troll's faster attacks." },
  { term: "spec", forms: ["spec", "specs"], def: "The way a character focuses its class, for example a Mage who studies Frost rather than Fire." },
  { term: "class", forms: ["class", "classes"], def: "A character's job, such as Mage, Priest or Warlock; it sets the spells, the armor and whether it can tank, heal or deal damage. Forever has nine." },
  { term: "race", forms: ["race", "races"], def: "A character's people, such as Undead, Troll or Tauren; it sets the look, a few special abilities and which classes are open." },
];
const OLD_TEXT = ["Troll's faster attacks", "Mage who studies Frost", "such as Mage, Priest or Warlock", "such as Undead, Troll or Tauren"];
const storedDoc = (glossary) => ({ generated: "2026-01-01T00:00:00Z", party: "Fictional Two", faction: "Horde", ruleset: "Normal",
  members: [{ name: "Alder Testwright", class: "Mage", race: "Undead", spec: "Frost", role: "damage" }, { name: "Birch Testwright", class: "Priest", race: "Troll", spec: "Holy", role: "healer" }],
  settled: ["Invented"], settled_extra: [], open: ["Invented"], polls: [], glossary });
const hidingSheets = () => [sheet("alder-testwright", "Alder Testwright", false), sheet("birch-testwright", "Birch Testwright", true)];
const showingSheets = () => [sheet("alder-testwright", "Alder Testwright", true), sheet("birch-testwright", "Birch Testwright", true)];
const noOldText = (out) => { const s = JSON.stringify(out); for (const t of OLD_TEXT) assert.ok(!s.includes(t), `old text "${t}" is served`); };

test("a stored row with the OLD party-shaped glossary: while a member hides every field, the bundle is served and the old text appears nowhere", () => {
  const doc = storedDoc(OLD_GLOSSARY), before = JSON.stringify(doc);
  const out = projectForAnonymous(doc, hidingSheets());
  assert.equal(out.withheld, WITHHELD_LINE);
  assert.deepEqual([out.settled, out.settled_extra, out.open], [[], [], []]);
  assert.deepEqual(out.glossary, servedGlossary());
  assert.deepEqual(out.glossary, BUNDLE);
  noOldText(out);
  assert.equal(JSON.stringify(doc), before, "the stored document is not touched");
});

test("the same stored row when nobody hides: the bundle is served and the old text appears nowhere", () => {
  const out = projectForAnonymous(storedDoc(OLD_GLOSSARY), showingSheets());
  assert.equal(out.withheld, undefined);
  assert.deepEqual(out.glossary, BUNDLE);
  noOldText(out);
});

test("the stored glossary is replaced whatever it holds: missing, empty, a string, junk, poisoned", () => {
  for (const g of [undefined, [], "text", 7, null, [null, 3], [{ term: "x", forms: ["x"], def: "such as Undead" }], OLD_GLOSSARY]) {
    for (const sheets of [hidingSheets(), showingSheets(), null]) {
      const doc = storedDoc(g); if (g === undefined) delete doc.glossary;
      const out = projectForAnonymous(doc, sheets);
      assert.deepEqual(out.glossary, BUNDLE);
    }
  }
});

test("a document that is not a party document is withheld whole, with the bundled glossary", () => {
  for (const d of [null, "x", 5, [], { glossary: OLD_GLOSSARY }, { members: "no", glossary: OLD_GLOSSARY }]) {
    const out = projectForAnonymous(d, showingSheets());
    assert.deepEqual(out.glossary, BUNDLE);
    noOldText(out);
  }
});

test("every route that carries the party document serves the bundle: /data/party and the socket message", () => {
  const doc = storedDoc(OLD_GLOSSARY), inputs = { partyDoc: doc, sheets: hidingSheets() };
  const viaData = projectDataDoc("party", doc, inputs);
  assert.deepEqual(viaData.glossary, BUNDLE);
  const viaSocket = projectBroadcast({ type: "data", key: "party", data: doc }, inputs);
  assert.deepEqual(viaSocket.data.glossary, BUNDLE);
  noOldText([viaData, viaSocket]);
});

test("belt and braces: an entry that names the vocabulary is withheld from what is served", () => {
  const poisoned = [...BUNDLE, { term: "x", forms: ["x"], def: "like a Troll" }, { term: "y", forms: ["y"], def: "Und​ead" }, { term: "z", forms: ["Frostbolt"], def: "ok" }, { term: "valley of strength", forms: [], def: "ok" }];
  const kept = filterGlossary(poisoned).map((g) => g.term);
  assert.ok(!kept.includes("x") && !kept.includes("y") && !kept.includes("z"));
  assert.ok(kept.includes("valley of strength"), "the allowed meeting place stays");
  assert.deepEqual(filterGlossary(BUNDLE), BUNDLE, "nothing of the bundle is dropped");
  assert.deepEqual(filterGlossary("nope"), []);
  assert.equal(entryNamesVocabulary({ term: "t", forms: ["f"], def: "d" }).length, 0);
});

test("the served glossary is a copy: changing it changes nothing in the bundle", () => {
  const a = servedGlossary(); a[0].def = "changed"; a[0].forms.push("changed");
  assert.deepEqual(servedGlossary(), BUNDLE);
});

// ---- the library edit is not inert: generated moved, and the stamp index.json carries matches the file ------------------------------------------------------------------
test("data/library/glossary.json: `generated` is newer than the value the stored D1 blob carries (the seed keeps the D1 row unless the repo copy is newer)", () => {
  const PRE_PR = "2026-11-01T22:54:52.063Z";
  assert.ok(String(load("data/library/glossary.json").generated) > PRE_PR);
});

test("data/library/index.json: every stamp is the first 10 hex of the sha256 of its file's bytes", () => {
  const idx = load("data/library/index.json"), stale = [];
  const names = Object.keys(idx.stamps);
  assert.ok(names.length >= 15 && names.includes("glossary.json"));
  for (const f of names) {
    let h; try { h = createHash("sha256").update(raw(`data/library/${f}`)).digest("hex").slice(0, 10); } catch { stale.push(`${f}: file missing`); continue; }
    if (idx.stamps[f] !== h) stale.push(`${f}: stamp ${idx.stamps[f]}, file ${h}`);
  }
  assert.deepEqual(stale, []);
});
