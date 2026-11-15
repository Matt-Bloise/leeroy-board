// W-key: the one resolver for the Anthropic credential (BYOK gateway, Secrets Store, legacy secret). Offline: fake env, fake fetch, fake keys only.
// Run: node --test tests/unit/ai-keys.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { anthropicAuth, anthropicAvailable, scrubSecrets, resetKeyCacheForTests, KEY_TTL_MS, NEG_TTL_MS } from "../../infrastructure/worker/ai-keys.js";
import { dispatchToProvider, isProviderConfigured, shortProviderError } from "../../infrastructure/worker/ai-models.js";

const FAKE = "sk-ant-FAKE-TEST-KEY-0000";
const GW = "https://gateway.ai.cloudflare.com/v1/acct1/gw1/anthropic/v1/messages";
const DIRECT = "https://api.anthropic.com/v1/messages";
const baseEnv = { CLOUDFLARE_ACCOUNT_ID: "acct1", AI_GATEWAY_ID: "gw1", AI_GATEWAY_TOKEN: "tok" };
const store = (impl) => ({ get: impl });
const OK = () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });

function withFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: { ...init.headers }, body: init.body }); return handler(url, init, calls.length); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
function captureConsole() {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => Object.assign(console, real) };
}
const ask = (env) => dispatchToProvider({ provider: "claude", env, systemPrompt: "S", userPrompt: "U", deep: false });

test.beforeEach(() => resetKeyCacheForTests());

// ---- precedence ----
test("precedence: BYOK beats store beats legacy secret", async () => {
  const get = async () => FAKE;
  assert.equal((await anthropicAuth({ ANTHROPIC_BYOK: "on", ANTHROPIC_KEY_STORE: store(get), ANTHROPIC_API_KEY: "legacy" })).mode, "gateway-byok");
  assert.equal((await anthropicAuth({ ANTHROPIC_BYOK: "off", ANTHROPIC_KEY_STORE: store(get), ANTHROPIC_API_KEY: "legacy" })).mode, "store");
  assert.equal((await anthropicAuth({ ANTHROPIC_KEY_STORE: store(get), ANTHROPIC_API_KEY: "legacy" })).mode, "store");
  assert.equal((await anthropicAuth({ ANTHROPIC_API_KEY: "legacy" })).mode, "legacy");
  assert.equal((await anthropicAuth({})).mode, "none");
  assert.equal((await anthropicAuth({ ANTHROPIC_BYOK: "ON " })).mode, "none", "only the exact on counts");
});

test("headers per mode", async () => {
  assert.deepEqual((await anthropicAuth({ ANTHROPIC_BYOK: "on" })).headers, {});
  assert.deepEqual((await anthropicAuth({ ANTHROPIC_KEY_STORE: store(async () => FAKE) })).headers, { "x-api-key": FAKE });
  assert.deepEqual((await anthropicAuth({ ANTHROPIC_API_KEY: "legacy-fake" })).headers, { "x-api-key": "legacy-fake" });
});

test("an empty, whitespace or throwing get falls through to the legacy secret with a short non-secret reason", async () => {
  for (const impl of [async () => "", async () => "   ", async () => null, async () => { throw new Error(`boom ${FAKE}`); }, () => { throw new Error("sync boom"); }]) {
    resetKeyCacheForTests();
    const a = await anthropicAuth({ ANTHROPIC_KEY_STORE: store(impl), ANTHROPIC_API_KEY: "legacy-fake" });
    assert.equal(a.mode, "legacy");
    assert.deepEqual(a.headers, { "x-api-key": "legacy-fake" });
    assert.match(a.reason, /^store-(empty|error|invalid)$/);
    assert.ok(!JSON.stringify(a).includes(FAKE));
  }
  resetKeyCacheForTests();
  assert.equal((await anthropicAuth({ ANTHROPIC_KEY_STORE: store(async () => "") })).mode, "none");
});

// ---- availability is cheap ----
test("anthropicAvailable never calls get(), even across 100 calls", () => {
  let n = 0;
  const env = { ANTHROPIC_KEY_STORE: store(async () => { n++; return FAKE; }) };
  for (let i = 0; i < 100; i++) assert.equal(anthropicAvailable(env), true);
  assert.equal(n, 0);
  for (let i = 0; i < 100; i++) isProviderConfigured(env, "claude");
  assert.equal(n, 0);
});

test("availability matrix, and isProviderConfigured agrees", () => {
  const cases = [
    [{}, false], [{ ANTHROPIC_BYOK: "off" }, false], [{ ANTHROPIC_BYOK: "on" }, false], [{ ...baseEnv, ANTHROPIC_BYOK: "on" }, true],
    [{ ANTHROPIC_KEY_STORE: store(async () => FAKE) }, true], [{ ANTHROPIC_KEY_STORE: {} }, false],
    [{ ANTHROPIC_API_KEY: "x" }, true],
  ];
  for (const [env, want] of cases) {
    assert.equal(anthropicAvailable(env), want, JSON.stringify(Object.keys(env)));
    assert.equal(isProviderConfigured(env, "claude"), want);
  }
  assert.equal(isProviderConfigured({ ANTHROPIC_BYOK: "on", IS_PR_PREVIEW: "true" }, "claude"), false, "PR previews stay on free models");
});

// ---- cache ----
test("get() is cached within the TTL and refreshed after", async () => {
  let n = 0, t = 1_000_000;
  const env = { ANTHROPIC_KEY_STORE: store(async () => `k${++n}`) };
  const now = () => t;
  assert.equal((await anthropicAuth(env, { now })).headers["x-api-key"], "k1");
  t += KEY_TTL_MS - 1;
  assert.equal((await anthropicAuth(env, { now })).headers["x-api-key"], "k1");
  assert.equal(n, 1);
  t += 2;
  assert.equal((await anthropicAuth(env, { now })).headers["x-api-key"], "k2");
  assert.equal(n, 2);
  assert.equal(KEY_TTL_MS, 5 * 60 * 1000);
});

test("a failed get is not cached as a key and is retried", async () => {
  let n = 0;
  const env = { ANTHROPIC_KEY_STORE: store(async () => { n++; if (n === 1) throw new Error("x"); return FAKE; }) };
  let t = 5_000_000;
  const now = () => t;
  assert.equal((await anthropicAuth(env, { now })).mode, "none");
  t += NEG_TTL_MS + 1;
  assert.equal((await anthropicAuth(env, { now })).mode, "store");
});

// ---- request shape ----
test("legacy path is byte-identical to the pre-change request (golden captured from master before the edit)", async () => {
  const f = withFetch(OK);
  try {
    const r = await ask({ ...baseEnv, ANTHROPIC_API_KEY: FAKE });
    assert.deepEqual(r, { answer: "ok", model: "claude-haiku-4-5-20251001", provider: "claude" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, GW);
    assert.equal(JSON.stringify(f.calls[0].headers), JSON.stringify({
      "Content-Type": "application/json", "x-api-key": FAKE, "anthropic-version": "2023-06-01",
      "cf-aig-cache-ttl": "21600", "cf-aig-metadata": "{\"app\":\"leeroy-board\",\"service\":\"chamber\"}", "cf-aig-authorization": "Bearer tok",
    }));
    assert.equal(f.calls[0].body, "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":350,\"system\":[{\"type\":\"text\",\"text\":\"S\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":\"U\"}]}");
  } finally { f.restore(); }
});

test("store mode sends the same request as legacy, with the stored key", async () => {
  const f = withFetch(OK);
  try {
    await ask({ ...baseEnv, ANTHROPIC_KEY_STORE: store(async () => FAKE) });
    assert.equal(f.calls[0].url, GW);
    assert.equal(f.calls[0].headers["x-api-key"], FAKE);
    assert.equal(Object.keys(f.calls[0].headers)[1], "x-api-key");
  } finally { f.restore(); }
});

test("BYOK sends cf-aig-authorization and no x-api-key", async () => {
  const f = withFetch(OK);
  try {
    const r = await ask({ ...baseEnv, ANTHROPIC_BYOK: "on" });
    assert.equal(r.answer, "ok");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, GW);
    const names = Object.keys(f.calls[0].headers).map((h) => h.toLowerCase());
    assert.ok(!names.includes("x-api-key"));
    assert.equal(f.calls[0].headers["cf-aig-authorization"], "Bearer tok");
    assert.equal(f.calls[0].headers["anthropic-version"], "2023-06-01");
  } finally { f.restore(); }
});

test("BYOK never falls back to the direct endpoint: gateway 401/403/404/500, network throw", async () => {
  for (const mode of [401, 403, 404, 500, 503, "throw"]) {
    const f = withFetch(() => { if (mode === "throw") throw new Error("net down"); return new Response("nope", { status: mode }); });
    const c = captureConsole();
    try {
      await assert.rejects(() => ask({ ...baseEnv, ANTHROPIC_BYOK: "on" }));
      assert.equal(f.calls.length, 1, `mode ${mode}`);
      assert.ok(f.calls.every((x) => x.url === GW), `mode ${mode}`);
      assert.ok(!f.calls.some((x) => x.url === DIRECT));
    } finally { c.restore(); f.restore(); }
  }
});

test("BYOK with no gateway config throws without any request", async () => {
  for (const env of [{ ANTHROPIC_BYOK: "on", AI_GATEWAY_TOKEN: "tok" }, { ...baseEnv, AI_GATEWAY_TOKEN: undefined, ANTHROPIC_BYOK: "on" }]) {
    const f = withFetch(OK);
    try {
      await assert.rejects(() => ask(env), /BYOK/);
      assert.equal(f.calls.length, 0);
    } finally { f.restore(); }
  }
});

test("store/legacy keep the direct fallback on gateway failure (unchanged behaviour)", async () => {
  const f = withFetch((url) => (url === GW ? new Response("bad", { status: 500 }) : OK()));
  const c = captureConsole();
  try {
    const r = await ask({ ...baseEnv, ANTHROPIC_API_KEY: FAKE });
    assert.equal(r.answer, "ok");
    assert.deepEqual(f.calls.map((x) => x.url), [GW, DIRECT]);
  } finally { c.restore(); f.restore(); }
});

test("no credential at all: clear error without the word key value, no request", async () => {
  const f = withFetch(OK);
  try {
    await assert.rejects(() => ask(baseEnv), /not configured/);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

// ---- scrubbing ----
test("scrubSecrets removes the sk-ant pattern and an exact known key; shortProviderError too", () => {
  assert.ok(!scrubSecrets(`a ${FAKE} b sk-ant-api03-AbC_dEf-123 c`).includes("sk-ant-"));
  assert.ok(!scrubSecrets("opaque-secret-value here", "opaque-secret-value").includes("opaque-secret-value"));
  assert.ok(!shortProviderError(new Error(`bad key ${FAKE}`)).includes("sk-ant-"));
  assert.ok(!shortProviderError(new Error("x sk-ant-abcdefgh12")).includes("sk-ant-"));
});

// ---- property test: 200 seeded failure cases ----
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test("property: over 200 seeded failures the key and the sk-ant pattern never leak", async () => {
  const rand = rng(20261114);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  let ran = 0, rejected = 0;
  for (let i = 0; i < 200; i++) {
    const mode = pick(["legacy", "store", "byok"]);
    const failure = pick(["gw-body-echo", "gw-throw", "both-body-echo", "both-throw", "bad-json", "ok"]);
    const pad = "x".repeat(Math.floor(rand() * 150));
    const leaky = `${pad} invalid x-api-key ${FAKE} ${pad} sk-ant-api03-ZZZ${i}`;
    const env = { ...baseEnv, ...(mode === "byok" ? { ANTHROPIC_BYOK: "on" } : mode === "store" ? { ANTHROPIC_KEY_STORE: store(async () => FAKE) } : { ANTHROPIC_API_KEY: FAKE }) };
    const status = pick([400, 401, 403, 404, 429, 500, 502]);
    const f = withFetch((url) => {
      const gw = url === GW;
      const fail = failure === "both-body-echo" || failure === "both-throw" || (gw && (failure === "gw-body-echo" || failure === "gw-throw"));
      if (failure === "bad-json" && gw) return new Response(`not json ${leaky}`, { status: 200 });
      if (!fail) return OK();
      if (failure.endsWith("throw")) throw new Error(`network ${leaky}`);
      return new Response(leaky, { status });
    });
    const c = captureConsole();
    resetKeyCacheForTests();
    let result, err;
    try { result = await ask(env); } catch (e) { err = e; }
    c.restore(); f.restore();
    ran++;
    if (err) rejected++;
    const surfaces = [String(err && err.message), String(err && err.stack ? "" : ""), JSON.stringify(result || {}), c.lines.join("\n"), err ? shortProviderError(err) : ""];
    for (const s of surfaces) {
      assert.ok(!s.includes(FAKE), `case ${i} ${mode}/${failure}: key leaked`);
      assert.ok(!s.includes("sk-ant-"), `case ${i} ${mode}/${failure}: pattern leaked`);
    }
    for (const call of f.calls) {
      for (const [h, v] of Object.entries(call.headers)) {
        if (h.toLowerCase() === "x-api-key") {
          assert.notEqual(mode, "byok", `case ${i}: byok sent x-api-key`);
          assert.equal(v, FAKE);
        } else assert.ok(!String(v).includes("sk-ant-"), `case ${i}: header ${h}`);
      }
      assert.ok(!call.body.includes("sk-ant-"));
      if (mode === "byok") assert.equal(call.url, GW);
    }
  }
  assert.equal(ran, 200);
  assert.ok(rejected > 20, "the generator must actually produce failures");
});
