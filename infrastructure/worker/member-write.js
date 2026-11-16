// The one write path for a discord_members roster entry. POST /api/admin/members and the /member add command both call saveMember, so the
// validation, the slug and id rules, the kv_state write and the cache invalidation cannot drift apart. The caller has already done its own
// admin gate. Replies never echo other members.
import { upsertMember } from "./members.js";
import { invalidateConfigCache, validateConfigValue } from "./config.js";

// The largest entry the route has always taken (it was a raw body limit; a re-serialised entry is never larger than its body).
export const MEMBER_ENTRY_MAX_BYTES = 2000;

// Returns { ok: true, slug, entries } or { ok: false, status, error }. status is the HTTP status the route answers with.
export async function saveMember(env, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, status: 400, error: "member must be an object" };
  if (new TextEncoder().encode(JSON.stringify(entry)).length > MEMBER_ENTRY_MAX_BYTES) return { ok: false, status: 413, error: "Body too large" };
  let current = [];
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'discord_members'").first();
    if (row && row.json) current = JSON.parse(row.json);
  } catch {
    return { ok: false, status: 500, error: "Could not read the roster" };
  }
  const result = upsertMember(Array.isArray(current) ? current : [], entry);
  if (result.error) return { ok: false, status: 400, error: result.error };
  const problem = validateConfigValue("discord_members", result.members);
  if (problem) return { ok: false, status: 400, error: problem };
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
    .bind("discord_members", JSON.stringify(result.members), now)
    .run();
  invalidateConfigCache("discord_members");
  return { ok: true, slug: entry.slug, entries: result.members.length };
}
