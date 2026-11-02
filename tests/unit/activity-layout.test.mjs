// Q08: portrait lock and data-layout in js/brain.js, driven by a stubbed Discord SDK. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../js/brain.js"), "utf8");

function load() {
  const dataset = {};
  const win = { addEventListener() {} };
  const ctx = { window: win, document: { documentElement: { dataset }, addEventListener() {} }, location: { hostname: "", search: "", hash: "", protocol: "file:" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, history: {}, console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => Promise.reject(new Error("no network")) };
  ctx.self = ctx.globalThis = ctx;
  vm.runInNewContext(SRC, ctx);
  return { brain: win.BoardBrain, dataset };
}
function stub(platform, over = {}) {
  const calls = [], subs = {};
  return { calls, subs, platform, commands: { setOrientationLockState: async (a) => { calls.push(a); } }, subscribe: async (n, f) => { subs[n] = f; }, ...over };
}

test("mobile: locks portrait, leaves PiP and grid unlocked, sets data-layout", async () => {
  for (const p of ["mobile", "ios", "android"]) {
    const { brain, dataset } = load(), sdk = stub(p);
    assert.equal(await brain.lockLayout(sdk), true);
    assert.equal(JSON.stringify(sdk.calls), JSON.stringify([{ lock_state: 2, picture_in_picture_lock_state: 1, grid_lock_state: 1 }]));
    assert.deepEqual(Object.keys(sdk.subs).sort(), ["ACTIVITY_LAYOUT_MODE_UPDATE", "ORIENTATION_UPDATE"]);
    sdk.subs.ORIENTATION_UPDATE({ screen_orientation: 0 });
    sdk.subs.ACTIVITY_LAYOUT_MODE_UPDATE({ layout_mode: 1 });
    assert.equal(dataset.layout, "portrait-pip");
    sdk.subs.ACTIVITY_LAYOUT_MODE_UPDATE({ layout_mode: 2 });
    assert.equal(dataset.layout, "portrait-grid");
  }
});

test("desktop and missing SDK: no lock, no subscribe", async () => {
  const { brain, dataset } = load(), sdk = stub("desktop");
  assert.equal(await brain.lockLayout(sdk), false);
  assert.equal(sdk.calls.length, 0);
  assert.equal(Object.keys(sdk.subs).length, 0);
  assert.equal(await brain.lockLayout(null), false);
  assert.equal(dataset.layout, undefined);
});

test("every call is guarded: throwing SDK never escapes", async () => {
  const { brain } = load();
  const bad = stub("mobile", { subscribe: () => { throw new Error("x"); }, commands: { setOrientationLockState: async () => { throw new Error("y"); } } });
  assert.equal(await brain.lockLayout(bad), false);
  assert.equal(await brain.lockLayout({ get platform() { throw new Error("z"); } }), false);
});

test("junk event payloads are ignored", async () => {
  const { brain, dataset } = load(), sdk = stub("mobile");
  await brain.lockLayout(sdk);
  sdk.subs.ORIENTATION_UPDATE(null);
  sdk.subs.ACTIVITY_LAYOUT_MODE_UPDATE({ layout_mode: 99 });
  assert.equal(dataset.layout, undefined);
});
