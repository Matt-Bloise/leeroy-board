// /build modal (Q19): payload, submit parsing and the D1 write. Pure apart from saveConfirmedBuild(), which takes env.DB.
// Writes only tables from migration 0002 (users, tenants, characters, builds). Nothing here calls Blizzard or an AI.

export const BUILD_MODAL_ID = "build:modal";
export const NOTES_MAX = 1000;

export const CLASSES = ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Shaman", "Mage", "Warlock", "Druid"];
export const FACTION_OF_RACE = {
  Human: "Alliance",
  Dwarf: "Alliance",
  "Night Elf": "Alliance",
  Gnome: "Alliance",
  Orc: "Horde",
  Undead: "Horde",
  Tauren: "Horde",
  Troll: "Horde",
};
export const RACES = Object.keys(FACTION_OF_RACE);
export const RULESETS = ["Normal", "PvP", "Roleplay", "Roleplay PvP"];
export const ROLES = ["Tank", "Healer", "DPS"];

const SNOWFLAKE = /^\d{17,20}$/;

export function buildModalEnabled(env) {
  return ["1", "true", "on", "yes"].includes(String((env && env.BUILD_MODAL) || "").trim().toLowerCase());
}

export function isSnowflake(id) {
  return SNOWFLAKE.test(String(id || ""));
}

const select = (custom_id, label, values) => ({
  type: 18,
  label,
  component: { type: 3, custom_id, placeholder: label, min_values: 1, max_values: 1, options: values.map((v) => ({ label: v, value: v })) },
});

// Discord allows 5 top-level modal components, so faction is not asked: it follows from the race.
export function buildModalResponse() {
  return {
    type: 9,
    data: {
      custom_id: BUILD_MODAL_ID,
      title: "Your build",
      components: [
        select("class", "Class", CLASSES),
        select("race", "Race (sets your faction)", RACES),
        select("ruleset", "Ruleset", RULESETS),
        select("role", "Role", ROLES),
        {
          type: 18,
          label: "Notes",
          component: { type: 4, custom_id: "notes", style: 2, required: false, max_length: NOTES_MAX, placeholder: "Talents, plans, anything to remember" },
        },
      ],
    },
  };
}

// Flatten a modal-submit component tree (action rows or labels) into { custom_id: value }.
export function readModalValues(components) {
  const out = {};
  const walk = (c) => {
    if (!c || typeof c !== "object") return;
    if (c.custom_id && c.type !== 1 && c.type !== 18) {
      if (Array.isArray(c.values)) out[c.custom_id] = c.values[0];
      else if (typeof c.value === "string") out[c.custom_id] = c.value;
    }
    if (Array.isArray(c.components)) c.components.forEach(walk);
    if (c.component) walk(c.component);
  };
  (components || []).forEach(walk);
  return out;
}

// Returns { ok: true, build } or { ok: false, error }.
export function parseBuildSubmit(components) {
  const v = readModalValues(components);
  if (!CLASSES.includes(v.class)) return { ok: false, error: "Pick a class." };
  if (!RACES.includes(v.race)) return { ok: false, error: "Pick a race." };
  if (!RULESETS.includes(v.ruleset)) return { ok: false, error: "Pick a ruleset." };
  if (!ROLES.includes(v.role)) return { ok: false, error: "Pick a role." };
  return {
    ok: true,
    build: {
      class: v.class,
      race: v.race,
      faction: FACTION_OF_RACE[v.race],
      ruleset: v.ruleset,
      role: v.role,
      notes: String(v.notes || "").slice(0, NOTES_MAX),
    },
  };
}

export const SQL = {
  tenant: "SELECT id FROM tenants WHERE discord_guild_id = ? AND status = 'active'",
  user:
    "INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(discord_user_id) DO UPDATE SET display_name = excluded.display_name",
  character:
    "INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, class, spec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) " +
    "ON CONFLICT(id) DO UPDATE SET class = excluded.class",
  build:
    "INSERT INTO builds (id, character_id, source, status, title, data_json, created_at, confirmed_at) " +
    "VALUES (?, ?, 'modal', 'confirmed', ?, ?, ?, ?)",
};

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn(msg);
}
export function resetBuildModalWarning() {
  warned = false;
}

// Result: { saved: true, buildId } or { saved: false, reason: "no-tables" | "no-tenant" | "bad-user" | "error" }.
// The identities table is attach-only (battlenet, twitch, google, github) and never holds Discord itself,
// so the Discord user id is recorded in users only.
export async function saveConfirmedBuild(env, { discordUserId, displayName, guildId, build, now = new Date(), newId = () => crypto.randomUUID() }) {
  if (!isSnowflake(discordUserId) || !isSnowflake(guildId)) return { saved: false, reason: "bad-user" };
  try {
    const tenant = await env.DB.prepare(SQL.tenant).bind(String(guildId)).first();
    if (!tenant || !tenant.id) {
      warnOnce("build-modal: no active tenant row for this guild; using the legacy /build reply");
      return { saved: false, reason: "no-tenant" };
    }
    const at = now.toISOString();
    const characterId = `${tenant.id}:${discordUserId}`;
    const buildId = newId();
    const title = `${build.class} ${build.role} (${build.ruleset})`;
    await env.DB.batch([
      env.DB.prepare(SQL.user).bind(String(discordUserId), String(displayName || "").slice(0, 80) || null, at),
      env.DB.prepare(SQL.character).bind(characterId, tenant.id, String(discordUserId), String(discordUserId), "unset", "us", build.class, at),
      env.DB.prepare(SQL.build).bind(buildId, characterId, title, JSON.stringify(build), at, at),
    ]);
    return { saved: true, buildId };
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) {
      warnOnce("build-modal: identity/tenancy tables are missing in D1 (migration 0002 not applied); using the legacy /build reply");
      return { saved: false, reason: "no-tables" };
    }
    console.error("build-modal: save failed", (e && e.message) || e);
    return { saved: false, reason: "error" };
  }
}
