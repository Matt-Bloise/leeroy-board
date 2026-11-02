// =============================================================================
// Multi-Provider AI Integration & House-Voice Guardrails (`worker/ai-models.js`)
// Supports switching seamlessly between:
//   1. Anthropic Claude (`claude` — Haiku 4.5 / Sonnet 4.5 via `ANTHROPIC_API_KEY`)
//   2. Google Gemini Free Tier (`gemini` — Gemini 3.5 Flash-Lite / 3.8 Pro via `GEMINI_API_KEY`)
//   3. Cloudflare Workers AI Free Tier (`workers-ai` — Llama 3.3 70B via `[ai]` binding, 0 keys needed)
//   4. GroqCloud Free Tier (`groq` — Llama 3.3 70B Versatile via `GROQ_API_KEY`)
//   5. Cerebras Free Tier (`cerebras` — Llama 3.3 70B via `CEREBRAS_API_KEY`)
//   6. GitHub Models Free Tier (`github` — OpenAI GPT-4o-mini / GPT-4o via `GITHUB_MODELS_TOKEN`)
//   7. OpenRouter Free Tier (`openrouter` — DeepSeek V3 `:free` via `OPENROUTER_API_KEY`)
// Includes `wow-mage/bot/tools/api-brain.mjs` + `precheck.mjs` house-voice guardrails,
// `guided` coach voice, and `wiki-learn.mjs` automated D1 fact extraction.
// =============================================================================

import { broadcastToRoom, purgeWorkerCache, buildPartySheetsFromD1 } from "./index.js";
import { rank as rankWikiCore, factHays } from "./rank-core.js";
import { sha256Hex } from "./crypto.js";
import { loadPersona, buildSystemPrompt, pickLine } from "./persona.js";
import { loadConfigKey } from "./config.js";
import { estimateNeurons, tokensFromChars, loadBudget, recordUsage, recordAttributed, checkAskBudget, loadAskCaps, overCap, dailyCap, secondsToUtcMidnight, CRON_RESERVE } from "./budget.js";
import { clampContent, ALLOWED_MENTIONS_NONE } from "./discord-safety.js";
import { formatAnswer, answerFormatEnabled, answerUxEnabled, extractCitedIds } from "./answer-format.js";
import { ROSTER_DATA } from "./bot-data.js";

// Alias -> display name for the voice guards. Only distinctive single-word aliases that sit inside a longer display name
// are used ("squidward" -> "Handsome Squidward"); short or common words such as "rat", "tank" or "mage" are never rewritten.
export function rosterAliases() {
  const map = {};
  for (const r of ROSTER_DATA) {
    for (const a of r.aliases || []) {
      if (/^[a-z]{6,}$/i.test(a) && a.toLowerCase() !== r.display.toLowerCase() && r.display.toLowerCase().includes(a.toLowerCase())) map[a] = r.display;
    }
  }
  return map;
}

export const AI_PROVIDER_LABELS = {
  claude: "Claude",
  gemini: "Gemini Free Tier",
  "workers-ai": "Cloudflare Workers AI (Llama 3.3 70B)",
  groq: "Groq Free Tier (Llama 3.3 70B)",
  cerebras: "Cerebras Free Tier (Llama 3.3 70B)",
  github: "GitHub Models (GPT-4o)",
  openrouter: "OpenRouter Free (DeepSeek V3)",
};

const ORDERS_RE = new RegExp(
  String.raw`(^|[.!?]\s+)(?:Don't|Do not|Make sure|Start with|Treat (?:it|this|that) as|Go with|Get it done|You should|Remember to|Be sure to)\b[^.!?\n]*[.!?]?`,
  "gm"
);

const COACH_PROMPT =
  "This reply stays on the asker's own screen. Speak as their coach: two or three plain sentences, the one next thing to do, in the second person, no list, and say how long it takes when you know.";

export function repairHouseVoice(rawText, opts = {}) {
  let out = String(rawText || "").trim();
  if (!out) return out;

  // 1. Replace real-life first names with party display names (privacy rule). The map comes from D1 config
  // (opts.nameMap); with no map this step is a no-op.
  for (const [first, display] of Object.entries(opts.nameMap || {})) {
    if (!/^[\w .'-]+$/.test(first)) continue;
    out = out.replace(new RegExp(`\\b${first}\\b`, "g"), display);
  }
  out = out.replace(/\bSkippy\b/gi, "Leeroy");

  // 2. Strip bare 17-20 digit Discord snowflake IDs outside URLs
  out = out.replace(/(?<!https:\/\/discord\.com\/[^\s"]*)\b\d{17,20}\b/g, "");

  // 3. Inform, never instruct (strip imperative openers unless in private Guided coach mode)
  if (!opts.isCoach) {
    const stripped = out.replace(ORDERS_RE, "$1").trim();
    if (stripped.length >= 16) out = stripped;
  }

  // 4. Keep at most one bold span (`**...**`) per `api-brain.mjs` house-style rule
  let seenBold = false;
  out = out.replace(/\*\*([^*]+)\*\*/g, (match, inner) => {
    if (!seenBold) {
      seenBold = true;
      return match;
    }
    return inner;
  });

  // Collapse spaces and tabs only; newlines carry the answer's line structure.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Website-only: turn a Discord deep-link token {board:<token>} into a plain link,
// or drop it when the token is malformed. Stored answers keep the token.
export function webBoardLinks(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\{board:([^}]*)\}/g, (m, token) =>
      /^[a-z0-9.-]{1,80}$/.test(token) ? `https://leeroy.party/#${token}` : ""
    )
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// Website-only, recursive: run webBoardLinks over every string that carries a
// {board:...} token inside a JSON-like value (objects, arrays). Returns a copy only
// where something changed; everything else is passed through untouched. Used for
// bootstrap/state/data responses and room broadcasts. Never applied to what is stored.
export function webBoardLinksDeep(value) {
  if (typeof value === "string") return value.includes("{board:") ? webBoardLinks(value) : value;
  if (Array.isArray(value)) {
    let out = null;
    value.forEach((v, i) => {
      const n = webBoardLinksDeep(v);
      if (n !== v) {
        if (!out) out = value.slice();
        out[i] = n;
      }
    });
    return out || value;
  }
  if (value && typeof value === "object") {
    let out = null;
    for (const k of Object.keys(value)) {
      const n = webBoardLinksDeep(value[k]);
      if (n !== value[k]) {
        if (!out) out = { ...value };
        out[k] = n;
      }
    }
    return out || value;
  }
  return value;
}

export function isPrPreviewEnv(env) {
  if (!env) return false;
  return (
    String(env.IS_PR_PREVIEW || "").toLowerCase() === "true" ||
    String(env.IS_PR_PREVIEW || "") === "1" ||
    Boolean(env.PR_NUMBER) ||
    String(env.WORKER_NAME || "").includes("-pr-")
  );
}

export function isProviderConfigured(env, provider) {
  if (isPrPreviewEnv(env)) {
    // In ephemeral PR preview environments, strictly enforce free zero-key AI models
    return provider === "workers-ai" && Boolean(env.AI && typeof env.AI.run === "function");
  }

  switch (provider) {
    case "claude":
      return Boolean(env.ANTHROPIC_API_KEY);
    case "gemini":
      return Boolean(env.GEMINI_API_KEY);
    case "workers-ai":
      return Boolean(env.AI && typeof env.AI.run === "function");
    case "groq":
      return Boolean(env.GROQ_API_KEY);
    case "cerebras":
      return Boolean(env.CEREBRAS_API_KEY);
    case "github":
      return Boolean(env.GITHUB_MODELS_TOKEN);
    case "openrouter":
      return Boolean(env.OPENROUTER_API_KEY);
    default:
      return false;
  }
}

export function resolveAiProvider(env, requestedProvider) {
  if (isPrPreviewEnv(env)) {
    // In ephemeral PR preview environments, only free AI models are permitted
    return "workers-ai";
  }

  const valid = Object.keys(AI_PROVIDER_LABELS);
  const req = String(requestedProvider || "").toLowerCase().trim();
  if (valid.includes(req) && isProviderConfigured(env, req)) {
    return req;
  }

  const def = String(env.AI_PROVIDER || "claude").toLowerCase().trim();
  if (valid.includes(def) && isProviderConfigured(env, def)) {
    return def;
  }

  // Automatic fallback across configured providers (Workers AI needs no external secret)
  for (const candidate of ["claude", "gemini", "groq", "cerebras", "github", "openrouter", "workers-ai"]) {
    if (isProviderConfigured(env, candidate)) return candidate;
  }
  return valid.includes(req) ? req : "claude";
}

function scorePageForQuestion(page, words) {
  let score = 0;
  const hayTitle = `${page.id} ${page.category || ""} ${page.title} ${page.blurb || ""}`.toLowerCase();
  const hayAliases = String(page.aliases_json || "").toLowerCase();
  const hayFacts = String(page.facts_json || "").toLowerCase();
  const hayOpen = String(page.open_json || "").toLowerCase();
  for (const w of words) {
    if (hayTitle.includes(w)) score += 5;
    if (hayAliases.includes(w)) score += 4;
    if (hayFacts.includes(w)) score += 2;
    if (hayOpen.includes(w)) score += 2;
  }
  return score;
}

// Timeouts live here and nowhere else. AI_TIMEOUT_MS is the default for callers with no deadline (cron, tests).
// The interactive ask path uses the shorter chosen/fallback budgets so the whole chain fits inside the Discord deadline.
const AI_TIMEOUT_MS = 20000;
export const ASK_CHOSEN_TIMEOUT_MS = 12000;
export const ASK_FALLBACK_TIMEOUT_MS = 9000;
export const ASK_DEADLINE_MS = 24000;

export class AiTimeoutError extends Error {
  constructor(what, ms = AI_TIMEOUT_MS) {
    super(`${what} timed out after ${ms}ms`);
    this.name = "AiTimeoutError";
    this.code = "ai_timeout";
  }
}

function isAbortLike(err) {
  return Boolean(err) && (err.name === "TimeoutError" || err.name === "AbortError");
}

// Every provider HTTP call goes through here so it carries an abort signal (20s by default).
async function fetchWithTimeout(url, init, what = "AI provider request", ms = AI_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (isAbortLike(err)) throw new AiTimeoutError(what, ms);
    throw err;
  }
}

// Time left before a provider call deadline (epoch ms), or the default when there is no deadline.
function msLeft(deadlineAt) {
  return deadlineAt ? Math.max(1000, deadlineAt - Date.now()) : AI_TIMEOUT_MS;
}

async function runWorkersAiWithTimeout(env, model, inputs, options, ms = AI_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(ms);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new AiTimeoutError("Workers AI call", ms));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const call = env.AI.run(model, inputs, { ...(options || {}), signal });
    call.catch?.(() => {}); // a late rejection after the race is settled must not be unhandled
    return await Promise.race([call, aborted]);
  } catch (err) {
    if (isAbortLike(err)) throw new AiTimeoutError("Workers AI call", ms);
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function resolveGatewayUrl(env, providerSlug, defaultEndpoint) {
  const accountId = (env && (env.CLOUDFLARE_ACCOUNT_ID || env.ACCOUNT_ID || env.CF_ACCOUNT_ID)) || "";
  const gatewayId = (env && env.AI_GATEWAY_ID) || "leeroy-ai-gateway";
  if (!accountId || !gatewayId || !providerSlug) return defaultEndpoint;
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${providerSlug}`;
}

export function getOpenAiProviderSlug(provider) {
  switch (provider) {
    case "groq":
      return "groq/chat/completions";
    case "cerebras":
      return "cerebras/chat/completions";
    case "openrouter":
      return "openrouter/chat/completions";
    case "github":
      return "compat/chat/completions";
    default:
      return "compat/chat/completions";
  }
}

export async function fetchWithGatewayFallback({
  env,
  providerSlug,
  defaultEndpoint,
  headers = {},
  body,
  skipCache = false,
  cacheKey = null,
  deadlineAt = null,
}) {
  const gwUrl = resolveGatewayUrl(env, providerSlug, defaultEndpoint);
  const aigToken = (env && (env.AI_GATEWAY_TOKEN || env.CLOUDFLARE_AIG_TOKEN || env.CLOUDFLARE_API_TOKEN)) || "";
  const cacheHeaders = env && env.AI_GATEWAY_ID ? {
    "cf-aig-cache-ttl": String(env.AI_GATEWAY_CACHE_TTL || 21600), // 6 hours matching the cron update cycle
    "cf-aig-metadata": JSON.stringify({ app: "leeroy-board", service: "chamber" }),
    ...(aigToken ? { "cf-aig-authorization": `Bearer ${aigToken}` } : {}),
    ...(skipCache ? { "cf-aig-skip-cache": "true" } : {}),
    ...(cacheKey ? { "cf-aig-cache-key": String(cacheKey) } : {}),
  } : {};

  if (gwUrl !== defaultEndpoint) {
    try {
      const resp = await fetchWithTimeout(
        gwUrl,
        {
          method: "POST",
          headers: { ...headers, ...cacheHeaders },
          body,
        },
        "AI provider request",
        deadlineAt ? Math.max(1000, Math.round(msLeft(deadlineAt) * 0.6)) : AI_TIMEOUT_MS
      );
      // If gateway returns success (2xx), return immediately
      if (resp.ok) return resp;
      // If gateway returns 401/403/404 or server error, fall back to direct endpoint
      console.warn(`[AI-Gateway] HTTP ${resp.status} from ${gwUrl}, falling back to direct endpoint`);
    } catch (err) {
      console.warn(`[AI-Gateway] Error for ${gwUrl}: ${err.message}, falling back to direct endpoint`);
    }
  }

  return await fetchWithTimeout(
    defaultEndpoint,
    {
      method: "POST",
      headers,
      body,
    },
    "AI provider request",
    msLeft(deadlineAt)
  );
}

async function callAnthropicClaude({ env, systemPrompt, userPrompt, deep, skipCache = false, cacheKey = null, deadlineAt = null }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY secret is not configured on the Cloudflare Worker");
  }
  const model = deep
    ? env.CLAUDE_MODEL_DEEP || "claude-sonnet-4-5-20250929"
    : env.CLAUDE_MODEL_FAST || "claude-haiku-4-5-20251001";

  const defaultEndpoint = "https://api.anthropic.com/v1/messages";
  const body = JSON.stringify({
    model,
    max_tokens: 350,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  const resp = await fetchWithGatewayFallback({
    env,
    providerSlug: "anthropic/v1/messages",
    defaultEndpoint,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body,
    skipCache,
    cacheKey,
    deadlineAt,
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Anthropic API HTTP ${resp.status}: ${errTxt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const answer = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return { answer, model, provider: "claude" };
}

async function callGeminiFreeTier({ env, systemPrompt, userPrompt, deep, skipCache = false, cacheKey = null, deadlineAt = null }) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY secret is not configured on the Cloudflare Worker");
  }
  const model = deep
    ? env.GEMINI_MODEL_DEEP || "gemini-3.8-pro"
    : env.GEMINI_MODEL_FAST || "gemini-3.5-flash-lite";

  const defaultEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  const body = JSON.stringify({
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 350,
      temperature: 0.3,
    },
  });

  const resp = await fetchWithGatewayFallback({
    env,
    providerSlug: `google-ai-studio/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`,
    defaultEndpoint,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body,
    skipCache,
    cacheKey,
    deadlineAt,
  });

  let activeResp = resp;
  let activeModel = model;
  if (!activeResp.ok && (activeResp.status === 503 || activeResp.status === 429) && activeModel !== "gemini-3.5-flash-lite") {
    console.warn(`[Gemini] ${activeModel} returned HTTP ${activeResp.status}, retrying with gemini-3.5-flash-lite`);
    activeModel = "gemini-3.5-flash-lite";
    activeResp = await fetchWithGatewayFallback({
      env,
      providerSlug: `google-ai-studio/v1beta/models/${encodeURIComponent(
        activeModel
      )}:generateContent`,
      defaultEndpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        activeModel
      )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body,
      skipCache,
      cacheKey,
      deadlineAt,
    });
  }

  if (!activeResp.ok) {
    const errTxt = await activeResp.text();
    throw new Error(`Gemini API HTTP ${activeResp.status}: ${errTxt.slice(0, 200)}`);
  }

  const data = await activeResp.json();
  const parts =
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts) ||
    [];
  const answer = parts
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  if (!answer) {
    throw new Error("Gemini API returned an empty response");
  }

  return { answer, model: activeModel, provider: "gemini" };
}

async function callCloudflareWorkersAi({ env, systemPrompt, userPrompt, skipCache = false, budgetKind = "ask", budgetKeys = null, deadlineAt = null }) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("Cloudflare Workers AI binding (env.AI) is not configured in wrangler.toml");
  }
  const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const inputs = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 350,
    temperature: 0.3,
  };

  let result = null;
  if (env && env.AI_GATEWAY_ID) {
    try {
      result = await runWorkersAiWithTimeout(env, model, inputs, {
        gateway: {
          id: env.AI_GATEWAY_ID,
          skipCache: Boolean(skipCache),
          cacheTtl: Number(env.AI_GATEWAY_CACHE_TTL) || 21600, // 6 hours: matches the cron update cycle
        },
      }, deadlineAt ? Math.max(1000, Math.round(msLeft(deadlineAt) * 0.6)) : AI_TIMEOUT_MS);
    } catch (gwErr) {
      console.warn(`[AI-Gateway] Workers AI gateway error (${env.AI_GATEWAY_ID}): ${gwErr.message}, falling back to direct run`);
      result = null;
    }
  }

  if (!result) {
    result = await runWorkersAiWithTimeout(env, model, inputs, undefined, msLeft(deadlineAt));
  }

  const answer = String(
    (result && (result.response || (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content))) || ""
  ).trim();

  if (!answer) throw new Error("Cloudflare Workers AI returned an empty response");

  // Count neurons against the daily soft cap. Use the API usage when present, else estimate from text length.
  const usage = (result && result.usage) || {};
  const inTok = Number(usage.prompt_tokens) || tokensFromChars(systemPrompt.length + userPrompt.length);
  const outTok = Number(usage.completion_tokens) || tokensFromChars(answer.length);
  const neurons = estimateNeurons(model, inTok, outTok);
  await recordUsage(env, budgetKind, neurons);
  if (budgetKind === "ask") await recordAttributed(env, budgetKeys, neurons);
  return { answer, model, provider: "workers-ai" };
}

async function callOpenAiCompatible({ provider, endpoint, apiKey, model, systemPrompt, userPrompt, extraHeaders = {}, env, skipCache = false, cacheKey = null, deadlineAt = null }) {
  if (!apiKey) {
    throw new Error(`API key secret for provider '${provider}' is not configured on the Cloudflare Worker`);
  }
  const body = JSON.stringify({
    model,
    max_tokens: 350,
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const providerSlug = getOpenAiProviderSlug(provider);

  const resp = await fetchWithGatewayFallback({
    env,
    providerSlug,
    defaultEndpoint: endpoint,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body,
    skipCache,
    cacheKey,
    deadlineAt,
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`${provider} API HTTP ${resp.status}: ${errTxt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const answer = String(
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ""
  ).trim();
  if (!answer) throw new Error(`${provider} returned an empty response`);
  return { answer, model, provider };
}

export async function dispatchToProvider({ provider, env, systemPrompt, userPrompt, deep, skipCache = false, cacheKey = null, budgetKind = "ask", budgetKeys = null, timeoutMs = null }) {
  if (isPrPreviewEnv(env) && provider !== "workers-ai") {
    provider = "workers-ai";
  }
  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  switch (provider) {
    case "gemini":
      return await callGeminiFreeTier({ env, systemPrompt, userPrompt, deep, skipCache, cacheKey, deadlineAt });
    case "workers-ai":
      return await callCloudflareWorkersAi({ env, systemPrompt, userPrompt, skipCache, budgetKind, budgetKeys, deadlineAt });
    case "groq":
      return await callOpenAiCompatible({
        provider: "groq",
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        apiKey: env.GROQ_API_KEY,
        model: deep
          ? env.GROQ_MODEL_DEEP || "llama-3.3-70b-versatile"
          : env.GROQ_MODEL_FAST || "llama-3.3-70b-versatile",
        systemPrompt,
        userPrompt,
        env,
        skipCache,
        cacheKey,
        deadlineAt,
      });
    case "cerebras":
      return await callOpenAiCompatible({
        provider: "cerebras",
        endpoint: "https://api.cerebras.ai/v1/chat/completions",
        apiKey: env.CEREBRAS_API_KEY,
        model: env.CEREBRAS_MODEL || "llama-3.3-70b",
        systemPrompt,
        userPrompt,
        env,
        skipCache,
        cacheKey,
        deadlineAt,
      });
    case "github":
      return await callOpenAiCompatible({
        provider: "github",
        endpoint: "https://models.inference.ai.azure.com/chat/completions",
        apiKey: env.GITHUB_MODELS_TOKEN,
        model: deep ? env.GITHUB_MODEL_DEEP || "gpt-4o" : env.GITHUB_MODEL_FAST || "gpt-4o-mini",
        systemPrompt,
        userPrompt,
        env,
        skipCache,
        cacheKey,
        deadlineAt,
      });
    case "openrouter":
      return await callOpenAiCompatible({
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free",
        systemPrompt,
        userPrompt,
        extraHeaders: {
          "HTTP-Referer": env.BOARD_PUBLIC_URL || "https://leeroy.party",
          "X-Title": "Dungeons and Drinking Living Board",
        },
        env,
        skipCache,
        cacheKey,
        deadlineAt,
      });
    case "claude":
    default:
      return await callAnthropicClaude({ env, systemPrompt, userPrompt, deep, skipCache, cacheKey, deadlineAt });
  }
}

let cachedParsedPages = null;
let cachedHays = null;
let cachedPagesAt = 0;
const PAGES_TTL_MS = 15 * 60 * 1000; // 15 minutes in-memory isolate cache

export function invalidatePagesCache() {
  cachedParsedPages = null;
  cachedHays = null;
  cachedPagesAt = 0;
}

export async function getParsedLibraryData(env) {
  const now = Date.now();
  if (cachedParsedPages && cachedHays && now - cachedPagesAt < PAGES_TTL_MS) {
    return { pages: cachedParsedPages, hays: cachedHays };
  }
  const { results: pages } = await env.DB.prepare(
    "SELECT id, category, title, as_of, blurb, aliases_json, facts_json, open_json FROM lib_pages"
  ).all();
  cachedParsedPages = (pages || []).map((p) => {
    let aliases = [],
      facts = [],
      open = [];
    try {
      aliases = JSON.parse(p.aliases_json || "[]");
    } catch {}
    try {
      facts = JSON.parse(p.facts_json || "[]");
    } catch {}
    try {
      open = JSON.parse(p.open_json || "[]");
    } catch {}
    return { ...p, aliases, facts, open };
  });
  cachedHays = factHays(cachedParsedPages);
  cachedPagesAt = now;
  return { pages: cachedParsedPages, hays: cachedHays };
}

export async function getParsedLibraryPages(env) {
  const { pages } = await getParsedLibraryData(env);
  return pages;
}

// Short, secret-free reason a provider was skipped, for the stored model field.
export function shortProviderError(err) {
  const raw = String((err && (err.code === "ai_timeout" ? `timeout ${err.message}` : err.message)) || err || "error");
  return raw
    .replace(/[?&]key=[^\s&"]+/gi, "")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export async function answerWithAi({
  env,
  origin,
  intentId,
  by,
  memberSlug,
  question,
  deep = false,
  share = true,
  journey = "curious",
  provider: requestedProvider,
  budget = null, // optional { userKey, tenantKey, guest }; without it only the global soft cap applies
  isMember, // is the asker a party member? Defaults to "not the Visitor placeholder".
}) {
  const t0 = Date.now();
  const nowIso = () => new Date().toISOString();
  const isCoach = journey === "guided" && share !== true;
  let budgetCode = null;

  try {
    // 1. Pull relevant library pages, index stamp & full party/schedule state from D1 for grounded RAG context
    const [{ pages: parsedPages, hays: cachedHays }, { results: stateRows }, partySheets, idxRow] = await Promise.all([
      getParsedLibraryData(env),
      env.DB.prepare("SELECT key, json FROM kv_state WHERE key IN ('party', 'signups', 'timeline', 'tonight')").all(),
      buildPartySheetsFromD1(env),
      env.DB.prepare("SELECT stamp FROM lib_blobs WHERE name = 'index.json'").first(),
    ]);

    const libraryStamp = (idxRow && idxRow.stamp) || "v1";

    // Score individual facts & open questions using precomputed cachedHays (TF-IDF + stemming + synonyms + role/lead boosts)
    const { words, hits } = rankWikiCore(question, parsedPages, { hays: cachedHays });
    const topFactHits = hits
      .slice(0, 20)
      .map((h) => `  - [${h.page}~${h.key}] (score ${h.score}): ${h.value}`);

    const pageHitBonus = new Map();
    for (const h of hits.slice(0, 30)) {
      pageHitBonus.set(h.page, (pageHitBonus.get(h.page) || 0) + h.score);
    }

    const fallbackWords =
      words && words.length
        ? words
        : question
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 2);

    const ranked = parsedPages
      .map((p) => ({ p, s: scorePageForQuestion(p, fallbackWords) + (pageHitBonus.get(p.id) || 0) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((x) => x.p);

    const topPagesSummary = ranked
      .map((p) => `  - ${p.title} (${p.id})${p.blurb ? `: ${p.blurb}` : ""}`)
      .join("\n");

    const stateMap = {};
    for (const r of stateRows || []) {
      try {
        stateMap[r.key] = JSON.parse(r.json);
      } catch {
        stateMap[r.key] = r.json;
      }
    }

    let partySummary = "";
    if (isCoach) {
      const roster = (partySheets && partySheets.party ? partySheets.party : []).map(
        (m) => `${m.name || m.slug}: ${m.role || "Member"} (${m.class || "Adventurer"} lvl ${m.level || 1})`
      ).join(", ");
      const tonight = stateMap.tonight ? (stateMap.tonight.title || stateMap.tonight.status || "") : "";
      const signups = stateMap.signups && stateMap.signups.roster
        ? Object.entries(stateMap.signups.roster).map(([k, v]) => `${k}:${v}`).join(", ")
        : "";
      partySummary = `Party Roster: ${roster || "Santa, Bible Boi, Street Rat, Bloise, Handsome Squidward"}${tonight ? ` | Tonight: ${tonight}` : ""}${signups ? ` | Signups: ${signups}` : ""}`;
    } else {
      partySummary = "Party: Santa, Bible Boi, Street Rat, Bloise, Handsome Squidward.";
    }

    const baseSystemPrompt = [
      "You are Leeroy Jenkins, the party librarian for the 'Dungeons and Drinking' WoW Classic Forever five-player Horde group (Santa, Bible Boi, Street Rat, Bloise, Handsome Squidward).",
      `[Library-Epoch: ${libraryStamp}]`,
      "Answer strictly using the verified library facts and party state below. Where the library does not know something yet, state plainly that it is not published yet.",
      "Display names only in full every time (Santa, Bible Boi, Street Rat, Bloise, Handsome Squidward; never real first names). Inform, never instruct: facts, options, and trade-offs.",
      "Keep answers concise (2 to 4 sentences), warm and plain-spoken. End with one line `-# Sources: id1, id2` listing only the library page ids you actually used (plain ids separated by commas, no brackets); the system turns them into links. Never write bare web addresses.",
    ].join(" ");
    const persona = await loadPersona(env);
    const systemPrompt = persona
      ? buildSystemPrompt(persona, { journey, question, partySummary, libraryStamp, isCoach, coachPrompt: COACH_PROMPT })
      : isCoach ? `${baseSystemPrompt}\n\n${COACH_PROMPT}` : baseSystemPrompt;

    const askerIsMember = isMember === undefined ? String(by).trim().toLowerCase() !== "visitor" : Boolean(isMember);
    const userPrompt = `Party Context:\n${partySummary}\n\nTop Library Facts:\n${topFactHits.join(
      "\n"
    )}\n\nTop Matching Pages:\n${topPagesSummary}\n\nAsker: ${by} (${askerIsMember ? "party member" : "visitor"})\nAddress the asker by display name only when they are a party member, and never address other party members as if they were the asker.\n\nQuestion from ${by} (journey: ${journey}): ${question}`;

    // 2. Route to selected AI provider (with local D1 RAG synthesis fallback for offline `wrangler dev --local`)
    const reqClean = String(requestedProvider || "").toLowerCase().trim();
    const chosenProvider = isPrPreviewEnv(env)
      ? "workers-ai"
      : (Object.prototype.hasOwnProperty.call(AI_PROVIDER_LABELS, reqClean) && isProviderConfigured(env, reqClean))
        ? reqClean
        : resolveAiProvider(env, requestedProvider);
    const activeProvider = resolveAiProvider(env, chosenProvider);
    const qHash = (await sha256Hex(question)).slice(0, 16);
    const cacheKey = `ask:${libraryStamp}:${chosenProvider}:${deep ? "deep" : "fast"}:${qHash}`;
    // Daily Workers AI budget: past the soft cap, answer in voice without calling AI. Other providers are not capped.
    if (chosenProvider === "workers-ai") {
      const verdict = await checkAskBudget(env, budget, budget ? await loadAskCaps(env) : null);
      if (verdict) {
        budgetCode = verdict.code;
        const limitedAt = nowIso();
        const retryAfter = verdict.retryAfter;
        const limitText = pickLine(persona, "errorLines", intentId);
        await env.DB.prepare(
          "UPDATE ask_turns SET answer = ?, model = ?, status = 'answered', latency_ms = ?, answered_at = ? WHERE id = ?"
        )
          .bind(limitText, budgetCode === "budget_global" ? "workers-ai:daily-limit" : `workers-ai:${budgetCode}`, Date.now() - t0, limitedAt, intentId)
          .run();
        await broadcastToRoom(env, {
          type: "ask",
          slug: memberSlug || by.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          ask: {
            id: Number(String(intentId).replace(/\D/g, "").slice(0, 13)) || Date.now(),
            kind: "ask",
            by,
            q: question,
            text: question,
            answer: limitText,
            cites: [],
            sources: [],
            model: "daily-limit",
            provider: "workers-ai",
            share: false,
            ms: Date.now() - t0,
            status: "answered",
            why: "limited",
            code: budgetCode,
            retryAfter,
            at: limitedAt,
          },
        });
        return { code: budgetCode };
      }
    }

    let rawAnswer, model, provider;
    let fallbackNote = "";
    try {
      ({ answer: rawAnswer, model, provider } = await dispatchToProvider({
        provider: chosenProvider,
        env,
        systemPrompt,
        userPrompt,
        deep,
        cacheKey,
        budgetKeys: budget,
        timeoutMs: ASK_CHOSEN_TIMEOUT_MS,
      }));
    } catch (providerErr) {
      fallbackNote = ` (after ${chosenProvider}: ${shortProviderError(providerErr)})`;
      if (activeProvider !== chosenProvider && isProviderConfigured(env, activeProvider)) {
        try {
          ({ answer: rawAnswer, model, provider } = await dispatchToProvider({
            provider: activeProvider,
            env,
            systemPrompt,
            userPrompt,
            deep,
            timeoutMs: ASK_FALLBACK_TIMEOUT_MS,
          }));
        } catch {}
      }
      // Skip the last-resort Workers AI hop when the chain has already used most of the Discord deadline.
      if (!rawAnswer && chosenProvider !== "workers-ai" && isProviderConfigured(env, "workers-ai") && Date.now() - t0 < ASK_DEADLINE_MS - ASK_FALLBACK_TIMEOUT_MS) {
        try {
          ({ answer: rawAnswer, model, provider } = await dispatchToProvider({
            provider: "workers-ai",
            env,
            systemPrompt,
            userPrompt,
            deep,
            skipCache: false,
            cacheKey,
            budgetKind: "ask",
            budgetKeys: budget,
            timeoutMs: ASK_FALLBACK_TIMEOUT_MS,
          }));
        } catch (waiErr) {
          console.warn("[AI-Failover] Workers AI fallback failed:", waiErr.message);
        }
      }
      if (!rawAnswer) {
        if (hits && hits.length > 0) {
          rawAnswer = hits
            .slice(0, 3)
            .map((h) => `${h.value} [${h.page}~${h.key}]`)
            .join(" ");
          rawAnswer += `\n-# Sources: ${[...new Set(hits.slice(0, 3).map((h) => h.page))].join(", ")}`;
          provider = chosenProvider;
          model = `${chosenProvider}-local-d1-rag`;
        } else if (ranked.length > 0) {
          const snippets = [];
          for (const p of ranked.slice(0, 3)) {
            const facts = p.facts || [];
            const topFact = facts[0]
              ? `${facts[0].value} [${p.id}~${facts[0].key}]`
              : `${p.blurb || p.title} [${p.id}]`;
            snippets.push(topFact);
          }
          rawAnswer = snippets.join(" ");
          rawAnswer += `\n-# Sources: ${ranked.slice(0, 3).map((p) => p.id).join(", ")}`;
          provider = chosenProvider;
          model = `${chosenProvider}-local-d1-rag`;
        } else {
          throw providerErr;
        }
      }
    }

    // Apply `wow-mage` house-voice & privacy guardrails (`precheck.mjs` parity)
    const nameMap = (await loadConfigKey(env, "name_map")) || {};
    const repaired = repairHouseVoice(rawAnswer, { isCoach, nameMap });

    // Layout, link masking and visitor-safe addressing for every provider and surface (kill switch ANSWER_FORMAT=off).
    // Cites are read from the unformatted text, because formatting replaces the ids with titled links.
    const libPages = parsedPages.map((p) => ({ id: p.id, category: p.category, title: p.title }));
    const known = new Set(libPages.map((p) => p.id));
    const cites = extractCitedIds(repaired).filter((id) => known.has(id));
    const chatMax = Number(persona && persona.format && persona.format.chatMaxChars);
    const answer = answerFormatEnabled(env)
      ? formatAnswer(repaired, {
          pages: libPages,
          asker: { name: by, isMember: askerIsMember },
          boardUrl: env.BOARD_PUBLIC_URL || "https://leeroy.party",
          maxChars: chatMax > 0 ? chatMax : 1200,
          ...(answerUxEnabled(env)
            ? { ux: true, roster: rosterAliases(), intentId, isCoach, egg: persona && persona.egg }
            : {}),
        })
      : repaired;
    const latencyMs = Date.now() - t0;
    const answeredAt = nowIso();

    // 3. Save completed Q&A turn in D1 `ask_turns` and update `kv_state['stats']`
    await env.DB.prepare(
      "UPDATE ask_turns SET answer = ?, cites_json = ?, model = ?, status = 'answered', latency_ms = ?, answered_at = ? WHERE id = ?"
    )
      .bind(answer, JSON.stringify(cites), `${provider}:${model}${fallbackNote}`.slice(0, 120), latencyMs, answeredAt, intentId)
      .run();

    const statsRow = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'stats'").first();
    if (statsRow) {
      try {
        const stats = JSON.parse(statsRow.json);
        stats.answers = (Number(stats.answers) || 0) + 1;
        stats.updated = answeredAt.slice(0, 10);
        stats.recent = [
          {
            id: intentId,
            by,
            q: question,
            a: answer,
            cites,
            model,
            provider,
            at: answeredAt,
            ms: latencyMs,
          },
          ...(Array.isArray(stats.recent) ? stats.recent : []),
        ].slice(0, 15);
        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'stats'")
          .bind(JSON.stringify(stats), answeredAt)
          .run();
        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/stats.json"]);
      } catch (e) {
        console.error("Failed updating stats row:", e);
      }
    }

    // 4. Broadcast live completion over WebSockets to all connected browsers
    const numericId = Number(String(intentId).replace(/\D/g, "").slice(0, 13)) || Date.now();
    const completedItem = {
      id: numericId,
      kind: "ask",
      by,
      q: question,
      text: question,
      answer,
      cites,
      sources: cites,
      model,
      provider,
      share: Boolean(share),
      ms: latencyMs,
      status: "answered",
      at: answeredAt,
    };
    await broadcastToRoom(env, {
      type: "data",
      key: "stats",
      intent: completedItem,
    });
    const broadcastSlug = memberSlug || by.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await broadcastToRoom(env, {
      type: "ask",
      slug: broadcastSlug,
      ask: completedItem,
    });

    // 5. Optional Discord Webhook post to #wow-forever
    if (share && env.DISCORD_WEBHOOK_URL) {
      const label = AI_PROVIDER_LABELS[provider] || provider;
      await fetch(env.DISCORD_WEBHOOK_URL, {
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: `Leeroy (${label})`,
          content: clampContent(`**${by} asked:** ${question}\n${answer}`),
          allowed_mentions: ALLOWED_MENTIONS_NONE,
        }),
      }).catch(() => {});
    }
  } catch (err) {
    const failedAt = nowIso();
    const msg = String((err && err.message) || err);
    await env.DB.prepare("UPDATE ask_turns SET status = 'error', answer = ?, answered_at = ? WHERE id = ?")
      .bind(msg, failedAt, intentId)
      .run()
      .catch(() => {});
    await broadcastToRoom(env, {
      type: "intent",
      item: { id: intentId, kind: "ask", by, q: question, status: "error", error: msg, at: failedAt },
    });
  }
}

// =============================================================================
// Automated D1 Wiki Fact Learning (`wiki-learn.mjs` serverless replacement)
// Extracts updated facts from newly fetched source text snapshots and saves
// proposals + confirmed updates directly in D1 (`wiki_proposals` & `lib_pages`).
// =============================================================================
export async function extractWikiFactsWithAi({ env, source, cleanText }) {
  try {
    const { results: allPages } = await env.DB.prepare(
      "SELECT id, category, title, facts_json, history_json FROM lib_pages"
    ).all();
    const matchingPages = (allPages || []).filter((p) =>
      String(p.facts_json || "").includes(`"${source.id}"`)
    );
    if (!matchingPages.length) return [];

    const pagesContext = matchingPages.slice(0, 4).map((p) => ({
      page_id: p.id,
      title: p.title,
      facts: JSON.parse(p.facts_json || "[]")
        .slice(0, 15)
        .map((f) => ({ key: f.key, value: f.value })),
    }));

    const systemPrompt =
      "You are the WoW: Forever wiki fact extractor (`wiki-learn`). Compare the newly fetched source text against existing page facts. Output ONLY a valid JSON array of updated facts: [{\"page_id\":\"...\",\"fact_key\":\"...\",\"proposed_value\":\"...\",\"confidence\":\"confirmed\"}]. If nothing changed, output [].";
    const userPrompt = `Source (${source.id} - ${source.label}, ${source.url}):\n${cleanText.slice(
      0,
      5000
    )}\n\nExisting Facts:\n${JSON.stringify(pagesContext)}`;

    const provider = resolveAiProvider(env);
    // Keep room for asks: the cron sweep skips Workers AI once usage is within the reserve of the cap.
    if (provider === "workers-ai") {
      const budget = await loadBudget(env);
      if (overCap(budget.neurons, dailyCap(env), CRON_RESERVE)) return [];
    }
    const { answer } = await dispatchToProvider({
      provider,
      env,
      systemPrompt,
      userPrompt,
      deep: false,
      skipCache: true, // Cron fact learner MUST run live inference on new content
      budgetKind: "cron",
    });

    const jsonMatch = answer.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const proposals = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(proposals) || !proposals.length) return [];

    const now = new Date().toISOString();
    const applied = [];

    for (const prop of proposals.slice(0, 5)) {
      if (!prop || !prop.page_id || !prop.fact_key || !prop.proposed_value) continue;
      const page = matchingPages.find((p) => p.id === prop.page_id);
      if (!page) continue;

      const facts = JSON.parse(page.facts_json || "[]");
      const history = JSON.parse(page.history_json || "[]");
      const existing = facts.find((f) => f.key === prop.fact_key);
      const oldVal = existing ? existing.value : null;
      if (oldVal === prop.proposed_value) continue;

      if (existing) {
        existing.value = String(prop.proposed_value);
      } else {
        facts.push({
          key: prop.fact_key,
          value: String(prop.proposed_value),
          refs: [{ id: source.id, url: source.url, host: source.host, label: source.label, tier: source.tier }],
        });
      }
      history.unshift({
        date: now.slice(0, 10),
        text: `${prop.fact_key} auto-updated from ${source.id} (${provider})`,
      });

      const propId = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO wiki_proposals (id, source_id, page_id, fact_key, old_value, proposed_value, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?)"
        ).bind(
          propId,
          source.id,
          page.id,
          prop.fact_key,
          oldVal,
          String(prop.proposed_value),
          prop.confidence || "confirmed",
          now
        ),
        env.DB.prepare(
          "UPDATE lib_pages SET facts_json = ?, history_json = ?, checked = ?, updated_at = ? WHERE id = ?"
        ).bind(JSON.stringify(facts), JSON.stringify(history), now.slice(0, 10), now, page.id),
      ]);

      applied.push({ page_id: page.id, category: page.category, fact_key: prop.fact_key });
    }

    if (applied.length > 0) invalidatePagesCache();
    return applied;
  } catch {
    return [];
  }
}

export { answerWithAi as answerWithClaude };
