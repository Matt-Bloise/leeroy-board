// Pure unit tests for infrastructure/worker/image-rule.js. No network, no D1, no AI.
// Run: node --test tests/unit/image-rule.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldRenderImage, namesKnownTooltip, carriesNumberOrDate } from "../../infrastructure/worker/image-rule.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tips = JSON.parse(fs.readFileSync(path.join(root, "data/library/tooltips.json"), "utf8"));
const names = tips.names;

test("a question naming a spell in tooltips.json gets a picture even when the answer has no number", () => {
  assert.equal(shouldRenderImage("What does Frostbolt do?", "It slows the target.", names), true);
  assert.equal(shouldRenderImage("is fireball any good", "Yes, for leveling.", names), true);
});

test("names match on whole words only and are case and punctuation tolerant", () => {
  assert.equal(namesKnownTooltip("ARCANE INTELLECT, please!", names), true);
  assert.equal(namesKnownTooltip("fireballs everywhere", names), false);
  assert.equal(namesKnownTooltip("", names), false);
});

test("an answer with a number or a date gets a picture", () => {
  assert.equal(shouldRenderImage("when is launch", "Launch is November 4 at 6 PM.", names), true);
  assert.equal(shouldRenderImage("how much", "It costs 1,200 gold.", names), true);
  assert.equal(shouldRenderImage("when", "Dates: 2026-11-04.", names), true);
  assert.equal(shouldRenderImage("when", "Late in November, they say.", names), false);
});

test("plain prose with no tooltip name and no number gets no picture", () => {
  assert.equal(shouldRenderImage("who should tank", "Whoever likes standing in front.", names), false);
  assert.equal(carriesNumberOrDate("a1b2 is a code"), false);
});

test("an empty or non-string answer never gets a picture, and bad names input is safe", () => {
  assert.equal(shouldRenderImage("frostbolt", "", names), false);
  assert.equal(shouldRenderImage("frostbolt", null, names), false);
  assert.equal(shouldRenderImage("frostbolt", "ok 5", undefined), true);
  assert.equal(shouldRenderImage("frostbolt", "ok", null), false);
  assert.equal(shouldRenderImage("frostbolt", "ok", new Set(["frostbolt"])), true);
  assert.equal(shouldRenderImage("fire", "ok", ["fi"]), false);
});
