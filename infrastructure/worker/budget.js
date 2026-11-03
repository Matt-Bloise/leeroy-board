// Daily Workers AI neuron budget (soft cap). Pure helpers plus two small D1 helpers on kv_state.
// Free plan: 10,000 neurons per day, resets 00:00 UTC; past that Workers AI calls fail. We stop earlier.
// D1 touches here fail open (a budget error never blocks an answer), except for a Workers AI guest ask, which fails closed:
// checkAskBudget({ failClosed }) and reserveNeurons both report a read or write error so the caller can refuse.

import { loadConfigKey } from "./config.js";

export const DEFAULT_DAILY_CAP = 8000;
export const CRON_RESERVE = 1500;
export const DEFAULT_USER_DAILY_ASKS = 40; // member asks per user per UTC day (guests keep their own 2 per hour limit)
export const DEFAULT_TENANT_SHARE_PCT = 100; // one tenant may use at most this share of the soft cap
export const DEFAULT_TENANT = "default";

// Neurons per million tokens (Cloudflare Workers AI pricing). Unknown Workers AI models use the 70B rates.
const RATES = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 26668, output: 204805 },
};
const DEFAULT_RATE = RATES["@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

export function estimateNeurons(model, inputTokens, outputTokens) {
  const rate = RATES[model] || DEFAULT_RATE;
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  return (inTok * rate.input + outTok * rate.output) / 1e6;
}

export function tokensFromChars(n) {
  return Math.ceil(Math.max(0, Number(n) || 0) / 4);
}

export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function secondsToUtcMidnight(date = new Date()) {
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - date.getTime()) / 1000));
}

export function overCap(usedNeurons, cap, reserve = 0) {
  return (Number(usedNeurons) || 0) >= cap - reserve;
}

export function dailyCap(env) {
  const n = Number(env && env.AI_DAILY_NEURON_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

const keyFor = (now) => `ai_budget:${utcDayKey(now)}`;
const empty = () => ({ neurons: 0, asks: 0, cron: 0 });

// Returns { neurons, asks, cron } for the UTC day; zeros if absent or on any error.
export async function loadBudget(env, now = new Date(), { strict = false } = {}) {
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(keyFor(now)).first();
    if (!row) return empty();
    const b = JSON.parse(row.json);
    return { neurons: Number(b.neurons) || 0, asks: Number(b.asks) || 0, cron: Number(b.cron) || 0 };
  } catch (e) {
    if (strict) throw e;
    return empty();
  }
}

// ---- Per-user and per-tenant attribution (Q30) ----
// Sibling kv_state rows next to the global day record: ai_budget:<day>:user:<id> and ai_budget:<day>:tenant:<id>.
// Both start with the private "ai_budget:" prefix, so GET /api/data/<key> never serves them.
// Every function here is a no-op (null verdict, no writes) when no keys are given.

export const BUDGET_CODES = ["budget_user", "budget_tenant", "budget_global", "budget_unavailable"];
export const BUDGET_UNAVAILABLE_RETRY_SECONDS = 45; // a budget read/write error is an outage, not "out for the day"

const safeId = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);

// Stable, non-reversible key part for a raw id (Discord user id, guest address hash). Returns "" for an empty id.
export async function hashId(raw) {
  const text = String(raw || "");
  if (!text) return "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ask-budget:${text}`));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Builds { userKey, tenantKey, guest } for the budget parameter. userPart must already be a hash or slug.
export function askBudgetKeys({ userPart, tenantId, guest = false } = {}) {
  const u = safeId(userPart);
  if (!u) return null;
  return { userKey: `user:${guest ? "guest-" : ""}${u}`, tenantKey: `tenant:${safeId(tenantId) || DEFAULT_TENANT}`, guest: Boolean(guest) };
}

const rowKey = (now, key) => `${keyFor(now)}:${key}`;

async function loadRow(env, key, now, { strict = false } = {}) {
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(rowKey(now, key)).first();
    if (!row) return { neurons: 0, asks: 0 };
    const b = JSON.parse(row.json);
    return { neurons: Number(b.neurons) || 0, asks: Number(b.asks) || 0 };
  } catch (e) {
    if (strict) throw e;
    return { neurons: 0, asks: 0 };
  }
}

// Caps live in the private config row "ai_budget_caps": { userDailyAsks, tenantSharePct }. Bad or missing values use defaults.
export function resolveCaps(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const asks = Number(r.userDailyAsks);
  const pct = Number(r.tenantSharePct);
  return {
    userDailyAsks: Number.isFinite(asks) && asks >= 1 ? Math.floor(asks) : DEFAULT_USER_DAILY_ASKS,
    tenantSharePct: Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : DEFAULT_TENANT_SHARE_PCT,
  };
}

export async function loadAskCaps(env) {
  try {
    return resolveCaps(await loadConfigKey(env, "ai_budget_caps"));
  } catch {
    return resolveCaps(null);
  }
}

// Returns null when the ask may proceed, else { code, retryAfter }. Fails open on any error.
// keys: { userKey, tenantKey, guest } or null. With no keys only the global soft cap is checked (the old behaviour).
// opts.skipGlobal: leave out the global (Workers AI neurons) cap but still enforce the user and tenant caps.
// opts.failClosed: a read error refuses the ask (budget_global) instead of letting it through. Used for Workers AI guest asks.
export async function checkAskBudget(env, keys, caps, now = new Date(), { skipGlobal = false, failClosed = false } = {}) {
  const retryAfter = secondsToUtcMidnight(now);
  try {
    if (!skipGlobal) {
      const global = await loadBudget(env, now, { strict: failClosed });
      if (overCap(global.neurons, dailyCap(env))) return { code: "budget_global", retryAfter };
    }
    if (!keys) return null;
    const c = caps || resolveCaps(null);
    if (keys.tenantKey) {
      const t = await loadRow(env, keys.tenantKey, now, { strict: failClosed });
      if (t.neurons >= (dailyCap(env) * c.tenantSharePct) / 100) return { code: "budget_tenant", retryAfter };
    }
    if (keys.userKey && !keys.guest) {
      const u = await loadRow(env, keys.userKey, now);
      if (u.asks >= c.userDailyAsks) return { code: "budget_user", retryAfter };
    }
    return null;
  } catch {
    return failClosed ? { code: "budget_unavailable", retryAfter: BUDGET_UNAVAILABLE_RETRY_SECONDS } : null;
  }
}

// Friendly ephemeral text for a verdict. Plain words, no ids.
export function budgetMessage(code) {
  if (code === "budget_user") return "You have used your questions for today. Leeroy is back at midnight UTC.";
  if (code === "budget_tenant") return "This server has used its share of today's questions so everyone gets a turn. Leeroy is back at midnight UTC.";
  if (code === "budget_unavailable") return "Leeroy cannot check today's allowance right now. Try again in a minute.";
  return "Leeroy has used up today's questions. He is back at midnight UTC.";
}

// Adds an ask's cost to the user and tenant rows. Same lossy read-modify-write as the global record; fails open.
export async function recordAttributed(env, keys, neurons, now = new Date()) {
  if (!keys) return;
  for (const key of [keys.userKey, keys.tenantKey]) {
    if (!key) continue;
    try {
      const b = await loadRow(env, key, now);
      b.neurons = Math.round((b.neurons + (Number(neurons) || 0)) * 100) / 100;
      b.asks += 1;
      await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
        .bind(rowKey(now, key), JSON.stringify(b), now.toISOString())
        .run();
    } catch {
      // fail open
    }
  }
}

// kind: "ask" or "cron". Read-modify-write without a transaction: concurrent asks can lose an update,
// which is fine for a soft cap with 2000 neurons of headroom.
export async function recordUsage(env, kind, neurons, now = new Date()) {
  // One atomic add (no read-modify-replace), so it cannot wipe a reservation another request just made.
  const add = Math.max(0, Math.round((Number(neurons) || 0) * 100) / 100);
  const seed = JSON.stringify({ neurons: add, asks: kind === "cron" ? 0 : 1, cron: kind === "cron" ? 1 : 0 });
  const field = kind === "cron" ? "cron" : "asks";
  try {
    await env.DB.prepare(
      "INSERT INTO kv_state (key, json, updated_at) VALUES (?1, ?2, ?3) " +
        `ON CONFLICT(key) DO UPDATE SET json = json_set(kv_state.json, '$.neurons', ROUND(COALESCE(json_extract(kv_state.json, '$.neurons'), 0) + ?4, 2), '$.${field}', COALESCE(json_extract(kv_state.json, '$.${field}'), 0) + 1), updated_at = excluded.updated_at`
    )
      .bind(keyFor(now), seed, now.toISOString(), add)
      .run();
  } catch {
    // fail open
  }
}

// ---- Reserve, then reconcile (global Workers AI neuron record) ----
// The old flow read the day's total, called the model, then added the real cost afterwards: parallel asks all passed the same
// read and together overshot the cap. Now an estimated cost is added to the day's record BEFORE the call, in one statement that
// only succeeds while the total stays within the cap (the check and the add are one atomic UPDATE in D1), and the difference to
// the real cost is added afterwards. A failed call gives the whole reservation back.

// Cap for a kind: asks may use the whole soft cap; the cron sweep (and anything else) leaves CRON_RESERVE for asks.
export function capFor(env, kind) {
  return kind === "ask" ? dailyCap(env) : dailyCap(env) - CRON_RESERVE;
}

// Returns { ok: true, key } when reserved, { ok: false, over: true } when it would pass the cap, { ok: false, error: true } on a D1 error.
export async function reserveNeurons(env, kind, neurons, cap, now = new Date()) {
  const est = Math.max(0, Math.round((Number(neurons) || 0) * 100) / 100);
  try {
    if (est > cap) return { ok: false, over: true };
    const seed = JSON.stringify({ neurons: est, asks: 0, cron: 0 });
    const res = await env.DB.prepare(
      "INSERT INTO kv_state (key, json, updated_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET json = json_set(kv_state.json, '$.neurons', ROUND(COALESCE(json_extract(kv_state.json, '$.neurons'), 0) + ?4, 2)), updated_at = excluded.updated_at " +
        "WHERE COALESCE(json_extract(kv_state.json, '$.neurons'), 0) + ?4 <= ?5"
    )
      .bind(keyFor(now), seed, now.toISOString(), est, cap)
      .run();
    const changes = res && res.meta ? res.meta.changes : undefined;
    return changes === 0 ? { ok: false, over: true } : { ok: true, key: keyFor(now), reserved: est };
  } catch {
    return { ok: false, error: true };
  }
}

// Replaces a reservation with the real cost. counted: false gives the reservation back without counting an ask (the call failed).
// key is the reservation's own record key (reserveNeurons returns it), so a reservation made before 00:00 UTC settles against the same row.
export async function reconcileNeurons(env, kind, reserved, actual, { counted = true, key = null } = {}, now = new Date()) {
  const delta = Math.round(((Number(actual) || 0) - (Number(reserved) || 0)) * 100) / 100;
  const field = kind === "cron" ? "cron" : "asks";
  try {
    await env.DB.prepare(
      `UPDATE kv_state SET json = json_set(json, '$.neurons', MAX(0, ROUND(COALESCE(json_extract(json, '$.neurons'), 0) + ?1, 2)), '$.${field}', COALESCE(json_extract(json, '$.${field}'), 0) + ?2), updated_at = ?3 WHERE key = ?4`
    )
      .bind(delta, counted ? 1 : 0, now.toISOString(), key || keyFor(now))
      .run();
  } catch {
    // fail open: the reservation stays, which only makes the soft cap slightly more careful
  }
}
