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
// The fixed vocabulary of `reason`: what claudeCappedCall can return (research/claude.js failReason and guardReason) plus ok and claude:empty. Anything else, including claude:error-<Name> and a guard:<kind>
// that is not one of the three below, is reported as claude:error, in the response and in the log line.
const REASONS = new Set(["ok", "claude:no-call", "claude:no-key", "claude:paused", "claude:subcap", "claude:cap", "claude:counter-error", "claude:no-time", "claude:header", "claude:subrequests", "claude:error", "claude:empty", "claude:overloaded", "guard:secret", "guard:host", "guard:config"]);
const TIMEOUT_REASON = /^claude:timeout(?:@(?:compose|retry)-\d{1,2}s)?$/;
const HTTP_REASON = /^claude:http-\d{3}$/;
export const safeReason = (r) => (typeof r === "string" && (REASONS.has(r) || TIMEOUT_REASON.test(r) || HTTP_REASON.test(r)) ? r : "claude:error");

// The ONLY body a self-test accepts. A signed /api/listen event (or any other signed body) must never start a paid call: the signature is shared with the listener, so the body carries the purpose.
export const SELFTEST_PURPOSE = "claude-selftest";
export const isSelftestBody = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && v.purpose === SELFTEST_PURPOSE;
export const REPLAY_WINDOW_MS = 120 * 1000; // LISTEN_MAX_AGE_SECONDS: how long a signature stays valid, so how long its hash is kept
const MAX_SEEN = 64;
const sha256Hex = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

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
  const nowFn = deps.now || (() => new Date()); // one clock for the signature window and for the limiter (tests inject it: no wall-clock second boundary)
  const ok = await verifyListen(await listenerKeyFor(env), req.headers.get("X-Listen-Timestamp"), raw, req.headers.get("X-Listen-Signature"), Math.floor(nowFn().getTime() / 1000));
  if (!ok) return json({ error: "unauthorized" }, 401);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  if (!isSelftestBody(parsed)) return json({ error: "bad body" }, 400); // after the signature: a signed listener event is refused here, before anything is stored or sent

  const nowMs = nowFn().getTime();
  let wait = 0;
  let replay = false;
  // The signature hash (SHA-256 of the lower-cased hex, never the signature) is kept for the 120 s the signature stays valid, in the limiter row itself (compare-and-set), so a repeat is refused (409)
  // before anything is sent. A limited call (429) is recorded too.
  const sigHash = await sha256Hex(String(req.headers.get("X-Listen-Signature") || "").toLowerCase());
  try {
    await updateKvJson(env, SELFTEST_RATE_KEY, (cur) => {
      const last = cur && Number.isFinite(cur.at) ? cur.at : 0;
      const seen = (cur && Array.isArray(cur.seen) ? cur.seen : []).filter((e) => e && typeof e.h === "string" && Number.isFinite(e.t) && nowMs - e.t <= REPLAY_WINDOW_MS);
      if (seen.some((e) => e.h === sigHash)) { replay = true; return { skip: true }; }
      const left = Math.ceil((last + SELFTEST_MIN_INTERVAL_S * 1000 - nowMs) / 1000);
      const seenNow = [...seen, { h: sigHash, t: nowMs }].slice(-MAX_SEEN);
      if (left > 0) { wait = left; return { doc: { at: last, seen: seenNow } }; }
      return { doc: { at: nowMs, seen: seenNow } };
    }, { now: () => new Date(nowMs).toISOString() });
  } catch {
    return json({ error: "unavailable" }, 503); // the limiter could not be written: no send (fail closed)
  }
  if (replay) return json({ error: "replay" }, 409);
  if (wait > 0) return json({ error: "rate limited", retryAfter: wait }, 429, { "Retry-After": String(wait) });

  const call = deps.call || callAnthropicClaude;
  const steps = [await step(env, "compose", true, call, nowFn), await step(env, "fast", false, call, nowFn)];
  console.log(JSON.stringify({ evt: "selftest_claude", compose: steps[0].reason, fast: steps[1].reason }));
  return json({ ok: steps.every((s) => s.ok), steps });
}
