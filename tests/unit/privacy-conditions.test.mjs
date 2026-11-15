// PR 329 owner conditions A and C at unit level (roster-config.js researchMembersFor): first names from sheets, common-word / game-term / library-word sheet names are never keys.
// Fictional names only. Run: node --test tests/unit/privacy-conditions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { researchMembersFor, genericAliases, isGenericName, libraryWords } from "../../infrastructure/worker/privacy/roster-config.js";
import { buildNameMap, tokenise } from "../../infrastructure/worker/privacy/tokenise.js";

const keys = (members) => members.flatMap((m) => [m.display, ...(m.aliases || []), ...(m.firstNames || []), ...(m.characterNames || [])]).map((x) => String(x).toLowerCase());

test("A. the first word of a multi-word sheet name is that member's first name; a one-word handle adds none", () => {
  const m = researchMembersFor([{ slug: "mirabel-stormcrow", name: "Mirabel Stormcrow" }, { slug: "zedex", name: "ZedEx" }]);
  assert.deepEqual(m.find((x) => x.display === "Mirabel Stormcrow").firstNames, ["Mirabel"]);
  assert.deepEqual(m.find((x) => x.display === "ZedEx").firstNames, []);
});

test("A. a first_name / real_name sheet field is a first name too", () => {
  const m = researchMembersFor([{ slug: "zedex", name: "ZedEx", fields: { first_name: { value: "Quillon" }, real_name: "Vorn Atteberry" } }]);
  const z = m.find((x) => x.display === "ZedEx");
  assert.ok(z.firstNames.includes("Quillon") && z.firstNames.includes("Vorn"));
});

test("A. the name map tokenises a first name typed alone", () => {
  const members = researchMembersFor([{ slug: "mirabel-stormcrow", name: "Mirabel Stormcrow" }]);
  const map = buildNameMap(members, null, { genericAliases, nonce: "abcd" });
  assert.ok(!/mirabel/i.test(tokenise("what would mirabel say", map)));
});

test("C. common words and game terms as sheet names, first names or characters are never keys; the prompt text is unchanged", () => {
  const sheets = [
    { slug: "light", name: "Light" }, { slug: "tank-x", name: "Tank" }, { slug: "mage-y", name: "Mage" }, { slug: "ranger", name: "Ranger" },
    { slug: "r", name: "Rogue", fields: { main: { value: "Healer" } } }, { slug: "ld", name: "Light Dawnbringer" },
  ];
  const members = researchMembersFor(sheets);
  const base = new Set(keys(researchMembersFor([]))); // the roster's own keys (its aliases include 'tank') are not sheet-derived
  const k = keys(members).filter((x) => !base.has(x));
  for (const w of ["light", "tank", "mage", "ranger", "rogue", "healer"]) assert.ok(!k.includes(w), `${w} became a key`);
  assert.ok(k.includes("light dawnbringer"), "a multi-word name is still a key");
  const map = buildNameMap(members, null, { genericAliases, nonce: "abcd" });
  const text = "is light armor good for a tank or a ranger mage";
  assert.equal(tokenise(text, map), text);
});

test("C. a word that appears in the library fact text is not a key (any length); the same name with no library word is", () => {
  const lib = libraryWords([{ title: "Frostbite", blurb: "", facts: [{ key: "a", value: "Frostbite slows targets, and a frostbite stack ends. Drink an elixir of Brilliance for one hour." }] }]);
  assert.ok(isGenericName("Frostbite", lib) && isGenericName("elixir", lib));
  assert.ok(!isGenericName("Quillon", lib));
  // library words drop ALT and derived first names only: an alt called Frostbite is not a key; a sheet's own name is (see the Mason test)
  assert.ok(!keys(researchMembersFor([{ slug: "zq", name: "Zqxv", fields: { main: { value: "Frostbite" } } }], lib)).includes("frostbite"));
  assert.ok(keys(researchMembersFor([{ slug: "f", name: "Frostbite" }], lib)).includes("frostbite"));
  assert.ok(keys(researchMembersFor([{ slug: "q", name: "Quillon" }], lib)).includes("quillon"));
});

test("C. the exception is sheet-derived names only: 'Hunter Vale' stays a full-name key, its common-word first name is not, a roster first name that is a common word still is", () => {
  const sheets = [{ slug: "hunter-vale", name: "Hunter Vale" }];
  const m = researchMembersFor(sheets);
  const map = buildNameMap(m, null, { genericAliases, nonce: "abcd" });
  assert.ok(!/vale/i.test(tokenise("hunter vale rolled a need", map)), "the full name is tokenised");
  assert.equal(tokenise("a hunter pulls", map), "a hunter pulls");
  // a roster member's first name (injected) is never filtered, common word or not
  const roster = [{ display: "Zedex", aliases: [], firstNames: ["Wren", "Mason"] }];
  const map2 = buildNameMap(roster, null, { genericAliases, nonce: "abcd" });
  assert.ok(!/wren|mason/i.test(tokenise("tell wren and Mason", map2)));
});

test("C. a party member's name that a library fact MENTIONS (capitalised, or inside a fact key) stays a key: only words the library uses in lowercase are common", () => {
  const pages = [{ title: "Healers", blurb: "", facts: [{ key: "testbard.heals", value: "Testbard heals single targets well. Fakepriest also heals." }] }];
  const lib = libraryWords(pages);
  assert.ok(!isGenericName("Testbard", lib) && !isGenericName("Fakepriest", lib));
  const keysOf = keys(researchMembersFor([{ slug: "testbard", name: "Testbard" }, { slug: "fakepriest", name: "Fakepriest" }], lib));
  assert.ok(keysOf.includes("testbard") && keysOf.includes("fakepriest"));
});

// ---- Fable round 2 ----------------------------------------------------------------------------------------------------------------------------------
import { libraryPages } from "../../tools/guard-library-trips.mjs";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { skeleton } from "../../infrastructure/worker/privacy/skeleton.js";
const realPages = () => libraryPages().map((p) => ({ id: p.id, title: "", blurb: "", facts: [{ key: "k", value: p.text }] }));

test("R2.2 a sheet member's own one-word name is a key even when the library uses that word in lowercase ('Mason'); so are the ordinary given names (10+) that the real library contains", () => {
  const lib = libraryWords([{ id: "x/y", title: "Masonry", blurb: "", facts: [{ key: "a", value: "a mason builds walls; the mason guild trains masons." }] }]);
  assert.ok(lib.has("mason"));
  assert.ok(keys(researchMembersFor([{ slug: "mason", name: "Mason" }], lib)).includes("mason"));
  const real = libraryWords(realPages());
  const given = "will mark grace rose hunter mason dawn april may june summer amber jade ruby pearl faith hope joy sky jack bill bob rob tom tim sam max ben dan ray art guy rich frank grant chase drew miles lance pierce reed wade dean cliff glen heath dale brook lane page chance christian angel victor rex duke earl king prince sage basil olive ivy iris lily daisy holly hazel heather willow autumn winter storm rain river forest ash clay cole flint gray jasper".split(" ");
  const inLib = given.filter((w) => real.has(w) && !isGenericName(w, null));
  assert.ok(inLib.length >= 10, `only ${inLib.length} ordinary names are library words; the probe is too weak`);
  const bad = inLib.filter((w) => !keys(researchMembersFor([{ slug: w, name: w[0].toUpperCase() + w.slice(1) }], real)).includes(w));
  assert.deepEqual(bad.length, 0, `${bad.length} sheet names dropped for being library words`);
  // ...but an ALT name that is a library word is dropped
  assert.ok(!keys(researchMembersFor([{ slug: "zq", name: "Zqxv", fields: { main: { value: "Mason" } } }], lib)).includes("mason"));
});

test("R2.2 roster displays and aliases are never filtered by isGenericName, with or without library words (pins the exemption)", () => {
  const all = ROSTER_DATA.flatMap((r) => [r.display, ...(r.aliases || [])]).map((x) => skeleton(x));
  const lib = { has: () => true }; // every word is a "library word"
  const members = researchMembersFor([], lib);
  const got = new Set(members.flatMap((m) => [m.display, ...m.aliases]).map((x) => skeleton(x)));
  assert.deepEqual(all.filter((k) => !got.has(k)).length, 0, "a roster name was dropped");
  assert.equal(researchMembersFor([{ slug: "zq", name: "Zqxv" }], lib).filter((m) => m.display === "Zqxv").length, 1, "an unrelated sheet name is a key even if every word is a library word");
});

test("R2.3 a sheet with a generic name and slug still keys its first_name / real_name fields, every word of a real_name, not its titles", () => {
  const m = researchMembersFor([{ slug: "hunter", name: "Hunter", fields: { first_name: { value: "Quillon" }, class: { value: "rogue" } } }]);
  assert.ok(keys(m).includes("quillon"), "first_name of a generic-named sheet");
  const m2 = researchMembersFor([{ slug: "zedex", name: "ZedEx", fields: { real_name: "Dr Vorn Atteberry" } }]);
  const k2 = keys(m2);
  assert.ok(k2.includes("vorn") && k2.includes("atteberry"), "every word of a real_name");
  assert.ok(!k2.includes("dr"), "a title is not a name");
  const map = buildNameMap(m2, null, { genericAliases, nonce: "abcd" });
  assert.ok(!/atteberry/i.test(tokenise("is Atteberry online", map)), "the surname typed alone is tokenised");
});

test("R2.4 the common-word check normalises punctuation, case and leet digits: 'Light.', 'LIGHT', 'L1ght', 'T4nk!' are generic; multi-word and ordinary names are not", () => {
  for (const n of ["Light.", "LIGHT", "L1ght", "T4nk!", "Tank!", "l.i.g.h.t", "R0gue"]) assert.ok(isGenericName(n, null), n);
  for (const n of ["Quillon", "Light Dawnbringer", "Zedex"]) assert.ok(!isGenericName(n, null), n);
  const k = keys(researchMembersFor([{ slug: "l1", name: "Light." }, { slug: "l3", name: "L1ght" }]));
  assert.ok(!k.includes("light.") && !k.includes("l1ght"));
});

test("R2. multi-word names are never rejected (even when their letters spell a common word), explicit first names are keyed even when common or a library word, library words are lowercase-only", () => {
  assert.ok(!isGenericName("Thun Der", null) && !isGenericName("Thun Der", { has: () => true }));
  assert.ok(keys(researchMembersFor([{ slug: "td", name: "Thun Der" }])).includes("thun der"));
  const lib = libraryWords([{ id: "a/b", title: "Mason Hunter", blurb: "", facts: [{ key: "k", value: "Mason and Hunter appear only capitalised here." }] }]);
  assert.ok(!lib.has("mason") && !lib.has("hunter"), "capitalised words are names, not library words");
  const m = researchMembersFor([{ slug: "zedex", name: "ZedEx", fields: { first_name: { value: "Hunter" }, real_name: "Mason Vale" } }], { has: () => true });
  const k = keys(m);
  assert.ok(k.includes("hunter") && k.includes("mason") && k.includes("vale"), "explicit first names are keys even if every word is a library word");
});

test("R2.5 libraryWords is lazy and cached: nothing is scanned until has() is called, a rebuilt array with the same content reuses the set", () => {
  let reads = 0;
  const mk = () => [{ id: "a/b", title: "T", blurb: "", facts: [{ key: "k", get value() { reads++; return "plain lowercase words here"; } }] }];
  const lib = libraryWords(mk());
  const after = reads; // the signature reads each fact value once for its length
  assert.ok(!researchMembersFor([{ slug: "zedex", name: "ZedEx" }], lib).some((m) => m.display === "Nobody"));
  assert.equal(reads, after, "a party with no alt or first name never builds the word set");
  assert.ok(lib.has("lowercase"));
  const built = reads;
  assert.ok(libraryWords(mk()).has("lowercase"));
  assert.equal(reads - built, 1 + 0, "same content, new array: only the signature pass reads values again, the set is reused");
});

test("C. genericAliases is the single mechanism: every explicit entry is rejected, and ordinary handles are not", () => {
  for (const g of genericAliases) assert.ok(isGenericName(g, new Set()), g);
  for (const n of ["Quillon", "ZedEx", "Mirabel", "Grukthar"]) assert.ok(!isGenericName(n, new Set()), n);
});
