// The one write path for a discord_members roster entry. POST /api/admin/members and the /member add command both call saveMember, so the
// validation, the slug and id rules, the kv_state write and the cache invalidation cannot drift apart. The caller has already done its own
// admin gate. Replies never echo other members.
import { upsertMember } from "./members.js";
import { invalidateConfigCache, validateConfigValue } from "./config.js";
import { updateKvJson, KvConflictError } from "./kv-cas.js";

// The largest entry the route has always taken (it was a raw body limit; a re-serialised entry is never larger than its body).
export const MEMBER_ENTRY_MAX_BYTES = 2000;

// Returns { ok: true, slug, entries } or { ok: false, status, error }. status is the HTTP status the route answers with.
// The write is a compare-and-set on the stored text (kv-cas.js), so two admins adding at the same moment cannot overwrite each other.
// noRebind (the /member command): an existing slug may only be updated for the same Discord id; a different or missing id answers
// { ok: false, status: 409, code: "taken" } judged on the row at write time. Rebinding a slug stays on the token-gated route.
export async function saveMember(env, entry, { noRebind = false } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, status: 400, error: "member must be an object" };
  if (new TextEncoder().encode(JSON.stringify(entry)).length > MEMBER_ENTRY_MAX_BYTES) return { ok: false, status: 413, error: "Body too large" };
  let out;
  try {
    out = await updateKvJson(env, "discord_members", (doc) => {
      const current = Array.isArray(doc) ? doc : [];
      if (noRebind) {
        const prior = current.find((m) => m && m.slug === entry.slug);
        if (prior && prior.id !== entry.id) return { skip: true, result: { ok: false, status: 409, code: "taken", error: "that name is already on the roster" } };
      }
      const result = upsertMember(current, entry);
      if (result.error) return { skip: true, result: { ok: false, status: 400, error: result.error } };
      const problem = validateConfigValue("discord_members", result.members);
      if (problem) return { skip: true, result: { ok: false, status: 400, error: problem } };
      return { doc: result.members, result: { ok: true, slug: entry.slug, entries: result.members.length } };
    });
  } catch (e) {
    if (e instanceof KvConflictError) return { ok: false, status: 409, error: "The roster changed at the same moment. Try again." };
    if (e instanceof SyntaxError) return { ok: false, status: 500, error: "Could not read the roster" };
    throw e;
  }
  if (out.result.ok) invalidateConfigCache("discord_members");
  return out.result;
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

// One append-only audit_log row per successful /member add: who ran it (actor column), which id was added (detail_json), the slug (target), when. No display name, no match text.
// audit_log.actor_discord_user_id is a foreign key to users, so it is filled only when the admin has a users row; the admin id is not repeated in detail_json.
// Returns true when the row was written.
export async function auditMemberAdd(env, { by, added, slug, at = new Date().toISOString() }) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) " +
      "VALUES (NULL, (SELECT discord_user_id FROM users WHERE discord_user_id = ?), 'member.add', ?, ?, ?)"
    ).bind(String(by), slug, JSON.stringify({ added: String(added) }), at).run();
    return true;
  } catch {
    return false;
  }
}
