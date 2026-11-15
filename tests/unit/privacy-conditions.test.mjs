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
  const lib = libraryWords([{ title: "Frostbite", blurb: "", facts: [{ key: "a", value: "Frostbite slows targets. Elixir of Brilliance lasts one hour." }] }]);
  assert.ok(isGenericName("Frostbite", lib) && isGenericName("elixir", lib));
  assert.ok(!isGenericName("Quillon", lib));
  assert.ok(!keys(researchMembersFor([{ slug: "f", name: "Frostbite" }], lib)).includes("frostbite"));
  assert.ok(keys(researchMembersFor([{ slug: "q", name: "Quillon" }], lib)).includes("quillon"));
});

test("C. genericAliases is the single mechanism: every explicit entry is rejected, and ordinary handles are not", () => {
  for (const g of genericAliases) assert.ok(isGenericName(g, new Set()), g);
  for (const n of ["Quillon", "ZedEx", "Mirabel", "Grukthar"]) assert.ok(!isGenericName(n, new Set()), n);
});
