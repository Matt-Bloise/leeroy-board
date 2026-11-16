// The layout sweep's click wait scales with the page's pixel count (CI: a 5120x2880 cell timed out at a flat 20 s twice in a row on a slow runner).
// layout-sweep.mjs is a CLI that runs on import, so the pure function is read out of its source and evaluated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../browser/layout-sweep.mjs", import.meta.url), "utf8");
const m = /const pressTimeout = (\([^)]*\) => [^\n;]+;)/.exec(src);
const pressTimeout = m ? new Function(`return ${m[1].replace(/;$/, "")}`)() : null;
test("pressTimeout is defined in the sweep and used as press()'s default", () => {
  assert.ok(pressTimeout, "pressTimeout not found");
  assert.match(src, /async function press\(page, locator, timeout = null\)/);
  assert.match(src, /timeout = pressTimeout\(vp\.width, vp\.height\)/);
});
test("20 s up to full HD, scaled beyond it, capped at 3x", () => {
  assert.equal(pressTimeout(390, 844), 20000);
  assert.equal(pressTimeout(1366, 768), 20000);
  assert.equal(pressTimeout(1920, 1080), 20000);
  assert.equal(pressTimeout(2560, 1440), Math.round(20000 * (2560 * 1440) / (1920 * 1080)));
  assert.equal(pressTimeout(3840, 2160), 60000);
  assert.equal(pressTimeout(5120, 2880), 60000);
  assert.equal(pressTimeout(undefined, undefined), 20000);
});
