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
  accepts(db, sql, ["t1", "pro", "active", "processor", "2026-02-01T00:00:00Z", NOW]);
  accepts(db, sql, ["t1", "pro", "canceled", "manual", null, NOW]);
});

test("discord_events: id unique for replay safety, payload hash is 64 lowercase hex, kind non-empty", () => {
  const db = freshDb();
  const sql = "INSERT INTO discord_events (id, tenant_id, kind, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)";
  rejects(db, sql, ["", "t1", "k", HASH, NOW], CHECK);
  rejects(db, sql, ["e1", "t1", "", HASH, NOW], CHECK);
  rejects(db, sql, ["e1", "t1", "k", "short", NOW], CHECK);
  rejects(db, sql, ["e1", "t1", "k", "B".repeat(64), NOW], CHECK);
  rejects(db, sql, ["e1", "nope", "k", HASH, NOW], FK);
  accepts(db, sql, ["e1", "t1", "k", HASH, NOW]);
  rejects(db, sql, ["e1", "t1", "k", HASH, NOW], UNIQUE);
  db.prepare("INSERT OR IGNORE INTO discord_events (id, tenant_id, kind, payload_hash, created_at) VALUES ('e1','t1','k',?,?)").run(HASH, NOW);
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

test("ON DELETE RESTRICT: a tenant with groups, entitlements or events cannot be deleted", () => {
  const cases = {
    groups: null,
    entitlements: "INSERT INTO entitlements (tenant_id, plan, status, source, created_at) VALUES ('t1', 'pro', 'active', 'manual', '" + NOW + "')",
    discord_events: "INSERT INTO discord_events (id, tenant_id, kind, payload_hash, created_at) VALUES ('e1', 't1', 'k', '" + HASH + "', '" + NOW + "')",
  };
  for (const [table, ins] of Object.entries(cases)) {
    const db = freshDb();
    if (ins) {
      db.exec(ins);
      db.exec("DELETE FROM groups");
    }
    assert.throws(() => db.exec("DELETE FROM tenants WHERE id = 't1'"), FK, table);
    assert.equal(count(db, "tenants"), 1, table);
  }
});

test("0002 cascade behaviour (previously untested): a tenant with no restricting rows cascades to memberships and characters", () => {
  const db = freshDb();
  db.exec("INSERT INTO memberships (tenant_id, discord_user_id, joined_at) VALUES ('t1', '" + U + "', '" + NOW + "')");
  db.exec("INSERT INTO builds (id, character_id, source, created_at) VALUES ('b1', 'c1', 'web', '" + NOW + "')");
  db.exec("DELETE FROM groups");
  db.exec("DELETE FROM tenants WHERE id = 't1'");
  assert.equal(count(db, "memberships"), 0);
  assert.equal(count(db, "characters"), 0);
  assert.equal(count(db, "builds"), 0);
  assert.equal(count(db, "users"), 1);
});
