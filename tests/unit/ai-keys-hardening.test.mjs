// W-key hardening after the Fable attack: store get() timeout / single-flight / negative cache, credential validation, success-path and
// derived-form scrubbing, cause/code scrubbing, strict BYOK flag and prerequisites, availability, 401 invalidation, generic failure text.
// Offline: fake env, fake fetch, fake keys only. Run: node --test tests/unit/ai-keys-hardening.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicAuth, anthropicAvailable, scrubSecrets, scrubError, resetKeyCacheForTests, clearStoreKey,
  KEY_TTL_MS, NEG_TTL_MS, STORE_TIMEOUT_MS,
} from "../../infrastructure/worker/ai-keys.js";
import { dispatchToProvider, shortProviderError } from "../../infrastructure/worker/ai-models.js";

const FAKE = "sk-ant-FAKE-TEST-KEY-0000";
const GW = "https://gateway.ai.cloudflare.com/v1/acct1/gw1/anthropic/v1/messages";
const baseEnv = { CLOUDFLARE_ACCOUNT_ID: "acct1", AI_GATEWAY_ID: "gw1", AI_GATEWAY_TOKEN: "tok" };
const store = (get) => ({ get });
const OK = (text = "ok") => new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });

function withFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init, headers: { ...init.headers }, body: init.body }); return handler(url, init, calls.length); };
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

// ---- 1. store get(): timeout, single-flight, negative cache ----
test("a never-resolving get() falls through to the legacy secret within the timeout", async () => {
  assert.ok(STORE_TIMEOUT_MS >= 1000 && STORE_TIMEOUT_MS <= 2000);
  const t0 = Date.now();
  const a = await anthropicAuth({ ANTHROPIC_KEY_STORE: store(() => new Promise(() => {})), ANTHROPIC_API_KEY: "sk-ant-legacy-FAKE-0001" }, { timeoutMs: 40 });
  assert.equal(a.mode, "legacy");
  assert.equal(a.reason, "store-timeout");
  assert.ok(Date.now() - t0 < 1000);
});

test("end to end: a hung store get() does not hold the ask past the default timeout", async () => {
  const f = withFetch(() => OK());
  try {
    const t0 = Date.now();
    const r = await ask({ ...baseEnv, ANTHROPIC_KEY_STORE: store(() => new Promise(() => {})), ANTHROPIC_API_KEY: FAKE });
    assert.equal(r.answer, "ok");
    assert.ok(Date.now() - t0 < STORE_TIMEOUT_MS + 1000);
    assert.equal(f.calls[0].headers["x-api-key"], FAKE);
  } finally { f.restore(); }
});

test("single-flight: 50 concurrent first calls make one get()", async () => {
  let n = 0;
  const env = { ANTHROPIC_KEY_STORE: store(async () => { n++; await new Promise((r) => setTimeout(r, 20)); return FAKE; }) };
  const all = await Promise.all(Array.from({ length: 50 }, () => anthropicAuth(env)));
  assert.equal(n, 1);
  assert.ok(all.every((a) => a.mode === "store" && a.headers["x-api-key"] === FAKE));
});

test("a failing or empty store is cached for about 30 s, then retried; availability drops while it is known bad", async () => {
  assert.equal(NEG_TTL_MS, 30_000);
  for (const impl of [async () => { throw new Error("down"); }, async () => ""]) {
    resetKeyCacheForTests();
    let n = 0, t = 9_000_000;
    const now = () => t;
    const env = { ANTHROPIC_KEY_STORE: store(async () => { n++; return impl(); }) };
    assert.equal(anthropicAvailable(env, { now }), true, "unknown state counts as available");
    for (let i = 0; i < 20; i++) assert.equal((await anthropicAuth(env, { now })).mode, "none");
    assert.equal(n, 1, "20 asks, one get()");
    assert.equal(anthropicAvailable(env, { now }), false, "known-bad store alone is not available");
    assert.equal(anthropicAvailable({ ...env, ANTHROPIC_API_KEY: FAKE }, { now }), true, "legacy secret still counts");
    t += NEG_TTL_MS + 1;
    await anthropicAuth(env, { now });
    assert.equal(n, 2);
  }
});

// ---- 2. credential validation ----
test("stored or legacy values with INTERIOR whitespace or control characters are not configured, and no message carries them", async () => {
  const bad = [`sk-ant-FAKE\tTEST-0000`, `sk-ant-FAKE-\x00-0000`, `sk-ant-FAKE-\r\n-0000`, "sk-ant-FAKE TEST-0000", `${FAKE}\nx`];
  for (const v of bad) {
    for (const env of [{ ANTHROPIC_API_KEY: v }, { ANTHROPIC_KEY_STORE: store(async () => v) }]) {
      resetKeyCacheForTests();
      const a = await anthropicAuth(env);
      assert.equal(a.mode, "none", JSON.stringify(v));
      assert.ok(!JSON.stringify(a).includes("FAKE"));
      assert.equal(anthropicAvailable({ ANTHROPIC_API_KEY: v }), false);
      const f = withFetch(() => OK());
      try {
        await assert.rejects(() => ask({ ...baseEnv, ...env }), (e) => /not configured/.test(e.message) && !e.message.includes("FAKE"));
        assert.equal(f.calls.length, 0);
      } finally { f.restore(); }
    }
  }
});

test("the gateway console.warn path is scrubbed with the known key (tail echoed by a network error)", async () => {
  const f = withFetch((url) => { if (url === GW) throw new Error(`bad header ${FAKE.slice(8)}`); return OK(); });
  const c = captureConsole();
  try {
    await ask({ ...baseEnv, ANTHROPIC_API_KEY: FAKE });
  } finally { c.restore(); f.restore(); }
  assert.ok(c.lines.length > 0);
  assert.ok(!c.lines.join("\n").includes(FAKE.slice(8)));
});

// ---- 3. success path ----
test("a 200 answer that echoes the key (exact, tail, base64) is scrubbed before it leaves", async () => {
  const echo = `Your key is ${FAKE}, tail ${FAKE.slice(10)}, b64 ${Buffer.from(FAKE).toString("base64")}`;
  const f = withFetch(() => OK(echo));
  try {
    const r = await ask({ ...baseEnv, ANTHROPIC_API_KEY: FAKE });
    assert.ok(!r.answer.includes(FAKE.slice(10)));
    assert.ok(!r.answer.includes(Buffer.from(FAKE).toString("base64")));
    assert.ok(!r.answer.includes("sk-ant-"));
  } finally { f.restore(); }
});

// ---- 4. derived forms ----
test("scrubSecrets removes derived forms of the known key", () => {
  const K = FAKE;
  const forms = {
    exact: K, uppercase: K.toUpperCase(), lowercase: K.toLowerCase(),
    tail8: K.slice(-8), tail12: K.slice(-12), tail15: K.slice(10),
    newlineSplit: `${K.slice(0, 12)}\n${K.slice(12)}`, escapedNewline: `${K.slice(0, 12)}\\n${K.slice(12)}`, spaceSplit: `${K.slice(0, 9)} ${K.slice(9)}`,
    base64: Buffer.from(K).toString("base64"), base64NoPad: Buffer.from(K).toString("base64").replace(/=+$/, ""), base64url: Buffer.from(K).toString("base64url"),
    hex: Buffer.from(K).toString("hex"), hexUpper: Buffer.from(K).toString("hex").toUpperCase(),
    percent: encodeURIComponent(K), percentAll: [...K].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
    dotted: K.replace(/-/g, "."), basicAuth: Buffer.from(`x:${K}`).toString("base64"), base64Shift1: Buffer.from(`x${K}`).toString("base64"),
    unicodeDash: K.replace(/-/g, "\\u002d"), jsonEscaped: JSON.stringify(K).slice(1, -1),
  };
  for (const [name, form] of Object.entries(forms)) {
    const out = scrubSecrets(`before ${form} after`, K);
    assert.ok(!out.toLowerCase().includes(form.toLowerCase()), `${name}: ${out}`);
  }
});

test("short known keys (4+ chars) are scrubbed exactly; the pattern needs 8+ chars and a word boundary", () => {
  assert.ok(!scrubSecrets("x abcd y", "abcd").includes("abcd"));
  assert.ok(!scrubSecrets("x ab12345 y", "ab12345").includes("ab12345"));
  assert.equal(scrubSecrets("x abc y", "abc"), "x abc y", "under 4 chars is not scrubbed");
  assert.equal(scrubSecrets("the task-ant-hill and task-ant-hillhillhill"), "the task-ant-hill and task-ant-hillhillhill");
  assert.equal(scrubSecrets("sk-ant-short ok"), "sk-ant-short ok");
  assert.equal(scrubSecrets("a sk-ant-abcdefgh b"), "a [redacted] b");
  assert.equal(scrubSecrets("(sk-ant-api03-AbC_dEf-123)"), "([redacted])");
});

test("scrubSecrets stays fast on a large body", () => {
  const big = ("lorem ipsum dolor sit amet ".repeat(2000)) + FAKE;
  const t0 = Date.now();
  const out = scrubSecrets(big, FAKE);
  assert.ok(Date.now() - t0 < 500);
  assert.ok(!out.includes("FAKE-TEST"));
});

// ---- 5. scrubError ----
test("scrubError scrubs cause and code, keeps clean errors as they are", () => {
  const dirty = new Error("fetch failed", { cause: new Error(`hdr ${FAKE}`) });
  dirty.code = `E_${FAKE}`;
  const out = scrubError(dirty, FAKE);
  const dump = [out.message, out.stack, String(out.code), out.cause && out.cause.message, out.cause && out.cause.stack].join("|");
  assert.ok(!dump.includes("FAKE-TEST") && !dump.includes("sk-ant-"));
  const strCause = new Error("x", { cause: `tail ${FAKE.slice(10)}` });
  assert.ok(!String(scrubError(strCause, FAKE).cause).includes(FAKE.slice(10)));
  const deep = new Error("a", { cause: new Error("b", { cause: new Error(`c ${FAKE}`) }) });
  assert.ok(!JSON.stringify(scrubError(deep, FAKE).cause.cause.message).includes("FAKE-TEST"));
  const clean = Object.assign(new Error("timeout"), { code: "ai_timeout" });
  assert.equal(scrubError(clean, FAKE), clean);
  assert.equal(scrubError(Object.assign(new Error(`k ${FAKE}`), { code: "ai_timeout" }), FAKE).code, "ai_timeout");
});

// ---- 6. strict BYOK flag and prerequisites ----
test("only exact on/off count; any other non-empty value warns once, with no value in the warning, and is treated as off", async () => {
  const c = captureConsole();
  try {
    for (const v of ["ON", " on", "true", "1", "yes"]) {
      const a = await anthropicAuth({ ANTHROPIC_BYOK: v, ANTHROPIC_API_KEY: FAKE });
      assert.equal(a.mode, "legacy", v);
      assert.equal(anthropicAvailable({ ANTHROPIC_BYOK: v }), false, v);
    }
    for (let i = 0; i < 5; i++) await anthropicAuth({ ANTHROPIC_BYOK: "TRUE", ANTHROPIC_API_KEY: FAKE });
    for (const v of [undefined, "", "off"]) await anthropicAuth({ ANTHROPIC_BYOK: v, ANTHROPIC_API_KEY: FAKE });
  } finally { c.restore(); }
  const warns = c.lines.filter((l) => /ANTHROPIC_BYOK/.test(l));
  assert.equal(warns.length, 1, "one warning per isolate");
  assert.ok(!/TRUE|true|ON|yes/.test(warns[0].replace("ANTHROPIC_BYOK", "")));
});

test("BYOK needs a clean account id, gateway id and token: blank or space-containing throws before any request", async () => {
  const good = { ...baseEnv, ANTHROPIC_BYOK: "on" };
  for (const [k, v] of [["CLOUDFLARE_ACCOUNT_ID", ""], ["CLOUDFLARE_ACCOUNT_ID", "ac ct"], ["AI_GATEWAY_ID", ""], ["AI_GATEWAY_ID", " gw1"], ["AI_GATEWAY_TOKEN", "   "], ["AI_GATEWAY_TOKEN", "to ken"], ["AI_GATEWAY_TOKEN", "tok\n"]]) {
    const env = { ...good, [k]: v };
    const f = withFetch(() => OK());
    try {
      await assert.rejects(() => ask(env), /BYOK/, `${k}=${JSON.stringify(v)}`);
      assert.equal(f.calls.length, 0);
      assert.equal(anthropicAvailable(env), false);
    } finally { f.restore(); }
  }
  assert.equal(anthropicAvailable(good), true);
});

test("BYOK requests use redirect manual and a 3xx is an error; store and legacy requests carry no redirect option", async () => {
  let f = withFetch(() => OK());
  try {
    await ask({ ...baseEnv, ANTHROPIC_BYOK: "on" });
    assert.equal(f.calls[0].init.redirect, "manual");
  } finally { f.restore(); }
  f = withFetch(() => new Response("", { status: 302, headers: { location: "https://evil.example/" } }));
  try {
    await assert.rejects(() => ask({ ...baseEnv, ANTHROPIC_BYOK: "on" }));
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
  f = withFetch(() => OK());
  try {
    await ask({ ...baseEnv, ANTHROPIC_API_KEY: FAKE });
    assert.ok(!("redirect" in f.calls[0].init));
  } finally { f.restore(); }
});

// ---- 9. 401/403 invalidation ----
test("a 401 or 403 from Anthropic clears the cached store key, so the next ask re-reads the store", async () => {
  for (const status of [401, 403]) {
    resetKeyCacheForTests();
    let n = 0;
    const env = { ...baseEnv, ANTHROPIC_KEY_STORE: store(async () => `sk-ant-ROTATED-FAKE-${++n}`) };
    const f = withFetch(() => new Response("denied", { status }));
    const c = captureConsole();
    try {
      await assert.rejects(() => ask(env));
      assert.equal(n, 1);
      await assert.rejects(() => ask(env));
      assert.equal(n, 2, `status ${status}: the cached key was dropped`);
    } finally { c.restore(); f.restore(); }
  }
  // a 500 keeps the cache
  resetKeyCacheForTests();
  let m = 0;
  const env = { ...baseEnv, ANTHROPIC_KEY_STORE: store(async () => `sk-ant-FAKE-KEEP-${++m}`) };
  const f = withFetch(() => new Response("oops", { status: 500 }));
  const c = captureConsole();
  try { await assert.rejects(() => ask(env)); await assert.rejects(() => ask(env)); assert.equal(m, 1); } finally { c.restore(); f.restore(); }
});

test("clearStoreKey drops the cache for a binding", async () => {
  let n = 0;
  const env = { ANTHROPIC_KEY_STORE: store(async () => `sk-ant-FAKE-${++n}-0000`) };
  await anthropicAuth(env);
  clearStoreKey(env);
  await anthropicAuth(env);
  assert.equal(n, 2);
  assert.ok(KEY_TTL_MS > 0);
});

// ---- 8. generic failure text ----
test("provider failure text is generic: status only, no provider body, in the thrown message and in shortProviderError", async () => {
  const f = withFetch(() => new Response("Your account balance is low; org org_12345 contact billing@example.com", { status: 400 }));
  const c = captureConsole();
  let err;
  try { await ask({ ...baseEnv, ANTHROPIC_API_KEY: FAKE }); } catch (e) { err = e; } finally { c.restore(); f.restore(); }
  assert.equal(err.message, "Anthropic API HTTP 400");
  assert.equal(shortProviderError(err), "Anthropic API HTTP 400");
  assert.equal(shortProviderError(new Error("groq API HTTP 500: provider said something long and private about the account")), "groq API HTTP 500");
  assert.ok(!shortProviderError(new Error(`x ${FAKE}`)).includes("sk-ant-"));
});
