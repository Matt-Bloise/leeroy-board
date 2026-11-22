// Production bug (Nov 2026): every real /ask Claude call ended "[claude:error]+degraded". Cause (reproduced in workerd, wrangler dev --local, compatibility_date 2025-02-01, no nodejs_compat):
// ai-keys.js used the Node global `Buffer`, which does not exist in a Worker without nodejs_compat. scrubSecrets / scrubError threw "ReferenceError: Buffer is not defined" on the success path
// AND inside the catch that was meant to scrub an error, so whatever really happened (a 200, an HTTP error, a guard stop) came out as the same unnamed "claude:error".
// This file pins: (1) the scrubbers work with no `Buffer` global, (2) no Worker source reaches for Node-only globals, (3) failReason names the class of what failed (value-free), (4) an unusable gateway
// token stops the send with a fixed code instead of a runtime TypeError. Offline: fake fetch, stub D1, fake keys built at runtime.
// Run: node --test tests/unit/ask-claude-error-class.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tryResearchClaude, resetResearchClaudeForTests, failReason, ERROR_NAME_MAX } from "../../infrastructure/worker/research/claude.js";
import { callAnthropicClaude } from "../../infrastructure/worker/ai-models.js";
import { scrubSecrets, scrubError, resetKeyCacheForTests } from "../../infrastructure/worker/ai-keys.js";

const realFetch = globalThis.fetch;
const realBuffer = globalThis.Buffer;
const KEY = ["sk", "ant", "api03", "FAKE" + "FAKE" + "FAKE", "1234567890"].join("-"); // fake, built at runtime
const TOKEN = "fakeGatewayToken" + "123456";
let sent = [];
const OK_REPLY = () => ({ status: 200, body: { content: [{ type: "text", text: "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed" }], usage: { input_tokens: 10, output_tokens: 5 } } });
let reply = OK_REPLY;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), headers: { ...init.headers } });
  const r = reply();
  if (r.throws) throw r.throws;
  // A plain object: the Worker code only reads ok, status and json(), and Node's Response needs Buffer (this file removes it).
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
};
// A Worker without nodejs_compat has no Buffer: every test in this file runs that way.
test.before(() => {
  AbortSignal.timeout(1000);
  delete globalThis.Buffer;
});
test.after(() => { globalThis.Buffer = realBuffer; globalThis.fetch = realFetch; });
test.beforeEach(() => { reply = OK_REPLY; sent = []; resetKeyCacheForTests(); resetResearchClaudeForTests(); });

const baseEnv = (over = {}) => ({
  AI_GATEWAY_ID: "leeroy-ai-gateway", AI_GATEWAY_TOKEN: TOKEN, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BYOK: "off", CLOUDFLARE_ACCOUNT_ID: "d2528a785cb6079f1f28e9bc69769516",
  ASK_RESEARCH: "on", RESEARCH_NAMES: "real", RESEARCH_CLAUDE_MONTHLY_TOKENS: "5000000",
  DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ json: "1" }] }), run: async () => ({}) }) }) },
  ...over,
});
const run = (env) => tryResearchClaude({ env, priv: null, deep: true, hardEndAt: Date.now() + 20000, real: { system: "You are Leeroy.", user: "Asker: Bob (member)\nWhat should I level first?", friend: ["What should I level first?", "Bob"] }, call: callAnthropicClaude });

test("setup: this file really runs without a Buffer global", () => {
  assert.equal(typeof Buffer, "undefined");
});

// ---- (1) the scrubbers need no Buffer ----------------------------------------------------------------------------------------------------------------
test("scrubSecrets and scrubError work without Buffer: the key and its encoded forms are redacted", () => {
  const forms = [
    KEY, KEY.toUpperCase(), realBuffer.from(KEY).toString("base64"), realBuffer.from(KEY, "utf16le").toString("base64"), realBuffer.from(realBuffer.from(KEY, "utf16le")).swap16().toString("base64"),
    "x" + realBuffer.from(KEY).toString("base64"), "xx" + realBuffer.from(KEY).toString("base64"), realBuffer.from(KEY).toString("hex"), realBuffer.from(KEY, "utf16le").toString("hex"),
    [...KEY].map((c) => c.charCodeAt(0)).join(""), [...KEY].reverse().join(""),
  ];
  for (const form of forms) {
    const out = scrubSecrets(`before ${form} after`, KEY);
    assert.ok(out.includes("[redacted]"), `form not redacted: ${form.slice(0, 24)}`);
    assert.ok(!out.includes(form), "the form is gone");
  }
  assert.equal(scrubSecrets("a plain sentence with nothing in it", KEY), "a plain sentence with nothing in it");
  const err = scrubError(new Error(`provider said ${KEY}`), KEY);
  assert.ok(!err.message.includes(KEY) && err.message.includes("[redacted]"));
  assert.equal(scrubError(new Error("Anthropic API HTTP 400"), KEY).message, "Anthropic API HTTP 400");
});

test("the 12-character window layer still catches a key with non-ASCII characters (UTF-8 and UTF-16 byte forms)", () => {
  const key = "sk-ant-é中-unicode-key-12345678";
  const b64 = realBuffer.from(key).toString("base64");
  assert.ok(scrubSecrets(`x ${b64} y`, key).includes("[redacted]"));
  assert.ok(scrubSecrets(`x ${realBuffer.from(key, "utf16le").toString("base64")} y`, key).includes("[redacted]"));
});

// ---- (2) nothing in the Worker reaches for Node-only globals --------------------------------------------------------------------------------------------
test("Worker sources use no Node-only globals or imports (Buffer, process, require, node: modules): the Worker has no nodejs_compat", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.m?js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const root = new URL("../../infrastructure/worker", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const toml = readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8");
  assert.ok(!/^\s*compatibility_flags\s*=.*nodejs_compat/m.test(toml), "if nodejs_compat is ever enabled this test and the note in ai-keys.js can go");
  const bad = [];
  for (const file of walk(root)) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const re of [/\bBuffer\b/, /\bprocess\.(?:env|version|nextTick|hrtime|cwd|platform)\b/, /\brequire\(/, /__dirname|__filename/, /from\s+["']node:/, /\bsetImmediate\b/]) {
      if (re.test(code)) bad.push(`${file.slice(root.length + 1)}: ${re}`);
    }
  }
  assert.deepEqual(bad, []);
});

// ---- (3) the hop works and names what failed ---------------------------------------------------------------------------------------------------------------
test("a successful Claude answer comes back with no Buffer (it used to die in scrubSecrets)", async () => {
  const r = await run(baseEnv());
  assert.equal(r.reason, undefined, JSON.stringify(r));
  assert.equal(r.provider, "claude");
  assert.match(r.answer, /Short answer first/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers["cf-aig-authorization"], `Bearer ${TOKEN}`);
});

test("an HTTP error is named by its status, not masked by the scrubber", async () => {
  for (const status of [400, 401, 404, 429, 529]) {
    resetResearchClaudeForTests();
    reply = () => ({ status, body: { error: { type: "x", message: "nope" } } });
    const r = await run(baseEnv());
    assert.equal(r.reason, `claude:http-${status}`, String(status));
  }
});

test("a fetch that throws is named by the error class, never the message or the key", async () => {
  reply = () => ({ throws: new RangeError(`weird failure carrying ${KEY}`) });
  const r = await run(baseEnv());
  assert.equal(r.reason, "claude:error-RangeError");
  assert.ok(!JSON.stringify(r).includes(KEY.slice(-8)));
  reply = () => ({ throws: new Error("Too many subrequests by single worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/platform/limits") });
  assert.equal((await run(baseEnv())).reason, "claude:subrequests");
  reply = () => ({ throws: new TypeError("Invalid header value.") });
  assert.equal((await run(baseEnv())).reason, "claude:header");
});

test("a guard stop is still named by its guard code with no Buffer (the scrubber used to hide it behind claude:error)", async () => {
  // beforeSend (the outbound guard over the final body) throws a coded error; callAnthropicClaude passes it through scrubError, which must keep the code.
  const guard = Object.assign(new Error("outbound secret guard: env-secret"), { code: "OUTBOUND_SECRET" });
  await assert.rejects(callAnthropicClaude({ env: baseEnv(), systemPrompt: "s", userPrompt: "u", deep: true, wantUsage: true, beforeSend: () => { throw guard; } }), (e) => e.code === "OUTBOUND_SECRET" && e.name === "Error");
  assert.equal(sent.length, 0);
  const r = await tryResearchClaude({ env: baseEnv(), priv: null, deep: true, hardEndAt: Date.now() + 20000, real: { system: "s", user: "u", friend: [] }, call: () => Promise.reject(guard) });
  assert.equal(r.reason, "guard:secret");
});

test("failReason: fixed, value-free classes", () => {
  assert.equal(failReason({ code: "ai_timeout" }), "claude:timeout");
  assert.equal(failReason({ name: "TimeoutError" }), "claude:timeout");
  assert.equal(failReason(new Error("Anthropic API HTTP 529")), "claude:http-529");
  assert.equal(failReason(new Error("Too many subrequests by single worker invocation.")), "claude:subrequests");
  assert.equal(failReason(new Error("TOO MANY SUBREQUESTS")), "claude:subrequests");
  assert.equal(failReason(new TypeError("Invalid header value.")), "claude:header");
  assert.equal(failReason(new TypeError("Cannot convert argument to a ByteString because the character at index 3 has a value of 8212 which is greater than 255.")), "claude:header");
  assert.equal(failReason(new TypeError("x is not a function")), "claude:error-TypeError");
  assert.equal(failReason(new ReferenceError("Buffer is not defined")), "claude:error-ReferenceError");
  assert.equal(failReason(new Error("anything")), "claude:error-Error");
  assert.equal(failReason(Object.assign(new Error("m"), { code: "AI_GATEWAY_TOKEN_INVALID" })), "claude:header");
  // The name is sanitised: letters and digits only, capped; an empty or missing name is the bare class.
  assert.equal(failReason({ name: "My-Weird_Error!! name", message: "m" }), "claude:error-MyWeirdErrorname");
  assert.equal(failReason({ name: "A".repeat(80), message: "m" }), `claude:error-${"A".repeat(ERROR_NAME_MAX)}`);
  assert.equal(failReason({ name: "——", message: "m" }), "claude:error");
  for (const bad of [null, undefined, {}, "boom", 42]) assert.equal(failReason(bad), "claude:error");
  // Never the message.
  assert.ok(!failReason(Object.assign(new Error("secret message text 12345"), { name: "Weird" })).includes("secret"));
});

// ---- (4) the gateway token -----------------------------------------------------------------------------------------------------------------------------------
test("a gateway token with edge whitespace is trimmed and sent", async () => {
  const r = await run(baseEnv({ AI_GATEWAY_TOKEN: `  ${TOKEN}\n` }));
  assert.equal(r.reason, undefined);
  assert.equal(sent[0].headers["cf-aig-authorization"], `Bearer ${TOKEN}`);
});

test("a gateway token with a newline or control character inside stops the send with claude:header, before any fetch", async () => {
  for (const bad of [`${TOKEN}\n${TOKEN}`, `${TOKEN}\u0000x`, `${TOKEN} ${TOKEN}`, "x".repeat(600)]) {
    resetResearchClaudeForTests();
    sent = [];
    const r = await run(baseEnv({ AI_GATEWAY_TOKEN: bad }));
    assert.equal(r.reason, "claude:header");
    assert.equal(sent.length, 0);
  }
});
