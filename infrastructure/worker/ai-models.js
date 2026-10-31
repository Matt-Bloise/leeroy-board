// =============================================================================
// Multi-Provider AI Integration for Leeroy (`worker/ai-models.js`)
// Supports switching seamlessly between:
//   1. Anthropic Claude (`claude` — Haiku 4.5 / Sonnet 4.5 via `ANTHROPIC_API_KEY`)
//   2. Google Gemini Free Tier (`gemini` — Gemini 2.5 Flash / Pro via `GEMINI_API_KEY`)
//   3. Cloudflare Workers AI Free Tier (`workers-ai` — Llama 3.3 70B via `[ai]` binding, 0 keys needed)
//   4. GroqCloud Free Tier (`groq` — Llama 3.3 70B Versatile via `GROQ_API_KEY`)
//   5. Cerebras Free Tier (`cerebras` — Llama 3.3 70B via `CEREBRAS_API_KEY`)
//   6. GitHub Models Free Tier (`github` — OpenAI GPT-4o-mini / GPT-4o via `GITHUB_MODELS_TOKEN`)
//   7. OpenRouter Free Tier (`openrouter` — DeepSeek V3 `:free` via `OPENROUTER_API_KEY`)
// =============================================================================

import { broadcastToRoom, purgeWorkerCache } from "./index.js";

export const AI_PROVIDER_LABELS = {
  claude: "Claude",
  gemini: "Gemini Free Tier",
  "workers-ai": "Cloudflare Workers AI (Llama 3.3 70B)",
  groq: "Groq Free Tier (Llama 3.3 70B)",
  cerebras: "Cerebras Free Tier (Llama 3.3 70B)",
  github: "GitHub Models (GPT-4o)",
  openrouter: "OpenRouter Free (DeepSeek V3)",
};

export function isProviderConfigured(env, provider) {
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
  const hay = `${page.title} ${page.id} ${page.blurb || ""} ${page.facts_json || ""}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (hay.includes(w)) score += page.title.toLowerCase().includes(w) ? 4 : 1;
  }
  return score;
}

async function callAnthropicClaude({ env, systemPrompt, userPrompt, deep }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY secret is not configured on the Cloudflare Worker");
  }
  const model = deep
    ? env.CLAUDE_MODEL_DEEP || "claude-sonnet-4-5-20250929"
    : env.CLAUDE_MODEL_FAST || "claude-haiku-4-5-20251001";

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 450,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Claude API HTTP ${resp.status}: ${errTxt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const answer = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return { answer, model, provider: "claude" };
}

async function callGeminiFreeTier({ env, systemPrompt, userPrompt, deep }) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY secret is not configured on the Cloudflare Worker");
  }
  const model = deep
    ? env.GEMINI_MODEL_DEEP || "gemini-2.5-pro"
    : env.GEMINI_MODEL_FAST || "gemini-2.5-flash";

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 450, temperature: 0.3 },
    }),
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

  if (!answer) throw new Error("Gemini returned an empty response");
  return { answer, model, provider: "gemini" };
}

async function callCloudflareWorkersAi({ env, systemPrompt, userPrompt }) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("Cloudflare Workers AI binding (env.AI) is not configured in wrangler.toml");
  }
  const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const res = await env.AI.run(model, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 450,
    temperature: 0.3,
  });

  const answer = String((res && (res.response || (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content))) || "").trim();
  if (!answer) throw new Error("Cloudflare Workers AI returned an empty response");
  return { answer, model, provider: "workers-ai" };
}

async function callOpenAiCompatible({ provider, endpoint, apiKey, model, systemPrompt, userPrompt, extraHeaders = {} }) {
  if (!apiKey) {
    throw new Error(`API key secret for provider '${provider}' is not configured on the Cloudflare Worker`);
  }
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 450,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
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

async function dispatchToProvider({ provider, env, systemPrompt, userPrompt, deep }) {
  switch (provider) {
    case "gemini":
      return await callGeminiFreeTier({ env, systemPrompt, userPrompt, deep });
    case "workers-ai":
      return await callCloudflareWorkersAi({ env, systemPrompt, userPrompt });
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
      });
    case "cerebras":
      return await callOpenAiCompatible({
        provider: "cerebras",
        endpoint: "https://api.cerebras.ai/v1/chat/completions",
        apiKey: env.CEREBRAS_API_KEY,
        model: env.CEREBRAS_MODEL || "llama-3.3-70b",
        systemPrompt,
        userPrompt,
      });
    case "github":
      return await callOpenAiCompatible({
        provider: "github",
        endpoint: "https://models.inference.ai.azure.com/chat/completions",
        apiKey: env.GITHUB_MODELS_TOKEN,
        model: deep ? env.GITHUB_MODEL_DEEP || "gpt-4o" : env.GITHUB_MODEL_FAST || "gpt-4o-mini",
        systemPrompt,
        userPrompt,
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
          "HTTP-Referer": "https://leeroy-board.pages.dev",
          "X-Title": "Dungeons and Drinking Living Board",
        },
      });
    case "claude":
    default:
      return await callAnthropicClaude({ env, systemPrompt, userPrompt, deep });
  }
}

export async function answerWithAi({
  env,
  origin,
  intentId,
  by,
  question,
  deep = false,
  share = true,
  provider: requestedProvider,
}) {
  const t0 = Date.now();
  const nowIso = () => new Date().toISOString();

  try {
    // 1. Pull relevant library pages & party state from D1 for grounded RAG context
    const [{ results: pages }, partyRow] = await Promise.all([
      env.DB.prepare("SELECT id, category, title, as_of, blurb, facts_json, open_json FROM lib_pages").all(),
      env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first(),
    ]);

    const words = question
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const ranked = (pages || [])
      .map((p) => ({ p, s: scorePageForQuestion(p, words) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.p);

    const contextBlocks = ranked.map((p) => {
      let facts = [];
      try {
        facts = JSON.parse(p.facts_json || "[]");
      } catch {}
      const lines = facts.slice(0, 25).map((f) => `  - [${p.id}~${f.key}]: ${f.value}`);
      return `Page: ${p.title} (${p.id}, as of ${p.as_of || "current"})\n${lines.join("\n")}`;
    });

    const partySummary = partyRow ? partyRow.json : "{}";
    const systemPrompt = [
      "You are Leeroy, the party librarian for the 'Dungeons and Drinking' WoW Classic Forever five-player group (Mend, Tank, Moira, Shazz, Faux).",
      "Answer strictly using the verified library facts and party state below. Where the library does not know something yet, state plainly that it is not published yet.",
      "Keep answers concise (2 to 4 sentences), warm, plain-spoken, and cite specific library page IDs in brackets like [classes/paladin-holy] or [dungeons/overview] whenever you use a fact.",
    ].join(" ");

    const userPrompt = `Party Context:\n${partySummary}\n\nLibrary Facts:\n${contextBlocks.join(
      "\n\n"
    )}\n\nQuestion from ${by}: ${question}`;

    // 2. Route to selected AI provider (with local D1 RAG synthesis fallback for offline `wrangler dev --local`)
    const reqClean = String(requestedProvider || "").toLowerCase().trim();
    const chosenProvider = Object.prototype.hasOwnProperty.call(AI_PROVIDER_LABELS, reqClean)
      ? reqClean
      : resolveAiProvider(env, requestedProvider);
    const activeProvider = resolveAiProvider(env, chosenProvider);
    let answer, model, provider;
    try {
      ({ answer, model, provider } = await dispatchToProvider({
        provider: chosenProvider,
        env,
        systemPrompt,
        userPrompt,
        deep,
      }));
    } catch (providerErr) {
      if (activeProvider !== chosenProvider && isProviderConfigured(env, activeProvider)) {
        try {
          ({ answer, model, provider } = await dispatchToProvider({
            provider: activeProvider,
            env,
            systemPrompt,
            userPrompt,
            deep,
          }));
        } catch {}
      }
      if (!answer) {
        const topPages = ranked.slice(0, 3);
        if (topPages.length > 0) {
          const snippets = [];
          for (const p of topPages) {
            let facts = [];
            try {
              facts = JSON.parse(p.facts_json || "[]");
            } catch {}
            const topFact = facts[0]
              ? `${facts[0].value} [${p.id}~${facts[0].key}]`
              : `${p.blurb || p.title} [${p.id}]`;
            snippets.push(topFact);
          }
          answer = snippets.join(" ");
          provider = chosenProvider;
          model = `${chosenProvider}-local-d1-rag`;
        } else {
          throw providerErr;
        }
      }
    }

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
    const completedItem = {
      id: intentId,
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
    await broadcastToRoom(env, {
      type: "ask",
      slug: by.toLowerCase(),
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

export { answerWithAi as answerWithClaude };
