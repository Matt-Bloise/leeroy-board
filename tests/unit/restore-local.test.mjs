// tools/pull-export.mjs and tools/restore-local.mjs: parse, refuse, build SQL, and an in-process restore drill (export from one seeded SQLite
// through the real Worker route, load it into a second fresh SQLite, compare every count). No wrangler, no network, no AI, made-up data.
// The same drill against a real local D1 is tests/local/restore-drill.mjs. Run: node --test tests/unit/restore-local.test.mjs
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { EXCLUDED_TABLES } from "../../infrastructure/worker/export.js";
import { pull, parseArgv as pullArgv, insideRepo } from "../../tools/pull-export.mjs";
import { parseExport, buildSql, sqlLiteral, placeholderKeyHash, expectedCounts, compareCounts, countSql, parseArgv } from "../../tools/restore-local.mjs";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ADMIN = "admin-token-for-tests-0123456789abcdef", CTX = { waitUntil() {}, passThroughOnException() {} };
const U = "100000000000000001", KEYH = "k".repeat(64);

function seeded() {
  const db = schemaDb(), r = db.raw;
  r.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ?, 'now')").run(KEYH);
  r.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('rudolf', ?, 'now')").run("r".repeat(64));
  r.prepare("INSERT INTO sessions (token_hash, user_key, created_at, expires_at, last_seen) VALUES (?, ?, 1, 2, 3)").run("t".repeat(64), "f".repeat(64));
  r.prepare("INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (?, 'prefs', 'e', ?, 1)").run("f".repeat(64), '{"keys":{"a":{"v":"it\'s \\"quoted\\"","t":1}}}');
  r.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'Tester O''Neil', 'now')").run(U);
  r.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (?, ?, '2026-01-01', '2026-02-01')").run("e".repeat(64), U);
  r.prepare("INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES ('t1', '200000000000000001', 'Guild', 'active', 'now')").run();
  r.prepare("INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, class, created_at) VALUES ('c1', 't1', ?, 'Pip', 'Normal|EU', 'eu', 'Mage', 'now')").run(U);
  r.prepare("INSERT INTO character_profiles (character_id, race, faction, ruleset, region_label, selected) VALUES ('c1', 'Gnome', 'Alliance', 'Normal', 'EU', 1)").run();
  r.prepare("INSERT INTO builds (id, character_id, source, status, title, data_json, created_at) VALUES ('b1', 'c1', 'web', 'draft', 'T', '{}', 'now')").run();
  r.prepare("INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, detail_json, at) VALUES ('t1', ?, 'x', '{}', 'now')").run(U);
  for (const [k, v] of [["party", '{"members":[{"name":"Línea ünï"}]}'], ["secret_x", "SECRET"], ["feed_cache:stats", "{}"]]) r.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'now')").run(k, v);
  for (let i = 0; i < 7; i++) r.prepare("INSERT INTO intents (at, slug, kind, body, ver) VALUES ('now', 'santa', 'signup', ?, 1)").run(`{"n":${i}}`);
  r.prepare("INSERT INTO ask_turns (id, by_name, question, answer, status, created_at) VALUES ('a1', 'Tester', 'Where is the bank?', NULL, 'error', 'now')").run();
  return db;
}
const viaWorker = (db) => async (url, init) => {
  const u = new URL(url);
  return worker.fetch(new Request(`https://api.test${u.pathname}${u.search}`, init), { DB: db, BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "" }, CTX);
};
const exportOf = async (db, limit = 3) => (await pull({ api: "https://api.test", token: ADMIN, limit, fetchImpl: viaWorker(db) })).lines.join("\n") + "\n";
const counts = (db) => Object.fromEntries(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map(({ name }) => [name, db.raw.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));

test("restore drill (in process): export the seeded database, load it into a fresh one, every count matches, secrets stay out", async () => {
  const src = seeded(), text = await exportOf(src);
  const parsed = parseExport(text);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.excluded.sort(), Object.keys(EXCLUDED_TABLES).sort());
  const dst = schemaDb();
  dst.raw.exec(["PRAGMA defer_foreign_keys = true;", ...buildSql(parsed)].join("\n"));
  const want = counts(src), got = counts(dst);
  for (const t of Object.keys(EXCLUDED_TABLES)) assert.equal(got[t], 0, `${t} must come back empty`);
  assert.equal(got.kv_state, 1, "secret* and feed_cache:* rows are not restored");
  assert.equal(want.kv_state, 3);
  for (const t of Object.keys(want)) if (!EXCLUDED_TABLES[t] && t !== "kv_state") assert.equal(got[t], want[t], t);
  const cmp = compareCounts(expectedCounts(parsed), dst.raw.prepare(countSql(parsed.order)).get());
  assert.equal(cmp.ok, true, JSON.stringify(cmp.rows.filter((r) => !r.ok)));
  assert.ok(cmp.rows.length >= 25);
  // values survive: quotes, accents, apostrophes, JSON
  assert.equal(dst.raw.prepare("SELECT display_name FROM users").get().display_name, "Tester O'Neil");
  assert.equal(dst.raw.prepare("SELECT json FROM kv_state WHERE key = 'party'").get().json, '{"members":[{"name":"Línea ünï"}]}');
  assert.equal(JSON.parse(dst.raw.prepare("SELECT json FROM user_state").get().json).keys.a.v, 'it\'s "quoted"');
  assert.deepEqual(dst.raw.prepare("SELECT seq FROM intents ORDER BY seq").all().map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(dst.raw.prepare("SELECT race FROM character_profiles").get().race, "Gnome");
});

test("members come back with a placeholder hash that matches no key; the original hash is nowhere in the file", async () => {
  const src = seeded(), text = await exportOf(src), dst = schemaDb();
  assert.equal(text.includes(KEYH), false);
  dst.raw.exec(buildSql(parseExport(text)).join("\n"));
  const rows = dst.raw.prepare("SELECT slug, key_hash FROM members ORDER BY slug").all();
  assert.deepEqual(rows.map((r) => r.slug), ["rudolf", "santa"]);
  for (const r of rows) { assert.equal(r.key_hash, placeholderKeyHash(r.slug)); assert.match(r.key_hash, /^[0-9a-f]{64}$/); assert.notEqual(r.key_hash, KEYH); }
  assert.notEqual(rows[0].key_hash, rows[1].key_hash);
});

test("a restored database passes its foreign keys", async () => {
  const dst = schemaDb();
  dst.raw.exec(buildSql(parseExport(await exportOf(seeded()))).join("\n"));
  assert.deepEqual(dst.raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("page size does not change the result", async () => {
  const a = await exportOf(seeded(), 1), b = await exportOf(seeded(), 1000);
  const rows = (t) => parseExport(t).order.map((n) => parseExport(t).tables.get(n).rows.length);
  assert.deepEqual(rows(a), rows(b));
});

test("parseExport refuses: not an export, a partial export, a bad end count, a row that does not match its page, a never-exported table", async () => {
  const good = (await exportOf(seeded())).split("\n").filter(Boolean);
  assert.ok(parseExport("not json\n").problems.some((p) => /not JSON/.test(p)));
  assert.ok(parseExport('{"t":"table","table":"x","columns":["a"]}\n').problems.some((p) => /no manifest/.test(p)));
  // cut the file after the first page of intents (3 rows, next set)
  const firstEnd = good.findIndex((l) => /"t":"end","table":"intents"/.test(l));
  assert.ok(parseExport(good.slice(0, firstEnd + 1).join("\n")).problems.some((p) => /incomplete/.test(p)));
  assert.ok(parseExport(good.slice(0, firstEnd).join("\n")).problems.some((p) => /ends inside a page/.test(p)));
  let changed = false;
  const lied = good.map((l) => { if (!changed && /"t":"end","table":"intents"/.test(l)) { changed = true; return l.replace(/"rows":\d+/, '"rows":99'); } return l; });
  assert.ok(parseExport(lied.join("\n")).problems.some((p) => /says 99 rows/.test(p)));
  const swapped = good.map((l) => l.replace('"slug":"santa"', '"slug":"santa","extra":1'));
  assert.ok(parseExport(swapped.join("\n")).problems.some((p) => /row columns differ/.test(p)));
  const sneaky = [good[0], '{"t":"table","table":"sessions","columns":["token_hash"]}'].join("\n");
  assert.ok(parseExport(sneaky).problems.some((p) => /never exported/.test(p)));
});

test("sqlLiteral escapes quotes and handles null, numbers, and refuses objects", () => {
  assert.equal(sqlLiteral("a'b"), "'a''b'");
  assert.equal(sqlLiteral("'; DROP TABLE members; --"), "'''; DROP TABLE members; --'");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(12), "12");
  assert.equal(sqlLiteral(1.5), "1.5");
  assert.throws(() => sqlLiteral({}), /cannot restore/);
  assert.throws(() => sqlLiteral(Infinity), /non-finite/);
  const db = schemaDb();
  db.raw.exec(`INSERT INTO kv_state (key, json, updated_at) VALUES ('k', ${sqlLiteral("x'); DROP TABLE members; --")}, 'n')`);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM members").get().n, 0);
  assert.equal(db.raw.prepare("SELECT json FROM kv_state").get().json, "x'); DROP TABLE members; --");
});

test("restore-local is local only and needs its inputs; pull-export keeps the file out of the repo", () => {
  assert.throws(() => parseArgv(["--remote"]), /local only/);
  assert.throws(() => parseArgv(["--in"]), /needs a value/);
  assert.throws(() => parseArgv(["stray"]), /unexpected/);
  assert.deepEqual(parseArgv(["--in", "x", "--persist-to", "y", "--dry-run"]), { in: "x", "persist-to": "y", "dry-run": true });
  assert.throws(() => pullArgv(["--token", "x"]), /unknown option/);
  assert.equal(insideRepo(fileURLToPath(new URL("../../x.ndjson", import.meta.url))), true);
  assert.equal(insideRepo("/tmp/x.ndjson"), false);
});

test("pull stops on a refusal and never prints the token", async () => {
  const refusing = async () => new Response("no", { status: 401 });
  await assert.rejects(() => pull({ api: "https://api.test", token: "TOKEN-VALUE-1234567890", fetchImpl: refusing }), (e) => /answered 401/.test(e.message) && !e.message.includes("TOKEN-VALUE"));
});
