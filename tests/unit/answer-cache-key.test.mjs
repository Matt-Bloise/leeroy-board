// The AI answer cache key and gateway metadata. No network (fetch is stubbed and counted), no AI, no real keys.
// The key is a hash of the final system + user prompt, so the proof runs the real answerWithAi path and reads the
// cf-aig-cache-key / cf-aig-metadata headers it sends to the gateway. (PR previews force Workers AI, which never sends this
// header, so a preview or API-suite run cannot catch a cache key bug; this test can.)
// Run: node --test tests/unit/answer-cache-key.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, buildAnswerCacheKey, answerModelLabel, gatewayMetadata, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: init.headers });
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok. -# Sources: x" } }] }), { status: 200, headers: { "content-type": "application/json" } });
};
test.after(() => { globalThis.fetch = realFetch; });

const persona = (version, system = `You are Leeroy, voice v${version}.`) => ({
  version, system, journeys: { guided: "GUIDED", curious: "CURIOUS", everything: "ALL" }, format: { chatMaxChars: 900 },
});

let n = 0;
// Runs one real ask and returns the headers the gateway request carried.
async function ask({ by = "Santa", isMember = true, journey = "curious", share = true, pack = persona(1), question = "who tanks tonight", provider = "groq", deep = false } = {}) {
  invalidatePersonaCache();
  invalidatePagesCache();
  const DB = schemaDb();
  if (pack) DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('persona', ?, 'x')").run(JSON.stringify(pack));
  const env = {
    DB, GROQ_API_KEY: "test-key-not-real", AI_GATEWAY_ID: "gw", CLOUDFLARE_ACCOUNT_ID: "acct",
    BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) },
  };
  const id = `t${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, ?, 'thinking', 1, 'x')").run(id, by, question, provider);
  const before = calls.length;
  const silence = console.error; console.error = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, question, provider, share, journey, isMember, deep }); } finally { console.error = silence; }
  assert.equal(calls.length, before + 1, "exactly one gateway request");
  return calls[calls.length - 1].headers;
}
const keyOf = async (o) => (await ask(o))["cf-aig-cache-key"];

test("same inputs give the same key", async () => {
  const a = await keyOf({});
  assert.ok(a, "cache key header is sent");
  assert.equal(a, await keyOf({}));
});

test("two askers with the same question never share a key", async () => {
  assert.notEqual(await keyOf({ by: "Santa", isMember: true }), await keyOf({ by: "Bloise", isMember: true }));
});

test("member and visitor never share a key", async () => {
  assert.notEqual(await keyOf({ by: "Santa", isMember: true }), await keyOf({ by: "Santa", isMember: false }));
});

test("two persona versions never share a key", async () => {
  assert.notEqual(await keyOf({ pack: persona(1) }), await keyOf({ pack: persona(2) }));
  assert.notEqual(await keyOf({ pack: persona(1) }), await keyOf({ pack: null }), "no pack at all is its own key");
});

test("two journeys never share a key, and coach mode (private guided) differs from a shared guided ask", async () => {
  const curious = await keyOf({ journey: "curious" });
  const guided = await keyOf({ journey: "guided", share: true });
  const coach = await keyOf({ journey: "guided", share: false });
  assert.equal(new Set([curious, guided, coach]).size, 3);
});

test("depth changes the key", async () => {
  const k = await keyOf({});
  assert.notEqual(k, await keyOf({ deep: true }));
});

test("the key holds no raw name or question text", async () => {
  const k = await keyOf({ by: "Handsome Squidward", question: "SECRET QUESTION TEXT" });
  assert.ok(!/squidward|secret|question/i.test(k), k);
  assert.match(k, /^ask:groq:llama-3\.3-70b-versatile:fast:production:member:[0-9a-f]{32}$/);
});

test("metadata on the real request carries variant, tier and journey and no personal data", async () => {
  const h = await ask({ by: "Handsome Squidward", question: "SECRET QUESTION TEXT", journey: "guided" });
  assert.deepEqual(JSON.parse(h["cf-aig-metadata"]), { app: "leeroy-board", service: "chamber", variant: "production", tier: "member", journey: "guided" });
  assert.ok(!/squidward|secret/i.test(h["cf-aig-metadata"]));
  const v = await ask({ isMember: false });
  assert.equal(JSON.parse(v["cf-aig-metadata"]).tier, "guest");
});

test("gatewayMetadata: free text collapses to fixed labels; no input keeps the old two fields", () => {
  const bad = JSON.parse(gatewayMetadata({ variant: "plain", tier: "Santa Claus", journey: "what is bloise doing" }));
  assert.equal(bad.tier, "guest");
  assert.equal(bad.journey, "other");
  assert.ok(!/santa|bloise/i.test(JSON.stringify(bad)));
  assert.deepEqual(JSON.parse(gatewayMetadata(null)), { app: "leeroy-board", service: "chamber" });
});

test("buildAnswerCacheKey is a pure function of provider, model, depth, variant, tier and both prompts", async () => {
  const base = { provider: "gemini", model: answerModelLabel({}, "gemini", false), systemPrompt: "S", userPrompt: "U" };
  const k = await buildAnswerCacheKey(base);
  assert.equal(k, await buildAnswerCacheKey({ ...base }));
  for (const over of [{ systemPrompt: "S2" }, { userPrompt: "U2" }, { model: "other" }, { deep: true }, { variant: "plain" }, { tier: "member" }]) {
    assert.notEqual(k, await buildAnswerCacheKey({ ...base, ...over }), JSON.stringify(over));
  }
  // The split between the two prompts matters: moving text across the boundary changes the key.
  assert.notEqual(await buildAnswerCacheKey({ ...base, systemPrompt: "SU", userPrompt: "" }), await buildAnswerCacheKey({ ...base, systemPrompt: "S", userPrompt: "U" }));
});
