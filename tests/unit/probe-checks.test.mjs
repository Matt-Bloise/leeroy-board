// The judging rules of the production probe (tests/browser/prod-probe.mjs), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { junkIn, wrongCountCopy, memberCountProblem, slugOf } from "../helpers/probe-checks.mjs";

test("member count: equal passes, any difference fails", () => {
  assert.deepEqual(memberCountProblem(6, 6), []);
  assert.equal(memberCountProblem(5, 6).length, 1);
  assert.equal(memberCountProblem(7, 6).length, 1);
  assert.equal(memberCountProblem(0, 0).length, 1, "an empty reference is itself a failure");
});

test("a typed five with six members fails; with five members it passes", () => {
  assert.equal(wrongCountCopy(["Swipe sideways for all five."], 6).length, 1);
  assert.equal(wrongCountCopy(["Which of the five are you?"], 7).length, 1);
  assert.deepEqual(wrongCountCopy(["Swipe sideways for all five."], 5), []);
  assert.deepEqual(wrongCountCopy(["Swipe sideways for all six."], 6), []);
});

test("other typed counts: the other four, all five of us, the four of you", () => {
  assert.equal(wrongCountCopy(["Ask the other four"], 6).length, 1);
  assert.equal(wrongCountCopy(["Ask the other five"], 6).length, 1, "five is wrong for six members whatever it counts");
  assert.equal(wrongCountCopy(["the four of you"], 6).length, 1);
  assert.deepEqual(wrongCountCopy(["the six of you"], 6), []);
});

test("phrases about five of something else are not the party", () => {
  assert.deepEqual(wrongCountCopy(["The dial steps five points more", "a group of five players", "three of five still travel", "Read from five places"], 6), []);
});

test("junk text: undefined, NaN, [object Object], raw ids", () => {
  for (const bad of ["Level undefined", "NaN gold", "[object Object]", "id 123456789012345678", "x 3f2504e0-4f89-11d3-9a0c-0305e82c3301", "{{name}}", "null"]) assert.equal(junkIn([bad]).length, 1, bad);
  assert.deepEqual(junkIn(["Brindle Oakhand, Tauren Druid", "Level 60 in 4 weeks", "1,234 gold", "Nullify the curse", "Not a number"]), []);
});

test("slugs match the board's own", () => { assert.equal(slugOf("Brindle  Oakhand!"), "brindle-oakhand"); });
