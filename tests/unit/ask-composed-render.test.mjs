// Rendering of composed and picked facts (ask-composed.js labelOf, factParts, composeFactsBlock): labels that stand alone, and a cap that never drops silently.
// Fictional pages and facts only. No AI, no network. Run: node --test tests/unit/ask-composed-render.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { labelOf, factParts, composeFactsBlock, BLOCK_MAX_CHARS } from "../../infrastructure/worker/ask-composed.js";

test("labelOf keeps the key segments the page does not name, so a line keeps its subject", () => {
  // the raid lives in the key, not in the page title: the last segment alone ("crowns") lost it
  assert.equal(labelOf("glass_spire.crowns", "events/vaults-open-day-3", "Vaults open on day 3"), "glass spire crowns");
  // the faction lives in a middle segment: "owlkin" alone lost it
  assert.equal(labelOf("kinds.sunward.owlkin", "kinds/overview", "Kinds and calling combinations"), "sunward owlkin");
  // a segment the title already names is left out (also when one word starts the other, 4+ letters)
  assert.equal(labelOf("mirefen.size", "vaults/mirefens-hollow", "Mirefen's Hollow"), "size");
  assert.equal(labelOf("lantern.tide.bulwark", "callings/lantern", "Lantern"), "tide bulwark");
  // the last segment is always kept, even when the title names it
  assert.equal(labelOf("lantern", "callings/lantern", "Lantern"), "lantern");
  // short words never match by prefix: "tid" does not count as named by "tide"
  assert.equal(labelOf("tid.cap", "x/tide", "Tide"), "tid cap");
  assert.equal(labelOf("", "x/y", "Y"), "");
  assert.equal(labelOf("a__b..c", "x/y", "Y"), "a b c");
});

test("factParts uses the standalone label, and the rendered line carries title, label and value", () => {
  const p = factParts({ page: "events/vaults-open-day-3", key: "glass_spire.crowns", value: "13", title: "Vaults open on day 3" });
  assert.equal(p.label, "glass spire crowns");
  const b = composeFactsBlock([{ page: "kinds/overview", key: "kinds.sunward.owlkin", value: "Marsh, Reed", title: "Kinds and calling combinations" }]);
  assert.equal(b.lines[0], "- **Kinds and calling combinations** · sunward owlkin: Marsh, Reed");
});

test("composeFactsBlock reports every fact the cap leaves out; with maxChars Infinity nothing is left out", () => {
  const long = (k) => ({ page: `p/${k}`, key: `k.${k}`, value: "w ".repeat(140).trim(), title: `T${k}` });
  const facts = [long("a"), long("b"), long("c")];
  const capped = composeFactsBlock(facts, { max: 3, maxChars: BLOCK_MAX_CHARS });
  assert.ok(capped.lines.length < 3);
  assert.equal(capped.used.length + capped.dropped.length, 3, "every fact is either used or reported as dropped");
  const all = composeFactsBlock(facts, { max: 3, maxChars: Infinity });
  assert.equal(all.used.length, 3);
  assert.deepEqual(all.dropped, []);
});

// ---- safety review of ask-composed.js (normaliser, masked links, WHO slot) -----------------------------------------------------------
import { norm, nfkcChangesNumber, hasMaskedLink, factRefusal, composeAnswer, checkOpener, fallbackOpener, verifyComposed, whoPhrases } from "../../infrastructure/worker/ask-composed.js";
const ch = (n) => String.fromCodePoint(n);

test("the normaliser never joins two tokens: separators, zero-width and control characters become a space", () => {
  for (const c of [0x200b, 0x2028, 0x2029, 0x85, 0x0c, 0x0b, 0x1f, 0x200d, 0xad, 0x2060, 0xfeff]) {
    assert.equal(norm(`60${ch(c)}30 gold`), "60 30 gold", c.toString(16));
    assert.equal(norm(`Ashen${ch(c)}Vale`), "Ashen Vale", c.toString(16));
  }
});

test("a number NFKC would change is refused, never rewritten: the fact is not rendered and an answer holding it fails the proof", () => {
  for (const v of ["level 60\u00B9", "10\u00B2 yards", "5\u00BD gold", "\u2460open", "\uFF16\uFF10 gold", "\u2167 bosses"]) {
    assert.equal(nfkcChangesNumber(v), true, v);
    const fact = { page: "dungeons/glimmer", key: "glimmer.note", value: v, title: "Glimmer" };
    assert.match(factRefusal(fact), /NFKC/, v);
    const c = composeAnswer({ question: "q", retrievedFacts: [fact] });
    assert.equal(c.ok, false, v);
    assert.equal(verifyComposed(`Here is what I found.\n\n- **Glimmer** · note: ${v}`, [{ ...fact, value: "safe" }]).ok, false, v);
  }
  for (const v of ["level 60", "28-33", "5%", "\u0663 coins"]) assert.equal(nfkcChangesNumber(v), false, v);
  // letters NFKC folds (a ligature, fullwidth letters) are not numbers and still render
  assert.equal(factRefusal({ page: "a/b", key: "b.c", value: "\uFB01ne \uFF21sh", title: "B" }), "");
});

test("masked-link syntax left in a fact is refused whatever its length; a plain link is still shown as its label", () => {
  const long = `[the guide](https://evil.example/${"a".repeat(620)})`;
  const label420 = `[${"w ".repeat(210)}](https://evil.example/x)`;
  for (const v of [long, label420, '[x](https://evil.example/x "t")', "see [x] (https://evil.example)", "a ](b"]) {
    assert.equal(hasMaskedLink(norm(v).replace(/\[([^\]\n]{0,300})\]\(<?([^)>\s]{0,600})>?\)/g, "$1")), true, v.slice(0, 40));
    assert.match(factRefusal({ page: "a/b", key: "b.c", value: v, title: "B" }), /masked-link/, v.slice(0, 40));
  }
  assert.match(factRefusal({ page: "a/b", key: "[x](https://evil.example/y \"t\")", value: "ok", title: "B" }), /masked-link/, "in the key (label)");
  assert.match(factRefusal({ page: "a/b", key: "b.c", value: "ok", title: "[B](https://evil.example/q \"t\")" }), /masked-link/, "in the title");
  assert.equal(factRefusal({ page: "a/b", key: "b.c", value: "see [the guide](https://board.test/x) here", title: "B" }), "");
  const start = Date.now();
  hasMaskedLink("]".repeat(200000) + " ".repeat(200000));
  hasMaskedLink("[".repeat(200000));
  assert.ok(Date.now() - start < 500, "linear");
});

test("the WHO slot takes only whole known race, class, spec and role values, never words mixed across fields", () => {
  const bad = [
    [{ race: "free", spec: "epic", class: "mount" }, "Here is what I found for your free epic mount."],
    [{ race: "blood elf", class: "death knight" }, "Here is what I found for your blood knight."],
    [{ race: "blood elf", class: "death knight" }, "Here is what I found for your blood elf death knight."],
    [{ race: "human", class: "paladin", spec: "tank every dungeon" }, "Here is what I found for your tank."],
    [{ race: "human", class: "paladin" }, "Here is what I found for your paladin human."],
    [{ race: "night elf", class: "druid" }, "Here is what I found for your night druid."],
  ];
  for (const [b, t] of bad) assert.equal(checkOpener(t, { sheet: b, askerBuild: b, partyNames: [] }).ok, false, t);
  const good = { race: "night elf", class: "druid", spec: "feral", role: "tank" };
  for (const t of ["your night elf", "your druid", "your feral", "your tank", "your night elf druid", "your feral druid", "your night elf feral druid"]) {
    assert.ok(checkOpener(`Here is what I found for ${t}.`, { sheet: good, askerBuild: good, partyNames: [] }).ok, t);
  }
  assert.deepEqual([...whoPhrases(null, { race: "free", spec: "epic", class: "mount" })], []);
  assert.equal(fallbackOpener({ question: "q", askerBuild: { race: "free", spec: "epic", class: "mount" } }).includes("your"), false);
  assert.match(fallbackOpener({ question: "q", askerBuild: good }), /your night elf feral druid/);
});
