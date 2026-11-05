// B71b: the degraded-modes slow-network cell must not judge "painted" by page paint entries. Every browser context is clock-pinned (tests/helpers/browser-stub.mjs, B64), and under
// Playwright's clock install performance.getEntries* return nothing, so such a criterion can never be met and the cell is red whatever the page does. The cell uses CDP
// Page.lifecycleEvent firstPaint and a strictly visible card, and two negative conditions prove it still goes red on a genuinely slow page. Static checks on the suite's source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../browser/degraded-modes.mjs", import.meta.url), "utf8");

test("the slow cell takes its paint signal from CDP, not from performance entries", () => {
  assert.match(src, /Page\.setLifecycleEventsEnabled/, "lifecycle events are switched on");
  assert.match(src, /e\.name === "firstPaint"/, "the firstPaint lifecycle event is the paint signal");
  assert.doesNotMatch(src, /p\.paint\.length/, "no criterion may read the page's paint entries (empty under the clock pin)");
});

test("the slow cell needs a strictly visible card: full opacity and inside the viewport", () => {
  assert.match(src, /alpha\(e\) >= 0\.99 && inside\(e\)/);
  assert.match(src, /page\.evaluate\(probe, !!cond\.paint\)/, "the strict probe runs for the slow cell only");
});

test("two negative conditions must be refused, so a slow page still turns the check red", () => {
  const neg = src.match(/expectRed: true/g) || [];
  assert.ok(neg.length >= 2, `found ${neg.length} expectRed conditions, want at least 2 (document withheld, paint blocked)`);
  assert.match(src, /id: "slow-network-card-withheld"/);
  assert.match(src, /id: "slow-network-paint-blocked"/);
  assert.match(src, /the check refuses it/);
});
