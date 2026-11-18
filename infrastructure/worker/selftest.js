// Production self-test for the Claude path: POST /api/selftest/claude. docs/runbooks/claude-selftest.md; tools/claude-selftest.mjs signs and sends it.
// Same gate and signature as the listener (listener-config.js): the key is derived from the bot token, headers X-Listen-Timestamp / X-Listen-Signature, 120 s window, body any JSON up to 1 KB.
// No usable bot token (or a PR preview) means the route does not exist (404); a missing or wrong signature is 401. There is no flag: the signature is the gate, and what a valid call can do is bounded
// by itself (two sends of about 8 output tokens, one call per 60 s, its own sub-cap of SELFTEST_SUBCAP_FRACTION of the monthly cap under the same monthly counter as the asks).
// Two sends in sequence through claudeCappedCall (the same spend guard, host allow-list and secret scan as the asks): the compose model (deep primary), then the fast model. A failed compose still runs the fast step.
// The response carries only fixed-vocabulary fields: never model text, a key, an error body or a model id. D1 writes: the rate-limit row (kv_state selftest_claude_last) and the Claude counter rows. No ask_turns row.
import { callAnthropicClaude, isPrPreviewEnv } from "./ai-models.js";
import { claudeCappedCall, monthTag, CLAUDE_COMPOSE_MS, CLAUDE_RETRY_MAX_MS } from "./research/claude.js";
import { listenerKeyFor, verifyListen } from "./listener-config.js";
import { updateKvJson } from "./kv-cas.js";
import { readBounded } from "./listener.js";

export const SELFTEST_MAX_BODY = 1024;
export const SELFTEST_MIN_INTERVAL_S = 60;
export const SELFTEST_SUBCAP_FRACTION = 0.002; // 10,000 tokens a month at the default 5,000,000 cap: hundreds of calls, and never a dent in the ask budget
export const SELFTEST_MAX_TOKENS = 8;
export const SELFTEST_PROMPT = "Reply with the single word ok.";
export const SELFTEST_SYSTEM = "You are a connectivity check.";
export const SELFTEST_RATE_KEY = "selftest_claude_last";
export const selftestSubCounterKey = (now) => `claude_tokens_selftest_${monthTag(now)}`;

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

const modelClass = (id) => (/sonnet/i.test(id) ? "sonnet" : /haiku/i.test(id) ? "haiku" : "other");
const SAFE_REASON = /^(?:ok|[a-z]{2,8}:[A-Za-z0-9@._-]{1,48})$/;
const safeReason = (r) => (typeof r === "string" && SAFE_REASON.test(r) ? r : "claude:error");

async function step(env, stage, deep, call, nowFn) {
  const t0 = Date.now();
  let res;
  try {
    res = await claudeCappedCall({
      env, call, systemPrompt: SELFTEST_SYSTEM, userPrompt: SELFTEST_PROMPT, maxTokens: SELFTEST_MAX_TOKENS, now: nowFn,
      timeoutMs: deep ? CLAUDE_COMPOSE_MS : CLAUDE_RETRY_MAX_MS, subCounter: selftestSubCounterKey, subFraction: SELFTEST_SUBCAP_FRACTION,
      deep, modelFallback: false, stage: deep ? "compose" : null,
    });
  } catch {
    res = { reason: "claude:error" };
  }
  const ok = Boolean(res && !res.reason && typeof res.answer === "string" && res.answer.trim());
  const reason = ok ? "ok" : safeReason(res && res.reason ? res.reason : "claude:empty");
  return { stage, ok, ms: Math.max(0, Date.now() - t0), modelClass: modelClass(String((res && res.model) || "")), reason };
}

// deps.call: callAnthropicClaude by default (tests inject a fake). deps.now: a clock returning a Date.
export async function handleSelftestClaude(req, env, deps = {}) {
  if (isPrPreviewEnv(env) || !(await listenerKeyFor(env))) return json({ error: "not found" }, 404);
  const raw = await readBounded(req, SELFTEST_MAX_BODY);
  if (raw === null) return json({ error: "too large" }, 413);
  const ok = await verifyListen(await listenerKeyFor(env), req.headers.get("X-Listen-Timestamp"), raw, req.headers.get("X-Listen-Signature"), Math.floor(Date.now() / 1000));
  if (!ok) return json({ error: "unauthorized" }, 401);
  try { JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  const nowFn = deps.now || (() => new Date());
  const nowMs = nowFn().getTime();
  let wait = 0;
  try {
    await updateKvJson(env, SELFTEST_RATE_KEY, (cur) => {
      const last = cur && Number.isFinite(cur.at) ? cur.at : 0;
      const left = Math.ceil((last + SELFTEST_MIN_INTERVAL_S * 1000 - nowMs) / 1000);
      if (left > 0) { wait = left; return { skip: true }; }
      return { doc: { at: nowMs } };
    }, { now: () => new Date(nowMs).toISOString() });
  } catch {
    return json({ error: "unavailable" }, 503); // the limiter could not be written: no send (fail closed)
  }
  if (wait > 0) return json({ error: "rate limited", retryAfter: wait }, 429, { "Retry-After": String(wait) });

  const call = deps.call || callAnthropicClaude;
  const steps = [await step(env, "compose", true, call, nowFn), await step(env, "fast", false, call, nowFn)];
  console.log(JSON.stringify({ evt: "selftest_claude", compose: steps[0].reason, fast: steps[1].reason }));
  return json({ ok: steps.every((s) => s.ok), steps });
}
