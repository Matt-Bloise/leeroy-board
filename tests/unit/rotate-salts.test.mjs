// tools/rotate-salts.mjs: the dry-run plan for rotating USER_SALT and KEY_SALT. Made-up salts and ids throughout; nothing real, nothing applied.
// Checks: the tool's formulas equal the Worker's own functions; the generated SQL, run on a real SQLite built from schema.sql, renames what is
// known, leaves what is not, is safe to run twice and reverses cleanly; no salt and no full hash reaches the screen; the inventory covers every
// salted site in the Worker and every hash-like column in the schema. Run: node --test tests/unit/rotate-salts.test.mjs
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { userKey } from "../../infrastructure/worker/account.js";
import { userHash } from "../../infrastructure/worker/answer-ux.js";
import { voterHash } from "../../infrastructure/worker/votes.js";
import { hashKey } from "../../infrastructure/worker/auth.js";
import { derive, readSalts, parseIds, readExportFacts, buildPlan, fullSql, formatPlan, parseArgv, INVENTORY, BREAKS, short } from "../../tools/rotate-salts.mjs";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const OLD_U = "old-user-salt-0123456789-abcdefghijklmnop", NEW_U = "N3w-Us3r-Salt-Qx7!Zm29-kLpT81vW5rYb04cD", OLD_K = "old-key-salt-0123456789-abcdefghijklmnopq", NEW_K = "N3w-K3y-Salt-Rw4#Hj62-mNqS90xZ7tVc18eF";
const IDS = ["100000000000000001", "100000000000000002", "100000000000000003"], STRANGER = "100000000000000999";
const TOOL = fileURLToPath(new URL("../../tools/rotate-salts.mjs", import.meta.url));
const SALTS = { USER: { old: OLD_U, neu: NEW_U }, KEY: { old: OLD_K, neu: NEW_K } };
const ENV = { OLD_USER_SALT: OLD_U, NEW_USER_SALT: NEW_U, OLD_KEY_SALT: OLD_K, NEW_KEY_SALT: NEW_K };
const VOTE = "0a1b2c3d";

test("the tool's formulas equal the Worker's own functions", async () => {
  for (const id of IDS) {
    assert.equal(derive.userKey(OLD_U, id), await userKey({ USER_SALT: OLD_U }, id));
    assert.equal(derive.answerUx(OLD_U, id), await userHash({ USER_SALT: OLD_U }, id));
    assert.equal(derive.voter(OLD_U, VOTE, id), await voterHash(id, VOTE, OLD_U));
  }
  assert.equal(derive.memberKey(OLD_K, "k".repeat(30)), await hashKey({ KEY_SALT: OLD_K }, "k".repeat(30)));
  assert.notEqual(derive.userKey(OLD_U, IDS[0]), derive.userKey(NEW_U, IDS[0]));
});

test("salts: all four from the environment, long enough, different, and the new ones strong; --only limits what is needed", () => {
  assert.deepEqual(Object.keys(readSalts(ENV).salts), ["USER", "KEY"]);
  assert.match(readSalts({}).errors.join(), /OLD_USER_SALT is not set/);
  assert.match(readSalts({ ...ENV, NEW_USER_SALT: "short" }).errors.join(), /NEW_USER_SALT must be at least 32/);
  assert.match(readSalts({ ...ENV, OLD_KEY_SALT: "tiny" }).errors.join(), /OLD_KEY_SALT must be at least 16/);
  assert.match(readSalts({ ...ENV, NEW_USER_SALT: OLD_U }).errors.join(), /same as OLD_USER_SALT/);
  assert.match(readSalts({ ...ENV, NEW_KEY_SALT: "a".repeat(40) }).errors.join(), /too few different characters/);
  assert.deepEqual(Object.keys(readSalts({ OLD_USER_SALT: OLD_U, NEW_USER_SALT: NEW_U }, "user").salts), ["USER"]);
  assert.deepEqual(Object.keys(readSalts({ OLD_KEY_SALT: OLD_K, NEW_KEY_SALT: NEW_K }, "key").salts), ["KEY"]);
  assert.equal(readSalts({ OLD_USER_SALT: OLD_U, NEW_USER_SALT: NEW_U }, "key").errors.length > 0, true);
});

test("ids: lines, a JSON array, or the discord_members shape; junk is counted and ignored", () => {
  assert.deepEqual(parseIds(`${IDS[0]}\n${IDS[1]}\n${IDS[0]}\nnot-an-id\n123`).ids, [IDS[0], IDS[1]]);
  assert.equal(parseIds(`${IDS[0]}\nnot-an-id`).ignored, 1);
  assert.deepEqual(parseIds(JSON.stringify(IDS)).ids, IDS);
  assert.deepEqual(parseIds(JSON.stringify([{ slug: "a", id: IDS[0] }, { slug: "b" }, { slug: "c", id: IDS[2] }])).ids, [IDS[0], IDS[2]]);
});

// ---- the SQL, run for real
function seed(withStranger = true) {
  const db = schemaDb(), r = db.raw, U = (id) => derive.userKey(OLD_U, id), A = (id) => derive.answerUx(OLD_U, id);
  for (const [i, id] of [...IDS, ...(withStranger ? [STRANGER] : [])].entries()) {
    r.prepare("INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (?, 'prefs', ?, ?, 1)").run(U(id), `e${i}`, `{"keys":{"n":{"v":"${i}","t":1}}}`);
    r.prepare("INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (?, 'seen', ?, '{\"keys\":{}}', 1)").run(U(id), `s${i}`);
    r.prepare("INSERT INTO sessions (token_hash, user_key, created_at, expires_at, last_seen) VALUES (?, ?, 1, 2, 3)").run(derive.memberKey("tok", String(i)), U(id));
    r.prepare("INSERT INTO answer_details (intent_id, more, asker_hash, created_at) VALUES (?, 'm', ?, 'now')").run(`d${i}`, A(id));
    r.prepare("INSERT INTO answer_feedback (intent_id, user_hash, vote, created_at) VALUES ('f1', ?, 1, 'now')").run(A(id));
  }
  const ballots = {}; for (const [i, id] of [...IDS, ...(withStranger ? [STRANGER] : [])].entries()) ballots[derive.voter(OLD_U, VOTE, id)] = i % 2;
  r.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'now')").run(`vote:${VOTE}`, JSON.stringify({ id: VOTE, title: "T", choices: ["a", "b"], ballots }));
  r.prepare("INSERT INTO guest_rate_limits (ip_hash, created_at) VALUES (?, 1), (?, 2)").run("1".repeat(64), "2".repeat(64));
  r.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ?, 'now')").run(derive.memberKey(OLD_K, "k".repeat(30)));
  return db;
}
const plan0 = (over = {}) => buildPlan({ salts: SALTS, ids: IDS, voteIds: [VOTE], slugs: ["santa"], ...over });
const run = (db, plan) => { for (const s of plan.steps) db.raw.exec(s.sql); };
const row = (db, sql) => db.raw.prepare(sql).get();
const keys = (db, table, col) => db.raw.prepare(`SELECT ${col} AS k FROM ${table}`).all().map((x) => x.k);

test("running the plan: known ids are renamed everywhere, the unknown id is untouched, rate limits are cleared, members are NOT touched", () => {
  const db = seed(), plan = plan0();
  run(db, plan);
  const U = (salt, id) => derive.userKey(salt, id), A = (salt, id) => derive.answerUx(salt, id);
  const us = keys(db, "user_state", "user_key");
  for (const id of IDS) { assert.equal(us.filter((k) => k === U(NEW_U, id)).length, 2, "both documents moved"); assert.equal(us.includes(U(OLD_U, id)), false); }
  assert.equal(us.filter((k) => k === U(OLD_U, STRANGER)).length, 2, "the stranger keeps the old key (orphaned)");
  assert.equal(us.includes(U(NEW_U, STRANGER)), false);
  assert.deepEqual(keys(db, "sessions", "user_key").sort(), [...IDS.map((i) => U(NEW_U, i)), U(OLD_U, STRANGER)].sort());
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM sessions").n, 4, "no session is deleted");
  assert.deepEqual(keys(db, "answer_details", "asker_hash").sort(), [...IDS.map((i) => A(NEW_U, i)), A(OLD_U, STRANGER)].sort());
  assert.deepEqual(keys(db, "answer_feedback", "user_hash").sort(), [...IDS.map((i) => A(NEW_U, i)), A(OLD_U, STRANGER)].sort());
  const ballots = JSON.parse(row(db, `SELECT json FROM kv_state WHERE key = 'vote:${VOTE}'`).json).ballots;
  assert.deepEqual(Object.keys(ballots).sort(), [...IDS.map((i) => derive.voter(NEW_U, VOTE, i)), derive.voter(OLD_U, VOTE, STRANGER)].sort());
  assert.deepEqual(IDS.map((id, i) => ballots[derive.voter(NEW_U, VOTE, id)]), [0, 1, 0], "each voter keeps their choice");
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM guest_rate_limits").n, 0);
  assert.equal(row(db, "SELECT key_hash FROM members").key_hash, derive.memberKey(OLD_K, "k".repeat(30)), "member key hashes are only re-issued by hand");
  assert.equal(plan.steps.some((s) => /members|account_keys/.test(s.sql)), false);
});

test("safe to run twice: the second run changes nothing", () => {
  const db = seed(), plan = plan0();
  run(db, plan);
  const snap = () => JSON.stringify([keys(db, "user_state", "user_key").sort(), keys(db, "sessions", "user_key").sort(), keys(db, "answer_feedback", "user_hash").sort(), row(db, `SELECT json FROM kv_state WHERE key = 'vote:${VOTE}'`).json]);
  const once = snap();
  run(db, plan);
  assert.equal(snap(), once);
});

test("a newer row already under the new key wins; the old duplicate is removed, not left behind", () => {
  const db = seed(), id = IDS[0];
  db.raw.prepare("INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (?, 'prefs', 'newer', '{\"keys\":{\"n\":{\"v\":\"fresh\",\"t\":9}}}', 99)").run(derive.userKey(NEW_U, id));
  db.raw.prepare("INSERT INTO answer_feedback (intent_id, user_hash, vote, created_at) VALUES ('f1', ?, -1, 'later')").run(derive.answerUx(NEW_U, id));
  run(db, plan0());
  const prefs = db.raw.prepare("SELECT etag, json FROM user_state WHERE user_key = ? AND doc = 'prefs'").all(derive.userKey(NEW_U, id));
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].etag, "newer");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM user_state WHERE user_key = ?").get(derive.userKey(OLD_U, id)).n, 0);
  assert.equal(db.raw.prepare("SELECT vote FROM answer_feedback WHERE user_hash = ?").get(derive.answerUx(NEW_U, id)).vote, -1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM answer_feedback WHERE user_hash = ?").get(derive.answerUx(OLD_U, id)).n, 0);
});

test("the reverse plan undoes a forward run for known ids", () => {
  const db = seed(), before = JSON.stringify([keys(db, "user_state", "user_key").sort(), keys(db, "sessions", "user_key").sort(), keys(db, "answer_details", "asker_hash").sort(), JSON.parse(row(db, `SELECT json FROM kv_state WHERE key = 'vote:${VOTE}'`).json).ballots && Object.keys(JSON.parse(row(db, `SELECT json FROM kv_state WHERE key = 'vote:${VOTE}'`).json).ballots).sort()]);
  run(db, plan0());
  run(db, plan0({ reverse: true }));
  const after = JSON.stringify([keys(db, "user_state", "user_key").sort(), keys(db, "sessions", "user_key").sort(), keys(db, "answer_details", "asker_hash").sort(), Object.keys(JSON.parse(row(db, `SELECT json FROM kv_state WHERE key = 'vote:${VOTE}'`).json).ballots).sort()]);
  assert.equal(after, before);
});

test("the verification queries: BEFORE counts the old rows, AFTER shows zero left and the same number under the new keys", () => {
  const db = seed(), plan = plan0();
  const before = row(db, plan.checks.before[0].sql);
  assert.deepEqual(before, { __proto__: null, user_state_old: 6, sessions_old: 3, answer_details_old: 3, answer_feedback_old: 3, vote_rows_old: 1 });
  run(db, plan);
  const [zero, news] = plan.checks.after.map((c) => row(db, c.sql));
  assert.deepEqual(zero, { __proto__: null, user_state_old: 0, sessions_old: 0, answer_details_old: 0, answer_feedback_old: 0, vote_rows_old: 0, rate_limit_rows: 0 });
  assert.deepEqual(news, { __proto__: null, user_state_new: 6, sessions_new: 3, answer_details_new: 3, answer_feedback_new: 3, vote_rows_new: 1 });
  for (const c of [...plan.checks.before, ...plan.checks.after]) assert.doesNotMatch(c.sql, /UNION/i, "D1 limits compound SELECT");
});

test("--export facts: ids from users and discord_members, vote ids, slugs, and which rows can and cannot be renamed", () => {
  const line = (table, r) => JSON.stringify({ t: "row", table, r });
  const text = [
    line("users", { discord_user_id: IDS[0] }), line("users", { discord_user_id: STRANGER }),
    line("kv_state", { key: "discord_members", json: JSON.stringify([{ slug: "a", id: IDS[1] }]) }),
    line("kv_state", { key: `vote:${VOTE}`, json: JSON.stringify({ ballots: { [derive.voter(OLD_U, VOTE, IDS[0])]: 0, [derive.voter(OLD_U, VOTE, STRANGER)]: 1 } }) }),
    line("members", { slug: "santa", created_at: "n" }),
    line("user_state", { user_key: derive.userKey(OLD_U, IDS[0]) }), line("user_state", { user_key: derive.userKey(OLD_U, STRANGER) }),
    line("answer_feedback", { user_hash: derive.answerUx(OLD_U, IDS[1]) }),
  ].join("\n");
  const f = readExportFacts(text);
  assert.deepEqual([...f.ids].sort(), [IDS[0], IDS[1], STRANGER].sort());
  assert.deepEqual([...f.voteIds], [VOTE]);
  assert.deepEqual([...f.slugs], ["santa"]);
  const plan = buildPlan({ salts: SALTS, ids: IDS.slice(0, 2), voteIds: [VOTE], slugs: ["santa"], facts: f });
  assert.deepEqual(plan.rows.user_state, { total: 2, mapped: 1, unmapped: 1 });
  assert.deepEqual(plan.rows.vote_ballots, { total: 2, mapped: 1, unmapped: 1 });
  assert.deepEqual(plan.rows.answer_feedback, { total: 1, mapped: 1, unmapped: 0 });
  assert.match(plan.rows.sessions, /not in the export/);
});

test("KEY_SALT only: no SQL on member keys, a re-issue command per slug, and the break is stated", () => {
  const plan = buildPlan({ salts: { KEY: SALTS.KEY }, ids: [], slugs: ["santa", "rudolf"] });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.members.reissue.length, 2);
  assert.match(plan.members.reissue[0], /hash-key\.mjs santa$/);
  assert.match(plan.breaks.join(), /EVERY member key stops working/);
  assert.equal(plan.members.reissue.join().includes(NEW_K), false, "the salt is a variable name in the command, not a value");
});

test("nothing secret on the screen: no salt, no full 64-character hash, in text, JSON or the argument errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rot-"));
  try {
    const ids = path.join(dir, "ids.txt"); fs.writeFileSync(ids, IDS.join("\n"));
    const sqlOut = path.join(dir, "plan.sql");
    const env = { ...process.env, ...ENV };
    const text = spawnSync("node", [TOOL, "--ids-file", ids, "--vote-ids", VOTE, "--slugs", "santa", "--sql-out", sqlOut], { encoding: "utf8", env });
    assert.equal(text.status, 0, text.stderr);
    const json = spawnSync("node", [TOOL, "--ids-file", ids, "--vote-ids", VOTE, "--slugs", "santa", "--json"], { encoding: "utf8", env });
    assert.equal(json.status, 0, json.stderr);
    for (const out of [text.stdout + text.stderr, json.stdout + json.stderr]) {
      for (const s of [OLD_U, NEW_U, OLD_K, NEW_K]) assert.equal(out.includes(s), false, "a salt reached the output");
      assert.doesNotMatch(out, /[0-9a-f]{64}/, "a full hash reached the screen");
      for (const id of IDS) assert.equal(out.includes(id), false, "a Discord id reached the output");
    }
    assert.match(text.stdout, /^DRY RUN: nothing was applied/);
    assert.match(text.stdout, /What breaks for people/);
    assert.match(text.stdout, /\[KEY_SALT\] members\.key_hash/);
    const file = fs.readFileSync(sqlOut, "utf8");
    assert.match(file, /[0-9a-f]{64}/, "the file holds the full statements");
    for (const s of [OLD_U, NEW_U, OLD_K, NEW_K]) assert.equal(file.includes(s), false, "a salt reached the SQL file");
    if (process.platform !== "win32") assert.equal(fs.statSync(sqlOut).mode & 0o777, 0o600); // Windows has no POSIX modes
    // the SQL file runs as written
    const db = seed(); db.raw.exec(file.split("\n").filter((l) => !l.startsWith("--") && !/^SELECT/.test(l)).join("\n"));
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM user_state WHERE user_key = ?").get(derive.userKey(NEW_U, IDS[1])).n, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the tool cannot apply, takes no salt as an argument, needs ids, and keeps its SQL file out of the repo", () => {
  assert.throws(() => parseArgv(["--apply"]), /never applies/);
  assert.throws(() => parseArgv(["--new-user-salt", "x"]), /never arguments/);
  assert.throws(() => parseArgv(["--only", "both"]), /--only must be/);
  const env = { ...process.env, ...ENV };
  assert.equal(spawnSync("node", [TOOL, "--apply"], { encoding: "utf8", env }).status, 2);
  assert.match(spawnSync("node", [TOOL], { encoding: "utf8", env }).stderr, /no Discord ids/);
  const noSalt = spawnSync("node", [TOOL], { encoding: "utf8", env: { ...process.env, OLD_USER_SALT: "", NEW_USER_SALT: "", OLD_KEY_SALT: "", NEW_KEY_SALT: "" } });
  assert.equal(noSalt.status, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rot-"));
  try {
    const ids = path.join(dir, "ids.txt"); fs.writeFileSync(ids, IDS.join("\n"));
    const inRepo = spawnSync("node", [TOOL, "--ids-file", ids, "--sql-out", path.join(path.dirname(TOOL), "..", "plan.sql")], { encoding: "utf8", env });
    assert.equal(inRepo.status, 2);
    assert.match(inRepo.stderr, /inside this repository/);
    assert.equal(fs.existsSync(path.join(path.dirname(TOOL), "..", "plan.sql")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the inventory must stay complete
const WORKER = new URL("../../infrastructure/worker/", import.meta.url);
test("every Worker file that uses a salt is one the inventory accounts for", () => {
  const accounted = { "account.js": "user_state, sessions", "answer-ux.js": "answer_details, answer_feedback, button ids", "auth.js": "members", "data-rights.js": "audit_log erase targets", "discord.js": "vote ballots (votes.js)", "guest-key.js": "guest_rate_limits", "votes.js": "vote ballots", "salts.js": "the checks themselves", "moments.js": "moments_ledger hashes (diagnostic only)", "index.js": "guest_rate_limits (guestIpKey)" };
  const users = fs.readdirSync(WORKER).filter((f) => f.endsWith(".js") && /(USER_SALT|KEY_SALT)/.test(fs.readFileSync(new URL(f, WORKER), "utf8").replace(/^\s*\/\/.*$/gm, "")));
  assert.deepEqual(users.filter((f) => !accounted[f]), [], "a new file uses a salt: add it to INVENTORY and to this list");
});
test("every hash-like column in schema.sql is accounted for: salted (inventory) or unsalted (named here)", () => {
  const schema = fs.readFileSync(new URL("../../infrastructure/schema.sql", import.meta.url), "utf8");
  const found = new Set();
  let table = null;
  for (const l of schema.split("\n")) {
    const t = /^CREATE TABLE IF NOT EXISTS (\w+) \(/.exec(l); if (t) { table = t[1]; continue; }
    const c = /^\s+(\w*(?:hash|user_key|_enc)\w*)\s+(?:TEXT|INTEGER)/i.exec(l); if (c && table) found.add(`${table}.${c[1]}`);
  }
  const salted = new Set(["user_state.user_key", "sessions.user_key", "answer_details.asker_hash", "ask_turn_askers.asker_hash", "answer_feedback.user_hash", "guest_rate_limits.ip_hash", "members.key_hash", "account_keys.key_hash"]);
  const unsalted = new Set(["sessions.token_hash", "sessions_v2.token_hash", "discord_events.payload_hash", "provider_tokens.access_token_enc", "provider_tokens.refresh_token_enc"]);
  const unknown = [...found].filter((f) => !salted.has(f) && !unsalted.has(f));
  assert.deepEqual(unknown, [], "a new hash-like column: decide whether it is salted and add it to INVENTORY");
  for (const s of salted) assert.ok(found.has(s), `${s} is listed but not in the schema`);
  for (const s of salted) assert.ok(INVENTORY.some((i) => i.where.startsWith(s) || i.where.includes(s)), `${s} is salted but missing from INVENTORY`);
});
test("inventory and BREAKS are consistent with the runbook headings", () => {
  assert.ok(INVENTORY.filter((i) => i.salt === "KEY_SALT").every((i) => /NO/.test(i.rederive)));
  assert.ok(BREAKS.some((b) => /EVERY member key/.test(b)));
  assert.equal(short("a".repeat(64)).length, 9);
  assert.match(formatPlan(plan0()), /KEY_SALT: 1 member key/);
  assert.equal(fullSql(plan0()).includes("GENERATED, NOT APPLIED"), true);
});
