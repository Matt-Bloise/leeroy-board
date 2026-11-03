// B44 (2026-11-03): at 384x216 (and again at 320x568) in Firefox the fixed bottom bar covered the primary button "Show me what is next" and it could not be tapped.
// Cause: html.ga-one #panel-tonight used plain `align-content: center !important`, which pushes overflow above the scrollable area, and Firefox did not count the panel's overflow
// when scrolling #sheet-body. This test pins the one rule that fixes it; the behaviour itself is covered by the cross-engine layout sweep (member state, small sizes, Firefox).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const css = fs.readFileSync(path.join(root, "scenes", "guided-atlas.css"), "utf8");
const rule = css.split(/\r?\n/).find((l) => l.startsWith("html.ga-one #panel-tonight { align-content")) || "";

test("the tonight panel is centred with `safe center`, never plain center (overflow must stay reachable)", () => {
  assert.ok(rule, "the rule exists");
  assert.match(rule, /align-content: safe center !important/);
  assert.ok(!/align-content: center/.test(css.split(/\r?\n/).filter((l) => l.includes("#panel-tonight")).join(" ")), "plain center would push overflow above the scroll area");
});

test("the tonight panel is at least as tall as its content at every size, so #sheet-body scrolls to the primary button", () => {
  assert.match(rule, /min-height: min-content !important/);
});
