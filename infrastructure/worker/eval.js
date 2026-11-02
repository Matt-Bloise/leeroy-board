// Model bake-off runner (`worker/eval.js`) behind POST /api/admin/eval. Read-only: it stores nothing in D1 (apart from the shared
// daily neuron counter that every Workers AI call updates) and posts nothing to Discord. One request runs a small slice of a job
// (at most 6 model calls, under 25 seconds); the caller loops with `nextCursor`.
//
// Cells are numbered in question-major order: cell i = question floor(i / candidates), candidate i % candidates. Neighbouring cells
// therefore hit different providers, which spreads free-tier rate limits.
//
// All collaborators arrive through `deps` so the unit tests run with fake providers: no network, no D1, no AI.

import { buildAnswerInputs, finishAnswerText, dispatchToProvider, isProviderConfigured, isPrPreviewEnv, modelAllowed, EVAL_MODEL_ALLOWLIST, PROMPT_VARIANTS, shortProviderError } from "./ai-models.js";
import { lintAnswer } from "./answer-lint.js";
import { checkAskBudget, loadBudget, dailyCap } from "./budget.js";

// One place for every limit and pacing constant.
export const EVAL_LIMITS = {
  maxQuestions: 40,
  maxCandidates: 6,
  maxCallsPerJob: 120, // questions x candidates
  maxCallsPerRequest: 6,
  requestBudgetMs: 25000, // no request runs longer than this
  safetyMs: 1500, // headroom kept for building the response
  callTimeoutMs: 8000, // per provider call
  gapMs: 1000, // minimum gap between any two model calls
  cooldownMs: 60000, // after a rate-limit answer a provider is left alone for this long
  minRemainingPct: 40, // Workers AI: refuse while less than this share of the daily allowance remains
};
// Minimum gap between two calls to the same provider, from the published free-tier request rates (rounded up).
// Gemini free tier is about 15 requests per minute. Others are conservative guesses; raise them if a provider answers 429.
export const PROVIDER_MIN_GAP_MS = {
  gemini: 4200,
  groq: 2200,
  cerebras: 2200,
  github: 4000,
  openrouter: 3500,
  "workers-ai": 1000,
};

const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const LABEL_RE = /^[A-Za-z0-9 _.:+-]{1,40}$/;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota/i;

export function evalEnabled(env) {
  const v = String((env && env.EVAL_ENABLED) || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "on";
}

// Returns { error } or the cleaned request.
export function validateEvalRequest(body) {
  const L = EVAL_LIMITS;
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be a JSON object" };
  const { questions, candidates } = body;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > L.maxQuestions) return { error: `questions must be an array of 1 to ${L.maxQuestions}` };
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > L.maxCandidates) return { error: `candidates must be an array of 1 to ${L.maxCandidates}` };
  if (questions.length * candidates.length > L.maxCallsPerJob) return { error: `a job is at most ${L.maxCallsPerJob} model calls (questions x candidates); split it` };

  const qs = [];
  const seenQ = new Set();
  for (const q of questions) {
    if (!q || typeof q !== "object" || typeof q.id !== "string" || !ID_RE.test(q.id)) return { error: "each question needs an id of 1 to 40 letters, digits, . _ -" };
    if (seenQ.has(q.id)) return { error: `duplicate question id ${q.id}` };
    seenQ.add(q.id);
    if (typeof q.text !== "string" || !q.text.trim() || q.text.length > 1000) return { error: `question ${q.id}: text must be 1 to 1000 characters` };
    if (q.journey !== undefined && !(typeof q.journey === "string" && /^[a-z]{1,20}$/.test(q.journey))) return { error: `question ${q.id}: bad journey` };
    if (q.asker !== undefined && q.asker !== "member" && q.asker !== "visitor") return { error: `question ${q.id}: asker must be member or visitor` };
    qs.push({ id: q.id, text: q.text.trim(), journey: q.journey || "curious", asker: q.asker || "member" });
  }

  const cs = [];
  const seenC = new Set();
  for (const c of candidates) {
    if (!c || typeof c !== "object" || typeof c.label !== "string" || !LABEL_RE.test(c.label)) return { error: "each candidate needs a label of 1 to 40 letters, digits, space . _ : + -" };
    if (seenC.has(c.label)) return { error: `duplicate candidate label ${c.label}` };
    seenC.add(c.label);
    if (typeof c.provider !== "string" || !Object.prototype.hasOwnProperty.call(EVAL_MODEL_ALLOWLIST, c.provider)) {
      return { error: `candidate ${c.label}: provider must be one of ${Object.keys(EVAL_MODEL_ALLOWLIST).join(", ")}` };
    }
    if (c.model !== undefined && !(typeof c.model === "string" && modelAllowed(c.provider, c.model))) {
      return { error: `candidate ${c.label}: model is not on the allow-list for ${c.provider}` };
    }
    if (c.promptVariant !== undefined && !PROMPT_VARIANTS.includes(c.promptVariant)) {
      return { error: `candidate ${c.label}: promptVariant must be one of ${PROMPT_VARIANTS.join(", ")}` };
    }
    cs.push({ label: c.label, provider: c.provider, model: c.model || null, promptVariant: c.promptVariant || "production" });
  }

  let cursor = 0;
  if (body.cursor !== undefined) {
    cursor = body.cursor;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > qs.length * cs.length) return { error: "cursor must be an integer from 0 to questions x candidates" };
  }
  let maxCalls = L.maxCallsPerRequest;
  if (body.maxCalls !== undefined) {
    if (!Number.isInteger(body.maxCalls) || body.maxCalls < 1 || body.maxCalls > L.maxCallsPerRequest) return { error: `maxCalls must be 1 to ${L.maxCallsPerRequest}` };
    maxCalls = body.maxCalls;
  }
  let jobId = null;
  if (body.jobId !== undefined) {
    if (typeof body.jobId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(body.jobId)) return { error: "jobId must be 1 to 64 letters, digits, . _ : -" };
    jobId = body.jobId;
  }
  return { questions: qs, candidates: cs, cursor, maxCalls, jobId };
}

// null when a Workers AI call may go ahead, else a short reason. Shares the production daily counter (kv_state ai_budget:<day>).
export async function defaultBudgetVerdict(env) {
  const v = await checkAskBudget(env, null, null);
  if (v) return v.code;
  const used = (await loadBudget(env)).neurons;
  const cap = dailyCap(env);
  if (cap - used < (cap * EVAL_LIMITS.minRemainingPct) / 100) return "eval_reserve";
  return null;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultDeps() {
  return {
    buildInputs: buildAnswerInputs,
    finish: finishAnswerText,
    dispatch: dispatchToProvider,
    configured: isProviderConfigured,
    budgetVerdict: defaultBudgetVerdict,
    now: () => Date.now(),
    sleep: realSleep,
    // Last call time per provider, per isolate. Best effort: a different isolate does not know it, the provider answers 429 then.
    lastCallAt: lastCallAtShared,
    cooldownUntil: cooldownShared,
  };
}
const lastCallAtShared = new Map();
const cooldownShared = new Map();

export async function runEval(env, req, depsIn = {}) {
  const L = EVAL_LIMITS;
  const deps = { ...defaultDeps(), ...depsIn };
  const { questions, candidates, cursor, maxCalls, jobId } = req;
  const total = questions.length * candidates.length;
  const t0 = deps.now();
  const results = [];
  const inputsCache = new Map();
  let calls = 0;
  let lastAnyCall = -Infinity;
  let stoppedForBudget = false;
  let stoppedForTime = false;
  let i = cursor;

  const ctxFor = (q) => ({ asker: { isMember: q.asker !== "visitor" } });

  while (i < total && calls < maxCalls) {
    const q = questions[Math.floor(i / candidates.length)];
    const c = candidates[i % candidates.length];
    const base = { index: i, questionId: q.id, question: q.text, candidate: c.label, provider: c.provider, model: c.model || null, promptVariant: c.promptVariant };
    const fail = (error, extra = {}) => results.push({ ...base, ok: false, ms: 0, chars: 0, answer: "", rawChars: 0, lint: null, error, ...extra });

    if (isPrPreviewEnv(env) && c.provider !== "workers-ai") { fail("provider_unavailable_in_preview"); i++; continue; }
    if (!deps.configured(env, c.provider)) { fail("provider_not_configured"); i++; continue; }

    const now0 = deps.now();
    if ((deps.cooldownUntil.get(c.provider) || 0) > now0) { fail("rate_limited_cooldown", { rateLimited: true }); i++; continue; }

    const minGap = PROVIDER_MIN_GAP_MS[c.provider] || L.gapMs;
    const wait = Math.max(0, lastAnyCall + L.gapMs - now0, (deps.lastCallAt.get(c.provider) || -Infinity) + minGap - now0);
    if (now0 - t0 + wait + L.callTimeoutMs + L.safetyMs > L.requestBudgetMs) { stoppedForTime = true; break; }

    if (c.provider === "workers-ai") {
      const verdict = await deps.budgetVerdict(env);
      if (verdict) { stoppedForBudget = true; break; }
    }
    if (wait > 0) await deps.sleep(wait);

    const key = `${q.id}|${c.promptVariant}`;
    let inputs = inputsCache.get(key);
    if (!inputs) {
      try {
        inputs = await deps.buildInputs(env, {
          question: q.text,
          by: q.asker === "visitor" ? "Visitor" : "Santa",
          journey: q.journey,
          share: true,
          isMember: q.asker !== "visitor",
          promptVariant: c.promptVariant,
        });
      } catch (err) {
        fail(`inputs_failed: ${shortProviderError(err)}`);
        i++;
        continue;
      }
      inputsCache.set(key, inputs);
    }

    const callStart = deps.now();
    lastAnyCall = callStart;
    deps.lastCallAt.set(c.provider, callStart);
    calls++;
    try {
      const out = await deps.dispatch({
        provider: c.provider,
        model: c.model || undefined,
        env,
        systemPrompt: inputs.systemPrompt,
        userPrompt: inputs.userPrompt,
        deep: false,
        skipCache: true,
        budgetKind: "eval",
        timeoutMs: L.callTimeoutMs,
      });
      const raw = String((out && out.answer) || "");
      const { answer } = await deps.finish(env, {
        rawAnswer: raw,
        isCoach: inputs.isCoach,
        parsedPages: inputs.parsedPages,
        by: q.asker === "visitor" ? "Visitor" : "Santa",
        askerIsMember: inputs.askerIsMember,
        persona: inputs.persona,
      });
      const chatMax = Number(inputs.persona && inputs.persona.format && inputs.persona.format.chatMaxChars);
      const chatMin = Number(inputs.persona && inputs.persona.format && inputs.persona.format.chatMinChars);
      const lint = lintAnswer(answer, { ...ctxFor(q), maxChars: chatMax > 0 ? chatMax : undefined, minChars: chatMin > 0 ? chatMin : undefined });
      results.push({ ...base, model: (out && out.model) || base.model, ok: true, ms: deps.now() - callStart, chars: answer.length, answer, rawChars: raw.length, lint });
    } catch (err) {
      const msg = shortProviderError(err);
      const limited = RATE_LIMIT_RE.test(String((err && err.message) || ""));
      if (limited) deps.cooldownUntil.set(c.provider, deps.now() + L.cooldownMs);
      results.push({ ...base, ok: false, ms: deps.now() - callStart, chars: 0, answer: "", rawChars: 0, lint: null, error: msg, ...(limited ? { rateLimited: true } : {}) });
    }
    i++;
  }

  return {
    jobId,
    total,
    cursor,
    nextCursor: i < total ? i : null,
    callsMade: calls,
    stoppedForBudget,
    stoppedForTime,
    elapsedMs: deps.now() - t0,
    results,
  };
}
