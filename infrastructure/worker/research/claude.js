// /ask research mode (ASK_RESEARCH on): the Claude hop. Provider order for a member is Claude (compose on the deep model, one Haiku-class retry on 529/5xx/timeout, max 2 sends) -> the honest degraded line (+ library facts); no other provider ever sees friend text.
//
// RESEARCH_NAMES (research/real-names.js) picks how the prompt leaves. "real" (the wrangler.toml value): the Claude hop gets real names, sheet fields, builds and the asker's turns
// untokenised; the name guard and the whole-prompt name scan do not run and a name never fails the ask over. "tokenised": every outside call happens only after (1) the whole prompt
// is tokenised (privacy/tokenise.js: names become per-request tokens; the name list is the roster PLUS every name on the party sheets), (2) the strict guard passes over EVERY
// friend-writable segment (free-text sheet fields are sent only if they pass, else dropped) and (3) the cheap guard passes over the final request body.
// In BOTH modes these stay on: the host allow-list (Anthropic only), the secret and long-id scan of the body and the reply, pings defanged, friend text fenced as data.
// Any guard hit, any error, an unavailable key, a spent monthly token budget, a counter that cannot be read or written, or a privacy step over its CPU budget means: no Claude call.
// For a member that now means the honest degraded line (research/provider.js, ai-models.js), NEVER Workers AI or any other provider. Reasons are short fixed codes
// (claude:*, guard:*, tokenise:*, cpu:*), never values.
//
// Spend guard: an estimate is RESERVED atomically in D1 (kv_state key claude_tokens_YYYYMM, UTC month) before the call, then reconciled to the real usage
// (all four usage fields, clamped). RESEARCH_CLAUDE_MONTHLY_TOKENS (default 5,000,000) is the bound; when the reserve fails Claude is skipped and one alert row per
// month is written (alert:claude-cap:YYYYMM, no names, no text). A counter write that fails pauses Claude for 10 minutes (module memory). Prices are NOT modelled
// in code: the token cap is the bound (docs/runbooks/flags.md has the worst-case arithmetic).
import { anthropicAvailable } from "../ai-keys.js";
import { stripFence } from "../prompt-fence.js";
import { buildNameMap, tokenise, detokenise, stripRestorableTokens, makeNonce } from "../privacy/tokenise.js";
import { skeleton } from "../privacy/skeleton.js";
import { guardUserText, guardBody, replyLeaksIdentity } from "../privacy/outbound-guard.js";
import { researchMembers, researchMembersFor, genericAliases } from "../privacy/roster-config.js";
import { RESEARCH_MAX_TOKENS } from "./rules.js";
import { prepareRealPrompt, guardSecretsInBody, cleanRealReply, scanSecrets, defangPings, redactHex } from "./real-names.js";

export const DEFAULT_MONTHLY_TOKENS = 5000000;
// The Claude hop's budget. The ask's hard end is the deadline minus a sixth (research/no-wall.js hardEndMs): with ASK_DEADLINE_MS 26 s that is 22 s after the ask started. The Worker runs the ask under ctx.waitUntil, which
// Cloudflare ends 30 s after the response is sent (developers.cloudflare.com/workers/runtime-apis/context/ and /workers/platform/limits/: Workers Free has no wall-clock limit for a connected HTTP request, waitUntil gets up to
// 30 s); the Discord delivery edit has a 28 s budget (discord.js DELIVERY_BUDGET_MS). Sonnet composing a real-names research answer (a large prompt, up to RESEARCH_MAX_TOKENS 700 output tokens, one non-streaming call)
// needs seconds to the first token and several more to finish a long answer, so the old 6 s compose budget aborted real asks ("claude:timeout"). The 22 s is split: compose 16 s, then the Haiku-class retry the rest, at most 8 s.
export const CLAUDE_TIMEOUT_MS = 22000; // one budget for compose and the retry together, always clamped to the ask's hard end; Workers AI is never used for a member
export const CLAUDE_COMPOSE_MS = 16000; // the compose send's own deadline inside CLAUDE_TIMEOUT_MS; a timeout there still leaves >= RETRY_MIN_MS for the Haiku-class retry (see splitBudget)
export const CLAUDE_RETRY_MAX_MS = 8000; // the retry's own cap: min(what is left, 8 s); a Haiku-class answer finishes well inside it
export const PAUSE_MS = 10 * 60 * 1000;
export const USAGE_CLAMP = 200000; // per usage field, per call
export const RETRY_MIN_MS = 2500;
// How the time left (ms until the hop's end) is split between compose and the retry. Compose never takes the retry's minimum: with room for both it gets min(CLAUDE_COMPOSE_MS, remaining - RETRY_MIN_MS);
// with room for only one send (a short ask deadline or a slow start) it gets everything left and there is no retry.
export function splitBudget(remainingMs) {
  const r = Math.max(0, Math.floor(Number(remainingMs) || 0));
  if (r < 2 * RETRY_MIN_MS) return { compose: r, retry: 0 };
  const compose = Math.min(CLAUDE_COMPOSE_MS, r - RETRY_MIN_MS);
  return { compose, retry: Math.min(CLAUDE_RETRY_MAX_MS, r - compose) };
}
const MAX_PROMPT_CHARS = 60000; // CPU proxy that does not depend on a clock (Workers freezes timers during pure compute)
// Wall-clock budget for tokenise + guards per ask (measured with performance.now; in a Worker the clock may not advance during compute, so MAX_PROMPT_CHARS is the backstop).
export const privacyBudget = { ms: 8 };

// Sheet fields shown to the model (ask-build.js FIELD_ORDER). STRUCTURED values are short enumerated game data; FREE_TEXT is whatever the member typed.
// Any field not listed is free-text (the safe default). Free-text fields are sent only when they pass the strict guard; a structured field that fails stops Claude.
export const STRUCTURED_FIELDS = ["class", "race", "spec_path", "spec_at_40", "level", "role", "professions", "launch_state"];
export const FREE_TEXT_FIELDS = ["plan_zone", "goals"];
export const classifyField = (k) => (STRUCTURED_FIELDS.includes(k) ? "structured" : "free");

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

// ---- spend guard ------------------------------------------------------------------------------------------------------------------------------------
let pausedUntil = 0;
const pauseClaude = () => { pausedUntil = Date.now() + PAUSE_MS; };
export function resetResearchClaudeForTests() { pausedUntil = 0; ctxCache.clear(); }

// Counts all four usage fields (cache writes and reads are billed), each clamped to [0, USAGE_CLAMP]. A missing block, NaN, a non-number or a negative means the
// estimate (assume the worst we sent), never zero.
const USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
export function usageTokens(usage, estimate) {
  if (!usage || typeof usage !== "object") return estimate;
  const valid = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  // input and output must both be valid numbers: a partial block must never refund most of the reservation.
  if (!valid(usage.input_tokens) || !valid(usage.output_tokens)) return estimate;
  let sum = Math.min(usage.input_tokens, USAGE_CLAMP) + Math.min(usage.output_tokens, USAGE_CLAMP);
  for (const k of ["cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const raw = usage[k];
    if (raw === undefined || raw === null) continue; // optional: counted when present
    if (!valid(raw)) return estimate;
    sum += Math.min(raw, USAGE_CLAMP);
  }
  return sum > 0 ? Math.ceil(sum) : estimate; // a real response always used some input; 0 total is not believable
}

// Conservative upper bound on what a prompt costs: ASCII at 3 characters per token, every other UTF-16 unit (CJK, emoji, accents) at 1.5 tokens, plus the full answer allowance.
export function estimateTokens(systemText, userText) {
  const text = `${systemText ?? ""}${userText ?? ""}`;
  const nonAscii = (text.match(/[^\u0000-\u007f]/g) || []).length;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii * 1.5) + RESEARCH_MAX_TOKENS;
}

// One atomic statement: add the estimate only if the WHOLE reservation fits under the cap (both branches) (and the stored value is a plain integer). Rows come back only on success.
const RESERVE_SQL =
  "INSERT INTO kv_state (key, json, updated_at) SELECT ?1, CAST(CAST(?2 AS INTEGER) AS TEXT), ?3 WHERE ?4 > 0 AND CAST(?2 AS INTEGER) <= ?4 " +
  "ON CONFLICT(key) DO UPDATE SET json = CAST(CAST(json AS INTEGER) + CAST(?2 AS INTEGER) AS TEXT), updated_at = ?3 WHERE CAST(json AS INTEGER) + CAST(?2 AS INTEGER) <= ?4 AND json NOT GLOB '*[^0-9]*' RETURNING json";
const ADJUST_SQL = "UPDATE kv_state SET json = CAST(CAST(MAX(0, CAST(json AS INTEGER) + CAST(?2 AS INTEGER)) AS INTEGER) AS TEXT), updated_at = ?3 WHERE key = ?1";

export async function reserveTokens(env, estimate, cap, now = new Date(), key = counterKey(now)) {
  const res = await env.DB.prepare(RESERVE_SQL).bind(key, Math.max(1, Math.floor(estimate)), now.toISOString(), cap).all();
  return Boolean(res && Array.isArray(res.results) && res.results.length === 1);
}
async function adjustTokens(env, delta, now = new Date(), key = counterKey(now)) {
  if (!delta) return;
  await env.DB.prepare(ADJUST_SQL).bind(key, Math.trunc(delta), now.toISOString()).run();
}
// The group-wiki refresher's own counter (UTC month) and its share of the monthly cap: it can never use more than a tenth of it, so asks always have room.
export const SUBCAP_FRACTION = 0.1;
export const subCounterKey = (now) => `claude_tokens_group_${monthTag(now)}`;
async function alertOnce(env, cap, now = new Date()) {
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
      .bind(alertKey(now), JSON.stringify({ kind: "claude-monthly-token-cap", month: monthTag(now), cap }), now.toISOString()).run();
  } catch {}
}

// ---- name map: compiled once per roster+party, only the nonce changes per request ----------------------------------------------------------------
const ctxCache = new Map();
function contextFor(members) {
  const key = JSON.stringify(members);
  let c = ctxCache.get(key);
  if (!c) {
    const roster = { members, genericAliases: [...genericAliases] };
    const template = buildNameMap(members, null, { genericAliases, nonce: "tmpl" });
    c = { roster, template };
    if (ctxCache.size >= 8) ctxCache.clear();
    ctxCache.set(key, c);
  }
  return c;
}
function cloneMap(t, nonce) {
  const re = (s) => (typeof s === "string" ? s.split(".tmpl}").join(`.${nonce}}`) : s);
  const esc = nonce.replace(/[^a-z0-9]/gi, "");
  return {
    entries: t.entries.map((e) => ({ ...e, token: re(e.token) })),
    names: new Map([...t.names].map(([k, v]) => [k, re(v)])),
    byToken: new Map([...t.byToken].map(([k, v]) => [re(k), { ...v }])),
    ids: new Map([...t.ids].map(([k, v]) => [k, re(v)])),
    nonce,
    typedNonces: new Set(),
    special: Object.fromEntries(Object.entries(t.special).map(([k, v]) => [k, re(v)])),
    tokenFor: (i) => `{P${i + 1}.${nonce}}`,
    askerToken: null,
    splitRe: new RegExp(`(\\{(?:P\\d+|ID|ALL|INVITE|GUILD)\\.${esc}\\})`),
    tokRe: new RegExp(`\\{(P\\d+|ID|ALL|INVITE|GUILD)\\.${esc}\\}`, "g"),
  };
}

// ---- the party document: names, guarded segments, free-text filter --------------------------------------------------------------------------------
const fieldString = (f) => {
  const v = f && typeof f === "object" && !Array.isArray(f) && "value" in f ? f.value : f;
  if (v === null || v === undefined || v === "") return "";
  return Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
};
const strings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};

// Called by buildAnswerInputs in research mode, BEFORE the prompt blocks are rendered. Returns the sheets to render (free-text fields that fail the guard removed),
// the member list for the name map, and `mandatory`: raw strings that must pass the guard before Claude is called. Never throws: { failed: true } means skip Claude.
export function researchParty(sheets, stateMap, { real = false, env = null } = {}) {
  try {
    const list = Array.isArray(sheets) ? sheets : [];
    const members = researchMembersFor(list);
    const ctx = contextFor(members);
    const passes = (text) => { try { guardUserText([tokenise(text, ctx.template)], ctx.roster); return true; } catch { return false; } };
    const mandatory = [];
    let dropped = 0;
    const out = list.map((s) => {
      if (!s || typeof s !== "object" || !s.fields || typeof s.fields !== "object") return s;
      const fields = {};
      for (const [k, f] of Object.entries(s.fields)) {
        const text = fieldString(f);
        if (!text) { fields[k] = f; continue; }
        if (scanSecrets(redactHex(text), env, { ids: false }).length) { dropped++; continue; } // anything secret-shaped: the whole field is dropped, in both modes, and the ask goes on
        if (classifyField(k) === "structured") { mandatory.push(text); fields[k] = f; }
        else if (real || passes(text)) fields[k] = f; // RESEARCH_NAMES "real": the name guard does not run, so no free-text field is dropped for a name
        else dropped++;
      }
      return { ...s, fields };
    });
    const signups = stateMap && stateMap.signups && stateMap.signups.roster;
    if (signups && typeof signups === "object") for (const [k, v] of Object.entries(signups)) mandatory.push(k, ...strings(v));
    const tonight = stateMap && stateMap.tonight;
    if (tonight) mandatory.push(...strings(tonight));
    return { members, sheets: out, mandatory: mandatory.filter((x) => typeof x === "string" && x), dropped };
  } catch {
    return { failed: true, sheets, mandatory: [], dropped: 0 };
  }
}

// ---- tokenised prompt -----------------------------------------------------------------------------------------------------------------------------
const SAFE_ASKER = /^[\p{L}\p{N} _.'-]{1,32}$/u;
const LEFTOVER_TOKEN = /\{\s{0,3}(?:p\s{0,3}\d|id\b|all\b|invite\b|guild\b)/i;

// Builds the per-request name map and the tokenised prompts. Never throws: { ok:false, reason } means "do not call Claude; Workers AI uses the prompts as they are".
// An asker who is a known member is tokenised like any name. An unknown asker is tokenised BY CONSTRUCTION: only the two labels the code writes ("Asker: X (" and
// "Question from X (journey") become a token; the asker string is never a key over the rest of the prompt (an asker called "The" must not turn every "the" into a token).
export function prepareResearchPrivacy({ systemPrompt, userPrompt, question, previousQuestion, priorTurns, by, party }) {
  try {
    if (party && party.failed) return { ok: false, reason: "tokenise:error" };
    const members = party && party.members ? party.members : researchMembers();
    const ctx = contextFor(members); // compiled once per isolate and roster; not part of the per-ask budget
    const t0 = performance.now();
    const map = cloneMap(ctx.template, makeNonce());
    const askerRaw = String(by ?? "").trim();
    const userSegments = [tokenise(question, map)];
    if (previousQuestion) userSegments.push(tokenise(previousQuestion, map));
    // The asker's own earlier turns (research/turns.js): both the question and the earlier answer are friend-writable or model-written text, so each is tokenised and guarded like the question.
    if (Array.isArray(priorTurns)) for (const t of priorTurns) userSegments.push(tokenise(String(t.q ?? ""), map), tokenise(String(t.a ?? ""), map));
    if (askerRaw && askerRaw.toLowerCase() !== "visitor") userSegments.push(tokenise(askerRaw, map)); // the asker string is guarded like any typed text (never used as a key)
    const partySegments = (party && party.mandatory ? party.mandatory : []).map((t) => tokenise(t, map));
    const system = tokenise(systemPrompt, map);
    let user = tokenise(userPrompt, map);
    if (askerRaw && askerRaw.toLowerCase() !== "visitor" && !ctx.template.names.has(skeleton(askerRaw))) {
      // The swap runs AFTER tokenising (a token typed into the input would be escaped by tokenise), on the two label lines only.
      const label = tokenise(stripFence(askerRaw, { oneLine: true }), map);
      const tok = map.tokenFor(members.length);
      map.byToken.set(tok, { display: SAFE_ASKER.test(askerRaw) ? askerRaw : "someone" });
      if (label) user = user.split(`Asker: ${label} (`).join(`Asker: ${tok} (`).split(`Question from ${label} (journey`).join(`Question from ${tok} (journey`);
    }
    return {
      ok: true,
      map,
      roster: ctx.roster,
      system,
      user,
      userSegments,
      partySegments,
      ms: performance.now() - t0,
      // Raw model reply -> display-name text, or null when it must be discarded (a name we never send, or a token that is not ours).
      clean(raw) {
        const text = String(raw ?? "");
        if (!text.trim()) return null;
        try {
          if (replyLeaksIdentity(text, ctx.roster)) return null;
        } catch { return null; }
        if (LEFTOVER_TOKEN.test(stripRestorableTokens(text, map))) return null;
        return detokenise(text, map);
      },
    };
  } catch {
    return { ok: false, reason: "tokenise:error" };
  }
}

const guardReason = (e) => {
  if (e && e.code === "OUTBOUND_SECRET") return "guard:secret";
  if (e && e.code === "OUTBOUND_HOST") return "guard:host";
  if (e && e.code === "OUTBOUND_IDENTIFIER_LEAK") {
    const k = String((e.leaks && e.leaks[0] && e.leaks[0].kind) || "hit").toLowerCase().replace(/[^a-z]+/g, "-").slice(0, 16) || "hit";
    return `guard:${k}`;
  }
  return "guard:config";
};
// A fixed, value-free class for whatever the Claude hop threw (it ends up in the stored model label, so it must say what failed and never carry a value):
//   claude:timeout        a deadline
//   claude:http-NNN       the provider answered with that status
//   claude:subrequests    the Workers subrequest limit ("Too many subrequests")
//   claude:header         a header or token value the runtime refuses (our gateway token check, or the runtime's "Invalid header value" TypeError)
//   claude:error-<Name>   anything else: the error's NAME only (letters and digits, at most 24 characters), never the message; "claude:error" when it has no usable name
export const ERROR_NAME_MAX = 24;
// A timeout from the ask hop also says WHICH send timed out and after how many whole seconds: `claude:timeout@compose-16s`, `claude:timeout@retry-6s` (stage "compose" or "retry", the send's own elapsed time capped at 99 s).
export const timeoutBucket = (stage, ms) => ((stage === "compose" || stage === "retry") && Number.isFinite(ms) ? `@${stage}-${Math.min(99, Math.max(0, Math.round(ms / 1000)))}s` : "");
export const failReason = (e, sent = null) => {
  if (e && (e.code === "ai_timeout" || e.name === "AiTimeoutError" || e.name === "TimeoutError")) return `claude:timeout${sent ? timeoutBucket(sent.stage, Date.now() - sent.at) : ""}`;
  const message = String((e && e.message) || "");
  const m = /HTTP (\d{3})/.exec(message);
  if (m) return `claude:http-${m[1]}`;
  if (e && e.code === "AI_GATEWAY_TOKEN_INVALID") return "claude:header";
  if (/too many subrequests/i.test(message)) return "claude:subrequests";
  if (e && e.name === "TypeError" && /\bheader|ByteString/i.test(message)) return "claude:header";
  const name = String((e && e.name) || "").replace(/[^A-Za-z0-9]/g, "").slice(0, ERROR_NAME_MAX);
  return name ? `claude:error-${name}` : "claude:error";
};
// Overload-class failures that justify the one Haiku-class retry: Anthropic 529, any 5xx, or a timeout. Never 401/403/400/429/other 4xx.
const overloaded = (e) => Boolean(e) && (e.code === "ai_timeout" || e.name === "AiTimeoutError" || e.name === "TimeoutError" || Number(e.status) === 529 || (Number(e.status) >= 500 && Number(e.status) < 600));
// Billed or possibly billed: keep the reservation. Known not billed (a guard stop, a 4xx that is not a rate limit): give it back.
const GUARD_CODES = ["OUTBOUND_IDENTIFIER_LEAK", "OUTBOUND_GUARD_CONFIG", "OUTBOUND_SECRET", "OUTBOUND_HOST"];
const notBilled = (e) => Boolean(e) && (GUARD_CODES.includes(e.code) || (Number(e.status) >= 400 && Number(e.status) < 500 && Number(e.status) !== 429 && Number(e.status) !== 408));

// Returns { answer, model, provider: "claude" } or { reason } (reason may be null: silent skip, e.g. no key configured).
// call: callAnthropicClaude from ai-models.js (injected: this file must not import it back).
// hardEndAt: absolute epoch ms the whole Claude hop must end by (the ask's start + its deadline - margin, from ai-models.js); the reservation writes count inside it.
// real: { system, user } when RESEARCH_NAMES is "real" (research/real-names.js): the prompt is sent with real names, no name guard and no tokenising; only the always-on
// protections run (host allow-list, secrets and ids, pings, fencing). Without it (tokenised mode) priv drives everything exactly as before, plus the same always-on protections.
export async function tryResearchClaude({ env, priv, deep, call, now = () => new Date(), hardEndAt = null, real = null }) { // real: { system, user, friend: [the asker's own typed text] }
  if (!anthropicAvailable(env)) return { reason: null };
  if (Date.now() < pausedUntil) return { reason: "claude:paused" };
  let sendSystem;
  let sendUser;
  let cleanReply;
  let roster = null;
  if (real) {
    try {
      ({ system: sendSystem, user: sendUser } = prepareRealPrompt(real, env, [], { friend: real.friend || [] }));
    } catch (e) { return { reason: guardReason(e) }; }
    if (sendSystem.length + sendUser.length > MAX_PROMPT_CHARS) return { reason: "cpu:budget" };
    cleanReply = (raw) => cleanRealReply(raw, env);
  } else {
    if (!priv || !priv.ok) return { reason: (priv && priv.reason) || "tokenise:error" };
    const g0 = performance.now();
    try {
      guardUserText(priv.userSegments, priv.roster);
      for (const seg of priv.partySegments) guardUserText([seg], priv.roster);
    } catch (e) { return { reason: guardReason(e) }; }
    if (priv.ms + (performance.now() - g0) > privacyBudget.ms || priv.system.length + priv.user.length > MAX_PROMPT_CHARS) return { reason: "cpu:budget" };
    sendSystem = defangPings(redactHex(priv.system)); // pings with trailing characters ("@everyonelol") pass the name guard, so they are defanged here in tokenised mode too
    sendUser = defangPings(redactHex(priv.user));
    roster = priv.roster;
    cleanReply = (raw) => { const r0 = redactHex(raw); return scanSecrets(r0, env, { ids: false }).length ? null : priv.clean(r0); }; // a secret in the reply stops it in both modes
  }

  const budgetStart = Date.now(); // the 9 s / 6 s budgets start here, so the reservation write is inside them
  const hardEnd = Number(hardEndAt) > 0 ? Number(hardEndAt) : Infinity;
  if (hardEnd - budgetStart < RETRY_MIN_MS) return { reason: "claude:no-time" };
  const at = now();
  const cap = monthlyTokenCap(env);
  const estimate = estimateTokens(sendSystem, sendUser);
  try {
    if (!(await reserveTokens(env, estimate, cap, at))) {
      await alertOnce(env, cap, at);
      return { reason: "claude:cap" };
    }
  } catch {
    pauseClaude(); // a counter that cannot be written must not let spend go unrecorded
    return { reason: "claude:counter-error" };
  }
  const settle = async (delta) => { try { await adjustTokens(env, delta, at); } catch { pauseClaude(); } };

  // Compose always runs on the deep (Sonnet-class) model; the ask's `deep` flag no longer picks the model here. The fast (Haiku-class) model is only the overload fallback.
  // At most 2 Anthropic sends per ask: compose, then ONE of (a) the 4.5 id of the same family on a model-not-found, or (b) the Haiku-class model on 529/5xx/timeout.
  const { primary, fallback } = researchClaudeModels(env, true);
  const { primary: fastModel } = researchClaudeModels(env, false);
  const deadlineAt = Math.min(budgetStart + CLAUDE_TIMEOUT_MS, hardEnd);
  const composeDeadlineAt = budgetStart + splitBudget(deadlineAt - budgetStart).compose; // compose never takes the retry's minimum: a compose timeout still leaves the Haiku-class retry its share
  if (composeDeadlineAt - Date.now() < RETRY_MIN_MS) {
    await settle(-estimate); // the reservation write ate the budget: no send is started that cannot finish; the unused reservation goes back
    return { reason: "claude:no-time" };
  }
  // The final body check. Tokenised mode keeps the cheap name guard; BOTH modes always scan for secrets and long ids (the key is passed in by callAnthropicClaude).
  const beforeSend = (body, secretKey) => {
    if (roster) guardBody(body, roster);
    guardSecretsInBody(body, env, secretKey ? [secretKey] : []);
  };
  // sent: the send in flight (or the last one), so a timeout says which one it was and how long it ran (failReason). The retry is capped at CLAUDE_RETRY_MAX_MS and never past the hop's end.
  let sent = null;
  const attempt = (modelOverride, stage = "retry", dl = stage === "retry" ? Math.min(deadlineAt, Date.now() + CLAUDE_RETRY_MAX_MS) : deadlineAt) => {
    sent = { stage, at: Date.now() };
    return call({ env, systemPrompt: sendSystem, userPrompt: sendUser, deep: true, skipCache: true, metadata: null, deadlineAt: dl, maxTokens: RESEARCH_MAX_TOKENS, modelOverride, wantUsage: true, beforeSend });
  };
  let res;
  try {
    try {
      res = await attempt(primary, "compose", composeDeadlineAt);
    } catch (e) {
      if (e && e.modelMissing === true && fallback && fallback !== primary && deadlineAt - Date.now() >= RETRY_MIN_MS) {
        res = await attempt(fallback); // same reservation: a model-not-found answer is not billed
      } else if (overloaded(e) && fastModel && fastModel !== primary && deadlineAt - Date.now() >= RETRY_MIN_MS) {
        // The failed compose send keeps its reservation (possibly billed). The retry reserves and settles its own estimate under the same cap and pause rules.
        try {
          if (!(await reserveTokens(env, estimate, cap, at))) {
            await alertOnce(env, cap, at);
            return { reason: "claude:cap" };
          }
        } catch {
          pauseClaude();
          return { reason: "claude:counter-error" };
        }
        if (deadlineAt - Date.now() < RETRY_MIN_MS) {
          // The reservation write itself ate the budget: do not start a send that cannot finish. Give the unused reservation back.
          await settle(-estimate);
          return { reason: failReason(e, sent) };
        }
        res = await attempt(fastModel);
      } else throw e;
    }
  } catch (e) {
    if (notBilled(e)) await settle(-estimate);
    if (e && GUARD_CODES.includes(e.code)) return { reason: guardReason(e) };
    return { reason: failReason(e, sent) };
  }
  await settle(usageTokens(res.usage, estimate) - estimate);
  const text = cleanReply(res.answer);
  if (text === null) return { reason: "claude:reply-flagged" };
  return { answer: text, model: res.model, provider: "claude" };
}

// ---- one capped call that is not an ask (the group-wiki refresher, research/group-wiki.js) ---------------------------------------------------------------
// The same spend guard as an ask, plus a sub-cap of 10% of the monthly cap in its own counter (subCounterKey): the estimate is RESERVED in the same kv_state counter against the same RESEARCH_CLAUDE_MONTHLY_TOKENS cap (one alert row per month when it is spent), the
// counter is settled on the real usage, a counter that cannot be written pauses Claude for 10 minutes, and the always-on outbound protections run over the final body (the host allow-list is
// in callAnthropicClaude; secrets and long ids here). One send on the fast (Haiku-class) model; the only second send is the 4.5 id after a model-not-found answer, which is not billed.
// Returns { answer, model } or { reason } with a short fixed code. call: callAnthropicClaude from ai-models.js (injected, as for tryResearchClaude).
export const CAPPED_TIMEOUT_MS = 30000;
export async function claudeCappedCall({ env, call, systemPrompt, userPrompt, maxTokens, now = () => new Date(), timeoutMs = CAPPED_TIMEOUT_MS, subCounter = subCounterKey }) { // subCounter: the caller's own sub-cap counter key (default: the group-wiki refresher's), so another caller cannot starve it
  if (typeof call !== "function") return { reason: "claude:no-call" };
  if (!anthropicAvailable(env)) return { reason: "claude:no-key" };
  if (Date.now() < pausedUntil) return { reason: "claude:paused" };
  const at = now();
  const cap = monthlyTokenCap(env);
  const estimate = Math.max(1, estimateTokens(systemPrompt, userPrompt) - RESEARCH_MAX_TOKENS + Math.max(1, Math.floor(maxTokens)));
  const subKey = subCounter(at);
  try {
    // The refresher's own sub-cap first (a tenth of the monthly cap), then the monthly cap itself; a reservation the second refuses is given back to the first.
    if (!(await reserveTokens(env, estimate, Math.floor(cap * SUBCAP_FRACTION), at, subKey))) return { reason: "claude:subcap" };
    if (!(await reserveTokens(env, estimate, cap, at))) {
      await adjustTokens(env, -estimate, at, subKey);
      await alertOnce(env, cap, at);
      return { reason: "claude:cap" };
    }
  } catch {
    pauseClaude();
    return { reason: "claude:counter-error" };
  }
  const settle = async (delta) => { try { await adjustTokens(env, delta, at); await adjustTokens(env, delta, at, subKey); } catch { pauseClaude(); } };
  const { primary, fallback } = researchClaudeModels(env, false);
  const deadlineAt = Date.now() + timeoutMs;
  const beforeSend = (body, secretKey) => guardSecretsInBody(body, env, secretKey ? [secretKey] : []);
  const attempt = (modelOverride) => call({ env, systemPrompt, userPrompt, deep: false, skipCache: true, metadata: null, deadlineAt, maxTokens, modelOverride, wantUsage: true, beforeSend });
  let res;
  try {
    try {
      res = await attempt(primary);
    } catch (e) {
      if (e && e.modelMissing === true && fallback && fallback !== primary) res = await attempt(fallback);
      else throw e;
    }
  } catch (e) {
    if (notBilled(e)) await settle(-estimate);
    if (e && GUARD_CODES.includes(e.code)) return { reason: guardReason(e) };
    return { reason: failReason(e) };
  }
  await settle(usageTokens(res.usage, estimate) - estimate);
  return { answer: String(res.answer ?? ""), model: res.model };
}
