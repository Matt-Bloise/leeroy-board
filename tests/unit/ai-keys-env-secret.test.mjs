// The production key is an encrypted Worker env secret (ANTHROPIC_API_KEY) with no Secrets Store binding and no BYOK flag.
// The resolver must fall through to it. Offline: fake env, fake fetch, fake key only. Run: node --test tests/unit/ai-keys-env-secret.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { anthropicAuth, anthropicAvailable, resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";
import { dispatchToProvider } from "../../infrastructure/worker/ai-models.js";

const K = "sk-ant-FAKE-ENV-SECRET-0001";

test("only the env secret is present (no Secrets Store binding, no BYOK): mode legacy, key in x-api-key", async () => {
  resetKeyCacheForTests();
  assert.deepEqual(await anthropicAuth({ ANTHROPIC_API_KEY: K }), { mode: "legacy", headers: { "x-api-key": K } });
  assert.equal(anthropicAvailable({ ANTHROPIC_API_KEY: K }), true);
});

test("BYOK explicitly off and a binding without get() both fall through to the env secret", async () => {
  resetKeyCacheForTests();
  for (const extra of [{ ANTHROPIC_BYOK: "off" }, { ANTHROPIC_BYOK: undefined }, { ANTHROPIC_KEY_STORE: {} }, { ANTHROPIC_KEY_STORE: null }]) {
    const a = await anthropicAuth({ ANTHROPIC_API_KEY: K, ...extra });
    assert.equal(a.mode, "legacy", JSON.stringify(Object.keys(extra)));
    assert.equal(a.headers["x-api-key"], K);
  }
});

test("a Secrets Store binding that has no value falls through to the env secret", async () => {
  resetKeyCacheForTests();
  const a = await anthropicAuth({ ANTHROPIC_API_KEY: K, ANTHROPIC_KEY_STORE: { get: async () => "" } });
  assert.equal(a.mode, "legacy");
  assert.equal(a.headers["x-api-key"], K);
});

test("no key anywhere: mode none, never a request header", async () => {
  resetKeyCacheForTests();
  const a = await anthropicAuth({});
  assert.equal(a.mode, "none");
  assert.deepEqual(a.headers, {});
  assert.equal(anthropicAvailable({}), false);
});

test("a Claude dispatch with only the env secret sends it as x-api-key and never in the body", async () => {
  resetKeyCacheForTests();
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), headers: { ...init.headers }, body: String(init.body) }); return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }); };
  try { await dispatchToProvider({ provider: "claude", env: { ANTHROPIC_API_KEY: K }, systemPrompt: "S", userPrompt: "U", deep: false }); } finally { globalThis.fetch = real; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], K);
  assert.ok(!calls[0].body.includes(K));
});
