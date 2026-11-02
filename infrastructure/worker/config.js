// Admin-only config rows that live only in D1 (kv_state), never in the repo: 'name_map' and 'discord_members'.
// Written by PUT /api/config/<key>; there is no GET route. Cached 60 s per isolate; PUT invalidates the cache.
// Every reader falls back to null when the row is missing, so an unseeded Worker refuses or no-ops safely.

export const CONFIG_KEYS = ["name_map", "discord_members"];
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
    }
    return null;
  }
  return "unknown key";
}
