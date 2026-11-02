// Unit tests for Cloudflare AI Gateway URL resolution and slug mappings.
// Pure offline URL formatting tests only — zero AI provider calls, zero network, zero token usage.
// Run: node --test tests/unit/ai-gateway.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveGatewayUrl,
  getOpenAiProviderSlug,
} from "../../infrastructure/worker/ai-models.js";

test("resolveGatewayUrl formats correct Cloudflare AI Gateway URL", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acct123", AI_GATEWAY_ID: "leeroy-ai-gateway" };
  const gwUrl = resolveGatewayUrl(env, "anthropic/v1/messages", "https://api.anthropic.com/v1/messages");
  assert.equal(gwUrl, "https://gateway.ai.cloudflare.com/v1/acct123/leeroy-ai-gateway/anthropic/v1/messages");

  // Fallback to ACCOUNT_ID or CF_ACCOUNT_ID alias
  assert.equal(
    resolveGatewayUrl({ ACCOUNT_ID: "altAcct", AI_GATEWAY_ID: "gw" }, "groq/chat/completions", "https://api.groq.com"),
    "https://gateway.ai.cloudflare.com/v1/altAcct/gw/groq/chat/completions"
  );

  // When account ID is missing, fall back to default endpoint safely
  assert.equal(
    resolveGatewayUrl({ CLOUDFLARE_ACCOUNT_ID: "" }, "slug", "https://default.com"),
    "https://default.com"
  );
  assert.equal(
    resolveGatewayUrl(null, "slug", "https://default.com"),
    "https://default.com"
  );
});

test("getOpenAiProviderSlug returns proper gateway slug for each provider", () => {
  assert.equal(getOpenAiProviderSlug("groq"), "groq/chat/completions");
  assert.equal(getOpenAiProviderSlug("cerebras"), "cerebras/chat/completions");
  assert.equal(getOpenAiProviderSlug("openrouter"), "openrouter/chat/completions");
  assert.equal(getOpenAiProviderSlug("github"), "compat/chat/completions");
});
