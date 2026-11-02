// Daily Workers AI neuron budget (soft cap). Pure helpers plus two small D1 helpers on kv_state.
// Free plan: 10,000 neurons per day, resets 00:00 UTC; past that Workers AI calls fail. We stop earlier.
// Every D1 touch here fails open: a budget error never blocks an answer.

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
export async function loadBudget(env, now = new Date()) {
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(keyFor(now)).first();
    if (!row) return empty();
    const b = JSON.parse(row.json);
    return { neurons: Number(b.neurons) || 0, asks: Number(b.asks) || 0, cron: Number(b.cron) || 0 };
  } catch {
    return empty();
  }
}

// ---- Per-user and per-tenant attribution (Q30) ----
// Sibling kv_state rows next to the global day record: ai_budget:<day>:user:<id> and ai_budget:<day>:tenant:<id>.
// Both start with the private "ai_budget:" prefix, so GET /api/data/<key> never serves them.
// Every function here is a no-op (null verdict, no writes) when no keys are given.

export const BUDGET_CODES = ["budget_user", "budget_tenant", "budget_global"];

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

async function loadRow(env, key, now) {
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(rowKey(now, key)).first();
    if (!row) return { neurons: 0, asks: 0 };
    const b = JSON.parse(row.json);
    return { neurons: Number(b.neurons) || 0, asks: Number(b.asks) || 0 };
  } catch {
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
export async function checkAskBudget(env, keys, caps, now = new Date()) {
  try {
    const retryAfter = secondsToUtcMidnight(now);
    const global = await loadBudget(env, now);
    if (overCap(global.neurons, dailyCap(env))) return { code: "budget_global", retryAfter };
    if (!keys) return null;
    const c = caps || resolveCaps(null);
    if (keys.tenantKey) {
      const t = await loadRow(env, keys.tenantKey, now);
      if (t.neurons >= (dailyCap(env) * c.tenantSharePct) / 100) return { code: "budget_tenant", retryAfter };
    }
    if (keys.userKey && !keys.guest) {
      const u = await loadRow(env, keys.userKey, now);
      if (u.asks >= c.userDailyAsks) return { code: "budget_user", retryAfter };
    }
    return null;
  } catch {
    return null;
  }
}

// Friendly ephemeral text for a verdict. Plain words, no ids.
export function budgetMessage(code) {
  if (code === "budget_user") return "You have used your questions for today. Leeroy is back at midnight UTC.";
  if (code === "budget_tenant") return "This server has used its share of today's questions so everyone gets a turn. Leeroy is back at midnight UTC.";
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
  try {
    const b = await loadBudget(env, now);
    b.neurons = Math.round((b.neurons + (Number(neurons) || 0)) * 100) / 100;
    if (kind === "cron") b.cron += 1;
    else b.asks += 1;
    await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
      .bind(keyFor(now), JSON.stringify(b), now.toISOString())
      .run();
  } catch {
    // fail open
  }
}
