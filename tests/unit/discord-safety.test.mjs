// Unit tests for the Discord safety helpers. Pure functions and a source scan. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isFreshTimestamp,
  clampContent,
  hardenInteractionBody,
  ALLOWED_MENTIONS_NONE,
  DISCORD_MAX_AGE_SECONDS,
} from "../../infrastructure/worker/discord-safety.js";

const NOW = 1_800_000_000;

test("fresh timestamps are accepted", () => {
  assert.equal(isFreshTimestamp(String(NOW), NOW, 300), true);
  assert.equal(isFreshTimestamp(String(NOW - 299), NOW, 300), true);
  assert.equal(isFreshTimestamp(String(NOW - 300), NOW, 300), true);
});

test("stale timestamps are rejected", () => {
  assert.equal(isFreshTimestamp(String(NOW - 301), NOW, 300), false);
  assert.equal(isFreshTimestamp("1", NOW, 300), false);
  assert.equal(DISCORD_MAX_AGE_SECONDS, 300);
});

test("future-skewed timestamps beyond the window are rejected", () => {
  assert.equal(isFreshTimestamp(String(NOW + 30), NOW, 300), true);
  assert.equal(isFreshTimestamp(String(NOW + 301), NOW, 300), false);
  assert.equal(isFreshTimestamp(String(NOW + 10_000_000), NOW, 300), false);
});

test("malformed timestamps are rejected", () => {
  for (const bad of ["", "abc", "12abc", "1.5", "-5", "1e9", "0x10", " ", null, undefined, {}, [], NaN]) {
    assert.equal(isFreshTimestamp(bad, NOW, 300), false, `should reject ${String(bad)}`);
  }
  assert.equal(isFreshTimestamp(String(NOW), NaN, 300), false);
});

test("clampContent leaves short text unchanged and cuts at 2000 with an ellipsis", () => {
  assert.equal(clampContent("hello"), "hello");
  assert.equal(clampContent(""), "");
  assert.equal(clampContent(null), "");
  const exact = "a".repeat(2000);
  assert.equal(clampContent(exact), exact);
  const long = "b".repeat(2001);
  const out = clampContent(long);
  assert.equal(out.length, 2000);
  assert.ok(out.endsWith("…"));
  assert.equal(out.slice(0, 1999), "b".repeat(1999));
  assert.equal(clampContent("x".repeat(50000)).length, 2000);
});

test("hardenInteractionBody adds allowed_mentions and clamps message responses only", () => {
  const msg = hardenInteractionBody({ type: 4, data: { content: "z".repeat(3000), flags: 64 } });
  assert.deepEqual(msg.data.allowed_mentions, ALLOWED_MENTIONS_NONE);
  assert.equal(msg.data.content.length, 2000);
  assert.equal(msg.data.flags, 64);
  const deferred = hardenInteractionBody({ type: 5 });
  assert.deepEqual(deferred.data, { allowed_mentions: { parse: [] } });
  const pong = { type: 1 };
  assert.equal(hardenInteractionBody(pong), pong);
  const auto = { type: 8, data: { choices: [] } };
  assert.equal(hardenInteractionBody(auto), auto);
});

// Source scan: every body sent to a Discord URL carries allowed_mentions and a clamped content.
const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.join(here, "..", "..", "infrastructure", "worker");
const touched = ["discord.js", "index.js", "ai-models.js"];

// Return the balanced-paren argument text starting at the "(" at index open.
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return "";
}

test("every JSON body fetched to a Discord webhook URL includes allowed_mentions and clampContent", () => {
  let found = 0;
  for (const f of touched) {
    const src = fs.readFileSync(path.join(workerDir, f), "utf8");
    const re = /fetch\(\s*(?:`https:\/\/discord\.com\/api\/v10\/webhooks\/|env\.DISCORD_WEBHOOK_URL)/g;
    let m;
    while ((m = re.exec(src))) {
      const call = balanced(src, m.index + "fetch".length);
      const b = call.indexOf("JSON.stringify(");
      assert.ok(b >= 0, `${f}: Discord fetch without a JSON.stringify body`);
      const body = balanced(call, b + "JSON.stringify".length);
      assert.match(body, /allowed_mentions\s*:/, `${f}: body missing allowed_mentions`);
      assert.match(body, /clampContent\(/, `${f}: content not clamped`);
      found++;
    }
  }
  assert.equal(found, 6, "expected 6 Discord webhook fetches: the shared answerAndDeliver PATCH (/ask and Ask Leeroy), the answer-button follow-ups, the other follow-ups in discord.js, and one webhook post each in ai-models.js and index.js");
});

test("the interaction handler is wrapped by hardenInteractionBody and checks timestamp freshness first", () => {
  const src = fs.readFileSync(path.join(workerDir, "discord.js"), "utf8");
  assert.match(src, /hardenInteractionBody\(body\)/);
  const fresh = src.indexOf("isFreshTimestamp(tsHeader");
  const verify = src.indexOf("await verifyDiscordSignature(req, rawBody");
  assert.ok(fresh > 0 && verify > fresh, "freshness check must come before signature verification");
});
