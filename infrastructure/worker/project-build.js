// Lands one confirmed /build submit on the board's data (flag BUILD_PROJECT). The plan itself is pure and lives in projection.js;
// this file does the D1 reads and the ONE atomic env.DB.batch, then the same cache purge and live broadcast PUT /data/party does.
//
// Writes, all in one batch (D1 batches are a single transaction, so a failure leaves nothing behind):
//   tenants       idempotent upsert for the configured guild (discord_roster.guildId); no D1 console is needed to create it
//   users, characters, builds   the model-B rows, same statements as saveConfirmedBuild (characters.name = the handle)
//   kv_state discord_members    the roster entry (id -> slug and name), through upsertMember
//   kv_state party              the party document with this person's card added or refreshed
// Never touched: member keys (the members table), name_map, any secret, any AI code.
import { planProjection } from "./projection.js";
import { SQL as BUILD_SQL, buildTitle, cleanHandle, isSnowflake } from "./build-modal.js";
import { SQL as SETUP_SQL } from "./setup-command.js";
import { upsertMember } from "./members.js";
import { PARTY_MEMBERS } from "./party-source.js";
import { slugify } from "./member-model.js";
import { validateConfigValue, loadConfigKey, invalidateConfigCache } from "./config.js";

export const SQL = {
  tenantRow: "SELECT id, status FROM tenants WHERE discord_guild_id = ?",
  tenant: SETUP_SQL.tenant, // INSERT ... ON CONFLICT(discord_guild_id) DO UPDATE SET status = 'active' WHERE tenants.status != 'suspended'
  kvRead: "SELECT json, updated_at FROM kv_state WHERE key = ?",
  // Compare-and-swap: replace a document only if nobody wrote it since we read it (updated_at unchanged); a row that did not exist is created only if still absent.
  kvCas: "UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND updated_at = ?",
  kvCreate: "INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
};

const SAFE = "Not saved. Nothing was changed; try again in a moment.";

// Words for the person. planProjection's own strings stay as the reviewed plan wrote them; only the one that is a bare hand-off is expanded.
function say(error) {
  if (error === "ask an admin") return "You are already on the board under a different handle. Ask an admin to rename you.";
  return `Not saved: ${error}.`;
}

async function readDoc(env, key) {
  const row = await env.DB.prepare(SQL.kvRead).bind(key).first();
  if (!row || !row.json) return { doc: null, at: null };
  return { doc: JSON.parse(row.json), at: row.updated_at };
}

// Result: { ok: true, slug, created, duplicate, partyDoc } | { ok: false, reason, message }.
// `after` runs only once the batch has committed: ({ partyDoc }) => cache purge and broadcast. Its failure never turns a saved build into "not saved".
export async function projectBuild(env, { discordUserId, displayName, guildId, handle, build, now = new Date(), newId = () => crypto.randomUUID(), after } = {}) {
  const refuse = (reason, message) => ({ ok: false, reason, message });
  try {
    if (!isSnowflake(discordUserId) || !isSnowflake(guildId)) return refuse("bad-user", "Not saved: I can't tell who or where you are.");
    const roster = await loadConfigKey(env, "discord_roster");
    if (!roster || String(roster.guildId || "") !== String(guildId)) return refuse("wrong-guild", "Not saved: this server is not connected to the board.");

    // Fresh reads, never the 60 s config cache: the plan must see the roster and party exactly as the batch will replace them.
    const [tenant, partyRead, membersRead] = await Promise.all([
      env.DB.prepare(SQL.tenantRow).bind(String(guildId)).first(),
      readDoc(env, "party"),
      readDoc(env, "discord_members"),
    ]);
    const partyDoc = partyRead.doc, members = membersRead.doc;
    if (tenant && tenant.status === "suspended") return refuse("suspended", "Not saved: this server is suspended.");
    if (!partyDoc || !Array.isArray(partyDoc.members)) return refuse("no-party", "Not saved: the party document is missing on this board.");
    const rosterList = Array.isArray(members) ? members : [];

    const plan = planProjection({ handle, build, discordUserId, partyDoc, roster: rosterList, reservedSlugs: PARTY_MEMBERS.map((m) => slugify(String(m.name))) });
    if (!plan.ok) return refuse("plan", say(plan.error));

    const up = upsertMember(rosterList, plan.rosterEntry);
    if (up.error) return refuse("plan", say(up.error));
    const problem = validateConfigValue("discord_members", up.members);
    if (problem) return refuse("plan", say(problem));

    const lower = plan.partyEntry.name.toLowerCase();
    const has = partyDoc.members.some((m) => String(m.name).toLowerCase() === lower);
    const nextParty = {
      ...partyDoc,
      members: has ? partyDoc.members.map((m) => (String(m.name).toLowerCase() === lower ? plan.partyEntry : m)) : [...partyDoc.members, plan.partyEntry],
    };

    const at = now.toISOString();
    const created = !tenant;
    const tenantId = created ? newId() : tenant.id;
    const characterId = `${tenantId}:${discordUserId}`;
    const name = cleanHandle(handle);
    // Roster first, party second: if one compare-and-swap loses a race, a retry converges (the roster entry alone does not block the same person).
    const rosterStmt = membersRead.at
      ? env.DB.prepare(SQL.kvCas).bind(JSON.stringify(up.members), at, "discord_members", membersRead.at)
      : env.DB.prepare(SQL.kvCreate).bind("discord_members", JSON.stringify(up.members), at);
    const partyStmt = env.DB.prepare(SQL.kvCas).bind(JSON.stringify(nextParty), at, "party", partyRead.at);
    const results = await env.DB.batch([
      env.DB.prepare(SQL.tenant).bind(tenantId, String(guildId), `Guild ${guildId}`, at),
      env.DB.prepare(BUILD_SQL.user).bind(String(discordUserId), String(displayName || "").slice(0, 80) || null, at),
      env.DB.prepare(BUILD_SQL.character).bind(characterId, tenantId, String(discordUserId), name, "unset", "us", build.class, at),
      env.DB.prepare(BUILD_SQL.build).bind(newId(), characterId, buildTitle(build), JSON.stringify(build), at, at),
      rosterStmt,
      partyStmt,
    ]);
    // A lost race writes 0 rows. (A result without meta.changes is a stub; real D1 always reports it.)
    const lost = (r) => r && r.meta && typeof r.meta.changes === "number" && r.meta.changes !== 1;
    if (lost(results[4]) || lost(results[5])) {
      console.error("build-project: the board changed while saving; asked the person to try again");
      return refuse("conflict", "Not saved: the board changed at the same moment. Try again in a moment.");
    }

    invalidateConfigCache("discord_members");
    if (after) {
      try {
        await after({ partyDoc: nextParty });
      } catch (e) {
        console.error("build-project: purge or broadcast failed after a successful save", (e && e.message) || e);
      }
    }
    return { ok: true, slug: plan.slug, created, duplicate: plan.duplicate, partyDoc: nextParty };
  } catch (e) {
    console.error("build-project: save failed, nothing was written", (e && e.message) || e);
    return refuse("error", SAFE);
  }
}
