import test from "node:test";
import assert from "node:assert/strict";
import { parseWranglerJson } from "../../infrastructure/scripts/library-seed.mjs";

const payload = [{ results: [{ id: "classes/mage", category: "classes", as_of: "2026-10-19", checked: "2026-10-29" }], success: true, meta: { duration: 1 } }];
const json = JSON.stringify(payload, null, 2);

test("clean JSON parses", () => {
  assert.deepEqual(parseWranglerJson(json), payload);
});
test("progress lines before the payload (the Nov 8 production failure)", () => {
  const noisy = "├ Checking if file needs uploading\n\n" + json + "\n";
  assert.deepEqual(parseWranglerJson(noisy), payload);
});
test("banner, ANSI colours and progress lines before; log lines after", () => {
  const noisy = "\x1b[1m⛅️ wrangler 4.12.0\x1b[0m\n─────────────────\n\x1b[2m├ Checking if file needs uploading\x1b[0m\n🌀 Executing on remote database leeroy-board-db:\n" + json + "\n\x1b[32mDone in 1.2s\x1b[0m\nupdate available 4.99.0\n";
  assert.deepEqual(parseWranglerJson(noisy), payload);
});
test("an object payload and CRLF line endings", () => {
  const obj = { results: [{ n: 1 }] };
  assert.deepEqual(parseWranglerJson("├ working\r\n" + JSON.stringify(obj, null, 2).replace(/\n/g, "\r\n") + "\r\n"), obj);
});
test("a bracket inside a progress line does not hide the real payload", () => {
  const noisy = "[wrangler:info] starting\n" + json + "\n";
  assert.deepEqual(parseWranglerJson(noisy), payload);
});
test("garbage throws with the start of the output", () => {
  assert.throws(() => parseWranglerJson("├ Checking if file needs uploading\nERROR something broke\n"), /no d1 JSON payload; output starts: ├ Checking if file needs uploading ERROR/);
  assert.throws(() => parseWranglerJson(""), /no d1 JSON payload/);
});
test("an unrelated JSON line before the real payload is not mistaken for it (council review)", () => {
  assert.deepEqual(parseWranglerJson("{}\n" + json), payload);
  assert.deepEqual(parseWranglerJson("[123]\n[\"info\"]\n" + json), payload);
});
test("a truncated response is rejected, not turned into an empty result", () => {
  const truncated = json.slice(0, Math.floor(json.length / 2));
  assert.throws(() => parseWranglerJson("├ working\n" + truncated), /no d1 JSON payload/);
  assert.throws(() => parseWranglerJson("{}\n"), /no d1 JSON payload/);
});
test("a nested statement of a rejected or truncated array is never accepted on its own (council review)", () => {
  const failedFirst = JSON.stringify([{ results: [], success: false }, { results: [{ id: "x" }], success: true }], null, 2);
  assert.throws(() => parseWranglerJson("├ working\n" + failedFirst), /no d1 JSON payload/);
  const noClosingBracket = failedFirst.replace(/\n\]$/, "");
  assert.throws(() => parseWranglerJson("├ working\n" + noClosingBracket), /no d1 JSON payload/);
});
test("a failed statement result is rejected", () => {
  assert.throws(() => parseWranglerJson(JSON.stringify([{ results: [], success: false }])), /no d1 JSON payload/);
});
