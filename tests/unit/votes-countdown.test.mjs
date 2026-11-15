// Votes countdown wording (js/votes.js closesIn): days from 48 h, hours below, minutes below 1 h, closed when past, never NaN or "undefined".
// The client file is an IIFE, so it is run in a vm sandbox with a stub board kit; only window.BoardVotes.closesIn is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../js/votes.js", import.meta.url), "utf8");
const window = { __boardKit: { h: () => ({}), $: () => null, on: () => {} } };
const document = { readyState: "complete", hidden: true, addEventListener() {}, querySelector: () => null };
vm.runInNewContext(src, { window, document, setTimeout, clearInterval, setInterval, clearTimeout, Date, Math, isFinite });
const { closesIn } = window.BoardVotes;
const NOW = Date.parse("2026-01-10T12:00:00Z"), H = 3600000, M = 60000;
const at = (ms) => closesIn(NOW + ms, NOW);

test("closesIn is exported", () => assert.equal(typeof closesIn, "function"));
test("72 hours reads days", () => assert.equal(at(72 * H), "Closes in 3 days"));
test("a fresh 72 h vote a few seconds old still reads 3 days", () => assert.equal(at(72 * H - 5000), "Closes in 3 days"));
test("exactly 48 hours reads 2 days", () => assert.equal(at(48 * H), "Closes in 2 days"));
test("47 hours reads hours", () => assert.equal(at(47 * H), "Closes in 47 hours"));
test("1 hour reads singular hour", () => assert.equal(at(H), "Closes in 1 hour"));
test("30 minutes reads minutes", () => assert.equal(at(30 * M), "Closes in 30 minutes"));
test("under a minute reads 1 minute", () => assert.equal(at(10000), "Closes in 1 minute"));
test("just passed reads Closing now, long past reads Closed", () => {
  assert.equal(at(-1000), "Closing now");
  assert.equal(at(-2 * H), "Closed");
  assert.equal(at(-1e15), "Closed");
});
test("missing or invalid closes_at never prints NaN or undefined", () => {
  for (const bad of [null, undefined, "2026-01-12", "soon", NaN, Infinity, -Infinity, {}, [], true]) {
    const out = closesIn(bad, NOW);
    assert.equal(out, "Closed");
    assert.doesNotMatch(out, /NaN|undefined|null/);
  }
});
test("a huge future value stays a clean day count", () => assert.match(at(1e12), /^Closes in \d+ days$/));
