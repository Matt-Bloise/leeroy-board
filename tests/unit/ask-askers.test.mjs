// B43 follow-ups: (a) refuse an identifiable ask without USER_SALT, (b) web-session not_erased wording, (c) backfill of the migration-0009 gap,
// (e) export reads votes in IN(...) chunks, (f) every ask_turns insert site writes asker rows and migration 0009 itself runs.
// Real SQLite, made-up ids, no network. Run: node --test tests/unit/ask-askers.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { insertAskTurn, userHash, slugAskerHash } from "../../infrastructure/worker/answer-ux.js";
import { SaltMissingError } from "../../infrastructure/worker/salts.js";
import { backfillAskLegacy } from "../../infrastructure/scripts/backfill-ask-legacy.mjs";
import { handleDataRights, _resetDataRights } from "../../infrastructure/worker/data-rights.js";
import { webSessionHash, SESS_COOKIE } from "../../infrastructure/worker/web-auth.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { schemaDb, makeD1 } from "../helpers/sqlite-d1.mjs";

const ME = "100000000000000001", SLUG = "red-fox", USER_SALT = "user-salt-for-tests-0123456789", KEY_SALT = "salt-for-tests-0123456789";
const ROOT = new URL("../../", import.meta.url);
const ROW = (id) => ({ id, byName: "Red Fox", question: "q", provider: "p", share: true, createdAt: "2026-11-01T00:00:00.000Z" });
const n = (db, sql, ...a) => Number(db.raw.prepare(sql).get(...a).c);

// ---- (a)
test("insertAskTurn refuses an identifiable asker when USER_SALT is missing or short, and writes nothing", async () => {
  for (const salt of [undefined, "", "short"]) {
    const db = schemaDb();
    for (const who of [{ discordId: ME }, { slug: SLUG }, { discordId: ME, slug: SLUG }]) {
      await assert.rejects(insertAskTurn({ DB: db, USER_SALT: salt }, ROW("q-a"), who), (e) => e instanceof SaltMissingError);
    }
    assert.equal(n(db, "SELECT COUNT(*) AS c FROM ask_turns"), 0);
    await insertAskTurn({ DB: db, USER_SALT: salt }, ROW("q-visitor"), {}); // a visitor has no hash to lose
    assert.equal(n(db, "SELECT COUNT(*) AS c FROM ask_turns"), 1);
  }
});

// ---- (f) insert sites
test("every ask_turns insert goes through insertAskTurn, and every call site names who asked", () => {
  const dir = new URL("infrastructure/worker/", ROOT), files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  const inserts = [], calls = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+ask_turns\b/i.test(src)) inserts.push(f);
    for (const m of src.matchAll(/await insertAskTurn\(([^\n]*)\)/g)) calls.push({ f, args: m[1] });
  }
  assert.deepEqual(inserts, ["answer-ux.js"], "an ask_turns row must only be written by insertAskTurn");
  assert.deepEqual(calls.map((c) => c.f).sort(), ["discord.js", "discord.js", "index.js"], "the three known ask paths");
  for (const c of calls) assert.match(c.args, /(slug|discordId)/, `${c.f}: insertAskTurn call has no asker`);
});

test("insertAskTurn writes the asker rows: Discord-id hash and handle hash, handle only for a board key, none for a visitor", async () => {
  const db = schemaDb(), env = { DB: db, USER_SALT };
  await insertAskTurn(env, ROW("q-both"), { discordId: ME, slug: SLUG });
  await insertAskTurn(env, ROW("q-key"), { slug: SLUG });
  await insertAskTurn(env, ROW("q-web"), {});
  const hashes = (id) => db.raw.prepare("SELECT asker_hash FROM ask_turn_askers WHERE intent_id = ?").all(id).map((r) => r.asker_hash).sort();
  assert.deepEqual(hashes("q-both"), [await userHash(env, ME), await slugAskerHash(env, SLUG)].sort());
  assert.deepEqual(hashes("q-key"), [await slugAskerHash(env, SLUG)]);
  assert.deepEqual(hashes("q-web"), []);
});

// ---- (f) migration 0009 runs
test("migration 0009 applies on a database that has only the pre-0009 tables and leaves the expected schema", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("infrastructure/schema.sql", ROOT), "utf8").split(/CREATE TABLE IF NOT EXISTS ask_turn_askers/)[0]); // everything before the 0009 tables
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('ask_turn_askers','ask_turn_legacy')").all().length, 0, "fixture must be pre-0009");
  raw.prepare("INSERT INTO ask_turns (id, by_name, question, status, created_at) VALUES ('old-1', 'Red Fox', 'q', 'answered', 'x'), ('old-2', 'Red Fox', 'q', 'answered', 'x')").run();
  const sql = readFileSync(new URL("infrastructure/migrations/0009_ask_turn_askers.sql", ROOT), "utf8");
  raw.exec(sql);
  const cols = (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`);
  assert.deepEqual(cols("ask_turn_askers"), ["intent_id:TEXT:1:1", "asker_hash:TEXT:1:2"]);
  assert.deepEqual(cols("ask_turn_legacy"), ["intent_id:TEXT:0:1"]);
  assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ask_turn_askers_hash' AND tbl_name='ask_turn_askers'").get(), "hash index");
  assert.deepEqual(raw.prepare("SELECT intent_id FROM ask_turn_legacy ORDER BY 1").all().map((r) => r.intent_id), ["old-1", "old-2"], "existing questions are marked legacy");
  assert.throws(() => raw.prepare("INSERT INTO ask_turn_askers VALUES ('q', 'tooshort')").run(), /CHECK/);
  assert.throws(() => raw.prepare("INSERT INTO ask_turn_askers VALUES ('', ?)").run("a".repeat(64)), /CHECK/);
  raw.exec(sql); // a re-run is harmless: IF NOT EXISTS / INSERT OR IGNORE
  assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM ask_turn_legacy").get().c, 2);
});

test("schema.sql mirrors migration 0009 for both tables", () => {
  const db = schemaDb();
  for (const t of ["ask_turn_askers", "ask_turn_legacy"]) assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
});

// ---- (c) backfill
test("backfill marks only unhashed, unmarked rows inside the --after/--before window; dry-run changes nothing; a re-run is a no-op", async () => {
  const db = schemaDb(), env = { DB: db, USER_SALT };
  const raw = (id, at) => db.raw.prepare("INSERT INTO ask_turns (id, by_name, question, status, created_at) VALUES (?, 'Red Fox', 'q', 'answered', ?)").run(id, at);
  raw("gap-1", "2026-11-04T11:59:58.000Z"); raw("gap-2", "2026-11-04T11:59:59.000Z");
  raw("after", "2026-11-04T12:00:05.000Z"); // written by the new Worker's window: must not be marked
  raw("already", "2026-11-04T11:00:00.000Z"); db.raw.prepare("INSERT INTO ask_turn_legacy VALUES ('already')").run();
  raw("visitor", "2026-11-04T11:00:00.000Z"); db.raw.prepare("UPDATE ask_turns SET by_name = 'Visitor' WHERE id = 'visitor'").run(); // a web visitor: no asker row by design
  await insertAskTurn(env, ROW("hashed"), { discordId: ME }); // has an asker row
  const after = "2026-11-04T11:30:00Z", before = "2026-11-04T12:00:00Z";
  raw("too-old", "2026-11-04T10:00:00.000Z"); // an unhashed row from before migration 0009 ran: outside the window
  const dry = await backfillAskLegacy(db, { after, before, dryRun: true });
  assert.deepEqual(dry.ids.sort(), ["gap-1", "gap-2"]);
  assert.equal(n(db, "SELECT COUNT(*) AS c FROM ask_turn_legacy"), 1, "dry-run wrote something");
  const real = await backfillAskLegacy(db, { after, before });
  assert.equal(real.marked, 2);
  assert.deepEqual(db.raw.prepare("SELECT intent_id FROM ask_turn_legacy ORDER BY 1").all().map((r) => r.intent_id), ["already", "gap-1", "gap-2"]);
  assert.equal((await backfillAskLegacy(db, { after, before })).marked, 0);
  await assert.rejects(backfillAskLegacy(db, { before }), /--after/);
  await assert.rejects(backfillAskLegacy(db, { after }), /--before/);
  await assert.rejects(backfillAskLegacy(db, { after: before, before: after }), /earlier/);
});

// ---- (b) wording
test("the web sign-in erase answer says board-key questions asked after migration 0009 carry only the handle hash", async () => {
  invalidateConfigCache(); _resetDataRights();
  const db = schemaDb(), TOKEN = "A".repeat(43), th = await webSessionHash(TOKEN);
  const env = { DB: db, USER_SALT, KEY_SALT, DATA_RIGHTS: "on", WEB_LOGIN: "on" };
  db.raw.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'Fox', 'x')").run(ME);
  const exp = new Date(Date.now() + 86400000).toISOString();
  db.raw.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(th, ME, new Date().toISOString(), exp, new Date().toISOString());
  const req = new Request("https://api.test/api/me/erase", { method: "POST", headers: { Origin: "https://leeroy.test", Cookie: `${SESS_COOKIE}=${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "erase my data" }) });
  const res = await handleDataRights(req, env, { path: "/me/erase", now: Date.now() });
  assert.equal(res.status, 200);
  const lines = (await res.json()).not_erased.join("\n");
  assert.match(lines, /board key[^\n]*after migration 0009[^\n]*only your member-handle hash/);
});

// ---- (e) export queries
test("export reads vote documents with IN(...) chunks under D1's 100-parameter limit", async () => {
  const { default: worker } = await import("../../infrastructure/worker/index.js");
  const { voterHash } = await import("../../infrastructure/worker/votes.js");
  const db = schemaDb(), raw = db.raw;
  invalidateConfigCache();
  const th = await webSessionHash("B".repeat(43));
  raw.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'Fox', 'x')").run(ME);
  raw.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(th, ME, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  for (let i = 0; i < 200; i++) {
    const id = (0xabc000 + i).toString(16).padStart(8, "0");
    const ballots = i % 50 === 0 ? { [await voterHash(ME, id, USER_SALT)]: i % 3 } : {};
    raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(`vote:${id}`, JSON.stringify({ id, title: `T${i}`, choices: ["a"], ballots }));
  }
  const sqls = [], real = db.prepare;
  const e = { DB: { ...db, prepare: (sql) => { sqls.push({ sql, params: (sql.match(/\?/g) || []).length }); return real(sql); } }, USER_SALT, KEY_SALT, DATA_RIGHTS: "on", WEB_LOGIN: "on", ALLOWED_ORIGINS: "https://leeroy.test" };
  const res = await worker.fetch(new Request("https://api.test/api/me/export", { headers: { Cookie: `${SESS_COOKIE}=${"B".repeat(43)}`, "CF-Connecting-IP": "203.0.113.9" } }), e, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.legacy.vote_ballots.map((b) => b.title).sort(), ["T0", "T100", "T150", "T50"]);
  assert.ok(sqls.every((q) => q.params <= 100), "a statement exceeds D1's 100 bound parameters");
  assert.equal(sqls.filter((q) => /^SELECT key, json FROM kv_state WHERE key IN \(/.test(q.sql)).length, 3, "200 votes -> 3 IN(...) reads of at most 90 keys");
  assert.ok(sqls.filter((q) => /kv_state/.test(q.sql) && /vote/i.test(q.sql)).length <= 4, "query count for 200 votes stays small");
});

// ---- vote_ballots (PR 173, migration 0010): export and erase cover ballots kept as rows; bounded work per request
const OTHER = "100000000000000002", COOKIE_TOKEN = "C".repeat(43);
async function voteRig({ votes = 3, table = true, mine = [0], docBallotFor = [] } = {}) {
  const { default: worker } = await import("../../infrastructure/worker/index.js");
  const { voterHash } = await import("../../infrastructure/worker/votes.js");
  invalidateConfigCache(); _resetDataRights();
  const db = schemaDb(), raw = db.raw, th = await webSessionHash(COOKIE_TOKEN), now = new Date().toISOString();
  if (!table) raw.exec("DROP TABLE vote_ballots"); // schema.sql carries the table now (PR 173); drop it to model a database where migration 0010 was not applied
  for (const d of [ME, OTHER]) raw.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'P', 'x')").run(d);
  raw.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(th, ME, now, new Date(Date.now() + 86400000).toISOString(), now);
  const ids = [];
  for (let i = 0; i < votes; i++) {
    const id = (0xdef000 + i).toString(16).padStart(8, "0"); ids.push(id);
    const ballots = docBallotFor.includes(i) ? { [await voterHash(ME, id, USER_SALT)]: 1 } : {};
    raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(`vote:${id}`, JSON.stringify({ id, title: `Vote ${i}`, choices: ["a", "b", "c"], ballots }));
    if (table && mine.includes(i)) raw.prepare("INSERT INTO vote_ballots (vote_id, voter_hash, choice, cast_at) VALUES (?, ?, 2, 'x')").run(id, await voterHash(ME, id, USER_SALT));
    if (table) raw.prepare("INSERT INTO vote_ballots (vote_id, voter_hash, choice, cast_at) VALUES (?, ?, 0, 'x')").run(id, await voterHash(OTHER, id, USER_SALT));
  }
  // D1 counts a db.batch() call as ONE query toward the free plan's 50 per invocation (the per-statement limits still apply to each member),
  // so queries = prepared statements that are not members of a batch + one per batch. Members are recorded with their placeholder counts.
  let prepared = 0, batched = 0, batches = 0; const real = db.prepare, members = [];
  const env = { DB: { ...db, prepare: (sql) => { prepared++; return real(sql); }, batch: async (list) => { batches++; batched += list.length; for (const st of list) members.push(st.sql); return db.batch(list); } }, USER_SALT, KEY_SALT, DATA_RIGHTS: "on", WEB_LOGIN: "on", ALLOWED_ORIGINS: "https://leeroy.test" };
  const call = (path, method = "GET") => { prepared = 0; batched = 0; batches = 0; members.length = 0; return worker.fetch(new Request(`https://api.test${path}`, { method, headers: { Cookie: `${SESS_COOKIE}=${COOKIE_TOKEN}`, Origin: "https://leeroy.test", "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: method === "POST" ? JSON.stringify({ confirm: "erase my data" }) : undefined }), env, { waitUntil() {}, passThroughOnException() {} }); };
  return { raw, call, ids, statements: () => prepared, queries: () => prepared - batched + batches, members };
}

test("vote_ballots rows: the export lists the choice, the erase deletes the person's rows and leaves everyone else's", async () => {
  const r = await voteRig({ votes: 3, mine: [0, 2], docBallotFor: [1] });
  const exp = await (await r.call("/api/me/export")).json();
  assert.deepEqual(exp.legacy.vote_ballots.map((b) => [b.vote_id, b.title, b.choice]).sort(), [[r.ids[0], "Vote 0", 2], [r.ids[1], "Vote 1", 1], [r.ids[2], "Vote 2", 2]]);
  const res = await r.call("/api/me/erase", "POST");
  assert.equal(res.status, 200);
  assert.ok((await res.json()).erased_includes.join(" ").includes("per-ballot"));
  assert.equal(n({ raw: r.raw }, "SELECT COUNT(*) AS c FROM vote_ballots WHERE voter_hash IN (SELECT voter_hash FROM vote_ballots) AND vote_id IN (?, ?, ?)", ...r.ids), 3, "only the other person's three rows are left");
  assert.equal(r.raw.prepare("SELECT COUNT(*) AS c FROM vote_ballots").get().c, 3);
  assert.ok(!JSON.stringify(r.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(`vote:${r.ids[1]}`)).includes('\\"ballots\\":{\\"'), "the document ballot is gone too");
});

test("without the vote_ballots table (migration 0010 not applied) export and erase work and say nothing about it", async () => {
  const r = await voteRig({ votes: 2, table: false, docBallotFor: [0] });
  const exp = await r.call("/api/me/export");
  assert.equal(exp.status, 200);
  assert.deepEqual((await exp.json()).legacy.vote_ballots.map((b) => b.vote_id), [r.ids[0]]);
  assert.equal((await r.call("/api/me/erase", "POST")).status, 200);
});

test("work per request is bounded: at the maximum the statements stay under 50; one vote past it is a 413 that names the maximum and changes nothing", async () => {
  const { MAX_VOTES } = await import("../../infrastructure/worker/data-rights.js");
  const at = await voteRig({ votes: MAX_VOTES, mine: [0, MAX_VOTES - 1] });
  const exp = await at.call("/api/me/export");
  assert.equal(exp.status, 200);
  assert.equal((await exp.json()).legacy.vote_ballots.length, 2);
  assert.ok(at.queries() < 50, `export used ${at.queries()} queries at the maximum`);
  assert.equal((await at.call("/api/me/erase", "POST")).status, 200);
  assert.ok(at.queries() < 50, `erase used ${at.queries()} queries at the maximum`);
  assert.equal(at.raw.prepare("SELECT COUNT(*) AS c FROM vote_ballots").get().c, MAX_VOTES, "only the bystander rows remain");
  const over = await voteRig({ votes: MAX_VOTES + 1, mine: [0] });
  for (const [path, method] of [["/api/me/export", "GET"], ["/api/me/erase", "POST"]]) {
    const res = await over.call(path, method), body = await res.json();
    assert.equal(res.status, 413); assert.equal(body.error, "too_many_votes"); assert.equal(body.max_votes, MAX_VOTES);
    assert.ok(over.queries() < 50);
  }
  assert.equal(over.raw.prepare("SELECT COUNT(*) AS c FROM vote_ballots").get().c, MAX_VOTES + 2, "a refused erase changed nothing");
  assert.equal(over.raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, 2, "the account is still there");
});

// ---- erase query budget (free plan: 50 queries per invocation; one db.batch() counts as ONE). Worst case: MAX_VOTES votes, the person has a
// ballot in the document of every one AND a vote_ballots row for every one. The erase makes one json_remove edit per joined vote inside its batch.
test("worst-case erase (720 votes, a document ballot and a row ballot in each): under 50 queries, every batch member under 100 bound parameters, every ballot gone", async () => {
  const { MAX_VOTES } = await import("../../infrastructure/worker/data-rights.js");
  const all = Array.from({ length: MAX_VOTES }, (_, i) => i);
  const r = await voteRig({ votes: MAX_VOTES, mine: all, docBallotFor: all });
  const other = JSON.parse(r.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(`vote:${r.ids[5]}`).json);
  other.ballots.bystanderhash = 0; // someone else's document ballot must survive
  r.raw.prepare("UPDATE kv_state SET json = ? WHERE key = ?").run(JSON.stringify(other), `vote:${r.ids[5]}`);
  const res = await r.call("/api/me/erase", "POST");
  assert.equal(res.status, 200);
  const edits = r.members.filter((q) => /json_remove/.test(q)).length;
  assert.equal(edits, MAX_VOTES, "one edit per joined vote, inside the batch");
  assert.ok(r.queries() < 50, `erase used ${r.queries()} queries (non-batch statements + 1 per batch); budget: under 50`);
  for (const q of r.members) assert.ok((q.match(/\?/g) || []).length <= 100, `a batch member has more than 100 bound parameters: ${q.slice(0, 80)}`);
  const left = r.raw.prepare("SELECT key, json FROM kv_state WHERE key LIKE 'vote:%'").all();
  assert.equal(left.length, MAX_VOTES);
  assert.equal(left.reduce((sum, row) => sum + Object.keys(JSON.parse(row.json).ballots).length, 0), 1, "only the bystander's document ballot is left");
  assert.equal(r.raw.prepare("SELECT COUNT(*) AS c FROM vote_ballots").get().c, MAX_VOTES, "only the bystander's 720 rows are left");
});

test("erase only edits the votes the person joined", async () => {
  const r = await voteRig({ votes: 6, mine: [0, 1], docBallotFor: [2, 3] });
  assert.equal((await r.call("/api/me/erase", "POST")).status, 200);
  assert.equal(r.members.filter((q) => /json_remove/.test(q)).length, 2);
  assert.equal(r.raw.prepare("SELECT COUNT(*) AS c FROM vote_ballots").get().c, 6, "six bystander rows only");
});

// ---- voteIds: the limit is applied to vote keys only
test("a non-vote key that looks like one cannot hide a real vote from the maximum", async () => {
  const { MAX_VOTES } = await import("../../infrastructure/worker/data-rights.js");
  const r = await voteRig({ votes: MAX_VOTES + 1, table: false }); // no vote_ballots table: the document keys alone decide
  for (let i = 0; i < 5; i++) r.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, '{}', 'x')").run(`vote:-${String(i).padStart(7, "0")}`); // 13 characters, not hex: only the GLOB half of the predicate rejects them
  for (let i = 0; i < 5; i++) r.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, '{}', 'x')").run(`vote:000000000${i}`); // all hex but 9 characters: only the length half rejects them
  const res = await r.call("/api/me/export");
  assert.equal(res.status, 413, "721 real votes plus junk keys must still be over the maximum");
  const under = await voteRig({ votes: 3, table: false, docBallotFor: [0] });
  for (let i = 0; i < MAX_VOTES + 5; i++) under.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, '{}', 'x')").run(`vote:-${String(i).padStart(7, "0")}`);
  const ok = await under.call("/api/me/export");
  assert.equal(ok.status, 200, "junk keys are not votes and must not push a small board over the maximum");
  assert.equal((await ok.json()).legacy.vote_ballots.length, 1);
});

test("ballot rows whose vote document was deleted are still exported and erased", async () => {
  const r = await voteRig({ votes: 3, mine: [0, 1] });
  r.raw.prepare("DELETE FROM kv_state WHERE key = ?").run(`vote:${r.ids[0]}`);
  const exp = await (await r.call("/api/me/export")).json();
  assert.deepEqual(exp.legacy.vote_ballots.map((b) => [b.vote_id, b.title, b.choice]).sort(), [[r.ids[0], null, 2], [r.ids[1], "Vote 1", 2]]);
  assert.equal((await r.call("/api/me/erase", "POST")).status, 200);
  assert.equal(r.raw.prepare("SELECT COUNT(*) AS c FROM vote_ballots").get().c, 3, "only the bystander's rows remain, including the one under the deleted document");
});

test("a re-vote after migration 0010 (row) wins over the older choice in the document", async () => {
  const r = await voteRig({ votes: 1, mine: [0], docBallotFor: [0] }); // document says 1, row says 2
  const exp = await (await r.call("/api/me/export")).json();
  assert.deepEqual(exp.legacy.vote_ballots.map((b) => b.choice), [2]);
});

test("720 vote documents plus one ballot row for a vote with no document is over the maximum (the bound is checked after the union)", async () => {
  const { MAX_VOTES } = await import("../../infrastructure/worker/data-rights.js");
  const r = await voteRig({ votes: MAX_VOTES, mine: [0] });
  r.raw.prepare("INSERT INTO vote_ballots (vote_id, voter_hash, choice, cast_at) VALUES ('ffffffff', ?, 1, 'x')").run("e".repeat(64));
  for (const [path, method] of [["/api/me/export", "GET"], ["/api/me/erase", "POST"]]) assert.equal((await r.call(path, method)).status, 413, path);
  assert.equal(r.raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, 2, "a refused erase changed nothing");
});

test("erased_includes is stated only when ballots were looked for: not for a member key with no linked Discord id", async () => {
  const { default: worker } = await import("../../infrastructure/worker/index.js");
  const { sha256Hex } = await import("../../infrastructure/worker/crypto.js");
  const withDiscord = await voteRig({ votes: 1, mine: [0] });
  assert.ok(Array.isArray((await (await withDiscord.call("/api/me/erase", "POST")).json()).erased_includes));
  invalidateConfigCache(); _resetDataRights();
  const db = schemaDb(), KEY = "member-key-for-tests-0123456789ab", now = new Date().toISOString();
  db.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('red-fox', ?, ?)").run(await sha256Hex(`${KEY_SALT}:${KEY}`), now);
  db.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('discord_members', ?, ?)").run(JSON.stringify([{ slug: "red-fox", name: "Red Fox", match: [] }]), now); // no Discord id
  const env = { DB: db, USER_SALT, KEY_SALT, DATA_RIGHTS: "on", ALLOWED_ORIGINS: "https://leeroy.test" };
  const res = await worker.fetch(new Request("https://api.test/api/me/erase", { method: "POST", headers: { Authorization: `Board ${KEY}`, Origin: "https://leeroy.test", "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ confirm: "erase my data" }) }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).erased_includes, undefined, "no ballot query ran, so no ballot erasure is claimed");
});
