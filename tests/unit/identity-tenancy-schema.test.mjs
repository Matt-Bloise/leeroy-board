// Loads infrastructure/schema.sql (and the 0002 migration on top) into in-memory SQLite and checks that every CHECK constraint
// rejects a bad row. No network, no D1, no AI. Ids are made-up digit strings.
// Run: node --test tests/unit/identity-tenancy-schema.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SCHEMA = read("../../infrastructure/schema.sql");
const MIGRATION = read("../../infrastructure/migrations/0002_identity_tenancy.sql");

const U = "100000000000000001", G = "200000000000000001", T = "300000000000000001";
const NOW = "2026-01-01T00:00:00Z", LATER = "2026-01-02T00:00:00Z";
const HASH = "a".repeat(64);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec("INSERT INTO users (discord_user_id, created_at) VALUES ('" + U + "', '" + NOW + "')");
  db.exec("INSERT INTO tenants (id, discord_guild_id, name, created_at) VALUES ('t1', '" + G + "', 'Guild', '" + NOW + "')");
  db.exec("INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, created_at) VALUES ('c1', 't1', '" + U + "', 'Nm', 'Realm', 'eu', '" + NOW + "')");
  return db;
}
const rejects = (db, sql, params = []) =>
  assert.throws(() => db.prepare(sql).run(...params), /CHECK constraint failed|constraint failed/i, sql);
const accepts = (db, sql, params = []) => db.prepare(sql).run(...params);

test("schema.sql alone builds the new tables, and the migration is idempotent on top of it", () => {
  const db = freshDb();
  db.exec(MIGRATION);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ["users", "identities", "humans", "human_members", "sessions_v2", "provider_tokens", "tenants", "tenant_config", "memberships", "characters", "builds", "thread_cursors", "audit_log"]) {
    assert.ok(names.includes(t), t);
  }
});

test("migration alone builds the new tables on an empty database", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n >= 13, true);
});

test("users: Discord id must be 17 to 20 digits", () => {
  const db = freshDb();
  for (const bad of ["123", "abcdefghijklmnopqr", "1000000000000000011111", "10000000000000000x"]) {
    rejects(db, "INSERT INTO users (discord_user_id, created_at) VALUES (?, ?)", [bad, NOW]);
  }
  accepts(db, "INSERT INTO users (discord_user_id, created_at) VALUES (?, ?)", ["100000000000000002", NOW]);
});

test("identities: attach-only, provider must be a known non-Discord provider", () => {
  const db = freshDb();
  const sql = "INSERT INTO identities (provider, provider_user_id, discord_user_id, attached_at) VALUES (?, ?, ?, ?)";
  rejects(db, sql, ["discord", "x1", U, NOW]);
  rejects(db, sql, ["myspace", "x1", U, NOW]);
  rejects(db, sql, ["battlenet", "", U, NOW]);
  assert.throws(() => db.prepare(sql).run("battlenet", "x1", "100000000000000009", NOW), /FOREIGN KEY/i);
  accepts(db, sql, ["battlenet", "x1", U, NOW]);
  assert.throws(() => db.prepare(sql).run("battlenet", "x2", U, NOW), /UNIQUE/i);
});

test("humans and human_members: non-empty id, one human per user", () => {
  const db = freshDb();
  rejects(db, "INSERT INTO humans (id, created_at) VALUES ('', ?)", [NOW]);
  accepts(db, "INSERT INTO humans (id, created_at) VALUES ('h1', ?), ('h2', ?)", [NOW, NOW]);
  accepts(db, "INSERT INTO human_members (human_id, discord_user_id, added_at) VALUES ('h1', ?, ?)", [U, NOW]);
  assert.throws(() => db.prepare("INSERT INTO human_members (human_id, discord_user_id, added_at) VALUES ('h2', ?, ?)").run(U, NOW), /UNIQUE/i);
});

test("sessions_v2: token hash is 64 lowercase hex, expiry after creation", () => {
  const db = freshDb();
  const sql = "INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)";
  rejects(db, sql, ["short", U, NOW, LATER]);
  rejects(db, sql, ["A".repeat(64), U, NOW, LATER]);
  rejects(db, sql, ["g".repeat(64), U, NOW, LATER]);
  rejects(db, sql, [HASH, U, LATER, NOW]);
  rejects(db, sql, [HASH, U, NOW, NOW]);
  accepts(db, sql, [HASH, U, NOW, LATER]);
});

test("provider_tokens: known provider, non-empty ciphertext", () => {
  const db = freshDb();
  const sql = "INSERT INTO provider_tokens (discord_user_id, provider, access_token_enc, updated_at) VALUES (?, ?, ?, ?)";
  rejects(db, sql, [U, "myspace", "enc", NOW]);
  rejects(db, sql, [U, "battlenet", "", NOW]);
  accepts(db, sql, [U, "battlenet", "enc", NOW]);
});

test("tenants: guild id digits, name present, status in set", () => {
  const db = freshDb();
  const sql = "INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)";
  rejects(db, sql, ["t2", "12ab", "G", "active", NOW]);
  rejects(db, sql, ["t2", "200000000000000002", "", "active", NOW]);
  rejects(db, sql, ["t2", "200000000000000002", "G", "deleted", NOW]);
  rejects(db, sql, ["", "200000000000000002", "G", "active", NOW]);
  accepts(db, sql, ["t2", "200000000000000002", "G", "pending", NOW]);
});

test("tenant_config: value must be valid JSON, key non-empty", () => {
  const db = freshDb();
  const sql = "INSERT INTO tenant_config (tenant_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)";
  rejects(db, sql, ["t1", "k", "{not json", NOW]);
  rejects(db, sql, ["t1", "", "{}", NOW]);
  accepts(db, sql, ["t1", "k", '{"a":1}', NOW]);
});

test("memberships: role and status in set", () => {
  const db = freshDb();
  const sql = "INSERT INTO memberships (tenant_id, discord_user_id, role, status, joined_at) VALUES ('t1', ?, ?, ?, ?)";
  rejects(db, sql, [U, "god", "active", NOW]);
  rejects(db, sql, [U, "member", "banned", NOW]);
  accepts(db, sql, [U, "owner", "active", NOW]);
});

test("characters: region in set, name and realm non-empty", () => {
  const db = freshDb();
  const sql = "INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, created_at) VALUES (?, 't1', ?, ?, ?, ?, ?)";
  rejects(db, sql, ["c2", U, "N", "R", "mars", NOW]);
  rejects(db, sql, ["c2", U, "", "R", "us", NOW]);
  rejects(db, sql, ["c2", U, "N", "", "us", NOW]);
  rejects(db, sql, ["", U, "N", "R", "us", NOW]);
  accepts(db, sql, ["c2", U, "N", "R", "us", NOW]);
});

test("builds: source in modal/import/web, status in draft/confirmed, confirmed_at matches status, JSON valid", () => {
  const db = freshDb();
  const sql = "INSERT INTO builds (id, character_id, source, status, data_json, created_at, confirmed_at) VALUES (?, 'c1', ?, ?, ?, ?, ?)";
  rejects(db, sql, ["b1", "api", "draft", "{}", NOW, null]);
  rejects(db, sql, ["b1", "modal", "final", "{}", NOW, null]);
  rejects(db, sql, ["b1", "modal", "confirmed", "{}", NOW, null]);
  rejects(db, sql, ["b1", "modal", "draft", "{}", NOW, LATER]);
  rejects(db, sql, ["b1", "modal", "draft", "nope", NOW, null]);
  for (const s of ["modal", "import", "web"]) accepts(db, sql, ["b-" + s, s, "draft", "{}", NOW, null]);
  accepts(db, sql, ["b-ok", "web", "confirmed", "{}", NOW, LATER]);
});

test("thread_cursors: thread and message ids are digit snowflakes", () => {
  const db = freshDb();
  const sql = "INSERT INTO thread_cursors (tenant_id, thread_id, last_message_id, updated_at) VALUES ('t1', ?, ?, ?)";
  rejects(db, sql, [T.slice(0, 5), null, NOW]);
  rejects(db, sql, ["30000000000000000x", null, NOW]);
  rejects(db, sql, [T, "abc", NOW]);
  accepts(db, sql, [T, null, NOW]);
});

test("audit_log: action non-empty, detail valid JSON", () => {
  const db = freshDb();
  const sql = "INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, detail_json, at) VALUES ('t1', ?, ?, ?, ?)";
  rejects(db, sql, [U, "", "{}", NOW]);
  rejects(db, sql, [U, "build.confirm", "{bad", NOW]);
  accepts(db, sql, [U, "build.confirm", "{}", NOW]);
});
