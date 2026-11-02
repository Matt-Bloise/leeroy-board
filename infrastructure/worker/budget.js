// Daily Workers AI neuron budget (soft cap). Pure helpers plus two small D1 helpers on kv_state.
// Free plan: 10,000 neurons per day, resets 00:00 UTC; past that Workers AI calls fail. We stop earlier.
// Every D1 touch here fails open: a budget error never blocks an answer.

export const DEFAULT_DAILY_CAP = 8000;
export const CRON_RESERVE = 1500;

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
