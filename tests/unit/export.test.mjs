// GET /api/admin/export: admin only, NDJSON, paged, and never a secret. Real SQLite built from infrastructure/schema.sql, made-up values.
// The exclusion list is checked against the schema: every table is either exported or named in EXCLUDED_TABLES, and every secret-looking
// column is excluded, so a new table or column cannot slip into a backup unclassified. No network, no AI.
// Run: node --test tests/unit/export.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { EXCLUDED_TABLES, EXCLUDED_COLUMNS, ROW_FILTERS, PAGE, exportedColumns } from "../../infrastructure/worker/export.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ADMIN = "admin-token-for-tests-0123456789abcdef", CTX = { waitUntil() {}, passThroughOnException() {} };
const HASH_K = "k".repeat(64), HASH_T = "t".repeat(64), HASH_T2 = "e".repeat(64), HASH_A = "a".repeat(63) + "b", SECRET_ROW = "SECRET-VALUE-never-exported";
const U = "100000000000000001";

function seeded() {
  const db = schemaDb(), r = db.raw;
  r.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ?, 'now')").run(HASH_K);
  r.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('rudolf', ?, 'now')").run("r".repeat(64));
  r.prepare("INSERT INTO accounts (id, name, slug, created_at) VALUES ('a1', 'Acct', 'acct', 'now')").run();
  r.prepare("INSERT INTO account_keys (key_hash, account_id, label, created_at) VALUES (?, 'a1', 'l', 'now')").run(HASH_A);
  r.prepare("INSERT INTO sessions (token_hash, user_key, created_at, expires_at, last_seen) VALUES (?, ?, 1, 2, 3)").run(HASH_T, "f".repeat(64));
  r.prepare("INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (?, 'prefs', 'e', '{\"keys\":{}}', 1)").run("f".repeat(64));
  r.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'Tester', 'now')").run(U);
  r.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (?, ?, '2026-01-01', '2026-02-01')").run(HASH_T2, U);
  r.prepare("INSERT INTO provider_tokens (discord_user_id, provider, access_token_enc, updated_at) VALUES (?, 'discord', 'CIPHERTEXT-never-exported', 'now')").run(U);
  r.prepare("INSERT INTO guest_rate_limits (ip_hash, created_at) VALUES ('iphash-never-exported', 1)").run();
  for (const [k, v] of [["party", '{"members":[]}'], ["signups", '{"entries":[]}'], ["secret_x", SECRET_ROW], ["secrets", SECRET_ROW], ["feed_cache:stats", "{}"], ["persona", '{"p":1}']]) r.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'now')").run(k, v);
  for (let i = 0; i < 5; i++) r.prepare("INSERT INTO intents (at, slug, kind, body, ver) VALUES ('now', 'santa', 'signup', ?, 1)").run(`{"n":${i}}`);
  return db;
}
const env = (db) => ({ DB: db, BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "" });
const get = (e, path, auth = `Bearer ${ADMIN}`) => worker.fetch(new Request(`https://api.test${path}`, { headers: auth ? { Authorization: auth } : {} }), e, CTX);
const ndjson = async (res) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ---- the list against the schema
const SCHEMA = readFileSync(new URL("../../infrastructure/schema.sql", import.meta.url), "utf8");
const TABLES = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map((m) => m[1]);

test("every exclusion names a table or column that exists in schema.sql, and secrets are all covered", () => {
  for (const t of Object.keys(EXCLUDED_TABLES)) assert.ok(TABLES.includes(t), `excluded table ${t} is not in schema.sql`);
  const db = schemaDb();
  for (const [t, cols] of Object.entries(EXCLUDED_COLUMNS)) {
    const have = db.raw.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    for (const c of Object.keys(cols)) assert.ok(have.includes(c), `${t}.${c}`);
  }
  assert.deepEqual(Object.keys(EXCLUDED_TABLES).sort(), ["account_keys", "guest_rate_limits", "provider_tokens", "sessions", "sessions_v2"]);
  assert.deepEqual(Object.fromEntries(Object.entries(EXCLUDED_COLUMNS).map(([t, c]) => [t, Object.keys(c)])), { members: ["key_hash"] });
  assert.deepEqual(Object.keys(ROW_FILTERS), ["kv_state"]);
});

test("no exported column looks like a secret: names containing token, secret, password, key_hash or _enc must be excluded", () => {
  const db = schemaDb(), bad = [];
  for (const t of TABLES) {
    if (EXCLUDED_TABLES[t]) continue;
    for (const c of exportedColumns(t, db.raw.prepare(`PRAGMA table_info("${t}")`).all().map((x) => x.name))) {
      if (/token|secret|password|key_hash|_enc$|credential/i.test(c)) bad.push(`${t}.${c}`);
    }
  }
  assert.deepEqual(bad, []);
});

// ---- the route
test("admin token only: 401 without it, with a member-style header, with a wrong token; 503 when no admin token is configured", async () => {
  const e = env(seeded());
  for (const auth of [null, "Board somekey1234567890123456", "Bearer wrong-token-wrong-token-wrong-0000", "Bearer "]) assert.equal((await get(e, "/api/admin/export", auth)).status, 401, String(auth));
  assert.equal((await get(e, "/api/admin/export?table=members", null)).status, 401);
  assert.equal((await get({ ...e, BOARD_ADMIN_TOKEN: undefined }, "/api/admin/export")).status, 503);
  assert.equal((await get(e, "/api/admin/export")).status, 200);
});

test("manifest: one line per exported table with its columns, the excluded tables named, key_hash absent", async () => {
  const res = await get(env(seeded()), "/api/admin/export");
  assert.equal(res.headers.get("Content-Type"), "application/x-ndjson; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const lines = await ndjson(res);
  assert.equal(lines[0].t, "manifest");
  const tables = lines.filter((l) => l.t === "table"), ex = lines.filter((l) => l.t === "excluded_table");
  assert.deepEqual(ex.map((l) => l.table).sort(), Object.keys(EXCLUDED_TABLES).sort());
  assert.deepEqual(tables.map((l) => l.table).sort(), TABLES.filter((t) => !EXCLUDED_TABLES[t]).sort());
  const members = tables.find((l) => l.table === "members");
  assert.deepEqual(members.columns, ["slug", "created_at"]);
  assert.deepEqual(members.excluded_columns, ["key_hash"]);
  assert.equal(tables.find((l) => l.table === "kv_state").filter, ROW_FILTERS.kv_state);
});

test("a full export of every table never contains a secret value", async () => {
  const e = env(seeded()), manifest = await ndjson(await get(e, "/api/admin/export"));
  let all = JSON.stringify(manifest);
  for (const t of manifest.filter((l) => l.t === "table")) {
    let after = 0;
    for (;;) {
      const lines = await ndjson(await get(e, `/api/admin/export?table=${t.table}&after=${after}&limit=2`));
      all += JSON.stringify(lines);
      const end = lines[lines.length - 1];
      assert.equal(end.t, "end");
      if (end.next === null) break;
      after = end.next;
    }
  }
  for (const secret of [HASH_K, "r".repeat(64), HASH_T, HASH_T2, HASH_A, "CIPHERTEXT-never-exported", "iphash-never-exported", SECRET_ROW]) assert.equal(all.includes(secret), false, secret.slice(0, 12));
  assert.ok(all.includes('"slug":"santa"'), "members are exported without their hashes");
  assert.ok(all.includes("user_key"), "user_state is exported");
});

test("kv_state: secret* and feed_cache:* rows are filtered, the rest (including private config rows) are exported", async () => {
  const lines = await ndjson(await get(env(seeded()), "/api/admin/export?table=kv_state"));
  assert.deepEqual(lines.filter((l) => l.t === "row").map((l) => l.r.key).sort(), ["party", "persona", "signups"]);
});

test("paging: limit rows per page, a cursor that continues without gaps or repeats, next null at the end", async () => {
  const e = env(seeded()), seen = [];
  let after = 0, pages = 0;
  for (;;) {
    const lines = await ndjson(await get(e, `/api/admin/export?table=intents&after=${after}&limit=2`));
    assert.equal(lines[0].t, "page");
    assert.deepEqual(lines[0].columns, ["seq", "at", "slug", "kind", "body", "ver"]);
    const rows = lines.filter((l) => l.t === "row"), end = lines[lines.length - 1];
    assert.ok(rows.length <= 2); assert.equal(end.rows, rows.length);
    seen.push(...rows.map((l) => l.r.seq)); pages++;
    if (end.next === null) break;
    after = end.next;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(pages, 3);
  const exact = await ndjson(await get(e, "/api/admin/export?table=intents&limit=5"));
  assert.equal(exact[exact.length - 1].next, null, "a page that holds exactly the rest has no next");
});

test("limits: default and maximum page size, bad numbers and unknown or excluded tables", async () => {
  const e = env(seeded());
  assert.deepEqual([PAGE.default, PAGE.max], [200, 1000]);
  const big = await ndjson(await get(e, "/api/admin/export?table=intents&limit=999999"));
  assert.equal(big[big.length - 1].next, null);
  for (const q of ["after=-1", "after=abc", "after=1.5", "limit=0", "limit=x"]) assert.equal((await get(e, `/api/admin/export?table=intents&${q}`)).status, 400, q);
  for (const t of ["nope", "sessions", "sessions_v2", "provider_tokens", "account_keys", "guest_rate_limits", "sqlite_master", "d1_migrations", "intents;DROP TABLE members", "intents%22", "../x", ""]) assert.equal((await get(e, `/api/admin/export?table=${t}`)).status, 404, t);
});

test("the route is read only: it changes nothing", async () => {
  const db = seeded(), count = () => TABLES.map((t) => db.raw.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n).join(",");
  const before = count(), e = env(db);
  await get(e, "/api/admin/export"); await get(e, "/api/admin/export?table=members");
  assert.equal(count(), before);
  assert.equal(db.raw.prepare("SELECT key_hash FROM members WHERE slug = 'santa'").get().key_hash, HASH_K);
});

test("the module reads no secret from the environment and never logs row data", () => {
  const src = readFileSync(new URL("../../infrastructure/worker/export.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /env\.(KEY_SALT|USER_SALT|DISCORD_CLIENT_SECRET)/);
  assert.doesNotMatch(src.replace(/^\/\/.*$/gm, ""), /console\.(log|warn|info)/);
});
