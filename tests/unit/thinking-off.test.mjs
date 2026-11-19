// Production finding (Nov 2026): every full-size research compose on claude-sonnet-5-5 returned no text (claude:reply-flagged@empty at about 6.6 s) while an 8-token ping answered.
// Claude 5.5 models think by default and the thinking tokens come out of max_tokens (700 in research mode), so a real question can spend the whole cap thinking. This file pins that
// callAnthropicClaude turns thinking off with the form each 5.5 model accepts and leaves every other model's request exactly as before. Offline: fake fetch, fake key built at runtime.
// Run: node --test tests/unit/thinking-off.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { callAnthropicClaude, thinkingOffFor } from "../../infrastructure/worker/ai-models.js";
import { resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";

const realFetch = globalThis.fetch;
const KEY = ["sk", "ant", "api03", "FAKE" + "FAKE" + "FAKE", "1234567890"].join("-");
let bodies = [];
globalThis.fetch = async (url, init) => {
  bodies.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }) };
};
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { bodies = []; resetKeyCacheForTests(); });

const env = { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BYOK: "off" };
const call = (model) => callAnthropicClaude({ env, systemPrompt: "s", userPrompt: "u", deep: true, modelOverride: model, maxTokens: 700, skipCache: true });

test("thinkingOffFor: Sonnet 5.5 uses between_tools, Haiku 5.5 uses disabled, everything else gets nothing", () => {
  assert.deepEqual(thinkingOffFor("claude-sonnet-5-5"), { type: "between_tools" });
  assert.deepEqual(thinkingOffFor("claude-haiku-5-5"), { type: "disabled" });
  for (const m of ["claude-sonnet-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-50", "", null, undefined]) {
    assert.equal(thinkingOffFor(m), null, String(m));
  }
});

test("the request body carries the thinking switch for the 5.5 models and nothing else changes", async () => {
  await call("claude-sonnet-5-5");
  assert.deepEqual(bodies[0].thinking, { type: "between_tools" });
  assert.equal(bodies[0].max_tokens, 700);
  assert.equal(bodies[0].output_config, undefined, "no effort is set, so between_tools (effort high or below) is valid");
  await call("claude-haiku-5-5");
  assert.deepEqual(bodies[1].thinking, { type: "disabled" });
});

test("other models get no thinking field at all", async () => {
  for (const m of ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001", "claude-sonnet-5"]) {
    await call(m);
    assert.ok(!("thinking" in bodies[bodies.length - 1]), m);
  }
});
