// /build modal (Q19): drives infrastructure/worker/discord.js with the recorded fixtures and a stubbed D1,
// and asserts the exact SQL. No network, no AI, no Blizzard calls. Snowflake-shaped ids are built here at run time
// because the fixture files must not contain any.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { SQL, resetBuildModalWarning, parseBuildSubmit, buildModalResponse } from "../../infrastructure/worker/build-modal.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "discord");
const fx = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")).interaction;
const USER_ID = "1".repeat(18);
const GUILD_ID = "2".repeat(18);
const TENANT_ID = "tenant-fixture";

const withIds = (interaction) => {
  const i = structuredClone(interaction);
  i.guild_id = GUILD_ID;
  i.member.user.id = USER_ID;
  return i;
};

const submit = (values) => {
  const i = withIds(fx("modal-submit.json"));
  i.data.custom_id = "build:modal";
  i.data.components = [
    ...["class", "race", "ruleset", "role"].map((k) => ({ type: 18, component: { type: 3, custom_id: k, values: [values[k]] } })),
    { type: 18, component: { type: 4, custom_id: "notes", value: values.notes } },
  ];
  return i;
};
const GOOD = { class: "Mage", race: "Gnome", ruleset: "Roleplay PvP", role: "DPS", notes: "frost, then arcane" };

function stubDb({ tenant = { id: TENANT_ID }, failWith = null } = {}) {
  const log = [];
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        log.push({ sql, args });
        if (failWith) throw new Error(failWith);
        if (sql === SQL.tenant) return tenant;
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
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
const patches = [];
globalThis.fetch = async (url, init) => {
  patches.push({ url: String(url), init });
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};
test.after(() => {
  globalThis.fetch = realFetch;
});

async function run(interaction, envExtra = {}, db = stubDb()) {
  patches.length = 0;
  const env = { DB: db, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://board.test", ...envExtra };
  const pending = [];
  const res = await handleDiscordInteraction(signer.signedRequest(interaction), env, { waitUntil: (p) => pending.push(p) }, "https://worker.test");
  await Promise.allSettled(pending);
  return { res, body: await res.json(), db };
}

test("BUILD_MODAL off: /build keeps the existing reply (type 4, ephemeral)", async () => {
  const { body } = await run(withIds(fx("cmd-build.json")));
  assert.equal(body.type, 4);
  assert.equal(body.data.flags & 64, 64);
});

test("BUILD_MODAL on: /build opens a modal with class, race, ruleset, role and a 1000 char notes input", async () => {
  const { body } = await run(withIds(fx("cmd-build.json")), { BUILD_MODAL: "1" });
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, "build:modal");
  assert.ok(body.data.components.length <= 5, "Discord allows 5 top-level modal components");
  const inner = body.data.components.map((c) => c.component);
  assert.deepEqual(inner.map((c) => c.custom_id), ["class", "race", "ruleset", "role", "notes"]);
  assert.deepEqual(inner[2].options.map((o) => o.value), ["Normal", "PvP", "Roleplay", "Roleplay PvP"]);
  assert.deepEqual(inner[3].options.map((o) => o.value), ["Tank", "Healer", "DPS"]);
  assert.equal(inner[4].type, 4);
  assert.equal(inner[4].max_length, 1000);
  assert.equal(inner[4].required, false);
  assert.deepEqual(buildModalResponse().data.components.length, 5);
});

test("BUILD_MODAL on with a non-snowflake id falls back to the existing reply", async () => {
  const { body } = await run(fx("cmd-build.json"), { BUILD_MODAL: "1" });
  assert.equal(body.type, 4);
});

test("modal submit: defers (type 5) then writes exact SQL and edits the reply with a board link", async () => {
  resetBuildModalWarning();
  const { body, db } = await run(submit(GOOD));
  assert.equal(body.type, 5);
  assert.equal(body.data.flags, 64);
  assert.equal(db.log.length, 4);
  assert.deepEqual(db.log[0], { sql: "SELECT id FROM tenants WHERE discord_guild_id = ? AND status = 'active'", args: [GUILD_ID] });
  const [u, c, b] = db.log.slice(1);
  assert.equal(u.sql, "INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(discord_user_id) DO UPDATE SET display_name = excluded.display_name");
  assert.deepEqual(u.args.slice(0, 2), [USER_ID, "Fixture Tester"]);
  assert.equal(
    c.sql,
    "INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, class, spec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET class = excluded.class"
  );
  assert.deepEqual(c.args.slice(0, 7), [`${TENANT_ID}:${USER_ID}`, TENANT_ID, USER_ID, USER_ID, "unset", "us", "Mage"]);
  assert.equal(
    b.sql,
    "INSERT INTO builds (id, character_id, source, status, title, data_json, created_at, confirmed_at) VALUES (?, ?, 'modal', 'confirmed', ?, ?, ?, ?)"
  );
  assert.equal(b.args[1], `${TENANT_ID}:${USER_ID}`);
  assert.equal(b.args[2], "Mage DPS (Roleplay PvP)");
  assert.deepEqual(JSON.parse(b.args[3]), { class: "Mage", race: "Gnome", faction: "Alliance", ruleset: "Roleplay PvP", role: "DPS", notes: "frost, then arcane" });
  assert.equal(b.args[4], b.args[5], "confirmed_at is set with created_at");
  assert.ok(db.log.every((e) => !/identities/.test(e.sql)), "identities is attach-only and never gets a Discord row");

  assert.equal(patches.length, 1);
  assert.match(patches[0].url, /\/webhooks\/fixture-app-0001\/fixture-token-not-real\/messages\/@original$/);
  assert.equal(patches[0].init.method, "PATCH");
  const edit = JSON.parse(patches[0].init.body);
  assert.equal(edit.content, "Saved. Open your sheet");
  assert.deepEqual(edit.components[0].components[0], { type: 2, style: 5, label: "Open your sheet", url: "https://board.test/#five" });
});

test("modal submit with missing identity tables falls back to the existing behaviour and warns once", async () => {
  resetBuildModalWarning();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    for (let n = 0; n < 2; n++) {
      const { body } = await run(submit(GOOD), {}, stubDb({ failWith: "D1_ERROR: no such table: tenants" }));
      assert.equal(body.type, 5);
    }
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warns.length, 1, "logged once");
  assert.match(warns[0], /migration 0002/);
  const edit = JSON.parse(patches[0].init.body);
  assert.doesNotMatch(edit.content, /^Saved/);
  assert.equal(edit.components, undefined);
});

test("modal submit for a guild with no tenant row writes nothing", async () => {
  resetBuildModalWarning();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const { db } = await run(submit(GOOD), {}, stubDb({ tenant: null }));
    assert.equal(db.log.length, 1, "only the tenant lookup ran");
  } finally {
    console.warn = realWarn;
  }
});

test("parseBuildSubmit rejects unknown values and clamps notes to 1000", () => {
  const rows = (v) => Object.entries(v).map(([custom_id, value]) => ({ type: 1, components: [{ type: custom_id === "notes" ? 4 : 3, custom_id, ...(custom_id === "notes" ? { value } : { values: [value] }) }] }));
  assert.equal(parseBuildSubmit(rows({ ...GOOD, class: "Death Knight" })).ok, false);
  assert.equal(parseBuildSubmit(rows({ ...GOOD, role: "Support" })).ok, false);
  const ok = parseBuildSubmit(rows({ ...GOOD, notes: "x".repeat(1500) }));
  assert.equal(ok.ok, true);
  assert.equal(ok.build.notes.length, 1000);
});
