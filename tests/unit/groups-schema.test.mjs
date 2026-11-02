// Loads infrastructure/schema.sql (and the 0003 migration on top) into in-memory SQLite and probes every CHECK, FK and
// ON DELETE rule of groups, group_slots, signups_v2, entitlements and discord_events with bad rows. No network, no D1, no AI.
// Run: node --test tests/unit/groups-schema.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SCHEMA = read("../../infrastructure/schema.sql");
const MIGRATION = read("../../infrastructure/migrations/0003_groups_signups_entitlements.sql");

const U = "100000000000000001", G = "200000000000000001";
const NOW = "2026-01-01T00:00:00Z";
const HASH = "b".repeat(64);
const E1 = "300000000000000001";
const NEW = ["groups", "group_slots", "signups_v2", "entitlements", "discord_events"];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec("INSERT INTO users (discord_user_id, created_at) VALUES ('" + U + "', '" + NOW + "')");
  db.exec("INSERT INTO tenants (id, discord_guild_id, name, created_at) VALUES ('t1', '" + G + "', 'Guild', '" + NOW + "')");
  db.exec("INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, created_at) VALUES ('c1', 't1', '" + U + "', 'Nm', 'Realm', 'eu', '" + NOW + "')");
  db.exec("INSERT INTO groups (id, tenant_id, name, kind, size, created_at) VALUES ('g1', 't1', 'Run', 'dungeon', 5, '" + NOW + "')");
  return db;
}
const count = (db, table) => db.prepare("SELECT count(*) AS n FROM " + table).get().n;
const FK = /FOREIGN KEY constraint failed/i, UNIQUE = /UNIQUE constraint failed/i, CHECK = /CHECK constraint failed/i, NOTNULL = /NOT NULL constraint failed/i;
const rejects = (db, sql, params, re) => assert.throws(() => db.prepare(sql).run(...params), re, sql);
const accepts = (db, sql, params = []) => db.prepare(sql).run(...params);
const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);

test("schema.sql has the new tables; migration is idempotent on top and builds after 0002 alone", () => {
  const db = freshDb();
  db.exec(MIGRATION);
  for (const t of NEW) assert.ok(tableNames(db).includes(t), t);
  const alone = new DatabaseSync(":memory:");
  alone.exec(read("../../infrastructure/migrations/0002_identity_tenancy.sql"));
  alone.exec(MIGRATION);
  for (const t of NEW) assert.ok(tableNames(alone).includes(t), t);
});

test("groups: kind in set, size 1 to 40, name and id non-empty, tenant must exist", () => {
  const db = freshDb();
  const sql = "INSERT INTO groups (id, tenant_id, name, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)";
  rejects(db, sql, ["g2", "t1", "N", "party", 5, NOW], CHECK);
  rejects(db, sql, ["g2", "t1", "N", "raid", 0, NOW], CHECK);
  rejects(db, sql, ["g2", "t1", "N", "raid", 41, NOW], CHECK);
  rejects(db, sql, ["g2", "t1", "", "raid", 5, NOW], CHECK);
  rejects(db, sql, ["", "t1", "N", "raid", 5, NOW], CHECK);
  rejects(db, sql, ["g2", "nope", "N", "raid", 5, NOW], FK);
  rejects(db, sql, ["g2", "t1", "N", "raid", null, NOW], NOTNULL);
  accepts(db, sql, ["g2", "t1", "N", "raid", 40, NOW]);
  accepts(db, sql, ["g3", "t1", "N", "social", 1, NOW]);
});

test("group_slots: role and status in set, index 0 to 39, open seat has no character, FKs, unique seat", () => {
  const db = freshDb();
  const sql = "INSERT INTO group_slots (group_id, slot_index, role, character_id, status) VALUES (?, ?, ?, ?, ?)";
  rejects(db, sql, ["g1", 0, "wizard", null, "open"], CHECK);
  rejects(db, sql, ["g1", 0, "tank", null, "taken"], CHECK);
  rejects(db, sql, ["g1", -1, "tank", null, "open"], CHECK);
  rejects(db, sql, ["g1", 40, "tank", null, "open"], CHECK);
  rejects(db, sql, ["g1", 0, "tank", "c1", "open"], CHECK);
  rejects(db, sql, ["nope", 0, "tank", null, "open"], FK);
  rejects(db, sql, ["g1", 0, "tank", "nope", "filled"], FK);
  accepts(db, sql, ["g1", 0, "tank", "c1", "filled"]);
  rejects(db, sql, ["g1", 0, "dps", null, "open"], UNIQUE);
  accepts(db, sql, ["g1", 1, "healer", null, "open"]);
  accepts(db, sql, ["g1", 2, "dps", "c1", "bench"]);
});

test("signups_v2: rsvp in set, one row per group and user, FKs", () => {
  const db = freshDb();
  const sql = "INSERT INTO signups_v2 (group_id, user_id, character_id, rsvp, updated_at) VALUES (?, ?, ?, ?, ?)";
  rejects(db, sql, ["g1", U, null, "perhaps", NOW], CHECK);
  rejects(db, sql, ["nope", U, null, "yes", NOW], FK);
  rejects(db, sql, ["g1", "100000000000000009", null, "yes", NOW], FK);
  rejects(db, sql, ["g1", U, "nope", "yes", NOW], FK);
  accepts(db, sql, ["g1", U, "c1", "yes", NOW]);
  rejects(db, sql, ["g1", U, null, "no", NOW], UNIQUE);
  accepts(db, "INSERT INTO users (discord_user_id, created_at) VALUES ('100000000000000002', ?)", [NOW]);
  accepts(db, sql, ["g1", "100000000000000002", null, "maybe", NOW]);
});

test("entitlements: status and source in set, plan non-empty, tenant must exist", () => {
  const db = freshDb();
  const sql = "INSERT INTO entitlements (tenant_id, plan, status, source, current_period_end, created_at) VALUES (?, ?, ?, ?, ?, ?)";
  rejects(db, sql, ["t1", "", "active", "manual", null, NOW], CHECK);
  rejects(db, sql, ["t1", "pro", "paused", "manual", null, NOW], CHECK);
  rejects(db, sql, ["t1", "pro", "active", "gift", null, NOW], CHECK);
  rejects(db, sql, ["nope", "pro", "active", "manual", null, NOW], FK);
  rejects(db, sql, ["t1", "pro", "active", "processor", "2026-02-01T00:00:00Z", NOW], CHECK);
  accepts(db, sql, ["t1", "pro", "canceled", "manual", null, NOW]);
});

test("entitlements: processor rows need a unique processor_event_id; manual rows may leave it NULL (repeatedly)", () => {
  const db = freshDb();
  const sql = "INSERT INTO entitlements (tenant_id, plan, status, source, processor_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)";
  rejects(db, sql, ["t1", "pro", "active", "processor", null, NOW], CHECK);
  accepts(db, sql, ["t1", "pro", "active", "processor", "evt_1", NOW]);
  rejects(db, sql, ["t1", "pro", "active", "processor", "evt_1", NOW], UNIQUE);
  accepts(db, sql, ["t1", "pro", "active", "processor", "evt_2", NOW]);
  accepts(db, sql, ["t1", "pro", "active", "manual", null, NOW]);
  accepts(db, sql, ["t1", "pro", "active", "manual", null, NOW]);
  assert.equal(count(db, "entitlements"), 4);
});

test("discord_events: id unique for replay safety, payload hash is 64 lowercase hex, kind non-empty", () => {
  const db = freshDb();
  const sql = "INSERT INTO discord_events (id, tenant_id, kind, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)";
  rejects(db, sql, ["", "t1", "k", HASH, NOW], CHECK);
  rejects(db, sql, ["e1", "t1", "k", HASH, NOW], CHECK);
  rejects(db, sql, ["1".repeat(16), "t1", "k", HASH, NOW], CHECK);
  rejects(db, sql, ["1".repeat(21), "t1", "k", HASH, NOW], CHECK);
  rejects(db, sql, ["1".repeat(16) + "x", "t1", "k", HASH, NOW], CHECK);
  rejects(db, sql, [E1, "t1", "", HASH, NOW], CHECK);
  rejects(db, sql, [E1, "t1", "k", "short", NOW], CHECK);
  rejects(db, sql, [E1, "t1", "k", "B".repeat(64), NOW], CHECK);
  rejects(db, sql, [E1, "nope", "k", HASH, NOW], FK);
  accepts(db, sql, [E1, "t1", "k", HASH, NOW]);
  rejects(db, sql, [E1, "t1", "k", HASH, NOW], UNIQUE);
  db.prepare("INSERT OR IGNORE INTO discord_events (id, tenant_id, kind, payload_hash, created_at) VALUES (?,'t1','k',?,?)").run(E1, HASH, NOW);
  assert.equal(count(db, "discord_events"), 1);
});

test("ON DELETE CASCADE: deleting a group removes its slots and sign-ups", () => {
  const db = freshDb();
  accepts(db, "INSERT INTO group_slots (group_id, slot_index, role, status) VALUES ('g1', 0, 'tank', 'open')");
  accepts(db, "INSERT INTO signups_v2 (group_id, user_id, rsvp, updated_at) VALUES ('g1', ?, 'yes', ?)", [U, NOW]);
  db.exec("DELETE FROM groups WHERE id = 'g1'");
  assert.equal(count(db, "group_slots"), 0);
  assert.equal(count(db, "signups_v2"), 0);
});

test("ON DELETE CASCADE: deleting a user removes their sign-ups but not the group", () => {
  const db = freshDb();
  accepts(db, "INSERT INTO signups_v2 (group_id, user_id, rsvp, updated_at) VALUES ('g1', ?, 'yes', ?)", [U, NOW]);
  db.exec("DELETE FROM users WHERE discord_user_id = '" + U + "'");
  assert.equal(count(db, "signups_v2"), 0);
  assert.equal(count(db, "groups"), 1);
});

test("ON DELETE SET NULL: deleting a character nulls the slot and sign-up reference and keeps both rows", () => {
  const db = freshDb();
  accepts(db, "INSERT INTO group_slots (group_id, slot_index, role, character_id, status) VALUES ('g1', 0, 'tank', 'c1', 'filled')");
  accepts(db, "INSERT INTO signups_v2 (group_id, user_id, character_id, rsvp, updated_at) VALUES ('g1', ?, 'c1', 'yes', ?)", [U, NOW]);
  db.exec("DELETE FROM characters WHERE id = 'c1'");
  assert.equal(db.prepare("SELECT character_id FROM group_slots").get().character_id, null);
  assert.equal(db.prepare("SELECT character_id FROM signups_v2").get().character_id, null);
  assert.equal(count(db, "group_slots"), 1);
  assert.equal(count(db, "signups_v2"), 1);
});

test("ON DELETE CASCADE from tenants: groups (with slots and sign-ups) and discord_events go with the tenant", () => {
  const db = freshDb();
  accepts(db, "INSERT INTO group_slots (group_id, slot_index, role, status) VALUES ('g1', 0, 'tank', 'open')");
  accepts(db, "INSERT INTO signups_v2 (group_id, user_id, rsvp, updated_at) VALUES ('g1', ?, 'yes', ?)", [U, NOW]);
  accepts(db, "INSERT INTO discord_events (id, tenant_id, kind, payload_hash, created_at) VALUES (?, 't1', 'k', ?, ?)", [E1, HASH, NOW]);
  db.exec("DELETE FROM tenants WHERE id = 't1'");
  for (const t of ["groups", "group_slots", "signups_v2", "discord_events", "characters"]) assert.equal(count(db, t), 0, t);
  assert.equal(count(db, "users"), 1);
});

test("ON DELETE SET NULL from tenants: entitlements survive a tenant purge with tenant_id NULL", () => {
  const db = freshDb();
  accepts(db, "INSERT INTO entitlements (tenant_id, plan, status, source, processor_event_id, created_at) VALUES ('t1', 'pro', 'active', 'processor', 'evt_1', ?)", [NOW]);
  accepts(db, "INSERT INTO entitlements (tenant_id, plan, status, source, created_at) VALUES ('t1', 'pro', 'canceled', 'manual', ?)", [NOW]);
  accepts(db, "INSERT INTO entitlements (tenant_id, plan, status, source, created_at) VALUES (NULL, 'pro', 'canceled', 'manual', ?)", [NOW]);
  db.exec("DELETE FROM tenants WHERE id = 't1'");
  assert.equal(count(db, "tenants"), 0);
  const rows = db.prepare("SELECT tenant_id, processor_event_id FROM entitlements ORDER BY id").all();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.tenant_id === null));
  assert.equal(rows[0].processor_event_id, "evt_1");
});

test("group_slots: deleting a character re-opens a filled or bench seat (trigger fires on the SET NULL cascade; a two-way CHECK would have blocked it)", () => {
  const db = freshDb();
  accepts(db, "INSERT INTO group_slots (group_id, slot_index, role, character_id, status) VALUES ('g1', 0, 'tank', 'c1', 'filled')");
  accepts(db, "INSERT INTO group_slots (group_id, slot_index, role, character_id, status) VALUES ('g1', 1, 'dps', 'c1', 'bench')");
  db.exec("DELETE FROM characters WHERE id = 'c1'");
  const rows = db.prepare("SELECT character_id, status FROM group_slots ORDER BY slot_index").all();
  assert.deepEqual(rows.map((r) => [r.character_id, r.status]), [[null, "open"], [null, "open"]]);
});

test("group_slots: the CHECK guards UPDATE (open with a character is rejected); the trigger re-opens a seat whose character_id is set to NULL", () => {
  const db = freshDb();
  accepts(db, "INSERT INTO group_slots (group_id, slot_index, role, status) VALUES ('g1', 0, 'tank', 'open')");
  assert.throws(() => db.exec("UPDATE group_slots SET character_id = 'c1' WHERE slot_index = 0"), CHECK);
  accepts(db, "UPDATE group_slots SET character_id = 'c1', status = 'filled' WHERE slot_index = 0");
  assert.throws(() => db.exec("UPDATE group_slots SET status = 'open' WHERE slot_index = 0"), CHECK);
  accepts(db, "UPDATE group_slots SET status = 'bench' WHERE slot_index = 0");
  accepts(db, "UPDATE group_slots SET character_id = NULL WHERE slot_index = 0");
  assert.equal(db.prepare("SELECT status FROM group_slots WHERE slot_index = 0").get().status, "open");
  accepts(db, "UPDATE group_slots SET character_id = 'c1', status = 'filled' WHERE slot_index = 0");
  accepts(db, "UPDATE group_slots SET character_id = NULL WHERE slot_index = 0");
  assert.equal(db.prepare("SELECT status FROM group_slots WHERE slot_index = 0").get().status, "open");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_group_slots_free'").get());
});

test("discord_events has an index on created_at for purging, and the planner uses it", () => {
  const db = freshDb();
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_discord_events_created'").get());
  const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM discord_events WHERE created_at < '2026-01-01'").all().map((r) => r.detail).join(" ");
  assert.match(plan, /idx_discord_events_created/);
});

test("0002 cascade behaviour: deleting a tenant cascades to memberships, characters and builds", () => {
  const db = freshDb();
  db.exec("INSERT INTO memberships (tenant_id, discord_user_id, joined_at) VALUES ('t1', '" + U + "', '" + NOW + "')");
  db.exec("INSERT INTO builds (id, character_id, source, created_at) VALUES ('b1', 'c1', 'web', '" + NOW + "')");
  db.exec("DELETE FROM tenants WHERE id = 't1'");
  assert.equal(count(db, "memberships"), 0);
  assert.equal(count(db, "characters"), 0);
  assert.equal(count(db, "builds"), 0);
  assert.equal(count(db, "users"), 1);
});
