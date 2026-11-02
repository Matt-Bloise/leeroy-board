// =============================================================================
// Multi-Provider AI Integration & House-Voice Guardrails (`worker/ai-models.js`)
// Supports switching seamlessly between:
//   1. Anthropic Claude (`claude` — Haiku 4.5 / Sonnet 4.5 via `ANTHROPIC_API_KEY`)
//   2. Google Gemini Free Tier (`gemini` — Gemini 2.5 Flash / Pro via `GEMINI_API_KEY`)
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
import { loadPersona, buildSystemPrompt } from "./persona.js";

export const AI_PROVIDER_LABELS = {
  claude: "Claude",
  gemini: "Gemini Free Tier",
  "workers-ai": "Cloudflare Workers AI (Llama 3.3 70B)",
  groq: "Groq Free Tier (Llama 3.3 70B)",
  cerebras: "Cerebras Free Tier (Llama 3.3 70B)",
  github: "GitHub Models (GPT-4o)",
  openrouter: "OpenRouter Free (DeepSeek V3)",
};

const FIRST_NAME_MAP = {
  Nick: "Santa",
  Tony: "Bible Boi",
  Ethan: "Street Rat",
  Derek: "Handsome Squidward",
  Matt: "Bloise",
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

  // 1. Replace real-life first names with party display names (wow-mage privacy rule)
  for (const [first, display] of Object.entries(FIRST_NAME_MAP)) {
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

function resolveGatewayUrl(env, providerSlug, defaultEndpoint) {
  const accountId = env && env.CLOUDFLARE_ACCOUNT_ID;
  const gatewayId = env && env.AI_GATEWAY_ID;
  if (!accountId || !gatewayId) return defaultEndpoint;
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${providerSlug}`;
}

async function fetchWithGatewayFallback({
  env,
  providerSlug,
  defaultEndpoint,
  headers = {},
  body,
  skipCache = false,
  cacheKey = null,
}) {
  const gwUrl = resolveGatewayUrl(env, providerSlug, defaultEndpoint);
  const cacheHeaders = env && env.AI_GATEWAY_ID ? {
    "cf-aig-cache-ttl": String(env.AI_GATEWAY_CACHE_TTL || 21600), // 6 hours matching the cron update cycle
    "cf-aig-metadata": JSON.stringify({ app: "leeroy-board", service: "chamber" }),
    ...(skipCache ? { "cf-aig-skip-cache": "true" } : {}),
    ...(cacheKey ? { "cf-aig-cache-key": String(cacheKey) } : {}),
  } : {};

  if (gwUrl !== defaultEndpoint) {
    try {
      const resp = await fetch(gwUrl, {
        method: "POST",
        headers: { ...headers, ...cacheHeaders },
        body,
      });
      // If gateway returns 404 (e.g. gateway not configured in CF dash), fall back to direct endpoint
      if (resp.status !== 404) return resp;
    } catch {
      // Gateway network error, fall back to direct endpoint
    }
  }

  return await fetch(defaultEndpoint, {
    method: "POST",
    headers,
    body,
  });
}

async function callAnthropicClaude({ env, systemPrompt, userPrompt, deep, skipCache = false, cacheKey = null }) {
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

async function callGeminiFreeTier({ env, systemPrompt, userPrompt, deep, skipCache = false, cacheKey = null }) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY secret is not configured on the Cloudflare Worker");
  }
  const model = deep
    ? env.GEMINI_MODEL_DEEP || "gemini-2.5-pro"
    : env.GEMINI_MODEL_FAST || "gemini-2.5-flash";

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
    )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    defaultEndpoint,
    headers: { "Content-Type": "application/json" },
    body,
    skipCache,
    cacheKey,
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Gemini API HTTP ${resp.status}: ${errTxt.slice(0, 200)}`);
  }

  const data = await resp.json();
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

  return { answer, model, provider: "gemini" };
}

async function callCloudflareWorkersAi({ env, systemPrompt, userPrompt, skipCache = false }) {
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
      result = await env.AI.run(model, inputs, {
        gateway: {
          id: env.AI_GATEWAY_ID,
          skipCache: Boolean(skipCache),
          cacheTtl: Number(env.AI_GATEWAY_CACHE_TTL) || 21600, // 6 hours: matches the cron update cycle
        },
      });
    } catch {
      // If gateway is not found or fails in Cloudflare, smoothly fallback to direct run
      result = null;
    }
  }

  if (!result) {
    result = await env.AI.run(model, inputs);
  }

  const answer = String(
    (result && (result.response || (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content))) || ""
  ).trim();

  if (!answer) throw new Error("Cloudflare Workers AI returned an empty response");
  return { answer, model, provider: "workers-ai" };
}

async function callOpenAiCompatible({ provider, endpoint, apiKey, model, systemPrompt, userPrompt, extraHeaders = {}, env, skipCache = false, cacheKey = null }) {
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

  const providerSlug = provider === "groq"
    ? "groq/openai/v1/chat/completions"
    : provider === "openrouter"
    ? "openrouter/api/v1/chat/completions"
    : null;

  let resp;
  if (providerSlug && env && env.AI_GATEWAY_ID) {
    resp = await fetchWithGatewayFallback({
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
    });
  } else {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body,
    });
  }

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

export async function dispatchToProvider({ provider, env, systemPrompt, userPrompt, deep, skipCache = false, cacheKey = null }) {
  if (isPrPreviewEnv(env) && provider !== "workers-ai") {
    provider = "workers-ai";
  }
  switch (provider) {
    case "gemini":
      return await callGeminiFreeTier({ env, systemPrompt, userPrompt, deep, skipCache, cacheKey });
    case "workers-ai":
      return await callCloudflareWorkersAi({ env, systemPrompt, userPrompt, skipCache });
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
      });
    case "claude":
    default:
      return await callAnthropicClaude({ env, systemPrompt, userPrompt, deep, skipCache, cacheKey });
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
}) {
  const t0 = Date.now();
  const nowIso = () => new Date().toISOString();
  const isCoach = journey === "guided" && share !== true;

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
      "Keep answers concise (2 to 4 sentences), warm, plain-spoken, and cite specific library page IDs in brackets like [classes/paladin-holy] or [dungeons/overview] whenever you use a fact.",
    ].join(" ");
    const persona = await loadPersona(env);
    const systemPrompt = persona
      ? buildSystemPrompt(persona, { journey, question, partySummary, libraryStamp, isCoach, coachPrompt: COACH_PROMPT })
      : isCoach ? `${baseSystemPrompt}\n\n${COACH_PROMPT}` : baseSystemPrompt;

    const userPrompt = `Party Context:\n${partySummary}\n\nTop Library Facts:\n${topFactHits.join(
      "\n"
    )}\n\nTop Matching Pages:\n${topPagesSummary}\n\nQuestion from ${by} (journey: ${journey}): ${question}`;

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
    let rawAnswer, model, provider;
    try {
      ({ answer: rawAnswer, model, provider } = await dispatchToProvider({
        provider: chosenProvider,
        env,
        systemPrompt,
        userPrompt,
        deep,
        cacheKey,
      }));
    } catch (providerErr) {
      if (activeProvider !== chosenProvider && isProviderConfigured(env, activeProvider)) {
        try {
          ({ answer: rawAnswer, model, provider } = await dispatchToProvider({
            provider: activeProvider,
            env,
            systemPrompt,
            userPrompt,
            deep,
          }));
        } catch {}
      }
      if (!rawAnswer) {
        if (hits && hits.length > 0) {
          rawAnswer = hits
            .slice(0, 3)
            .map((h) => `${h.value} [${h.page}~${h.key}]`)
            .join(" ");
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
          provider = chosenProvider;
          model = `${chosenProvider}-local-d1-rag`;
        } else {
          throw providerErr;
        }
      }
    }

    // Apply `wow-mage` house-voice & privacy guardrails (`precheck.mjs` parity)
    const answer = repairHouseVoice(rawAnswer, { isCoach });

    // Extract cited page IDs like [classes/paladin-holy]
    const cites = [
      ...new Set(
        [...answer.matchAll(/\[([a-z0-9_-]+\/[a-z0-9_-]+)(?:~[^\]]+)?\]/gi)].map((m) => m[1])
      ),
    ];
    const latencyMs = Date.now() - t0;
    const answeredAt = nowIso();

    // 3. Save completed Q&A turn in D1 `ask_turns` and update `kv_state['stats']`
    await env.DB.prepare(
      "UPDATE ask_turns SET answer = ?, cites_json = ?, model = ?, status = 'answered', latency_ms = ?, answered_at = ? WHERE id = ?"
    )
      .bind(answer, JSON.stringify(cites), `${provider}:${model}`, latencyMs, answeredAt, intentId)
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: `Leeroy (${label})`,
          content: `**${by} asked:** ${question}\n${answer}`,
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
    const { answer } = await dispatchToProvider({
      provider,
      env,
      systemPrompt,
      userPrompt,
      deep: false,
      skipCache: true, // Cron fact learner MUST run live inference on new content
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
