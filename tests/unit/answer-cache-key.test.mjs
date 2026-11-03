// Unit tests for the AI answer cache key and gateway metadata. No network, no D1, no AI, no keys.
// Run: node --test tests/unit/answer-cache-key.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnswerCacheKey,
  gatewayMetadata,
  fetchWithGatewayFallback,
} from "../../infrastructure/worker/ai-models.js";

const base = {
  libraryStamp: "stamp1",
  provider: "gemini",
  deep: false,
  question: "who tanks tonight",
  journey: "curious",
  variant: "production",
  tier: "member",
  persona: { id: "leeroy", version: 1, system: "VOICE ONE" },
  memberSlug: "santa",
  isMember: true,
};
const key = (over = {}) => buildAnswerCacheKey({ ...base, ...over });

test("two personas never share a cache entry", async () => {
  const a = await key({ persona: { id: "leeroy", version: 1, system: "VOICE ONE" } });
  const b = await key({ persona: { id: "other", version: 1, system: "VOICE ONE" } });
  const c = await key({ persona: { id: "leeroy", version: 1, system: "VOICE TWO" } }); // edited without a bump
  const none = await key({ persona: null });
  assert.equal(new Set([a, b, c, none]).size, 4);
});

test("changing the persona version changes the key", async () => {
  const v1 = await key({ persona: { id: "leeroy", version: 1, system: "VOICE ONE" } });
  const v2 = await key({ persona: { id: "leeroy", version: 2, system: "VOICE ONE" } });
  assert.notEqual(v1, v2);
});

test("two askers never share an entry when the answer is addressed by name", async () => {
  const santa = await key({ memberSlug: "santa" });
  const bloise = await key({ memberSlug: "bloise" });
  assert.notEqual(santa, bloise);
  assert.equal(santa, await key({ memberSlug: "santa" })); // stable for the same asker
});

test("guests share only an anonymous scope, never with a member", async () => {
  const g1 = await key({ tier: "guest", isMember: false, memberSlug: "guest-abc" });
  const g2 = await key({ tier: "guest", isMember: false, memberSlug: "guest-xyz" });
  assert.equal(g1, g2);
  assert.notEqual(g1, await key({ memberSlug: "santa" }));
});

test("variant, tier, journey, provider, depth and coach mode each change the key", async () => {
  const k = await key();
  for (const over of [{ variant: "plain" }, { tier: "guest" }, { journey: "guided" }, { provider: "groq" }, { deep: true }, { coach: true }, { libraryStamp: "stamp2" }]) {
    assert.notEqual(k, await key(over), JSON.stringify(over));
  }
});

test("the key holds no raw name, slug or question text", async () => {
  const k = await key({ memberSlug: "handsome-squidward", question: "SECRET QUESTION TEXT" });
  assert.ok(!/squidward|santa|secret|question/i.test(k), k);
  assert.match(k, /^ask:stamp1:gemini:fast:curious:production:member:leeroy\.v1\.[0-9a-f]{8}:m[0-9a-f]{12}:[0-9a-f]{16}$/);
  assert.match(await key({ isMember: false, tier: "guest" }), /:anon:[0-9a-f]{16}$/);
});

test("metadata carries variant, tier and journey and no personal data", () => {
  const m = JSON.parse(gatewayMetadata({ variant: "production", tier: "member", journey: "guided" }));
  assert.deepEqual(m, { app: "leeroy-board", service: "chamber", variant: "production", tier: "member", journey: "guided" });
  // Free text is never passed through: unknown tier / journey collapse to fixed labels.
  const bad = JSON.parse(gatewayMetadata({ variant: "plain", tier: "Santa Claus", journey: "what is bloise doing" }));
  assert.equal(bad.tier, "guest");
  assert.equal(bad.journey, "other");
  assert.ok(!/santa|bloise/i.test(JSON.stringify(bad)));
  // No metadata given keeps the old two-field shape.
  assert.deepEqual(JSON.parse(gatewayMetadata(null)), { app: "leeroy-board", service: "chamber" });
});

test("the gateway request sends the cache key and the new metadata headers", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return new Response("{}", { status: 200 });
  };
  try {
    await fetchWithGatewayFallback({
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw" },
      providerSlug: "groq/chat/completions",
      defaultEndpoint: "https://api.groq.com/x",
      body: "{}",
      cacheKey: "ask:k",
      metadata: { variant: "production", tier: "guest", journey: "curious" },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["cf-aig-cache-key"], "ask:k");
  const meta = JSON.parse(seen[0].headers["cf-aig-metadata"]);
  assert.equal(meta.variant, "production");
  assert.equal(meta.tier, "guest");
  assert.equal(meta.journey, "curious");
});
