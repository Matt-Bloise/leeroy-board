// /setup (Q43): drives infrastructure/worker/discord.js with the recorded fixtures and a stubbed D1, asserting the exact SQL.
// No network, no AI, no Blizzard calls. Snowflake-shaped ids are built at run time because fixture files must not contain any.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleDiscordInteraction, DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { SQL, resetSetupWarning, manifestFor, canManageGuild, SETUP_COMMAND_DEFINITION } from "../../infrastructure/worker/setup-command.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "discord");
const fx = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")).interaction;
const USER_ID = "1".repeat(18);
const GUILD_ID = "2".repeat(18);
const CHANNEL_ID = "3".repeat(18);
const ROLE_ID = "4".repeat(18);
const MANAGE_GUILD = "32";
const ADMINISTRATOR = "8";

function setup({ permissions = MANAGE_GUILD, options } = {}) {
  // permissions: pass null to leave the field out entirely
  const i = structuredClone(fx("cmd-setup.json"));
  i.guild_id = GUILD_ID;
  i.member.user.id = USER_ID;
  if (permissions === null) delete i.member.permissions;
  else i.member.permissions = permissions;
  if (options) i.data.options = options;
  return i;
}
const BOTH = [
  { name: "announce_channel", type: 7, value: CHANNEL_ID },
  { name: "optin_role", type: 8, value: ROLE_ID },
];

function stubDb({ existing = null, failWith = null } = {}) {
  const log = [];
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        log.push({ sql, args });
        if (failWith) throw new Error(failWith);
        return sql === SQL.existing ? existing : null;
      },
      _sql: () => sql,
      _args: () => args,
    };
    return stmt;
  };
  const batch = async (stmts) => {
    if (failWith) throw new Error(failWith);
    for (const s of stmts) log.push({ sql: s._sql(), args: s._args(), batched: true });
    return stmts.map(() => ({ success: true }));
  };
  return { prepare, batch, log };
}

const signer = createDiscordSigner();
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
test.after(() => {
  globalThis.fetch = realFetch;
});

async function run(interaction, envExtra = { SETUP_COMMAND: "1" }, db = stubDb()) {
  const env = { DB: db, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://board.test", ...envExtra };
  const res = await handleDiscordInteraction(signer.signedRequest(interaction), env, { waitUntil: () => {} }, "https://worker.test");
  const body = await res.json();
  db.log = db.log.filter((e) => /tenants|tenant_config|memberships|audit_log|INTO users/.test(e.sql)); // drops the roster config read every command makes
  return { body, db };
}

test("flag off: /setup is not available and writes nothing", async () => {
  const { body, db } = await run(setup({ options: BOTH }), {});
  assert.equal(body.type, 4);
  assert.equal(body.data.flags & 64, 64);
  assert.match(body.data.content, /isn't available/);
  assert.equal(db.log.length, 0);
});

test("non-admin gets a polite ephemeral refusal and nothing is written", async () => {
  for (const permissions of ["0", "2048", null, "not-a-number"]) {
    const { body, db } = await run(setup({ permissions, options: BOTH }));
    assert.equal(body.type, 4);
    assert.equal(body.data.flags & 64, 64);
    assert.match(body.data.content, /Only people who can manage this server/);
    assert.equal(db.log.length, 0, `no SQL for permissions=${permissions}`);
  }
});

test("permission check: MANAGE_GUILD and ADMINISTRATOR pass, others do not", () => {
  assert.equal(canManageGuild("32"), true);
  assert.equal(canManageGuild("8"), true);
  assert.equal(canManageGuild("2199023255551"), true);
  assert.equal(canManageGuild("16"), false);
  assert.equal(canManageGuild(""), false);
  assert.equal(canManageGuild(null), false);
});

test("admin, new guild: exact SQL, creator becomes owner, reply is ephemeral with a board link", async () => {
  const { body, db } = await run(setup({ options: BOTH }));
  assert.equal(body.type, 4);
  assert.equal(body.data.flags & 64, 64);
  assert.deepEqual(body.data.allowed_mentions, { parse: [] });
  assert.match(body.data.content, /now connected/);
  assert.ok(body.data.content.includes(`<#${CHANNEL_ID}>`) && body.data.content.includes(`<@&${ROLE_ID}>`));
  assert.ok(body.data.content.includes("Board: https://board.test/"));

  assert.deepEqual(db.log[0], { sql: "SELECT id, status FROM tenants WHERE discord_guild_id = ?", args: [GUILD_ID] });
  const [user, tenant, chan, role, mem, audit] = db.log.slice(1);
  assert.equal(user.sql, "INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(discord_user_id) DO UPDATE SET display_name = excluded.display_name");
  assert.deepEqual(user.args.slice(0, 2), [USER_ID, "Fixture Tester"]);
  assert.equal(
    tenant.sql,
    "INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?) ON CONFLICT(discord_guild_id) DO UPDATE SET status = 'active' WHERE tenants.status != 'suspended'"
  );
  assert.equal(tenant.args[1], GUILD_ID);
  assert.ok(tenant.args[0].length > 0);
  const CONFIG_SQL =
    "INSERT INTO tenant_config (tenant_id, key, value_json, updated_at) SELECT id, ?, ?, ? FROM tenants WHERE discord_guild_id = ? ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at";
  assert.equal(chan.sql, CONFIG_SQL);
  assert.deepEqual([chan.args[0], chan.args[1], chan.args[3]], ["announce_channel_id", JSON.stringify(CHANNEL_ID), GUILD_ID]);
  assert.equal(role.sql, CONFIG_SQL);
  assert.deepEqual([role.args[0], role.args[1], role.args[3]], ["optin_role_id", JSON.stringify(ROLE_ID), GUILD_ID]);
  assert.equal(
    mem.sql,
    "INSERT INTO memberships (tenant_id, discord_user_id, role, status, joined_at) SELECT id, ?, ?, 'active', ? FROM tenants WHERE discord_guild_id = ? ON CONFLICT(tenant_id, discord_user_id) DO UPDATE SET status = 'active'"
  );
  assert.deepEqual([mem.args[0], mem.args[1], mem.args[3]], [USER_ID, "owner", GUILD_ID]);
  assert.equal(
    audit.sql,
    "INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) SELECT id, ?, 'tenant.setup', ?, ?, ? FROM tenants WHERE discord_guild_id = ?"
  );
  assert.deepEqual([audit.args[0], audit.args[1], audit.args[4]], [USER_ID, GUILD_ID, GUILD_ID]);
  assert.equal(JSON.parse(audit.args[2]).created, true);
  assert.ok(db.log.every((e) => !/identities/.test(e.sql)));
});

test("ADMINISTRATOR without MANAGE_GUILD is accepted; no options writes no tenant_config", async () => {
  const { body, db } = await run(setup({ permissions: ADMINISTRATOR }));
  assert.match(body.data.content, /nothing else was changed/);
  assert.equal(db.log.filter((e) => /tenant_config/.test(e.sql)).length, 0);
});

test("idempotent: an existing tenant keeps its id, the creator is not re-owned, and the reply says updated", async () => {
  const { body, db } = await run(setup({ options: BOTH }), { SETUP_COMMAND: "1" }, stubDb({ existing: { id: "tenant-existing", status: "active" } }));
  assert.match(body.data.content, /updated/);
  const tenant = db.log.find((e) => /^INSERT INTO tenants/.test(e.sql));
  assert.equal(tenant.args[0], "tenant-existing");
  const mem = db.log.find((e) => /^INSERT INTO memberships/.test(e.sql));
  assert.equal(mem.args[1], "admin");
  assert.equal(JSON.parse(db.log.find((e) => /audit_log/.test(e.sql)).args[2]).created, false);
});

test("a suspended tenant is not reactivated", async () => {
  const { body, db } = await run(setup({ options: BOTH }), { SETUP_COMMAND: "1" }, stubDb({ existing: { id: "t", status: "suspended" } }));
  assert.match(body.data.content, /suspended/);
  assert.equal(db.log.length, 1, "only the lookup ran");
});

test("missing tables: friendly reply, nothing thrown, warns once", async () => {
  resetSetupWarning();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    for (let n = 0; n < 2; n++) {
      const { body } = await run(setup({ options: BOTH }), { SETUP_COMMAND: "1" }, stubDb({ failWith: "D1_ERROR: no such table: tenants" }));
      assert.equal(body.type, 4);
      assert.equal(body.data.flags & 64, 64);
      assert.match(body.data.content, /isn't ready/);
    }
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /migration 0002/);
});

test("non-snowflake option values are ignored and a DM (no guild) is refused", async () => {
  const opts = [{ name: "announce_channel", type: 7, value: "not-an-id" }];
  const { db } = await run(setup({ options: opts }));
  assert.equal(db.log.filter((e) => /tenant_config/.test(e.sql)).length, 0);
  const dm = setup({ options: BOTH });
  delete dm.guild_id;
  const r = await run(dm);
  assert.match(r.body.data.content, /inside a server/);
  assert.equal(r.db.log.length, 0);
});

test("manifest: /setup is listed only when the flag is on, and requires MANAGE_GUILD", () => {
  assert.equal(manifestFor({}, DISCORD_SLASH_COMMANDS_MANIFEST).some((c) => c.name === "setup"), false);
  assert.equal(DISCORD_SLASH_COMMANDS_MANIFEST.some((c) => c.name === "setup"), false);
  const on = manifestFor({ SETUP_COMMAND: "true" }, DISCORD_SLASH_COMMANDS_MANIFEST);
  assert.deepEqual(on.at(-1), SETUP_COMMAND_DEFINITION);
  assert.equal(SETUP_COMMAND_DEFINITION.default_member_permissions, "32");
  assert.equal(SETUP_COMMAND_DEFINITION.dm_permission, false);
  assert.deepEqual(SETUP_COMMAND_DEFINITION.options.map((o) => [o.name, o.type, o.required]), [["announce_channel", 7, false], ["optin_role", 8, false]]);
});
