// ASK_COMPOSED relevance (ask-composed.js selectComposedFacts, buildIsTopical): which facts a composed answer shows, and when it names the asker's build.
// Fictional facts and builds only. No AI, no network. Run: node --test tests/unit/ask-composed-relevance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { selectComposedFacts, buildIsTopical, relevanceOf, COMPOSED_FLOOR, COMPOSED_MAX_FACTS } from "../../infrastructure/worker/ask-composed.js";
import { selectRelevant } from "../../infrastructure/worker/self-rag.js";

const hit = (page, key, value) => ({ page, key, value, score: 1 });
const S = (pairs) => pairs.map(([h, c]) => ({ h, c }));

test("only facts that clear the floor and most of the best coverage are shown, best first, at most two", () => {
  const a = hit("classes/mage", "mage.role", "ranged damage"), b = hit("zones/x", "x.y", "a place"), c = hit("classes/mage", "mage.frost", "slows"), d = hit("p/q", "r", "s");
  const got = selectComposedFacts(S([[b, 0.45], [a, 0.9], [c, 0.75], [d, 0.95]]));
  assert.deepEqual(got, [d, a], "0.95 and 0.9; 0.75 is under 0.8 x 0.95; never more than two");
  assert.equal(COMPOSED_MAX_FACTS, 2);
});

test("when the best fact covers less than the floor, nothing is shown (the caller then abstains)", () => {
  const a = hit("a/b", "k", "v");
  assert.deepEqual(selectComposedFacts(S([[a, COMPOSED_FLOOR - 0.01]])), []);
  assert.deepEqual(selectComposedFacts([]), []);
  assert.deepEqual(selectComposedFacts(null), []);
  assert.deepEqual(selectComposedFacts(S([[a, Number.NaN]])), []);
});

test("ties keep the ranker's order", () => {
  const a = hit("a/a", "k", "1"), b = hit("b/b", "k", "2");
  assert.deepEqual(selectComposedFacts(S([[a, 0.7], [b, 0.7]])), [a, b]);
});

test("selectRelevant reports a coverage for every kept hit, parallel to hits, without changing the hits", () => {
  const hays = ["mage frost nova slows enemies", "warrior charge rush", "priest heals"];
  const hits = [{ page: "classes/mage", key: "mage.nova", value: "frost nova slows enemies", score: 3 }, { page: "classes/warrior", key: "w.c", value: "charge rush", score: 1 }];
  const r = selectRelevant(hits, ["frost", "nova"], hays);
  assert.equal(r.coverage.length, r.hits.length);
  assert.ok(r.coverage.every((c) => c >= 0 && c <= 1));
  assert.deepEqual(Object.keys(r.hits[0]).sort(), ["key", "page", "score", "value"], "no field is added to a hit");
});

const BUILD = { race: "Gnome", class: "Mage", spec: "Frost", role: "damage", professions: ["Tailoring"] };

test("the build is named for a real reason: the question is about it, or a shown fact is about the asker's class, race, spec or professions", () => {
  assert.equal(buildIsTopical("explicit build phrase", [], BUILD), true);
  assert.equal(buildIsTopical("asker names own class or race", [], BUILD), true);
  assert.equal(buildIsTopical("default", [hit("classes/mage", "mage.role", "ranged damage and crowd control")], BUILD), true, "a Mage page");
  assert.equal(buildIsTopical("default", [hit("professions/tailoring", "tailoring.bags", "makes bags")], BUILD), true, "the asker's profession");
  assert.equal(buildIsTopical("default", [hit("systems/realms", "realms.pvp", "a PvP realm lets players attack each other")], BUILD), false, "a topic unrelated to the build");
  assert.equal(buildIsTopical("explicit build phrase", [], null), false, "no build, nothing to name");
});

test("build words match whole words only: Mage is not inside image", () => {
  assert.equal(buildIsTopical("default", [hit("ui/screens", "ui.image", "the loading image shows a castle")], { race: "", class: "Mage", spec: "" }), false);
  assert.equal(buildIsTopical("default", [hit("races/elves", "elf.start", "an elf starts in a grove")], { race: "Elf", class: "", spec: "" }), true);
});

test("relevance weights coverage by the ranker's score: a low-ranked fact with the same coverage counts for less", () => {
  assert.equal(relevanceOf(0.8, 10, 10), 0.8);
  assert.equal(relevanceOf(0.8, 0, 10), 0.4);
  assert.ok(relevanceOf(0.8, 2, 10) < relevanceOf(0.8, 8, 10));
  const top = { ...hit("a/a", "k", "1"), score: 10 }, low = { ...hit("b/b", "k", "2"), score: 1 };
  assert.deepEqual(selectComposedFacts(S([[low, 0.9], [top, 0.8]])), [top], "0.9 x 0.55 = 0.495 is under 0.8 x 0.8");
});

test("an asker speaking about themselves makes the build part of the question", () => {
  assert.equal(buildIsTopical("default", [], BUILD, "what should I do first at launch?"), true);
  assert.equal(buildIsTopical("default", [], BUILD, "is my build good for dungeons"), true);
  assert.equal(buildIsTopical("default", [], BUILD, "when do raids open?"), false);
  assert.equal(buildIsTopical("default", [], null, "what should I do"), false, "no build, nothing to name");
});
