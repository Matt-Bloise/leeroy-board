// Pure unit tests for repairHouseVoice and webBoardLinks. No network, no D1, no AI.
// Run: node --test tests/unit/format.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { repairHouseVoice, webBoardLinks, webBoardLinksDeep } from "../../infrastructure/worker/ai-models.js";

test("newlines and blank lines survive", () => {
  const out = repairHouseVoice("**Lead line here for the answer.**\n\nSecond chunk of text.\nMage - ranged\nDruid - any role");
  assert.equal(out, "**Lead line here for the answer.**\n\nSecond chunk of text.\nMage - ranged\nDruid - any role");
});

test("runs of spaces and tabs collapse, line-end spaces trimmed", () => {
  const out = repairHouseVoice("A mage   is\t\ta fine pick   \nSecond line stays here");
  assert.equal(out, "A mage is a fine pick\nSecond line stays here");
});

test("three or more blank lines become one blank line", () => {
  assert.equal(repairHouseVoice("First paragraph here.\n\n\n\nSecond paragraph here."), "First paragraph here.\n\nSecond paragraph here.");
});

test("first name replaced", () => {
  assert.match(repairHouseVoice("Alex brings the snacks to the dungeon run.", { nameMap: { Alex: "Red Fox" } }), /^Red Fox brings/);
});

test("Skippy replaced", () => {
  assert.match(repairHouseVoice("Skippy says the mage is a good pick."), /^Leeroy says/);
});

test("only one bold span survives", () => {
  const out = repairHouseVoice("**One** of the picks and **two** of them and **three** more");
  assert.equal(out.match(/\*\*/g).length, 2);
  assert.ok(out.startsWith("**One**"));
});

test("imperative opener stripped per line", () => {
  const out = repairHouseVoice("The mage is a flexible class in groups.\nDon't forget the water.\nWorth a look: Polymorph.");
  assert.ok(!/Don't forget/.test(out));
  assert.ok(out.includes("\n"));
  assert.ok(out.includes("Worth a look: Polymorph."));
});

test("multi-line sample with a Sources line keeps its line break", () => {
  const raw = "**A mage is a strong pick.** Ranged damage.\n\nMage - ranged damage\nDruid - any role\n\n-# Sources: [classes/mage]\n-# {board:library.classes.mage}";
  const out = repairHouseVoice(raw);
  assert.equal(out, raw);
  assert.ok(out.includes("\n-# Sources: [classes/mage]\n-# {board"));
});

test("webBoardLinks converts a valid token to a plain link", () => {
  assert.equal(webBoardLinks("Text\n-# {board:library.classes.mage}"), "Text\n-# https://leeroy.party/#library.classes.mage");
});

test("webBoardLinks removes an invalid token", () => {
  assert.equal(webBoardLinks("Text {board:Bad Token!} end"), "Text  end");
  assert.equal(webBoardLinks("Text\n-# {board:}"), "Text\n-#");
});

test("webBoardLinks passes null through", () => {
  assert.equal(webBoardLinks(null), null);
});

test("webBoardLinksDeep converts tokens nested in objects and arrays", () => {
  const input = { stats: { recent: [{ a: "Hi\n-# {board:library.classes.mage}", q: "plain" }] }, n: 3, z: null };
  const out = webBoardLinksDeep(input);
  assert.equal(out.stats.recent[0].a, "Hi\n-# https://leeroy.party/#library.classes.mage");
  assert.equal(out.stats.recent[0].q, "plain");
  assert.equal(out.n, 3);
  assert.equal(out.z, null);
  assert.ok(!JSON.stringify(out).includes("{board:"));
});

test("webBoardLinksDeep drops malformed tokens and does not mutate its input", () => {
  const input = { a: ["x {board:Bad Token!} y"] };
  const out = webBoardLinksDeep(input);
  assert.equal(out.a[0], "x  y");
  assert.equal(input.a[0], "x {board:Bad Token!} y");
});

test("webBoardLinksDeep returns the same reference when nothing changes", () => {
  const input = { a: [1, "two", { b: "three" }] };
  assert.equal(webBoardLinksDeep(input), input);
  assert.equal(webBoardLinksDeep("untouched  "), "untouched  ");
});
