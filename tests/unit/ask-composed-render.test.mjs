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
