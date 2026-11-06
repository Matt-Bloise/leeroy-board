// Slice 0: the CSS and JS motion tokens agree, use the one ease, and stay inside the duration tiers of the cinematic grammar.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const css = fs.readFileSync(path.join(root, "css/motion-tokens.css"), "utf8");
const js = await import(pathToFileURL(path.join(root, "js/motion-tokens.js")).href);
const firstRoot = css.split("@media")[0];
const cssMs = Object.fromEntries([...firstRoot.matchAll(/--cin-t-([a-z]+):\s*(\d+)ms;/g)].map((m) => [m[1], Number(m[2])]));
const TIERS = { acknowledge: [80, 120], hover: [80, 120], commit: [160, 250], refuse: [160, 250], open: [300, 400], close: [240, 400], arrive: [300, 400], milestone: [600, 600], ambient: [2000, 12000] };

test("CSS and JS tokens list the same verbs with the same milliseconds", () => {
  assert.deepEqual(cssMs, { ...js.CIN_DURATION });
  assert.deepEqual([...js.CIN_VERBS].sort(), Object.keys(TIERS).sort());
});
test("the one ease is the same in CSS and JS", () => {
  const m = /--cin-ease:\s*([^;]+);/.exec(css);
  assert.ok(m, "--cin-ease declared");
  assert.equal(m[1].replace(/\s+/g, ""), js.CIN_EASE.replace(/\s+/g, ""));
  assert.equal(js.CIN_EASE.replace(/\s+/g, ""), "cubic-bezier(.22,1,.36,1)");
});
test("every duration sits inside its tier", () => {
  for (const [verb, ms] of Object.entries(js.CIN_DURATION)) assert.ok(ms >= TIERS[verb][0] && ms <= TIERS[verb][1], `${verb} ${ms} ms outside ${TIERS[verb].join("-")}`);
  assert.ok(js.CIN_DURATION.close < js.CIN_DURATION.open, "exits are shorter than entrances");
});
test("reduced motion collapses every non-ambient token", () => {
  const rm = css.split("@media (prefers-reduced-motion: reduce)")[1] || "";
  for (const verb of Object.keys(js.CIN_DURATION).filter((v) => v !== "ambient")) assert.ok(rm.includes(`--cin-t-${verb}: 1ms;`), verb);
});
