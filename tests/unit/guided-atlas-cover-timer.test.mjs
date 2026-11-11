// Nightly "API held for 12 s | repeat visit" failures (Nov 6, 8 and 11 2026): a returning member's board stayed blank. scenes/guided-atlas.js puts html.ga-pre on the page
// (css: `html.ga-pre #board { visibility: hidden }`) so the wall does not flash before the atlas builds. The only timer that removed it sat inside the "booted" handler, and
// "booted" fires after the board data has arrived, so a held or failed API left the whole board invisible with the opening card already gone. The cover now arms its own 3 s timer
// when it is added. This test runs the script against a minimal page, never fires "booted", and requires the cover to be removed by a timer of 3000 ms or less.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = fs.readFileSync(path.join(root, "scenes", "guided-atlas.js"), "utf8");

function run({ store }) {
  const classes = new Set(), timers = [], listeners = {};
  const documentElement = { dataset: {}, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
  const doc = { head: {}, body: {}, documentElement, activeElement: null, addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ setAttribute() {}, append() {}, classList: { add() {} } }) };
  const kit = { MEM: { member: () => null, me: () => store["board-me"] || null }, $: () => null, h: () => ({}), SC: { open: null }, D: {}, on: (ev, f) => { (listeners[ev] ||= []).push(f); } };
  const win = {
    __boardKit: kit, BoardFetch: null, BoardBrain: null, document: doc, location: { search: "?preview=1", hash: "" }, innerWidth: 1366, innerHeight: 768,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} }, addEventListener() {}, matchMedia: () => ({ matches: false }),
    setTimeout: (f, ms) => { timers.push({ f, ms: ms || 0 }); return timers.length; }, clearTimeout() {}, requestAnimationFrame: undefined, fetch: () => new Promise(() => {}),
  };
  win.window = win;
  vm.runInNewContext(src, win, { filename: "guided-atlas.js" });
  return { classes, timers, listeners };
}

test("a remembered member gets the cover, and a timer of at most 3 s removes it even though booted never fires", () => {
  const { classes, timers, listeners } = run({ store: { "board-me": "some-member" } });
  assert.ok(classes.has("ga-pre"), "the cover is added for a remembered member");
  assert.ok((listeners.booted || []).length > 0, "the booted handler is still registered (the data path is unchanged)");
  const due = timers.filter((t) => t.ms <= 3000);
  let removed = false;
  for (const t of due) { try { t.f(); } catch (e) {} if (!classes.has("ga-pre")) { removed = true; break; } }
  assert.ok(removed, "a timer of 3000 ms or less removes html.ga-pre without a booted event");
});

test("no cover for a first visit or for just-looking", () => {
  assert.ok(!run({ store: {} }).classes.has("ga-pre"));
  assert.ok(!run({ store: { "board-me": "just-looking" } }).classes.has("ga-pre"));
});
