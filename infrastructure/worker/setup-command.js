// /setup (Q43): a guild admin binds their Discord guild to a tenant. Behind env SETUP_COMMAND (default off).
// Writes only tables from migration 0002 (users, tenants, tenant_config, memberships, audit_log). No Blizzard data, no AI.
// Permission comes only from interaction.member.permissions, which Discord sets and signs; no option or client field is trusted.
// The tenants table has no created_by column, so the creator is recorded as the tenant's 'owner' membership and in audit_log.

export const SETUP_COMMAND_NAME = "setup";
export const CONFIG_KEY_ANNOUNCE = "announce_channel_id";
export const CONFIG_KEY_OPTIN_ROLE = "optin_role_id";

// Discord permission bits: ADMINISTRATOR (1 << 3) implies every other permission, MANAGE_GUILD is 1 << 5.
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_GUILD = 1n << 5n;
const SNOWFLAKE = /^\d{17,20}$/;

export const SETUP_COMMAND_DEFINITION = {
  name: SETUP_COMMAND_NAME,
  description: "Admins: connect this server to the board (only you see the answer)",
  default_member_permissions: String(PERM_MANAGE_GUILD),
  dm_permission: false,
  options: [
    { name: "announce_channel", description: "Channel for board announcements (optional)", type: 7, required: false },
    { name: "optin_role", description: "Role members can opt in to (optional)", type: 8, required: false },
  ],
};

export function setupCommandEnabled(env) {
  return ["1", "true", "on", "yes"].includes(String((env && env.SETUP_COMMAND) || "").trim().toLowerCase());
}

// The manifest served at GET /api/discord/commands: /setup is listed only while the flag is on.
export function manifestFor(env, baseManifest) {
  return setupCommandEnabled(env) ? [...baseManifest, SETUP_COMMAND_DEFINITION] : baseManifest;
}

export function isSnowflake(id) {
  return SNOWFLAKE.test(String(id || ""));
}

export function canManageGuild(permissions) {
  try {
    const p = BigInt(String(permissions == null ? "" : permissions));
    return (p & (PERM_MANAGE_GUILD | PERM_ADMINISTRATOR)) !== 0n;
  } catch {
    return false;
  }
}

export const SQL = {
  existing: "SELECT id, status FROM tenants WHERE discord_guild_id = ?",
  user:
    "INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(discord_user_id) DO UPDATE SET display_name = excluded.display_name",
  tenant:
    "INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?) " +
    "ON CONFLICT(discord_guild_id) DO UPDATE SET status = 'active' WHERE tenants.status != 'suspended'",
  config:
    "INSERT INTO tenant_config (tenant_id, key, value_json, updated_at) SELECT id, ?, ?, ? FROM tenants WHERE discord_guild_id = ? " +
    "ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
  membership:
    "INSERT INTO memberships (tenant_id, discord_user_id, role, status, joined_at) SELECT id, ?, ?, 'active', ? FROM tenants WHERE discord_guild_id = ? " +
    "ON CONFLICT(tenant_id, discord_user_id) DO UPDATE SET status = 'active'",
  audit:
    "INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) SELECT id, ?, 'tenant.setup', ?, ?, ? FROM tenants WHERE discord_guild_id = ?",
};

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn(msg);
}
export function resetSetupWarning() {
  warned = false;
}

const reply = (content) => ({ content, flags: 64 });

// Returns the ephemeral message data ({ content, flags: 64 }).
export async function runSetup(env, { interaction, discordUserId, displayName, boardUrl, now = new Date(), newId = () => crypto.randomUUID() }) {
  const guildId = String(interaction.guild_id || "");
  if (!isSnowflake(guildId) || !isSnowflake(discordUserId)) return reply("Run /setup inside a server, not in a DM.");
  if (!canManageGuild(interaction.member && interaction.member.permissions)) {
    return reply("Only people who can manage this server can run /setup. Ask a server admin to run it.");
  }
  const opts = (interaction.data && interaction.data.options) || [];
  const pick = (name) => {
    const o = opts.find((x) => x.name === name);
    return o && isSnowflake(o.value) ? String(o.value) : null;
  };
  const channelId = pick("announce_channel");
  const roleId = pick("optin_role");
  const at = now.toISOString();
  const link = `${String(boardUrl).replace(/\/+$/, "")}/`;

  try {
    const existing = await env.DB.prepare(SQL.existing).bind(guildId).first();
    if (existing && existing.status === "suspended") return reply("This server is suspended, so /setup can't change it. Contact the board owner.");
    const created = !existing;
    const tenantId = created ? newId() : existing.id;
    const stmts = [
      env.DB.prepare(SQL.user).bind(discordUserId, String(displayName || "").slice(0, 80) || null, at),
      env.DB.prepare(SQL.tenant).bind(tenantId, guildId, `Guild ${guildId}`, at),
    ];
    const saved = [];
    if (channelId) {
      stmts.push(env.DB.prepare(SQL.config).bind(CONFIG_KEY_ANNOUNCE, JSON.stringify(channelId), at, guildId));
      saved.push(`Announcements go to <#${channelId}>.`);
    }
    if (roleId) {
      stmts.push(env.DB.prepare(SQL.config).bind(CONFIG_KEY_OPTIN_ROLE, JSON.stringify(roleId), at, guildId));
      saved.push(`Opt-in role is <@&${roleId}>.`);
    }
    stmts.push(env.DB.prepare(SQL.membership).bind(discordUserId, created ? "owner" : "admin", at, guildId));
    stmts.push(
      env.DB.prepare(SQL.audit).bind(discordUserId, guildId, JSON.stringify({ created, announce_channel: Boolean(channelId), optin_role: Boolean(roleId) }), at, guildId)
    );
    await env.DB.batch(stmts);
    return reply(
      [
        created ? "This server is now connected to the board." : "Your server settings are updated.",
        ...(saved.length ? saved : ["No channel or role given, so nothing else was changed."]),
        `Board: ${link}`,
      ].join("\n")
    );
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) {
      warnOnce("setup-command: identity/tenancy tables are missing in D1 (migration 0002 not applied); replying with a friendly message");
      return reply("Setup isn't ready on this board yet. Try again later.");
    }
    console.error("setup-command: save failed", (e && e.message) || e);
    return reply("Setup could not be saved. Nothing was changed; try again in a moment.");
  }
}
