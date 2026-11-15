// /ask research mode (ASK_RESEARCH on): the Claude hop. Provider order is Claude -> Workers AI -> library facts; no other provider ever sees friend text.
//
// Every outside call happens only after (1) the whole prompt is tokenised (privacy/tokenise.js: names become per-request tokens), (2) the strict guard passes over
// the friend-controlled segments (question, previous turn, asker) and (3) the cheap guard passes over the final request body. Any guard hit, any error, an
// unavailable key, a spent monthly token budget or a counter that cannot be read means: no Claude call, Workers AI (Cloudflare-internal) answers the same
// tokenised prompt. Never a wall, never a refusal. Reasons are short fixed codes (claude:*, guard:*, tokenise:*), never values.
//
// Spend guard: tokens (input + output, from the response usage block) are added to the D1 row kv_state key claude_tokens_YYYYMM (UTC month) with one atomic
// upsert. RESEARCH_CLAUDE_MONTHLY_TOKENS (default 2,000,000) is the bound; at or over it Claude is skipped and one alert row per month is written
// (alert:claude-cap:YYYYMM, no names, no text). Prices are NOT modelled in code: the token cap is the bound (docs/runbooks/flags.md has the worst-case arithmetic).
import { anthropicAvailable } from "../ai-keys.js";
import { buildNameMap, tokenise, detokenise } from "../privacy/tokenise.js";
import { guardUserText, guardBody, replyLeaksIdentity } from "../privacy/outbound-guard.js";
import { researchRoster, genericAliases } from "../privacy/roster-config.js";
import { RESEARCH_MAX_TOKENS } from "./rules.js";

export const DEFAULT_MONTHLY_TOKENS = 2000000;
export const CLAUDE_TIMEOUT_MS = 9000; // one budget for the first call and the model-id retry together; Workers AI keeps its own 12s after it, inside the 24s ask deadline
const RETRY_MIN_MS = 2500;
const MODELS = {
  fast: ["RESEARCH_CLAUDE_MODEL_FAST", "claude-haiku-5-5", "RESEARCH_CLAUDE_FALLBACK_FAST", "claude-haiku-4-5-20251001"],
  deep: ["RESEARCH_CLAUDE_MODEL_DEEP", "claude-sonnet-5-5", "RESEARCH_CLAUDE_FALLBACK_DEEP", "claude-sonnet-4-5-20250929"],
};
const clean = (v, d) => (typeof v === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(v.trim()) ? v.trim() : d);

export function researchClaudeModels(env, deep) {
  const [pk, pd, fk, fd] = MODELS[deep ? "deep" : "fast"];
  const e = env || {};
  return { primary: clean(e[pk], pd), fallback: clean(e[fk], fd) };
}

// A bad or missing value means the default, never unlimited. 0 is allowed (Claude off).
export function monthlyTokenCap(env) {
  const raw = env && env.RESEARCH_CLAUDE_MONTHLY_TOKENS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MONTHLY_TOKENS;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MONTHLY_TOKENS;
}

export const monthTag = (now = new Date()) => now.toISOString().slice(0, 7).replace("-", "");
export const counterKey = (now) => `claude_tokens_${monthTag(now)}`;
export const alertKey = (now) => `alert:claude-cap:${monthTag(now)}`;

// Tokens used this month. Throws when the row cannot be read or is not a number: the caller skips Claude.
export async function readTokensUsed(env, now = new Date()) {
  const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(counterKey(now)).first();
  if (!row) return 0;
  const n = Number(row.json);
  if (!Number.isFinite(n) || n < 0) throw new Error("claude token counter is not a number");
  return n;
}

// One atomic statement: no read-modify-write window between concurrent asks.
export async function addTokensUsed(env, tokens, now = new Date()) {
  const n = Math.max(0, Math.floor(Number(tokens) || 0));
  if (!n) return;
  await env.DB.prepare(
    "INSERT INTO kv_state (key, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET json = CAST(CAST(json AS INTEGER) + CAST(?2 AS INTEGER) AS TEXT), updated_at = ?3"
  ).bind(counterKey(now), String(n), now.toISOString()).run();
}

async function alertOnce(env, cap, used, now = new Date()) {
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
      .bind(alertKey(now), JSON.stringify({ kind: "claude-monthly-token-cap", month: monthTag(now), cap, used }), now.toISOString()).run();
  } catch {}
}

// ---- tokenised prompt -----------------------------------------------------------------------------------------------------------------------------
const SAFE_ASKER = /^[\p{L}\p{N} _.'-]{1,32}$/u;
const LEFTOVER_TOKEN = /\{\s{0,3}(?:p\s{0,3}\d|id\b|all\b|invite\b|guild\b)/i;

// Builds the per-request name map and the tokenised prompts. Never throws: { ok:false, reason } means "do not call Claude; Workers AI uses the prompts as they are".
export function prepareResearchPrivacy({ systemPrompt, userPrompt, question, previousQuestion, by }) {
  try {
    const roster = researchRoster();
    const askerRaw = String(by ?? "").trim();
    const asker = askerRaw && askerRaw.toLowerCase() !== "visitor" ? askerRaw : null;
    const map = buildNameMap(roster.members, asker, { genericAliases });
    // An asker who is not on the roster still gets their own typed name back in the reply (their own text returning to them); the token itself carries no name.
    if (map.askerToken && map.askerToken === map.tokenFor(roster.members.length) && SAFE_ASKER.test(askerRaw)) map.byToken.set(map.askerToken, { display: askerRaw });
    const segments = [tokenise(question, map)];
    if (previousQuestion) segments.push(tokenise(previousQuestion, map));
    if (asker) segments.push(tokenise(asker, map));
    return {
      ok: true,
      map,
      roster,
      asker,
      system: tokenise(systemPrompt, map),
      user: tokenise(userPrompt, map),
      segments,
      // Raw model reply -> display-name text, or null when it must be discarded (a name we never send, or a token that is not ours).
      clean(raw) {
        const text = String(raw ?? "");
        if (!text.trim()) return null;
        try {
          if (replyLeaksIdentity(text, roster)) return null;
        } catch { return null; }
        map.tokRe.lastIndex = 0;
        if (LEFTOVER_TOKEN.test(text.replace(map.tokRe, ""))) return null;
        return detokenise(text, map);
      },
    };
  } catch {
    return { ok: false, reason: "tokenise:error" };
  }
}

const guardReason = (e) => {
  if (e && e.code === "OUTBOUND_IDENTIFIER_LEAK") {
    const k = String((e.leaks && e.leaks[0] && e.leaks[0].kind) || "hit").toLowerCase().replace(/[^a-z]+/g, "-").slice(0, 16) || "hit";
    return `guard:${k}`;
  }
  return "guard:config";
};
const failReason = (e) => {
  if (e && (e.code === "ai_timeout" || e.name === "AiTimeoutError" || e.name === "TimeoutError")) return "claude:timeout";
  const m = /HTTP (\d{3})/.exec(String((e && e.message) || ""));
  return m ? `claude:http-${m[1]}` : "claude:error";
};
const isModelMissing = (e) => /HTTP (?:404|400)\b/.test(String((e && e.message) || ""));

// Returns { answer, model, provider: "claude" } or { reason } (reason may be null: silent skip, e.g. no key configured).
// call: callAnthropicClaude from ai-models.js (injected: this file must not import it back).
export async function tryResearchClaude({ env, priv, deep, call, now = () => new Date() }) {
  if (!anthropicAvailable(env)) return { reason: null };
  if (!priv || !priv.ok) return { reason: (priv && priv.reason) || "tokenise:error" };
  const at = now();
  const cap = monthlyTokenCap(env);
  let used;
  try { used = await readTokensUsed(env, at); } catch { return { reason: "claude:counter-error" }; }
  if (used >= cap) {
    await alertOnce(env, cap, used, at);
    return { reason: "claude:cap" };
  }
  try { guardUserText(priv.segments, priv.roster, priv.asker ? { asker: priv.asker } : {}); } catch (e) { return { reason: guardReason(e) }; }

  const { primary, fallback } = researchClaudeModels(env, deep);
  const deadlineAt = Date.now() + CLAUDE_TIMEOUT_MS;
  const beforeSend = (body) => guardBody(body, priv.roster);
  const attempt = (modelOverride) => call({ env, systemPrompt: priv.system, userPrompt: priv.user, deep, skipCache: true, metadata: null, deadlineAt, maxTokens: RESEARCH_MAX_TOKENS, modelOverride, wantUsage: true, beforeSend });
  let res;
  try {
    try {
      res = await attempt(primary);
    } catch (e) {
      if (e && e.code === "OUTBOUND_IDENTIFIER_LEAK") throw e;
      if (!(isModelMissing(e) && fallback && fallback !== primary && deadlineAt - Date.now() >= RETRY_MIN_MS)) throw e;
      res = await attempt(fallback); // one retry, and only for a model-not-found style answer
    }
  } catch (e) {
    if (e && (e.code === "OUTBOUND_IDENTIFIER_LEAK" || e.code === "OUTBOUND_GUARD_CONFIG")) return { reason: guardReason(e) };
    return { reason: failReason(e) };
  }
  const u = res.usage || {};
  const spent = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) || Math.ceil((priv.system.length + priv.user.length) / 3) + RESEARCH_MAX_TOKENS; // no usage block: assume the worst we sent
  try { await addTokensUsed(env, spent, at); } catch { console.warn("[research] claude token counter write failed"); }
  const text = priv.clean(res.answer);
  if (text === null) return { reason: "claude:reply-flagged" };
  return { answer: text, model: res.model, provider: "claude" };
}
