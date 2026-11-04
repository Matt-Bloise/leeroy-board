// D1 feed (flag D1_FEED, default off): computes the public `stats` document from D1 for GET /api/data/stats, so the
// board's numbers follow Discord activity. `timeline` and `tonight` have no D1 source today (see the pull request), so
// their builders return the stored document unchanged and the route serves it exactly as it does with the flag off.
//
// "Static doc" below means the kv_state row of the same name (what GET /api/data/<name> serves today; seeded from data/<name>.json).
// Output is built from an allow list of the static keys, so nothing the stored row carries beyond the static shape
// (for example stats.recent, which holds question text) is ever copied into the computed document.
//
// D1 cost per recompute: 3 aggregate/bounded reads of ask_turns and lib_pages, 1 kv_state read of the static row,
// 1 kv_state read and 1 write of the cache row. The cache row (private key, "feed_" prefix) lives 5 minutes.

export const FEED_DOCS = ["stats", "timeline", "tonight"];
export const FEED_TTL_MS = 5 * 60 * 1000;
export const FEED_MISS_S = 900; // stats.miss_threshold_s in the static doc
export const FEED_WINDOW = 500; // newest answered turns read for median and p95
export const cacheKey = (name) => `feed_cache:${name}`;

export const SQL = {
  kv: "SELECT json, updated_at FROM kv_state WHERE key = ?",
  put: "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)",
  totals:
    "SELECT COUNT(CASE WHEN status = 'answered' THEN 1 END) AS replies, COUNT(CASE WHEN status = 'error' THEN 1 END) AS noreply, " +
    "COUNT(CASE WHEN status = 'answered' AND latency_ms > ? THEN 1 END) AS misses, MAX(CASE WHEN status = 'answered' THEN latency_ms END) AS max_ms FROM ask_turns",
  window:
    "SELECT latency_ms, answered_at FROM ask_turns WHERE status = 'answered' AND latency_ms IS NOT NULL ORDER BY created_at DESC LIMIT ?",
  wiki: "SELECT COUNT(*) AS n FROM lib_pages",
};

import { flagOn } from "./flags.js";

// Legacy [vars] reader, kept for tests and local use. The route uses feedOn (Flagship first, then this var).
export const feedEnabled = (env) => String((env && env.D1_FEED) || "").trim().toLowerCase() === "on";
export const feedOn = (env) => flagOn(env, "D1_FEED");
export const isFeedDoc = (name) => FEED_DOCS.includes(name);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const secs = (ms) => Math.round(num(ms) / 1000);

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))];
}

// rows: { totals: {replies, noreply, misses, max_ms}, window: [{latency_ms, answered_at}] newest first, wikiPages }.
// Computed: answers, replies, noreply, median_s, p95_s, max_s, misses, last7, wiki_pages, generated.
// Still static (copied from `base`): miss_threshold_s, wiki_facts, index_generated.
// last7.kind and last7.how are not stored in ask_turns; they are emitted as "mention" and "reply", the board's defaults.
export function buildStats(base, rows, nowIso) {
  if (!base || typeof base !== "object") throw new Error("stats: no static document to build on");
  const t = rows.totals || {};
  const win = (rows.window || []).filter((r) => Number.isFinite(Number(r.latency_ms)));
  const sorted = win.map((r) => secs(r.latency_ms)).sort((a, b) => a - b);
  const replies = num(t.replies);
  const noreply = num(t.noreply);
  return {
    generated: nowIso,
    answers: replies + noreply,
    replies,
    noreply,
    median_s: percentile(sorted, 0.5),
    p95_s: percentile(sorted, 0.95),
    max_s: secs(t.max_ms),
    miss_threshold_s: FEED_MISS_S,
    misses: num(t.misses),
    last7: win
      .slice(0, 7)
      .reverse()
      .map((r) => ({ closed_utc: String(r.answered_at || ""), seconds: secs(r.latency_ms), kind: "mention", how: "reply" })),
    wiki_pages: num(rows.wikiPages),
    wiki_facts: base.wiki_facts,
    index_generated: base.index_generated,
  };
}

// No D1 source for either document yet: identical to the stored document.
export const buildTimeline = (base) => structuredClone(base);
export const buildTonight = (base) => structuredClone(base);

const COMPUTED = new Set(["stats"]);

async function loadStats(env, base, nowIso) {
  const db = env.DB;
  const [totals, window, wiki] = await Promise.all([
    db.prepare(SQL.totals).bind(FEED_MISS_S * 1000).first(),
    db.prepare(SQL.window).bind(FEED_WINDOW).all(),
    db.prepare(SQL.wiki).first(),
  ]);
  return buildStats(base, { totals: totals || {}, window: (window && window.results) || [], wikiPages: wiki && wiki.n }, nowIso);
}

const warned = new Set();
export const resetFeedWarnings = () => warned.clear();

// Returns { json, updated_at } for GET /api/data/<name>, or null when the route should serve the stored document
// (document not computed from D1, or any error; the error is logged once per document per Worker instance).
export async function serveFeedDoc(env, name, nowMs = Date.now()) {
  if (!isFeedDoc(name) || !COMPUTED.has(name)) return null;
  try {
    const cached = await env.DB.prepare(SQL.kv).bind(cacheKey(name)).first();
    const at = cached ? Date.parse(cached.updated_at) : NaN;
    if (cached && typeof cached.json === "string" && Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < FEED_TTL_MS) {
      return { json: cached.json, updated_at: cached.updated_at };
    }
    const baseRow = await env.DB.prepare(SQL.kv).bind(name).first();
    const base = baseRow ? JSON.parse(baseRow.json) : null;
    const nowIso = new Date(nowMs).toISOString();
    const json = JSON.stringify(await loadStats(env, base, nowIso));
    await env.DB.prepare(SQL.put).bind(cacheKey(name), json, nowIso).run();
    return { json, updated_at: nowIso };
  } catch (e) {
    if (!warned.has(name)) {
      warned.add(name);
      console.error(`D1_FEED: ${name} fell back to the stored document:`, e && e.message);
    }
    return null;
  }
}
