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

// Is this Discord user in the guild? GET /guilds/{guild}/members/{user} with the bot token: a REST call that needs no privileged intent
// (only List Guild Members and the gateway member events do). Returns "in" (200), "absent" (404) or "unknown" (anything else: no token,
// 5xx, 403, 429, a network error or the timeout). The caller fails closed on "unknown". Never returns the response body.
export async function checkGuildMember(env, guildId, userId, { timeoutMs = 2000 } = {}) {
  if (!env.DISCORD_BOT_TOKEN || !/^[0-9]{5,25}$/.test(String(guildId || "")) || !/^[0-9]{17,20}$/.test(String(userId || ""))) return "unknown";
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await globalThis.fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: "GET",
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    await res.arrayBuffer().catch(() => {});
    return res.status === 200 ? "in" : res.status === 404 ? "absent" : "unknown";
  } catch {
    return "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The roster as stored right now (a fresh read, not the cache). Returns an array, or null when it cannot be read.
export async function readStoredMembers(env) {
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'discord_members'").first();
    const v = row && row.json ? JSON.parse(row.json) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return null;
  }
}

// One append-only audit_log row per successful /member add: who ran it, which id was added, the slug, when. No display name, no match text.
// audit_log.actor_discord_user_id is a foreign key to users, so it is filled only when the admin has a users row; the id is also kept in detail_json.
// Returns true when the row was written.
export async function auditMemberAdd(env, { by, added, slug, at = new Date().toISOString() }) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) " +
      "VALUES (NULL, (SELECT discord_user_id FROM users WHERE discord_user_id = ?), 'member.add', ?, ?, ?)"
    ).bind(String(by), slug, JSON.stringify({ by: String(by), added: String(added) }), at).run();
    return true;
  } catch {
    return false;
  }
}
