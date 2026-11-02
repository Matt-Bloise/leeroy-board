// Unit tests for Cloudflare AI Gateway routing, provider key injection, and persona preservation.
// Run: node --test tests/unit/ai-gateway.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchToProvider,
  resolveGatewayUrl,
  getOpenAiProviderSlug,
} from "../../infrastructure/worker/ai-models.js";

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

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

test("Claude routes through AI Gateway with x-api-key and persona prompt", async () => {
  const recorded = [];
  globalThis.fetch = async (url, init) => {
    recorded.push({ url, init });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Answer from Claude" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const env = {
    ANTHROPIC_API_KEY: "sk-ant-test123",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const personaSystem = "You are Leeroy Jenkins, the party librarian.";
  const res = await dispatchToProvider({
    provider: "claude",
    env,
    systemPrompt: personaSystem,
    userPrompt: "What is Molten Core?",
    deep: false,
    cacheKey: "test-cache-key",
  });

  assert.equal(res.answer, "Answer from Claude");
  assert.equal(recorded.length, 1);
  const req = recorded[0];
  assert.equal(
    req.url,
    "https://gateway.ai.cloudflare.com/v1/acct-cf-456/leeroy-ai-gateway/anthropic/v1/messages"
  );
  assert.equal(req.init.headers["x-api-key"], "sk-ant-test123");
  assert.equal(req.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.init.headers["cf-aig-cache-key"], "test-cache-key");

  const parsedBody = JSON.parse(req.init.body);
  assert.equal(parsedBody.system[0].text, personaSystem);
});

test("Gemini routes through AI Gateway with x-goog-api-key, key query param, and persona prompt", async () => {
  const recorded = [];
  globalThis.fetch = async (url, init) => {
    recorded.push({ url, init });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Answer from Gemini" }] } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const env = {
    GEMINI_API_KEY: "gemini-secret-key-xyz",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const personaSystem = "You are Leeroy Jenkins, the party librarian.";
  const res = await dispatchToProvider({
    provider: "gemini",
    env,
    systemPrompt: personaSystem,
    userPrompt: "Who is Bloise?",
    deep: false,
    cacheKey: "gemini-cache-key",
  });

  assert.equal(res.answer, "Answer from Gemini");
  assert.equal(recorded.length, 1);
  const req = recorded[0];
  assert.ok(
    req.url.startsWith(
      "https://gateway.ai.cloudflare.com/v1/acct-cf-456/leeroy-ai-gateway/google-ai-studio/v1beta/models/"
    )
  );
  assert.equal(req.init.headers["x-goog-api-key"], "gemini-secret-key-xyz");
  assert.equal(req.init.headers["cf-aig-cache-key"], "gemini-cache-key");

  const parsedBody = JSON.parse(req.init.body);
  assert.equal(parsedBody.systemInstruction.parts[0].text, personaSystem);
});

test("Groq routes through AI Gateway with Bearer token and persona prompt", async () => {
  const recorded = [];
  globalThis.fetch = async (url, init) => {
    recorded.push({ url, init });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Answer from Groq" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const env = {
    GROQ_API_KEY: "groq-key-789",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const personaSystem = "You are Leeroy Jenkins.";
  const res = await dispatchToProvider({
    provider: "groq",
    env,
    systemPrompt: personaSystem,
    userPrompt: "Where is Blackrock Mountain?",
    deep: false,
  });

  assert.equal(res.answer, "Answer from Groq");
  assert.equal(recorded.length, 1);
  const req = recorded[0];
  assert.equal(
    req.url,
    "https://gateway.ai.cloudflare.com/v1/acct-cf-456/leeroy-ai-gateway/groq/chat/completions"
  );
  assert.equal(req.init.headers["Authorization"], "Bearer groq-key-789");

  const parsedBody = JSON.parse(req.init.body);
  assert.equal(parsedBody.messages[0].content, personaSystem);
});

test("Cerebras routes through AI Gateway with Bearer token", async () => {
  const recorded = [];
  globalThis.fetch = async (url, init) => {
    recorded.push({ url, init });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Answer from Cerebras" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const env = {
    CEREBRAS_API_KEY: "cerebras-key-123",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const res = await dispatchToProvider({
    provider: "cerebras",
    env,
    systemPrompt: "Persona",
    userPrompt: "Hello",
  });

  assert.equal(res.answer, "Answer from Cerebras");
  assert.equal(
    recorded[0].url,
    "https://gateway.ai.cloudflare.com/v1/acct-cf-456/leeroy-ai-gateway/cerebras/chat/completions"
  );
  assert.equal(recorded[0].init.headers["Authorization"], "Bearer cerebras-key-123");
});

test("OpenRouter routes through AI Gateway with Bearer token and custom referer headers", async () => {
  const recorded = [];
  globalThis.fetch = async (url, init) => {
    recorded.push({ url, init });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Answer from OpenRouter" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const env = {
    OPENROUTER_API_KEY: "openrouter-key-abc",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const res = await dispatchToProvider({
    provider: "openrouter",
    env,
    systemPrompt: "Persona",
    userPrompt: "Hello",
  });

  assert.equal(res.answer, "Answer from OpenRouter");
  assert.equal(
    recorded[0].url,
    "https://gateway.ai.cloudflare.com/v1/acct-cf-456/leeroy-ai-gateway/openrouter/chat/completions"
  );
  assert.equal(recorded[0].init.headers["Authorization"], "Bearer openrouter-key-abc");
  assert.equal(recorded[0].init.headers["X-Title"], "Dungeons and Drinking Living Board");
});

test("GitHub Models routes through AI Gateway compat endpoint with Bearer token", async () => {
  const recorded = [];
  globalThis.fetch = async (url, init) => {
    recorded.push({ url, init });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Answer from GitHub Models" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const env = {
    GITHUB_MODELS_TOKEN: "gh-token-xyz",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const res = await dispatchToProvider({
    provider: "github",
    env,
    systemPrompt: "Persona",
    userPrompt: "Hello",
  });

  assert.equal(res.answer, "Answer from GitHub Models");
  assert.equal(
    recorded[0].url,
    "https://gateway.ai.cloudflare.com/v1/acct-cf-456/leeroy-ai-gateway/compat/chat/completions"
  );
  assert.equal(recorded[0].init.headers["Authorization"], "Bearer gh-token-xyz");
});

test("Workers AI passes AI Gateway configuration and persona prompt to env.AI.run", async () => {
  const seenCalls = [];
  const env = {
    AI: {
      run: async (model, inputs, opts) => {
        seenCalls.push({ model, inputs, opts });
        return { response: "Answer from Workers AI Llama 3.3" };
      },
    },
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const personaSystem = "You are Leeroy Jenkins.";
  const res = await dispatchToProvider({
    provider: "workers-ai",
    env,
    systemPrompt: personaSystem,
    userPrompt: "Tell me about Ragnaros",
    skipCache: true,
  });

  assert.equal(res.answer, "Answer from Workers AI Llama 3.3");
  assert.equal(seenCalls.length, 1);
  const call = seenCalls[0];
  assert.equal(call.opts.gateway.id, "leeroy-ai-gateway");
  assert.equal(call.opts.gateway.skipCache, true);
  assert.equal(call.inputs.messages[0].content, personaSystem);
});

test("Gateway 404 smoothly falls back to direct provider endpoint", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      return new Response("Gateway Not Found", { status: 404 });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Direct Fallback Answer" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const env = {
    ANTHROPIC_API_KEY: "sk-ant-test123",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const res = await dispatchToProvider({
    provider: "claude",
    env,
    systemPrompt: "Persona",
    userPrompt: "Hello",
  });

  assert.equal(res.answer, "Direct Fallback Answer");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith("https://gateway.ai.cloudflare.com/"));
  assert.equal(calls[1].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[1].init.headers["x-api-key"], "sk-ant-test123");
});

test("AI_GATEWAY_TOKEN injects cf-aig-authorization header to Cloudflare AI Gateway", async () => {
  const recorded = [];
  globalThis.fetch = async (url, init) => {
    recorded.push({ url, init });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Authenticated Gateway Answer" }] } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const env = {
    GEMINI_API_KEY: "gemini-secret-key",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
    AI_GATEWAY_TOKEN: "cf-aig-auth-token-12345",
  };

  const res = await dispatchToProvider({
    provider: "gemini",
    env,
    systemPrompt: "Persona",
    userPrompt: "Hello",
  });

  assert.equal(res.answer, "Authenticated Gateway Answer");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].init.headers["cf-aig-authorization"], "Bearer cf-aig-auth-token-12345");
});

test("Gateway 401 Unauthorized smoothly falls back to direct provider endpoint", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      return new Response(JSON.stringify({ error: "Unauthorized", message: "Gateway requires authentication" }), { status: 401 });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Fallback from 401" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const env = {
    ANTHROPIC_API_KEY: "sk-ant-test123",
    CLOUDFLARE_ACCOUNT_ID: "acct-cf-456",
    AI_GATEWAY_ID: "leeroy-ai-gateway",
  };

  const res = await dispatchToProvider({
    provider: "claude",
    env,
    systemPrompt: "Persona",
    userPrompt: "Hello",
  });

  assert.equal(res.answer, "Fallback from 401");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith("https://gateway.ai.cloudflare.com/"));
  assert.equal(calls[1].url, "https://api.anthropic.com/v1/messages");
});
