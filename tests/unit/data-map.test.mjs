// Erase and export cover the same data. Real SQLite built from infrastructure/schema.sql, made-up people, no network, no AI.
//   1. DATA_MAP (worker/data-rights.js) names every table in schema.sql, so a new table fails here until someone decides how it is handled.
//   2. Seed one member into every table that can hold something about them (and a bystander next to each row), erase, then scan EVERY column
//      of EVERY table for every id and hash we derive for that member: zero hits. The bystander's rows must all survive.
//   3. The member export carries every section DATA_MAP promises, and the admin backup carries every table erase touches, except the
//      three that hold only login secrets.
//   4. The Durable Object keeps no state.
// Run: node --test tests/unit/data-map.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { DATA_MAP, DURABLE_OBJECT_STATE, CONFIRM_PHRASE } from "../../infrastructure/worker/data-rights.js";
import { EXCLUDED_TABLES } from "../../infrastructure/worker/export.js";
import { userKey } from "../../infrastructure/worker/account.js";
import { userHash, slugAskerHash, insertAskTurn } from "../../infrastructure/worker/answer-ux.js";
import { hashId } from "../../infrastructure/worker/budget.js";
import { voterHash } from "../../infrastructure/worker/votes.js";
import { webSessionHash, SESS_COOKIE } from "../../infrastructure/worker/web-auth.js";
import { invalidateMembersCache, authenticate } from "../../infrastructure/worker/auth.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ME = "100000000000000001", OTHER = "100000000000000002";
const SLUG = "red-fox", NAME = "Red Fox", DISPLAY = "Foxy Display", OTHER_SLUG = "blue-owl", OTHER_NAME = "Blue Owl";
const KEY_SALT = "salt-for-tests-0123456789", USER_SALT = "user-salt-for-tests-0123456789", MEMBER_KEY = "member-key-for-tests-0123456789ab";
const OTHER_KEY = "other-key-for-tests-0123456789abcd";
const TOKEN = "A".repeat(43);
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const CTX = { waitUntil() {}, passThroughOnException() {} };
const NOWISO = "2026-11-01T00:00:00.000Z", LATER = "2026-12-01T00:00:00.000Z";
const SCHEMA = readFileSync(new URL("../../infrastructure/schema.sql", import.meta.url), "utf8");
const TABLES = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map((m) => m[1]);
// Board documents the erase route says it does NOT edit (see not_erased). Seeded so the test pins that statement instead of hiding it.
const UNTOUCHED_KV = ["discord_members", "party"];

const env = (db) => ({ DB: db, KEY_SALT, USER_SALT, BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "https://leeroy.test", DATA_RIGHTS: "on", WEB_LOGIN: "on" });
const call = (e, method, path, headers = {}, body) => worker.fetch(new Request(`https://api.test${path}`, { method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers }, body }), e, CTX);
const asKey = { Authorization: `Board ${MEMBER_KEY}` };
const asCookie = { Cookie: `${SESS_COOKIE}=${TOKEN}` };

async function seeded() {
  invalidateMembersCache(); invalidateConfigCache();
  const db = schemaDb(), r = db.raw;
  const run = (sql, ...a) => r.prepare(sql).run(...a);
  const ids = {
    userKey: await userKey({ USER_SALT }, ME), otherUserKey: await userKey({ USER_SALT }, OTHER),
    answerHash: await userHash({ USER_SALT }, ME), otherAnswerHash: await userHash({ USER_SALT }, OTHER),
    budgetId: await hashId(ME), budgetSlug: await hashId(SLUG), otherBudget: await hashId(OTHER),
    ballot: await voterHash(ME, "aaaa1111", USER_SALT), otherBallot: await voterHash(OTHER, "aaaa1111", USER_SALT),
  };
  // identity and login
  for (const [id, name] of [[ME, DISPLAY], [OTHER, "Other Display"]]) run("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?)", id, name, NOWISO);
  run("INSERT INTO identities (provider, provider_user_id, discord_user_id, attached_at) VALUES ('github', 'gh-me', ?, ?)", ME, NOWISO);
  run("INSERT INTO identities (provider, provider_user_id, discord_user_id, attached_at) VALUES ('github', 'gh-other', ?, ?)", OTHER, NOWISO);
  run("INSERT INTO humans (id, created_at) VALUES ('h-me', ?), ('h-shared', ?)", NOWISO, NOWISO);
  run("INSERT INTO human_members (human_id, discord_user_id, added_at) VALUES ('h-me', ?, ?), ('h-shared', ?, ?)", ME, NOWISO, OTHER, NOWISO);
  run("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", await webSessionHash(TOKEN), ME, NOWISO, LATER);
  run("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", "b".repeat(64), OTHER, NOWISO, LATER);
  run("INSERT INTO provider_tokens (discord_user_id, provider, access_token_enc, updated_at) VALUES (?, 'discord', 'ciphertext-me', ?), (?, 'discord', 'ciphertext-other', ?)", ME, NOWISO, OTHER, NOWISO);
  // guild, characters, groups
  run("INSERT INTO tenants (id, discord_guild_id, name, created_at) VALUES ('t1', '200000000000000001', 'Guild', ?)", NOWISO);
  run("INSERT INTO memberships (tenant_id, discord_user_id, joined_at) VALUES ('t1', ?, ?), ('t1', ?, ?)", ME, NOWISO, OTHER, NOWISO);
  run("INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, created_at) VALUES ('c-me', 't1', ?, 'Foxchar', 'R', 'us', ?), ('c-other', 't1', ?, 'Owlchar', 'R', 'us', ?)", ME, NOWISO, OTHER, NOWISO);
  run("INSERT INTO character_profiles (character_id, race, selected) VALUES ('c-me', 'Orc', 1), ('c-other', 'Troll', 1)");
  run("INSERT INTO builds (id, character_id, source, data_json, created_at) VALUES ('b-me', 'c-me', 'web', '{}', ?), ('b-other', 'c-other', 'web', '{}', ?)", NOWISO, NOWISO);
  run("INSERT INTO groups (id, tenant_id, name, kind, size, created_at) VALUES ('g1', 't1', 'Raid', 'raid', 10, ?)", NOWISO);
  run("INSERT INTO group_slots (group_id, slot_index, role, character_id, status) VALUES ('g1', 0, 'dps', 'c-me', 'filled'), ('g1', 1, 'dps', 'c-other', 'filled')");
  run("INSERT INTO signups_v2 (group_id, user_id, character_id, rsvp, updated_at) VALUES ('g1', ?, 'c-me', 'yes', ?), ('g1', ?, 'c-other', 'yes', ?)", ME, NOWISO, OTHER, NOWISO);
  run("INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) VALUES ('t1', ?, 'build.confirm', NULL, '{}', ?), ('t1', ?, 'build.confirm', NULL, '{}', ?)", ME, NOWISO, OTHER, NOWISO);
  // legacy, keyed by member slug or name
  run("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)", SLUG, await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`), NOWISO);
  run("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, ?)", OTHER_SLUG, await sha256Hex(`${KEY_SALT}:${OTHER_KEY}`), NOWISO);
  for (const [slug, name] of [[SLUG, NAME], [OTHER_SLUG, OTHER_NAME]]) {
    run("INSERT INTO sheet_events (slug, name, field, value_json, created_at) VALUES (?, ?, 'class', '\"mage\"', ?)", slug, name, NOWISO);
    run("INSERT INTO dispatches (slug, name, ask_ids_json, created_at) VALUES (?, ?, '[]', ?)", slug, name, NOWISO);
    run("INSERT INTO intents (at, slug, kind, body, ver) VALUES (?, ?, 'ask', ?, 1)", NOWISO, slug, JSON.stringify({ by: name }));
    run("INSERT INTO fact_fixes (id, page_id, fact_key, new_value, note, by_name, created_at) VALUES (?, 'p', 'k', 'v', ?, ?, ?)", `ff-${slug}`, `note by ${name}`, name, NOWISO);
    run("INSERT INTO ask_turns (id, by_name, question, answer, status, created_at) VALUES (?, ?, ?, ?, 'answered', ?)", `q-${slug}`, name, `What should ${name} play?`, `${name} should try a mage.`, NOWISO);
    run("INSERT INTO answer_details (intent_id, more, sources, asker_hash, created_at) VALUES (?, ?, ?, NULL, ?)", `q-${slug}`, `More for ${name}`, `Sources for ${name}`, NOWISO);
  }
  run("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?), (?, ?)", `q-${SLUG}`, ids.answerHash, `q-${OTHER_SLUG}`, ids.otherAnswerHash);
  // answer buttons: one detail row bound to the person as asker (private answer), a vote by each person
  run("INSERT INTO answer_details (intent_id, more, asker_hash, created_at) VALUES ('q-private-me', 'private', ?, ?), ('q-private-other', 'private', ?, ?)", ids.answerHash, NOWISO, ids.otherAnswerHash, NOWISO);
  run("INSERT INTO answer_feedback (intent_id, user_hash, vote, created_at) VALUES ('q-x', ?, 1, ?), ('q-x', ?, -1, ?)", ids.answerHash, NOWISO, ids.otherAnswerHash, NOWISO);
  // saved settings and sessions keyed by the user key
  for (const k of [ids.userKey, ids.otherUserKey]) {
    run("INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (?, 'prefs', 'e', '{}', 1)", k);
    run("INSERT INTO sessions (token_hash, user_key, created_at, expires_at, last_seen) VALUES (?, ?, 1, 2, 3)", (k === ids.userKey ? "c" : "d").repeat(64), k);
  }
  // kv_state: budget rows, a vote with a ballot from each, the untouched board documents, the roster that lets the member key find its Discord id
  const kv = (key, value) => run("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)", key, typeof value === "string" ? value : JSON.stringify(value), NOWISO);
  for (const h of [ids.budgetId, ids.budgetSlug, ids.otherBudget]) kv(`ai_budget:2026-11-01:user:${h}`, { neurons: 5, asks: 1 });
  kv("ai_budget:2026-11-01", { neurons: 9 });
  kv("votes:index", { ids: ["aaaa1111"] });
  kv("vote:aaaa1111", { id: "aaaa1111", title: "Pick", choices: ["a", "b"], created_at: NOWISO, closes_at: LATER, ballots: { [ids.ballot]: 0, [ids.otherBallot]: 1 } });
  kv("discord_members", [{ slug: SLUG, name: NAME, match: [], id: ME }, { slug: OTHER_SLUG, name: OTHER_NAME, match: [], id: OTHER }]);
  kv("party", { members: [{ name: NAME }] });
  return { db, ids };
}

// every string a leftover row could be keyed by or carry, for this member
const needles = (ids) => [ME, ids.userKey, ids.answerHash, ids.budgetId, ids.budgetSlug, ids.ballot, SLUG, NAME, DISPLAY, "ciphertext-me", "gh-me"];
function scan(db, list, { skipKv = [] } = {}) {
  const hits = [];
  for (const { name: table } of db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const { name: col } of db.raw.prepare(`PRAGMA table_info("${table}")`).all()) {
      for (const n of list) {
        const where = table === "kv_state" && skipKv.length ? ` AND key NOT IN (${skipKv.map(() => "?").join(",")})` : "";
        const c = db.raw.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE CAST("${col}" AS TEXT) LIKE ?${where}`).get(`%${n}%`, ...(table === "kv_state" ? skipKv : [])).c;
        if (c) hits.push(`${table}.${col} has ${c} row(s) containing ${n.slice(0, 12)}...`);
      }
    }
  }
  return hits;
}
const count = (db, sql, ...a) => db.raw.prepare(sql).get(...a).c;

test("DATA_MAP names every table in schema.sql, and nothing that is not there", () => {
  assert.deepEqual(Object.keys(DATA_MAP).sort(), [...TABLES].sort());
  for (const [t, e] of Object.entries(DATA_MAP)) {
    assert.ok("links" in e && "erase" in e && "member" in e, t);
    if (e.erase !== null) assert.ok(e.links, `${t}: an erase rule needs a stated link`);
  }
});

test("member key erase: zero rows keyed by this member's ids or hashes in any column of any table, bystander untouched", async () => {
  const { db, ids } = await seeded(), e = env(db);
  const before = scan(db, needles(ids));
  assert.ok(before.length >= 20, `the seed must reach many tables, got ${before.length}`);
  const hitTables = new Set(before.map((h) => h.split(".")[0]));
  for (const t of ["ask_turn_askers", "users", "identities", "sessions_v2", "provider_tokens", "memberships", "characters", "signups_v2", "audit_log", "members", "sheet_events", "dispatches", "intents", "fact_fixes", "ask_turns", "answer_details", "answer_feedback", "user_state", "sessions", "kv_state"]) assert.ok(hitTables.has(t), `seed misses ${t}`);

  const res = await call(e, "POST", "/api/me/erase", { Origin: "https://leeroy.test", ...asKey }, JSON.stringify({ confirm: CONFIRM_PHRASE }));
  assert.equal(res.status, 200);

  // the roster and the party card are the documented exceptions: still there, and the response says so
  assert.deepEqual(scan(db, needles(ids), { skipKv: UNTOUCHED_KV }), []);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM kv_state WHERE key = 'discord_members'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM kv_state WHERE key = 'party'"), 1);
  assert.ok((await res.json()).not_erased.some((s) => /kv_state/.test(s) && /party/.test(s)));

  // tables with no column that mentions the person: check them through their links
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM builds WHERE character_id = 'c-me'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM character_profiles WHERE character_id = 'c-me'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM group_slots WHERE character_id = 'c-me'"), 0);
  assert.equal(count(db, "SELECT status AS c FROM group_slots WHERE slot_index = 0"), "open");
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM humans WHERE id = 'h-me'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM human_members WHERE discord_user_id = ?", ME), 0);
  // the answer text behind More/Sources and the cached budget rows are gone; the vote stays, minus the ballot
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM answer_details WHERE intent_id IN ('q-red-fox', 'q-private-me')"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM kv_state WHERE key LIKE 'ai_budget:%:user:%'"), 1);
  const vote = JSON.parse(db.raw.prepare("SELECT json FROM kv_state WHERE key = 'vote:aaaa1111'").get().json);
  assert.deepEqual(vote.ballots, { [ids.otherBallot]: 1 });
  assert.equal(vote.title, "Pick");

  // exactly one new audit row: an erase with no actor, no tenant and a target that is not derived from the person
  const audit = db.raw.prepare("SELECT * FROM audit_log WHERE action = 'erase'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_discord_user_id, null);
  assert.equal(audit[0].tenant_id, null);
  assert.equal(audit[0].detail_json, "{}");
  for (const s of [`discord:${ME}`, `slug:${SLUG}`]) assert.notEqual(audit[0].target, await sha256Hex(`${USER_SALT}:erase:${s}`));

  // the bystander keeps every row
  const keep = [
    ["SELECT COUNT(*) AS c FROM users WHERE discord_user_id = ?", OTHER], ["SELECT COUNT(*) AS c FROM identities WHERE discord_user_id = ?", OTHER],
    ["SELECT COUNT(*) AS c FROM sessions_v2 WHERE discord_user_id = ?", OTHER], ["SELECT COUNT(*) AS c FROM provider_tokens WHERE discord_user_id = ?", OTHER],
    ["SELECT COUNT(*) AS c FROM memberships WHERE discord_user_id = ?", OTHER], ["SELECT COUNT(*) AS c FROM characters WHERE discord_user_id = ?", OTHER],
    ["SELECT COUNT(*) AS c FROM signups_v2 WHERE user_id = ?", OTHER], ["SELECT COUNT(*) AS c FROM audit_log WHERE actor_discord_user_id = ?", OTHER],
    ["SELECT COUNT(*) AS c FROM human_members WHERE discord_user_id = ?", OTHER], ["SELECT COUNT(*) AS c FROM humans WHERE id = 'h-shared'"],
    ["SELECT COUNT(*) AS c FROM builds WHERE character_id = 'c-other'"], ["SELECT COUNT(*) AS c FROM character_profiles WHERE character_id = 'c-other'"],
    ["SELECT COUNT(*) AS c FROM group_slots WHERE character_id = 'c-other'"],
    ["SELECT COUNT(*) AS c FROM user_state WHERE user_key = ?", ids.otherUserKey], ["SELECT COUNT(*) AS c FROM sessions WHERE user_key = ?", ids.otherUserKey],
    ["SELECT COUNT(*) AS c FROM ask_turn_askers WHERE asker_hash = ?", ids.otherAnswerHash],
    ["SELECT COUNT(*) AS c FROM answer_feedback WHERE user_hash = ?", ids.otherAnswerHash], ["SELECT COUNT(*) AS c FROM answer_details WHERE asker_hash = ?", ids.otherAnswerHash],
    ["SELECT COUNT(*) AS c FROM kv_state WHERE key = ?", `ai_budget:2026-11-01:user:${ids.otherBudget}`], ["SELECT COUNT(*) AS c FROM kv_state WHERE key = 'ai_budget:2026-11-01'"],
    ["SELECT COUNT(*) AS c FROM members WHERE slug = ?", OTHER_SLUG], ["SELECT COUNT(*) AS c FROM ask_turns WHERE by_name = ?", OTHER_NAME],
    ["SELECT COUNT(*) AS c FROM answer_details WHERE intent_id = ?", `q-${OTHER_SLUG}`], ["SELECT COUNT(*) AS c FROM sheet_events WHERE slug = ?", OTHER_SLUG],
    ["SELECT COUNT(*) AS c FROM dispatches WHERE slug = ?", OTHER_SLUG], ["SELECT COUNT(*) AS c FROM fact_fixes WHERE by_name = ?", OTHER_NAME], ["SELECT COUNT(*) AS c FROM intents WHERE slug = ?", OTHER_SLUG],
  ];
  for (const [sql, ...a] of keep) assert.equal(count(db, sql, ...a), 1, sql);
});

test("web session erase: everything keyed by the Discord id or its hashes is gone; rows found only by name stay (stated)", async () => {
  const { db, ids } = await seeded(), e = env(db);
  db.raw.prepare("INSERT INTO ask_turns (id, by_name, question, status, created_at) VALUES ('q-legacy', ?, 'legacy question', 'answered', ?)").run(NAME, NOWISO); // no asker row
  db.raw.prepare("INSERT INTO ask_turn_legacy (intent_id) VALUES ('q-legacy')").run(); // existed when migration 0009 ran
  const res = await call(e, "POST", "/api/me/erase", { Origin: "https://leeroy.test", ...asCookie }, JSON.stringify({ confirm: CONFIRM_PHRASE }));
  assert.equal(res.status, 200);
  const byId = [ME, ids.userKey, ids.answerHash, ids.budgetId, ids.ballot, DISPLAY, "ciphertext-me", "gh-me"];
  assert.deepEqual(scan(db, byId, { skipKv: UNTOUCHED_KV }), []);
  // a web session cannot be tied to a slug, so the slug-keyed rows are still there and the response says so
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM sheet_events WHERE slug = ?", SLUG), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-legacy'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turns WHERE id = ?", `q-${SLUG}`), 0, "the question with the asker hash is found without a name");
  assert.ok((await res.json()).not_erased.some((x) => /member-key request/.test(x)));
});

test("a second erase of the same person is harmless", async () => {
  const { db } = await seeded(), e = env(db);
  const go = () => call(e, "POST", "/api/me/erase", { Origin: "https://leeroy.test", ...asCookie }, JSON.stringify({ confirm: CONFIRM_PHRASE }));
  assert.equal((await go()).status, 200);
  assert.equal((await go()).status, 401, "the session died with the erase");
});

test("member export carries every section DATA_MAP promises, with the seeded rows in it and no secrets", async () => {
  const { db, ids } = await seeded(), e = env(db);
  const res = await call(e, "GET", "/api/me/export", asKey);
  assert.equal(res.status, 200);
  const text = await res.text(), body = JSON.parse(text);
  const sections = new Set(Object.values(DATA_MAP).flatMap((x) => (x.member ? x.member.split(",").map((p) => p.trim()) : [])));
  assert.equal(sections.size, 24);
  for (const path of sections) {
    const [top, name] = path.split(".");
    const rows = body[top] && body[top][name];
    assert.ok(Array.isArray(rows) && rows.length >= 1, `export is missing rows for ${path}`);
  }
  assert.deepEqual(body.legacy.vote_ballots, [{ vote_id: "aaaa1111", title: "Pick", choice: 0 }]);
  assert.equal(body.legacy.answer_feedback.length, 1);
  assert.equal(body.legacy.ai_budget.length, 2); // the Discord-id key and the slug key
  assert.equal(body.legacy.answer_details.length, 2); // the private-answer row and the row for the person's own Ask turn
  for (const secret of ["ciphertext-me", await webSessionHash(TOKEN), ids.ballot, "token_hash", "key_hash"]) assert.ok(!text.includes(secret), `export leaks ${secret}`);
});

test("every table an erase touches is in the admin backup, except the three that hold only login secrets", async () => {
  const { db } = await seeded(), e = env(db);
  const res = await call(e, "GET", "/api/admin/export", { Authorization: `Bearer ${ADMIN}` });
  const exported = new Set((await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === "table").map((l) => l.table));
  const erased = Object.entries(DATA_MAP).filter(([, x]) => x.erase !== null).map(([t]) => t);
  const missing = erased.filter((t) => !exported.has(t)).sort();
  assert.deepEqual(missing, ["provider_tokens", "sessions", "sessions_v2"]);
  for (const t of missing) assert.ok(EXCLUDED_TABLES[t], `${t} must be an explicit, reasoned exclusion`);
  // and each of those three is in the member export (token columns stripped), so the person still sees it
  for (const t of missing) assert.ok(DATA_MAP[t].member, t);
  // what the backup leaves out is only what export.js names; the rows this change reaches (budget, ballots, answer text, votes) are in it
  assert.deepEqual([...exported].sort(), TABLES.filter((t) => !EXCLUDED_TABLES[t]).sort());
  for (const [table, expect] of [["answer_feedback", 2], ["answer_details", 4], ["kv_state", 8]]) {
    const page = await call(e, "GET", `/api/admin/export?table=${table}`, { Authorization: `Bearer ${ADMIN}` });
    const rows = (await page.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === "row");
    assert.equal(rows.length, expect, table);
  }
});

test("the Durable Object keeps no state: no storage call anywhere in room.js, and it runs with storage that throws", async () => {
  assert.equal(DURABLE_OBJECT_STATE.BoardRoom.startsWith("none"), true);
  const src = readFileSync(new URL("../../infrastructure/worker/room.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.storage\b|getAlarm|setAlarm|transaction/.test(src), "room.js must not use Durable Object storage");
  const sent = [];
  const ctx = { setWebSocketAutoResponse() {}, getWebSockets: () => [{ send: (m) => sent.push(m) }], get storage() { throw new Error("storage touched"); }, acceptWebSocket() {} };
  const room = new BoardRoom(ctx, {});
  const res = await room.fetch(new Request("https://room.internal/broadcast", { method: "POST", body: JSON.stringify({ type: "ask" }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, ['{"type":"ask"}']);
});

// ---- (3) a nickname that equals a member's name must not pull in, or delete, someone else's questions
test("nickname collision: a stranger who asked under the name Red Fox is neither exported nor erased; a legacy row (existed before migration 0009) still is", async () => {
  const { db, ids } = await seeded(), e = env(db);
  const r = db.raw;
  // a non-roster Discord user whose nickname is "Red Fox": their question carries their own asker hash
  r.prepare("INSERT INTO ask_turns (id, by_name, question, answer, status, created_at) VALUES ('q-stranger', ?, 'stranger question', 'stranger answer', 'answered', ?)").run(NAME, NOWISO);
  r.prepare("INSERT INTO ask_turn_askers (intent_id, asker_hash) VALUES ('q-stranger', ?)").run(ids.otherAnswerHash);
  r.prepare("INSERT INTO answer_details (intent_id, more, created_at) VALUES ('q-stranger', 'stranger detail', ?)").run(NOWISO);
  // a row written before migration 0009 has no asker row, so only the name can find it
  r.prepare("INSERT INTO ask_turns (id, by_name, question, answer, status, created_at) VALUES ('q-legacy', ?, 'legacy question', 'legacy answer', 'answered', ?)").run(NAME, NOWISO);
  r.prepare("INSERT INTO ask_turn_legacy (intent_id) VALUES ('q-legacy')").run();
  r.prepare("INSERT INTO answer_details (intent_id, more, created_at) VALUES ('q-legacy', 'legacy detail', ?)").run(NOWISO);

  const exp = await (await call(e, "GET", "/api/me/export", asKey)).text();
  assert.ok(exp.includes("legacy question"), "a row with no asker row is still exported by name");
  assert.ok(exp.includes(`What should ${NAME} play?`), "the member's own hashed question is exported");
  assert.ok(!exp.includes("stranger question") && !exp.includes("stranger detail"), "the stranger's rows leaked into the member's export");

  const res = await call(e, "POST", "/api/me/erase", { Origin: "https://leeroy.test", ...asKey }, JSON.stringify({ confirm: CONFIRM_PHRASE }));
  assert.equal(res.status, 200);
  const has = (sql, ...a) => count(db, sql, ...a);
  assert.equal(has("SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-stranger'"), 1, "the stranger's question was erased");
  assert.equal(has("SELECT COUNT(*) AS c FROM answer_details WHERE intent_id = 'q-stranger'"), 1, "the stranger's answer text was erased");
  assert.equal(has("SELECT COUNT(*) AS c FROM ask_turn_askers WHERE intent_id = 'q-stranger'"), 1);
  assert.equal(has("SELECT COUNT(*) AS c FROM ask_turns WHERE id IN ('q-legacy', ?)", `q-${SLUG}`), 0);
  assert.equal(has("SELECT COUNT(*) AS c FROM answer_details WHERE intent_id IN ('q-legacy', ?)", `q-${SLUG}`), 0);
  assert.ok((await res.json()).not_erased.some((x) => /not on the roster/.test(x)));
});

test("a web session finds the member's questions by asker hash (no name needed)", async () => {
  const { db } = await seeded(), e = env(db);
  const body = await (await call(e, "GET", "/api/me/export", asCookie)).json();
  assert.deepEqual(body.legacy.ask_turns.map((x) => x.id), [`q-${SLUG}`]);
});

// ---- (4) the ballot is removed inside the database, so a vote cast at the same moment is not overwritten
test("erase does not lose a ballot cast between its read and its write (json_remove, not a rewrite of the document)", async () => {
  const { db, ids } = await seeded(), e = env(db);
  const batch = e.DB.batch;
  e.DB.batch = async (list) => { // another request lands just before the erase batch runs
    db.raw.prepare("UPDATE kv_state SET json = json_set(json, '$.ballots.late', 1) WHERE key = 'vote:aaaa1111'").run();
    return batch(list);
  };
  const res = await call(e, "POST", "/api/me/erase", { Origin: "https://leeroy.test", ...asKey }, JSON.stringify({ confirm: CONFIRM_PHRASE }));
  assert.equal(res.status, 200);
  const vote = JSON.parse(db.raw.prepare("SELECT json FROM kv_state WHERE key = 'vote:aaaa1111'").get().json);
  assert.deepEqual(vote.ballots, { [ids.otherBallot]: 1, late: 1 });
  const src = readFileSync(new URL("../../infrastructure/worker/data-rights.js", import.meta.url), "utf8");
  assert.match(src, /json_remove\(json, \?\)/);
});

test("votes that left votes:index are cleaned too", async () => {
  const { db, ids } = await seeded(), e = env(db);
  db.raw.prepare("DELETE FROM kv_state WHERE key = 'votes:index'").run();
  await call(e, "POST", "/api/me/erase", { Origin: "https://leeroy.test", ...asKey }, JSON.stringify({ confirm: CONFIRM_PHRASE }));
  const vote = JSON.parse(db.raw.prepare("SELECT json FROM kv_state WHERE key = 'vote:aaaa1111'").get().json);
  assert.deepEqual(vote.ballots, { [ids.otherBallot]: 1 });
});

// ---- (5) an erased key stops working for writes at once, even in another running copy of the Worker
test("a member key erased elsewhere is refused on a write at once; reads keep the 15 minute cache and the response says so", async () => {
  const { db } = await seeded(), e = env(db);
  const mk = (method) => new Request("https://api.test/api/intent", { method, headers: asKey });
  assert.deepEqual(await authenticate(mk("GET"), e), { slug: SLUG }); // primes this isolate's cache
  db.raw.prepare("DELETE FROM members WHERE slug = ?").run(SLUG); // the erase happened in another isolate
  assert.deepEqual(await authenticate(mk("GET"), e), { slug: SLUG }, "reads still use the cache (the stated window)");
  assert.equal(await authenticate(mk("POST"), e), null, "a write must re-check the table");
  assert.equal(await authenticate(mk("GET"), e), null, "the re-check refreshed the cache");
  assert.equal(await authenticate(mk("DELETE"), e), null);
});

// ---- (1) ownership must not fail open: a new question whose hash was not written is never matched by name
const OWNER = { Origin: "https://leeroy.test" }, CONFIRM = JSON.stringify({ confirm: CONFIRM_PHRASE });
test("a new question without an asker row (hash write failed or skipped) is neither exported nor erased by a same-name member", async () => {
  const { db } = await seeded(), e = env(db);
  // as if the hash write had failed: a NEW row, same name as the member, no asker row, and not in ask_turn_legacy
  db.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, status, created_at) VALUES ('q-unowned', ?, 'unowned question', 'unowned answer', 'answered', ?)").run(NAME, NOWISO);
  db.raw.prepare("INSERT INTO answer_details (intent_id, more, created_at) VALUES ('q-unowned', 'unowned detail', ?)").run(NOWISO);
  const exp = await (await call(e, "GET", "/api/me/export", asKey)).text();
  assert.ok(!exp.includes("unowned question") && !exp.includes("unowned detail"), "a same-name member's export reached a new unowned question");
  assert.equal((await call(e, "POST", "/api/me/erase", { ...OWNER, ...asKey }, CONFIRM)).status, 200);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-unowned'"), 1, "a same-name member's erase deleted a new unowned question");
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM answer_details WHERE intent_id = 'q-unowned'"), 1);
});

test("insertAskTurn: the question and its asker rows are one batch; if the hash write fails the question is not stored either", async () => {
  const { db } = await seeded();
  const e = { ...env(db) };
  const real = db.prepare;
  e.DB = { ...db, prepare: (sql) => { const st = real(sql); return /INSERT OR IGNORE INTO ask_turn_askers/.test(sql) ? { ...st, bind: () => ({ _run: () => { throw new Error("D1_ERROR: disk I/O error"); }, run: async () => { throw new Error("disk I/O error"); } }) } : st; } };
  await assert.rejects(insertAskTurn(e, { id: "q-atomic", byName: NAME, question: "x", provider: "p", share: true, createdAt: NOWISO }, { discordId: ME, slug: SLUG }), /disk I\/O/);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-atomic'"), 0, "the ask row must roll back with the failed hash write");
});

test("insertAskTurn: no migration yet (table missing) still stores the question, as a row that is never matched by name; a visitor is stored alone", async () => {
  const { db } = await seeded(), e = env(db);
  db.raw.exec("DROP TABLE ask_turn_askers");
  const log = console.error; console.error = () => {};
  try { await insertAskTurn(e, { id: "q-nomig", byName: NAME, question: "x", provider: "p", share: true, createdAt: NOWISO }, { discordId: ME, slug: SLUG }); } finally { console.error = log; }
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-nomig'"), 1);
  await insertAskTurn(e, { id: "q-visitor", byName: "Visitor", question: "x", provider: "p", share: true, createdAt: NOWISO }, {});
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-visitor'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turn_legacy"), 0, "new rows are never marked legacy");
});

// ---- (2) a roster member's Discord questions are found with the board key, whichever credential asked
test("a Discord question by a roster member carries both hashes and is found by a board key whose roster entry has no Discord id", async () => {
  const { db, ids } = await seeded(), e = env(db);
  db.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'discord_members'").run(JSON.stringify([{ slug: SLUG, name: NAME, match: [] }, { slug: OTHER_SLUG, name: OTHER_NAME, match: [], id: OTHER }])); // no id: the key cannot derive the Discord hash
  await insertAskTurn(e, { id: "q-discord", byName: NAME, question: "asked on discord", provider: "p", share: true, createdAt: NOWISO }, { discordId: ME, slug: SLUG });
  const hashes = db.raw.prepare("SELECT asker_hash FROM ask_turn_askers WHERE intent_id = 'q-discord' ORDER BY asker_hash").all().map((r) => r.asker_hash);
  assert.deepEqual(hashes, [ids.answerHash, await slugAskerHash({ USER_SALT }, SLUG)].sort());
  const exp = await (await call(e, "GET", "/api/me/export", asKey)).json();
  assert.ok(exp.legacy.ask_turns.some((q) => q.id === "q-discord"), "the board key did not find the Discord question");
  assert.equal(exp.tenancy, null, "this key has no Discord id, so only the handle hash can find it");
  assert.equal((await call(e, "POST", "/api/me/erase", { ...OWNER, ...asKey }, CONFIRM)).status, 200);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-discord'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM ask_turn_askers WHERE intent_id = 'q-discord'"), 0);
});

test("a Discord question by someone not on the roster carries their Discord-id hash, so a web sign-in finds it; nothing else does", async () => {
  const { db, ids } = await seeded(), e = env(db);
  await insertAskTurn(e, { id: "q-nonroster", byName: "SomeNick", question: "from a non-roster user", provider: "p", share: true, createdAt: NOWISO }, { discordId: ME, slug: null });
  const web = await (await call(e, "GET", "/api/me/export", asCookie)).json();
  assert.ok(web.legacy.ask_turns.some((q) => q.id === "q-nonroster"));
  const other = await (await call(e, "GET", "/api/me/export", { Authorization: `Board ${OTHER_KEY}` })).text();
  assert.ok(!other.includes("from a non-roster user"));
});

// ---- (3) the work to find a member's ballots does not grow with every vote they never joined
test("erase and export look for ballots 40 votes per query and read or edit only the votes the member voted in", async () => {
  const { db, ids } = await seeded(), e = env(db);
  for (let i = 0; i < 130; i++) db.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(`vote:${(i + 0x1000).toString(16).padStart(8, "0")}`, JSON.stringify({ id: "x", title: "old", choices: ["a"], ballots: { [`h${i}`]: 0 } }), NOWISO);
  const sqls = [], real = e.DB.prepare;
  e.DB = { ...e.DB, prepare: (sql) => { sqls.push(sql); return real(sql); } };
  const exp = await (await call(e, "GET", "/api/me/export", asKey)).json();
  assert.deepEqual(exp.legacy.vote_ballots, [{ vote_id: "aaaa1111", title: "Pick", choice: 0 }]);
  const probes = sqls.filter((q) => /^SELECT key FROM kv_state WHERE \(key = \?/.test(q));
  assert.equal(probes.length, Math.ceil(131 / 40), "one probe per 40 votes");
  assert.equal(sqls.filter((q) => /^SELECT json FROM kv_state WHERE key = \?$/.test(q)).length <= 2, true, "documents are read only for the votes the member joined (plus the auth roster read)");
  sqls.length = 0;
  assert.equal((await call(e, "POST", "/api/me/erase", { ...OWNER, ...asKey }, CONFIRM)).status, 200);
  assert.equal(sqls.filter((q) => /json_remove/.test(q)).length, 1, "one edit, for the one vote the member joined");
  const left = JSON.parse(db.raw.prepare("SELECT json FROM kv_state WHERE key = 'vote:aaaa1111'").get().json);
  assert.deepEqual(left.ballots, { [ids.otherBallot]: 1 });
});
