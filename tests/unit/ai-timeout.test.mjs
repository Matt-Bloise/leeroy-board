// Unit tests for provider call timeouts in infrastructure/worker/ai-models.js.
// Stubbed fetch and AI binding only: no network, no AI calls.
// Run: node --test tests/unit/ai-timeout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchToProvider, AiTimeoutError } from "../../infrastructure/worker/ai-models.js";

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout;
const requested = [];

test.beforeEach(() => {
  requested.length = 0;
  // Record the requested duration but fire fast so the test does not wait 20s.
  // A ref'd timer (AbortSignal.timeout's own timer is unref'd and would let the loop exit).
  AbortSignal.timeout = (ms) => {
    requested.push(ms);
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DOMException("The operation timed out.", "TimeoutError")), 20);
    return ac.signal;
  };
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
});

// Slow fetch: only settles when the caller's signal aborts, like a hung provider.
function slowFetch(calls) {
  return (url, init) => new Promise((_, reject) => {
    calls.push({ url, init });
    assert.ok(init && init.signal, "every fetch must carry a signal");
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
}

const base = { systemPrompt: "s", userPrompt: "u", deep: false };

test("hung fetch maps to ai_timeout with a 20000ms signal", async () => {
  const calls = [];
  globalThis.fetch = slowFetch(calls);
  const env = { ANTHROPIC_API_KEY: "test-key" };
  await assert.rejects(
    dispatchToProvider({ ...base, provider: "claude", env }),
    (err) => err instanceof AiTimeoutError && err.code === "ai_timeout",
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(requested, [20000]);
});

test("openai-compatible providers time out the same way", async () => {
  const calls = [];
  globalThis.fetch = slowFetch(calls);
  const env = { GROQ_API_KEY: "test-key" };
  await assert.rejects(
    dispatchToProvider({ ...base, provider: "groq", env }),
    (err) => err.code === "ai_timeout",
  );
  assert.equal(calls.length, 1);
});

test("gateway timeout falls back to direct endpoint, which also times out", async () => {
  const calls = [];
  globalThis.fetch = slowFetch(calls);
  const env = { GEMINI_API_KEY: "test-key", CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw" };
  await assert.rejects(
    dispatchToProvider({ ...base, provider: "gemini", env }),
    (err) => err.code === "ai_timeout",
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith("https://gateway.ai.cloudflare.com/"));
  assert.ok(calls.every((c) => c.init.signal));
});

test("hung Workers AI binding maps to ai_timeout and receives the signal", async () => {
  const seen = [];
  const env = {
    AI: { run: (model, inputs, opts) => { seen.push(opts); return new Promise(() => {}); } },
  };
  await assert.rejects(
    dispatchToProvider({ ...base, provider: "workers-ai", env }),
    (err) => err instanceof AiTimeoutError && err.code === "ai_timeout",
  );
  assert.ok(seen[0] && seen[0].signal, "AI.run receives an abort signal");
  assert.deepEqual(requested, [20000]);
});

test("non-timeout errors pass through unchanged", async () => {
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  await assert.rejects(
    dispatchToProvider({ ...base, provider: "claude", env: { ANTHROPIC_API_KEY: "k" } }),
    (err) => err instanceof TypeError && err.code !== "ai_timeout",
  );
});
