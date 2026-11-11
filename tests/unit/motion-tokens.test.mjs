// Slice 0: the CSS motion tokens list the cinematic verbs, use the one ease, and stay inside the duration tiers of the cinematic grammar.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const css = fs.readFileSync(path.join(root, "css/motion-tokens.css"), "utf8");
const firstRoot = css.split("@media")[0];
const cssMs = Object.fromEntries([...firstRoot.matchAll(/--cin-t-([a-z]+):\s*(\d+)ms;/g)].map((m) => [m[1], Number(m[2])]));
const TIERS = { acknowledge: [80, 120], hover: [80, 120], commit: [160, 250], refuse: [160, 250], open: [300, 400], close: [240, 400], arrive: [300, 400], milestone: [600, 600], ambient: [2000, 12000] };

test("CSS tokens list exactly the cinematic verbs", () => {
  assert.deepEqual(Object.keys(cssMs).sort(), Object.keys(TIERS).sort());
});
test("the one ease is declared in CSS", () => {
  const m = /--cin-ease:\s*([^;]+);/.exec(css);
  assert.ok(m, "--cin-ease declared");
  assert.equal(m[1].replace(/\s+/g, ""), "cubic-bezier(.22,1,.36,1)");
});
test("every duration sits inside its tier", () => {
  for (const [verb, ms] of Object.entries(cssMs)) assert.ok(ms >= TIERS[verb][0] && ms <= TIERS[verb][1], `${verb} ${ms} ms outside ${TIERS[verb].join("-")}`);
  assert.ok(cssMs.close < cssMs.open, "exits are shorter than entrances");
});
test("reduced motion collapses every non-ambient token", () => {
  const rm = css.split("@media (prefers-reduced-motion: reduce)")[1] || "";
  for (const verb of Object.keys(cssMs).filter((v) => v !== "ambient")) assert.ok(rm.includes(`--cin-t-${verb}: 1ms;`), verb);
});
