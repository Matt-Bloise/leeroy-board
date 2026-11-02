import { isMemberId } from "./members.js";
import { validateSchedule as validateEventsSchedule } from "./scheduled-events.js";
import { validateSchedule as validateMomentsSchedule } from "./moments.js";

// Admin-only config rows that live only in D1 (kv_state), never in the repo: name_map, discord_members, discord_roster, ai_budget_caps, events_schedule (Discord scheduled events) and moments (the timed-post schedule; its run state, moments_state, is in the same table).
// Written by PUT /api/config/<key>; there is no GET route. Cached 60 s per isolate; PUT invalidates the cache.
// Every reader falls back to null when the row is missing, so an unseeded Worker refuses or no-ops safely.

export const CONFIG_KEYS = ["name_map", "discord_members", "discord_roster", "ai_budget_caps", "events_schedule", "moments"];
export const CONFIG_MAX_BYTES = 20000;

const TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { value, at }

export function invalidateConfigCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

export async function loadConfigKey(env, key) {
  if (!CONFIG_KEYS.includes(key)) return null;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(key).first();
    value = row ? JSON.parse(row.json) : null;
  } catch {
    value = null;
  }
  cache.set(key, { value, at: now });
  return value;
}

// Shape check used by PUT. Returns an error string, or null when valid.
export function validateConfigValue(key, value) {
  if (key === "name_map") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "name_map must be a JSON object";
    for (const [k, v] of Object.entries(value)) {
      if (!k || typeof v !== "string" || !v) return "name_map values must be non-empty strings";
    }
    return null;
  }
  if (key === "discord_members") {
    if (!Array.isArray(value)) return "discord_members must be a JSON array";
    for (const m of value) {
      if (!m || typeof m.slug !== "string" || typeof m.name !== "string" || !Array.isArray(m.match) || !m.match.every((t) => typeof t === "string" && t === t.toLowerCase())) {
        return "each member needs slug, name and a match array of lowercase strings";
      }
      if (m.id !== undefined && !isMemberId(m.id)) return "member id must be a numeric string of 17 to 20 digits";
    }
    return null;
  }
  if (key === "discord_roster") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "discord_roster must be a JSON object";
    if (value.guildId !== undefined && !isId(value.guildId)) return "guildId must be a digit string";
    for (const field of ["buildThreads", "libraryThreads"]) {
      const map = value[field];
      if (map === undefined) continue;
      if (!map || typeof map !== "object" || Array.isArray(map)) return `${field} must be a JSON object`;
      for (const [k, v] of Object.entries(map)) {
        if (!k || !isId(v)) return `${field} values must be digit strings`;
      }
    }
    for (const field of ["channels", "roles"]) {
      const map = value[field];
      if (map === undefined) continue;
      if (!map || typeof map !== "object" || Array.isArray(map)) return `${field} must be a JSON object`;
      for (const [k, v] of Object.entries(map)) {
        if (!k || !isId(v)) return `${field} values must be digit strings`;
      }
    }
    return null;
  }
  if (key === "events_schedule") return validateEventsSchedule(value);
  if (key === "moments") return validateMomentsSchedule(value);
  if (key === "ai_budget_caps") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "ai_budget_caps must be a JSON object";
    for (const k of Object.keys(value)) {
      if (k !== "userDailyAsks" && k !== "tenantSharePct") return "ai_budget_caps allows userDailyAsks and tenantSharePct only";
    }
    if (value.userDailyAsks !== undefined && !(Number.isInteger(value.userDailyAsks) && value.userDailyAsks >= 1 && value.userDailyAsks <= 10000)) return "userDailyAsks must be an integer from 1 to 10000";
    if (value.tenantSharePct !== undefined && !(typeof value.tenantSharePct === "number" && value.tenantSharePct > 0 && value.tenantSharePct <= 100)) return "tenantSharePct must be a number above 0 and at most 100";
    return null;
  }
  return "unknown key";
}

function isId(v) {
  return typeof v === "string" && /^[0-9]{5,25}$/.test(v);
}

// Pure helpers for the Discord handlers. Each returns a safe plain value when the roster row is missing.
// Library shelf entry: a link when the roster has the guild and thread id for that title, plain text otherwise.
export function libraryShelfLine(post, roster) {
  const threadId = roster?.libraryThreads?.[post.title];
  const guildId = roster?.guildId;
  const label = isId(threadId) && isId(guildId) ? `[${post.title}](https://discord.com/channels/${guildId}/${threadId})` : post.title;
  return `• ${label} (${post.short})`;
}

// Build thread mention for a roster entry, or null when no thread is configured.
export function buildThreadMention(person, roster) {
  const threadId = roster?.buildThreads?.[person.display];
  return isId(threadId) ? `<#${threadId}>` : null;
}

// kv_state rows that hold configuration or private working data. GET /api/data/<key> must never serve them:
// that route is public and serves any kv_state key. Exact keys plus prefixes; matching is case-insensitive.
const PRIVATE_EXACT = new Set(["persona", "name_map", "discord_members", "discord_roster", "ai_budget_caps", "events_schedule", "scheduled_events", "vocab", "votes:index", "feed_posts", "moments", "moments_state", "moments_shadow_state", "moments_ledger"]);
const PRIVATE_PREFIXES = ["ai_budget:", "vote:", "votes:", "feed_", "private:", "config:", "secret"];
export function isPrivateKvKey(key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return true;
  if (PRIVATE_EXACT.has(k)) return true;
  return PRIVATE_PREFIXES.some((p) => k.startsWith(p));
}
