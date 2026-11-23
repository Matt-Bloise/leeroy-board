// Shadow-compare recorder for /ask: POST /api/shadow/ask. docs/runbooks/shadow-ask.md; tools/shadow-ask.mjs signs and sends it.
// One mirrored question is run through the REAL production compose path (answerWithAi in ai-models.js: research prompt, Claude, real names, group memory read as a roster member's ask reads it, full-size prompt, the
// ask deadline and its hard end) with a record-only sink, so NOTHING is posted or shown: no Discord message, no interaction followup, no webhook, no socket message, no card, no stats entry, no group-memory write, no
// answer_details, and no ask_turns row (the board and its polls read ask_turns; this never touches it). The result goes to the private D1 table shadow_answers (migration 0014) and back to the signed caller.
// Gate, in order: flag SHADOW_ASK "on" (anything else, a PR preview or no usable bot token: 404, nothing read), then an HMAC with the SHADOW key (listener-config.js shadowKey: derived from the bot token with its own label, so
// the listener key the PC forwarder holds cannot call this route; same headers X-Listen-Timestamp / X-Listen-Signature, 120 s window,
// 401), body up to 4 KB (413), ASK_RESEARCH on (409), a body that carries "purpose":"shadow-ask" and only the keys below (400: a signed /api/listen event or self-test body can never start a paid compose), then the
// replay refusal (409, the signature hash is kept for the window) and the rate limit, 6 an hour and 20 a day by default (429; Worker var SHADOW_ASK_LIMITS, see shadowLimits). Spend goes through the normal Claude spend guard (the monthly token cap, with its pause and alert) and
// a sub-counter of its own capped at the third part of SHADOW_ASK_LIMITS (default 2) percent of that cap, so shadow runs can never starve the real asks.
// The caller is the key holder, so the response carries the answer text; it still passes the outbound protections (secrets, hex tokens, long ids) first, and what the table stores is what the caller is shown.
import { answerWithAi, isPrPreviewEnv, resolveAiProvider, askDeadlineMs } from "./ai-models.js";
import { monthTag } from "./research/claude.js";
import { researchModeOn } from "./research/provider.js";
import { hardEndMs } from "./research/no-wall.js";
import { scanSecrets, redactHex } from "./research/real-names.js";
import { shadowKeyFor, verifyListen, isSnow } from "./listener-config.js";
import { loadConfigKey } from "./config.js";
import { MAX_QUESTION_CHARS } from "./limits.js";
import { updateKvJson } from "./kv-cas.js";
import { readBounded } from "./listener.js";

export const SHADOW_FLAG = "SHADOW_ASK";
export const SHADOW_MAX_BODY = 4096;
export const SHADOW_PURPOSE = "shadow-ask";
export const SHADOW_PER_HOUR = 6;
export const SHADOW_PER_DAY = 20;
export const SHADOW_RATE_KEY = "shadow_ask_rate";
export const SHADOW_SUBCAP_PERCENT = 2;
export const SHADOW_SUBCAP_FRACTION = SHADOW_SUBCAP_PERCENT / 100; // 2% of the monthly Claude cap (100,000 tokens at the default 5,000,000): about ten full-size composes a month, and never a dent in the ask budget
export const shadowSubCounterKey = (now) => `claude_tokens_shadow_${monthTag(now)}`;
export const SHADOW_LOCAL_CHARS = 1500; // the local answer kept for the comparison (the whole body is 4 KB)
export const REPLAY_WINDOW_MS = 120 * 1000; // LISTEN_MAX_AGE_SECONDS: how long a signature stays valid, so how long its hash is kept
// Worker var SHADOW_ASK_LIMITS (hourly/daily/percent). The defaults are the original hard-coded limits. A value is read only if it is a plain positive decimal (a string like "40" or a number);
// unset, empty, non-numeric, NaN, Infinity, zero, negative or "1e3"-style text gives the DEFAULT, never "unlimited". A positive value past the range is clamped to the range edge. The daily limit is never below the hourly one.
const parsePositive = (v) => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string" || !/^\s*\d+(\.\d+)?\s*$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const clampedInt = (v, def, lo, hi) => { const n = parsePositive(v); const i = n === null ? 0 : Math.floor(n); return i < 1 ? def : Math.min(hi, Math.max(lo, i)); };
// ONE Worker var, SHADOW_ASK_LIMITS = "hourly/daily/percent" (for example "60/100/5"): three separate vars pushed the Worker past the Workers Free cap of 64 variables (the deploy failed, see
// tests/unit/var-budget.test.mjs). Absent, empty or malformed gives the defaults 6/20/2; each part is parsed and clamped on its own (a bad part takes its own default, never unlimited).
export function shadowLimits(env) {
  const raw = String(((env || {}).SHADOW_ASK_LIMITS) ?? "").trim();
  const parts = raw === "" ? [] : raw.split("/");
  const part = (i, legacy) => (parts[i] !== undefined && String(parts[i]).trim() !== "" ? parts[i] : legacy); // a part that is missing falls back to the older separate var (tests and any manual override), then the default
  const hourly = clampedInt(part(0, (env || {}).SHADOW_ASK_HOURLY), SHADOW_PER_HOUR, 1, 120);
  const daily = Math.max(hourly, clampedInt(part(1, (env || {}).SHADOW_ASK_DAILY), SHADOW_PER_DAY, 1, 600));
  const pct = parts.length > 3 ? null : parsePositive(part(2, (env || {}).SHADOW_ASK_SUBCAP_PERCENT));
  const percent = pct === null ? SHADOW_SUBCAP_PERCENT : Math.min(60, Math.max(0.1, pct));
  return { hourly, daily, percent, fraction: percent / 100 };
}
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ALLOWED_KEYS = new Set(["purpose", "question", "as", "channel", "private", "local_answer"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const shadowAskOn = (env) => String((env && env[SHADOW_FLAG]) || "").trim().toLowerCase() === "on";
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const sha256Hex = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
// reason: a fixed short code only (claude:timeout@compose-16s, claude:cap, guard:secret, ask:error ...), never free text.
export const safeReason = (r) => (typeof r === "string" && /^[a-z0-9][a-z0-9:@._-]{0,47}$/.test(r) ? r : r == null ? null : "other");

// The ONLY body a shadow call accepts. Parsed after the signature: a signed /api/listen event, a self-test body or any other signed JSON is refused before anything is stored or sent.
export function parseShadowBody(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "bad body" };
  if (v.purpose !== SHADOW_PURPOSE) return { error: "bad body" };
  if (Object.keys(v).some((k) => !ALLOWED_KEYS.has(k))) return { error: "bad body" };
  if (typeof v.question !== "string" || !v.question.trim()) return { error: "question required" };
  if (Array.from(v.question).length > MAX_QUESTION_CHARS) return { error: "question too long" };
  if (v.as !== undefined && v.as !== null && !(typeof v.as === "string" && SLUG_RE.test(v.as))) return { error: "bad asker" };
  if (v.channel !== undefined && v.channel !== null && v.channel !== "" && !isSnow(v.channel)) return { error: "bad channel" };
  if (v.private !== undefined && typeof v.private !== "boolean") return { error: "bad body" };
  if (v.local_answer !== undefined && v.local_answer !== null && typeof v.local_answer !== "string") return { error: "bad body" };
  return { ok: { question: v.question.trim(), as: v.as || null, channel: v.channel || "", priv: v.private === true, localAnswer: typeof v.local_answer === "string" ? v.local_answer : null } };
}

// deps.now: a clock returning a Date (tests).
export async function handleShadowAsk(req, env, deps = {}) {
  if (!shadowAskOn(env) || isPrPreviewEnv(env) || !(await shadowKeyFor(env))) return json({ error: "not found" }, 404);
  const raw = await readBounded(req, SHADOW_MAX_BODY);
  if (raw === null) return json({ error: "too large" }, 413);
  const ok = await verifyListen(await shadowKeyFor(env), req.headers.get("X-Listen-Timestamp"), raw, req.headers.get("X-Listen-Signature"), Math.floor(Date.now() / 1000));
  if (!ok) return json({ error: "unauthorized" }, 401);
  let research = false;
  try { research = Boolean(await researchModeOn(env, { preview: false })); } catch { research = false; }
  if (!research) return json({ error: "ask research is off" }, 409); // the shadow must run the research path the real asks run; without it there is nothing to compare
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const body = parseShadowBody(parsed);
  if (!body.ok) return json({ error: body.error }, 400);
  const { question, as, channel, priv } = body.ok;
  if (scanSecrets(question, env).length) return json({ error: "question holds a secret-shaped value" }, 400); // refused before any spend, and never stored
  // The WHOLE submitted local answer is scanned before it is cut: a secret that straddles the cut must not survive as a half-matched prefix.
  let localAnswer = null;
  let localDropped = false;
  if (body.ok.localAnswer !== null) {
    if (scanSecrets(body.ok.localAnswer, env).length) localDropped = true;
    else localAnswer = Array.from(body.ok.localAnswer).slice(0, SHADOW_LOCAL_CHARS).join("");
  }

  let asker = { slug: undefined, name: "Friend" };
  if (as) {
    const roster = await loadConfigKey(env, "discord_members");
    const m = Array.isArray(roster) ? roster.find((x) => x && x.slug === as && typeof x.name === "string" && x.name) : null;
    if (!m) return json({ error: "unknown asker" }, 400);
    asker = { slug: m.slug, name: m.name };
  }

  const limits = shadowLimits(env);
  const nowFn = deps.now || (() => new Date());
  const nowMs = nowFn().getTime();
  let replay = false;
  let wait = 0;
  // Accepted signatures only: the SHA-256 of the lower-cased signature (never the signature) is kept in the limiter row (compare-and-set) until the moment the verifier would stop accepting it (its timestamp plus the 120 s window),
  // so a repeat is refused (409) before anything runs. A call refused for any reason (400, 429) is NOT recorded, so a flood of rejected signed requests cannot push an accepted signature out of the cache; entries are pruned
  // by expiry only, never by count (the rate limits bound the list: at most SHADOW_ASK_DAILY accepted calls a day, 20 by default, each kept for 2 minutes).
  const sigHash = await sha256Hex(String(req.headers.get("X-Listen-Signature") || "").toLowerCase());
  const expiresAt = Number(req.headers.get("X-Listen-Timestamp")) * 1000 + REPLAY_WINDOW_MS;
  try {
    await updateKvJson(env, SHADOW_RATE_KEY, (cur) => {
      const seen = (cur && Array.isArray(cur.seen) ? cur.seen : []).filter((e) => e && typeof e.h === "string" && Number.isFinite(e.x) && e.x > nowMs);
      const hits = (cur && Array.isArray(cur.hits) ? cur.hits : []).filter((t) => Number.isFinite(t) && nowMs - t < DAY_MS);
      if (seen.some((e) => e.h === sigHash)) { replay = true; return { skip: true }; }
      const lastHour = hits.filter((t) => nowMs - t < HOUR_MS).sort((a, b) => a - b);
      let left = 0;
      if (lastHour.length >= limits.hourly) left = Math.ceil((lastHour[lastHour.length - limits.hourly] + HOUR_MS - nowMs) / 1000);
      if (hits.length >= limits.daily) left = Math.max(left, Math.ceil(([...hits].sort((a, b) => a - b)[hits.length - limits.daily] + DAY_MS - nowMs) / 1000));
      if (left > 0) { wait = left; return { skip: true }; } // a limited call writes nothing
      return { doc: { seen: [...seen, { h: sigHash, x: expiresAt }], hits: [...hits, nowMs] } };
    }, { now: () => new Date(nowMs).toISOString() });
  } catch {
    return json({ error: "unavailable" }, 503); // the limiter could not be written: nothing runs (fail closed)
  }
  if (replay) return json({ error: "replay" }, 409);
  if (wait > 0) return json({ error: "rate limited", retryAfter: wait }, 429, { "Retry-After": String(wait) });

  const id = crypto.randomUUID();
  let rec = null;
  const sink = { shadow: true, subSpend: { counter: shadowSubCounterKey, fraction: limits.fraction }, record: (r) => { rec = r; } };
  const t0 = Date.now();
  try {
    await answerWithAi({
      env, rosterOp: req, origin: new URL(req.url).origin, intentId: id, by: asker.name, memberSlug: asker.slug, question, provider: resolveAiProvider(env),
      share: !priv, budget: null, isMember: true, storeDetails: false, channel, sink,
    });
  } catch {
    rec = null;
  }
  const wallMs = Math.max(0, Date.now() - t0);
  if (!rec) rec = { status: "error", reason: "ask:error", latencyMs: wallMs };

  // The outbound protections over what leaves the Worker and what is stored: a secret-shaped or long-id answer is withheld whole, hex tokens are redacted.
  let status = ["answered", "degraded", "error", "refused"].includes(rec.status) ? rec.status : "error";
  let reason = safeReason(rec.reason);
  let answer = typeof rec.answer === "string" ? redactHex(rec.answer) : null;
  if (answer !== null && scanSecrets(answer, env).length) { answer = null; status = "error"; reason = "guard:outbound"; }
  const model = typeof rec.model === "string" ? rec.model.slice(0, 160) : null;
  const latencyMs = Number.isFinite(rec.latencyMs) ? Math.max(0, Math.round(rec.latencyMs)) : wallMs;
  const hardEnd = hardEndMs(askDeadlineMs(env));
  const meta = {
    v: 1, research: Boolean(rec.research), group_memory: Boolean(rec.groupMemory), share: !priv, as_given: Boolean(as), channel_given: Boolean(channel), local_dropped: localDropped,
    cites: Array.isArray(rec.cites) ? rec.cites.length : 0, answer_chars: answer ? Array.from(answer).length : 0, deadline_ms: askDeadlineMs(env), hard_end_ms: hardEnd, within_hard_end: latencyMs <= hardEnd,
  };
  // Measured Anthropic usage of the compose (and any retry send), integers or null (unknown, or a degraded non-Claude answer).
  const mu = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(1e7, Math.floor(v)) : null);
  const ru = rec.usage && typeof rec.usage === "object" && rec.status === "answered" ? rec.usage : null;
  const inputTokens = ru ? mu(ru.input_tokens) : null;
  const outputTokens = ru ? mu(ru.output_tokens) : null;
  const usageKnown = inputTokens !== null && outputTokens !== null;
  // GAME_FACTS_READ trace: the block text the model was shown (table rows only: no friend text is in it), the lookup's elapsed ms and its outcome. Present only when the reader ran.
  const gt = rec.gameFactsTrace;
  if (gt && typeof gt === "object") meta.gf = { ms: mu(gt.ms), outcome: ["timeout", "failed", "empty", "rows"].includes(gt.outcome) ? gt.outcome : null, timed_out: gt.outcome === "timeout", used: gt.used === true, dropped: gt.dropped === "prompt-budget" ? "prompt-budget" : null, block: typeof gt.block === "string" && gt.used === true ? gt.block.slice(0, 4000) : null };
  meta.input_tokens = usageKnown ? inputTokens : null;
  meta.output_tokens = usageKnown ? outputTokens : null;
  // Cache counts (Anthropic input_tokens excludes the cached part): integers when the usage is known, else null. Counts only; no new column (meta is JSON).
  meta.cache_creation_input_tokens = usageKnown ? mu(ru.cache_creation_input_tokens) ?? 0 : null;
  meta.cache_read_input_tokens = usageKnown ? mu(ru.cache_read_input_tokens) ?? 0 : null;
  const createdAt = nowFn().toISOString();
  try {
    await env.DB.prepare("INSERT INTO shadow_answers (id, created_at, asker_slug, question, answer, model, latency_ms, status, reason, local_answer, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, createdAt, asker.slug || null, question, answer, model, latencyMs, status, reason, localAnswer, JSON.stringify(meta)).run();
  } catch {
    console.log(JSON.stringify({ evt: "shadow_ask", stored: false, status, reason, ms: latencyMs }));
    return json({ id, ok: false, status: "store-failed", model, latency_ms: latencyMs, reason: "store:failed", answer, input_tokens: meta.input_tokens, output_tokens: meta.output_tokens }, 500);
  }
  console.log(JSON.stringify({ evt: "shadow_ask", stored: true, status, reason, ms: latencyMs })); // no text, no name
  return json({ id, ok: status === "answered", status, model, latency_ms: latencyMs, reason: reason || (status === "answered" ? "ok" : null), answer, input_tokens: meta.input_tokens, output_tokens: meta.output_tokens });
}
