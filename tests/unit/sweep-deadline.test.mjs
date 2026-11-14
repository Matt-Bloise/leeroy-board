// Deadlines for browser sweeps (tests/helpers/deadline.mjs): a hung call becomes a named failure instead of a silent job timeout.
// Run: node --test tests/unit/sweep-deadline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withDeadline, watchdog, DeadlineError } from "../helpers/deadline.mjs";

test("a call that settles in time passes its value or its error through", async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1000, "x"), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error("boom")), 1000, "x"), /boom/);
});

test("a call that never settles rejects with DeadlineError naming the label and the seconds", async () => {
  const never = new Promise(() => {});
  const e = await withDeadline(never, 30, "cell 390x844 gate").catch((x) => x);
  assert.ok(e instanceof DeadlineError);
  assert.equal(e.label, "cell 390x844 gate");
  assert.match(e.message, /cell 390x844 gate did not finish within 0 s/);
});

test("the watchdog fires once with what is still running, and stop() cancels it", () => {
  let fire = null, cleared = false;
  const fired = [];
  const g = watchdog(1000, (r) => fired.push(r), { setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => { cleared = true; } });
  g.add("a"); g.add("b"); g.remove("a");
  fire();
  assert.deepEqual(fired, [["b"]]);
  g.stop();
  assert.equal(cleared, false, "a fired watchdog is not cleared again");
  const g2 = watchdog(1000, () => fired.push("no"), { setTimer: () => 2, clearTimer: () => { cleared = true; } });
  g2.stop();
  assert.equal(cleared, true);
});

test("layout-sweep wraps every cell attempt and browser.close in a deadline and runs the watchdog", () => {
  const src = readFileSync(new URL("../browser/layout-sweep.mjs", import.meta.url), "utf8");
  assert.match(src, /withDeadline\(cell\(browser, size, state, a\), CELL_MS/);
  assert.match(src, /withDeadline\(browser\.close\(\), CLOSE_MS/);
  assert.match(src, /const guard = watchdog\(HARD_MS/);
  assert.match(src, /guard\.stop\(\)/);
});
