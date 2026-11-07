// Cinematic slice 4: the pure math of js/light.js (light vector from pointer or tilt, clamps, ease, quantise, and when the moving light is allowed). No browser.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { math: M } = createRequire(import.meta.url)("../../js/light.js");

test("vector maps the pointer to [-1, 1] and clamps outside the viewport", () => {
  assert.deepEqual(M.vector(0, 0, 1000, 500), { x: -1, y: -1 });
  assert.deepEqual(M.vector(500, 250, 1000, 500), { x: 0, y: 0 });
  assert.deepEqual(M.vector(1000, 500, 1000, 500), { x: 1, y: 1 });
  assert.deepEqual(M.vector(-50, 9999, 1000, 500), { x: -1, y: 1 });
  assert.deepEqual(M.vector(NaN, Infinity, 0, 0), { x: -1, y: -1 }, "garbage in, finite and clamped out");
});
test("fromTilt is relative to the resting pose and clamps", () => {
  assert.deepEqual(M.fromTilt(10, 20, 10, 20), { x: 0, y: 0 });
  assert.equal(M.fromTilt(19, 0, 10, 0).x, 0.5);
  assert.equal(M.fromTilt(500, -500, 0, 0).x, 1);
  assert.equal(M.fromTilt(500, -500, 0, 0).y, -1);
  assert.equal(M.fromTilt(null, undefined, 0, 0).x, 0);
});
test("lampAt stays inside the viewport for any vector", () => {
  for (const v of [{ x: -9, y: -9 }, { x: 9, y: 9 }, { x: 0, y: 0 }, { x: 0.3, y: -0.2 }]) {
    const p = M.lampAt(v, 390, 844);
    assert.ok(p.x >= 0 && p.x <= 390 && p.y >= 0 && p.y <= 844, JSON.stringify(p));
  }
  assert.deepEqual(M.lampAt({ x: 0, y: 0 }, 400, 800), { x: 200, y: 400 });
});
test("ease moves toward the target, never past it, and is frame-rate independent", () => {
  const one = M.ease(0, 1, 33.4, 0.18), two = M.ease(M.ease(0, 1, 16.7, 0.18), 1, 16.7, 0.18);
  assert.ok(Math.abs(one - two) < 1e-9);
  assert.ok(M.ease(0, 1, 16.7, 0.18) > 0 && M.ease(0, 1, 100000, 1) <= 1);
  assert.equal(M.ease(0.5, 0.5, 16.7, 0.18), 0.5);
});
test("quant steps in 0.1", () => { assert.equal(+M.quant(0.34, 0.1).toFixed(1), 0.3); assert.equal(+M.quant(-0.96, 0.1).toFixed(1), -1); });
test("active: off for reduced motion, the Calm switch, calm html, a hidden tab", () => {
  assert.equal(M.active({}), true);
  for (const k of ["reduced", "calmUser", "calmHtml", "hidden"]) assert.equal(M.active({ [k]: true }), false, k);
});
