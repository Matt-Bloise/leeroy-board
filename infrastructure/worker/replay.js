// Replay protection for signed Discord interactions. Discord signs each request but a captured one stays valid for as long as its
// timestamp is fresh, so the interaction id is recorded in discord_events (migration 0003) and a second delivery is refused.
// Only a hash of the payload is kept, never the payload. The row belongs to the guild's tenant, or to the reserved 'legacy' tenant
// (migration 0008) for a guild that never ran /setup and for direct messages.
import { sha256Hex } from "./crypto.js";

export const REPLAY_WINDOW_MS = 10 * 60 * 1000;
export const LEGACY_TENANT = "legacy";

export function replayCutoffIso(nowMs = Date.now()) {
  return new Date(nowMs - REPLAY_WINDOW_MS).toISOString();
}

// Returns "new" | "duplicate" | "skipped". "skipped" (no usable id, or the table is not there) never blocks: the signature and
// timestamp checks still apply, and a D1 hiccup must not take the bot down.
export async function recordInteraction(env, interaction, rawBody, nowMs = Date.now()) {
  const id = String((interaction && interaction.id) || "");
  if (!/^\d{17,20}$/.test(id)) return "skipped";
  try {
    const hash = await sha256Hex(String(rawBody || ""));
    const guild = String((interaction && interaction.guild_id) || "");
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO discord_events (id, tenant_id, kind, payload_hash, created_at) " +
        "SELECT ?, COALESCE((SELECT id FROM tenants WHERE discord_guild_id = ?), ?), ?, ?, ?"
    )
      .bind(id, guild, LEGACY_TENANT, `type_${Number(interaction.type) || 0}`, hash, new Date(nowMs).toISOString())
      .run();
    // D1 always reports meta.changes; 0 means the id was already there (INSERT OR IGNORE).
    return res && res.meta && res.meta.changes === 0 ? "duplicate" : "new";
  } catch (e) {
    console.error("replay record failed:", e && e.message);
    return "skipped";
  }
}

export async function purgeOldInteractions(env, nowMs = Date.now()) {
  try {
    await env.DB.prepare("DELETE FROM discord_events WHERE created_at < ?").bind(replayCutoffIso(nowMs)).run();
  } catch (e) {
    console.error("replay purge failed:", e && e.message);
  }
}
