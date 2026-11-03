// Member data export and erase (Q59): flag, auth, confirm, Origin, export shape, erase order, no token hashes.
// A stubbed D1 that records statements; made-up ids and names; no network. Run: node --test tests/unit/data-rights.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { handleDataRights, _resetDataRights, CONFIRM_PHRASE } from "../../infrastructure/worker/data-rights.js";
import { webSessionHash, SESS_COOKIE } from "../../infrastructure/worker/web-auth.js";
import { userKey } from "../../infrastructure/worker/account.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { userHash, slugAskerHash } from "../../infrastructure/worker/answer-ux.js";
import { hashId } from "../../infrastructure/worker/budget.js";

const ID = "100000000000000001"; // made-up snowflake
const NOW = Date.now();
const KEY_SALT = "salt-for-tests-0123456789", USER_SALT = "user-salt-for-tests-0123456789", MEMBER_KEY = "member-key-for-tests-0123456789ab";
const TOKEN = "A".repeat(43);
const CTX = { waitUntil() {}, passThroughOnException() {} };

// Stub D1: all() answers by table name in the SQL; run/batch statements are recorded in order; selects are recorded too.
async function makeEnv({ flag = "on", webLogin = "on", roster = [{ slug: "red-fox", name: "Red Fox", match: [], id: ID }], missing = null } = {}) {
  invalidateConfigCache(); // the roster is cached per isolate for 60 s
  const memberHash = await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`);
  const tokenHash = await webSessionHash(TOKEN);
  const executed = [], selects = [];
  const data = {
    users: [{ discord_user_id: ID, display_name: "Fox", created_at: "2026-10-01" }],
    characters: [{ id: "c1", tenant_id: "t1", name: "Foxy", realm: "R", region: "us", class: "mage", spec: "frost", created_at: "x" }],
    builds: [{ id: "b1", character_id: "c1", source: "web", status: "draft", title: "t", data_json: "{}", created_at: "x", confirmed_at: null }],
    group_slots: [{ group_id: "g1", slot_index: 0, role: "dps", character_id: "c1", status: "filled" }],
    memberships: [{ tenant_id: "t1", tenant_name: "Guild", role: "member", status: "active", joined_at: "x" }],
    signups_v2: [{ group_id: "g1", user_id: ID, character_id: "c1" }],
    sessions_v2: [{ created_at: "a", expires_at: "b", last_seen_at: "c" }],
    sheet_events: [{ id: 1, slug: "red-fox", name: "Red Fox", field: "class", value_json: "\"mage\"", visible: 1, source: "board", created_at: "x" }],
    ask_turns: [{ id: "q1", by_name: "Red Fox", question: "hi" }],
    user_state: [{ doc: "prefs", json: "{}", updated_at: 1 }],
  };
  const stmt = (sql) => {
    let args = [];
    const hit = () => { if (missing && sql.includes(missing)) throw new Error(`D1_ERROR: no such table: ${missing}`); };
    const o = {
      bind: (...a) => { args = a; return o; },
      all: async () => {
        hit();
        selects.push(sql);
        if (/FROM sessions\b/.test(sql)) return { results: [{ created_at: 1, expires_at: 2, last_seen: 3 }] };
        const t = /FROM (\w+)/i.exec(sql)[1];
        if (t === "members") return { results: /WHERE slug/.test(sql) ? [{ slug: "red-fox", created_at: "x" }] : [{ slug: "red-fox", key_hash: memberHash }] }; // a real D1 returns only the columns asked for
        return { results: data[t] || [] };
      },
      first: async () => {
        hit();
        if (/FROM kv_state WHERE key = \?/i.test(sql) && args[0] === "discord_members") return { json: JSON.stringify(roster), updated_at: "1" };
        if (/FROM sessions_v2 s JOIN users/.test(sql)) return args[0] === tokenHash ? { token_hash: tokenHash, discord_user_id: ID, expires_at: new Date(NOW + 86400000).toISOString(), last_seen_at: new Date(NOW).toISOString(), display_name: "Fox" } : null;
        return null;
      },
      run: async () => { hit(); executed.push({ sql, args }); return { meta: { changes: 1 } }; },
      _rec: () => { hit(); executed.push({ sql, args }); return { meta: { changes: 1 } }; },
    };
    return o;
  };
  return {
    DB: { prepare: stmt, batch: async (list) => list.map((s) => s._rec()) },
    KEY_SALT, USER_SALT, ALLOWED_ORIGINS: "https://leeroy.test", DATA_RIGHTS: flag, WEB_LOGIN: webLogin, executed, selects,
  };
}

const KEY = { Authorization: `Board ${MEMBER_KEY}` };
const COOKIE = { Cookie: `${SESS_COOKIE}=${TOKEN}` };
const ORIGIN = { Origin: "https://leeroy.test" };
const req = (method, path, headers = {}, body) => new Request(`https://api.test${path}`, { method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers }, body });
const go = (env, ...a) => worker.fetch(req(...a), env, CTX);
const erase = (env, headers, body = JSON.stringify({ confirm: CONFIRM_PHRASE })) => go(env, "POST", "/api/me/erase", { ...ORIGIN, ...headers }, body === null ? undefined : body);
const shape = (executed) => executed.map((e) => /^(DELETE FROM|INSERT INTO) (\w+)/.exec(e.sql).slice(1).join(" "));

test("flag off: both routes are 404 for every kind of caller, with no DB access", async () => {
  for (const flag of ["off", "", null]) {
    const env = await makeEnv({ flag });
    if (flag === null) delete env.DATA_RIGHTS;
    for (const h of [{}, KEY, COOKIE]) {
      assert.equal((await go(env, "GET", "/api/me/export", h)).status, 404);
      assert.equal((await erase(env, h)).status, 404);
    }
    assert.deepEqual(env.executed, []);
    assert.deepEqual(env.selects, []);
  }
});

test("unauthenticated: 401 on both routes, and an unknown key is 401", async () => {
  const env = await makeEnv();
  assert.equal((await go(env, "GET", "/api/me/export")).status, 401);
  assert.equal((await erase(env, {})).status, 401);
  assert.equal((await go(env, "GET", "/api/me/export", { Authorization: "Board not-a-real-key-0123456789abcdef" })).status, 401);
  assert.deepEqual(env.executed, []);
});

test("a web cookie is ignored while WEB_LOGIN is off", async () => {
  const env = await makeEnv({ webLogin: "off" });
  assert.equal((await go(env, "GET", "/api/me/export", COOKIE)).status, 401);
});

test("wrong method is 405; missing USER_SALT is 503", async () => {
  const env = await makeEnv();
  assert.equal((await go(env, "POST", "/api/me/export", KEY, "{}")).status, 405);
  assert.equal((await go(env, "GET", "/api/me/erase", KEY)).status, 405);
  delete env.USER_SALT;
  assert.equal((await go(env, "GET", "/api/me/export", KEY)).status, 503);
});

test("export by member key: shape, attachment, no-store, and every section present", async () => {
  const env = await makeEnv();
  const res = await go(env, "GET", "/api/me/export", KEY);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Disposition"), /attachment/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const b = await res.json();
  assert.equal(b.format, "leeroy-member-export-v1");
  assert.equal(b.identified_by, "member-key");
  for (const k of ["members", "sheet_events", "dispatches", "intents", "ask_turns", "fact_fixes", "user_state", "sessions"]) assert.ok(Array.isArray(b.legacy[k]), `legacy.${k}`);
  for (const k of ["users", "identities", "human_members", "provider_tokens", "sessions_v2", "memberships", "characters", "builds", "group_slots", "signups_v2", "audit_log_as_actor"]) assert.ok(Array.isArray(b.tenancy[k]), `tenancy.${k}`);
  assert.equal(b.tenancy.characters[0].name, "Foxy");
  assert.equal(b.tenancy.group_slots[0].character_id, "c1");
  assert.equal(b.legacy.sheet_events[0].slug, "red-fox");
  assert.ok(Array.isArray(b.not_included) && b.not_included.length >= 2);
});

test("export by web session: tenancy and user_state only, no name-keyed rows, with a stated gap", async () => {
  const env = await makeEnv();
  const b = await (await go(env, "GET", "/api/me/export", COOKIE)).json();
  assert.equal(b.identified_by, "web-session");
  assert.equal(b.tenancy.users.length, 1);
  assert.equal(b.legacy.sheet_events, undefined);
  assert.ok(Array.isArray(b.legacy.ask_turns), "a web session finds its own questions by asker hash, never by name");
  assert.ok(b.not_included.some((s) => /cannot be tied to a slug/.test(s)));
});

test("export by a key with no linked Discord id: legacy rows only, tenancy null and said so", async () => {
  const env = await makeEnv({ roster: [{ slug: "red-fox", name: "Red Fox", match: [] }] });
  const b = await (await go(env, "GET", "/api/me/export", KEY)).json();
  assert.equal(b.tenancy, null);
  assert.ok(b.not_included.some((s) => /no linked Discord id/.test(s)));
});

test("export never carries a token hash, key hash or encrypted token, in the body or in any query", async () => {
  const env = await makeEnv();
  const secrets = [await webSessionHash(TOKEN), await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`)];
  for (const h of [KEY, COOKIE]) {
    const text = await (await go(env, "GET", "/api/me/export", h)).text();
    assert.ok(!/token_hash|key_hash|access_token_enc|refresh_token_enc/.test(text), "secret column name in the output");
    for (const s of secrets) assert.ok(!text.includes(s), "secret hash value in the output");
  }
  assert.ok(env.selects.length > 10);
  // the auth lookup itself (SELECT slug, key_hash FROM members) is not export output; every other query must avoid secret columns
  for (const sql of env.selects.filter((q) => !/FROM members\s*$/i.test(q.trim()))) assert.ok(!/token_hash|key_hash|_enc\b|SELECT \*/.test(sql), `secret column selected: ${sql}`);
});

test("erase needs the confirm phrase: missing, wrong, bad JSON and empty body are all 400 with nothing deleted", async () => {
  const env = await makeEnv();
  for (const body of [null, "{}", "not json", JSON.stringify({ confirm: "yes" }), JSON.stringify({ confirm: "ERASE MY DATA" }), JSON.stringify({ confirm: true })]) {
    assert.equal((await erase(env, KEY, body)).status, 400, String(body));
  }
  assert.deepEqual(env.executed, []);
});

test("erase needs an Origin header: 403 without it, nothing deleted", async () => {
  const env = await makeEnv();
  const res = await go(env, "POST", "/api/me/erase", KEY, JSON.stringify({ confirm: CONFIRM_PHRASE }));
  assert.equal(res.status, 403);
  assert.deepEqual(env.executed, []);
});

test("erase by member key: one atomic batch in the safe order, then the audit row last", async () => {
  const env = await makeEnv();
  let batches = 0;
  const orig = env.DB.batch;
  env.DB.batch = async (l) => { batches += 1; return orig(l); };
  const res = await erase(env, KEY);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).erased, true);
  assert.equal(batches, 1);
  assert.deepEqual(shape(env.executed), [
    "DELETE FROM user_state", "DELETE FROM sessions", "DELETE FROM answer_feedback", "DELETE FROM answer_details",
    "DELETE FROM kv_state", "DELETE FROM kv_state", "DELETE FROM answer_details", "DELETE FROM ask_turns", "DELETE FROM ask_turn_askers", "DELETE FROM ask_turn_askers", "DELETE FROM ask_turn_legacy",
    "DELETE FROM sheet_events", "DELETE FROM dispatches", "DELETE FROM intents",
    "DELETE FROM fact_fixes", "DELETE FROM members", "DELETE FROM sessions_v2", "DELETE FROM humans",
    "DELETE FROM users", "INSERT INTO audit_log",
  ]);
  const at = (table, n = 0) => env.executed.filter((e) => e.sql.startsWith(`DELETE FROM ${table}`))[n];
  assert.deepEqual(at("user_state").args, [await userKey(env, ID)]);
  assert.deepEqual(at("answer_feedback").args, [await userHash(env, ID)]);
  assert.deepEqual(at("kv_state", 0).args, [`ai_budget:%:user:${await hashId(ID)}`]);
  assert.deepEqual(at("kv_state", 1).args, [`ai_budget:%:user:${await hashId("red-fox")}`]);
  assert.deepEqual(at("sheet_events").args, ["red-fox"]);
  // questions are found by the asker hash first; the name only for rows that have no asker row
  assert.deepEqual(at("ask_turns").args, [await userHash(env, ID), await slugAskerHash(env, "red-fox"), "red-fox", "Red Fox"]);
  assert.match(at("ask_turns").sql, /id IN \(SELECT intent_id FROM ask_turn_legacy\)/); // the name fallback is for legacy rows only
  assert.deepEqual(at("users").args, [ID]);
});

test("the audit row holds no personal data: actor and tenant NULL, action erase, a random target, empty detail", async () => {
  const env = await makeEnv();
  await erase(env, KEY);
  const a = env.executed.at(-1);
  assert.match(a.sql, /VALUES \(NULL, NULL, 'erase', \?, '\{\}', \?\)/);
  assert.match(a.args[0], /^[0-9a-f]{64}$/);
  for (const subject of [`discord:${ID}`, `slug:red-fox`]) assert.notEqual(a.args[0], await sha256Hex(`${USER_SALT}:erase:${subject}`), "target must not be derived from the person");
  const env2 = await makeEnv();
  await erase(env2, KEY);
  assert.notEqual(env2.executed.at(-1).args[0], a.args[0], "two erases of the same person must not share a target");
  const flat = JSON.stringify(a);
  for (const s of [ID, "red-fox", "Red Fox", "Fox"]) assert.ok(!flat.includes(s), `audit row contains ${s}`);
});

test("erase by web session: tenancy and user_state rows only, never a slug or name match, and the cookie is cleared", async () => {
  const env = await makeEnv();
  const res = await erase(env, COOKIE);
  assert.equal(res.status, 200);
  assert.deepEqual(shape(env.executed), ["DELETE FROM user_state", "DELETE FROM sessions", "DELETE FROM answer_feedback", "DELETE FROM answer_details", "DELETE FROM kv_state", "DELETE FROM answer_details", "DELETE FROM ask_turns", "DELETE FROM ask_turn_askers", "DELETE FROM ask_turn_askers", "DELETE FROM ask_turn_legacy", "DELETE FROM sessions_v2", "DELETE FROM humans", "DELETE FROM users", "INSERT INTO audit_log"]);
  const sc = res.headers.get("Set-Cookie");
  assert.match(sc, new RegExp(`^${SESS_COOKIE}=; .*Max-Age=0`));
  assert.match(sc, /HttpOnly/);
  assert.ok(!JSON.stringify(env.executed).includes("red-fox"));
});

test("erase by a key with no linked Discord id: slug-keyed legacy rows only, no users delete", async () => {
  const env = await makeEnv({ roster: [] });
  assert.equal((await erase(env, KEY)).status, 200);
  const order = shape(env.executed);
  assert.ok(!order.includes("DELETE FROM users"));
  assert.ok(order.includes("DELETE FROM members"));
  assert.equal(order.at(-1), "INSERT INTO audit_log");
});

test("the admin token is not a caller for export or erase", async () => {
  const env = { ...(await makeEnv()), BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef" };
  const h = { Authorization: `Bearer ${env.BOARD_ADMIN_TOKEN}` };
  assert.equal((await go(env, "GET", "/api/me/export", h)).status, 401);
  assert.equal((await erase(env, h)).status, 401);
  assert.deepEqual(env.executed, []);
});

test("a missing table is a 503, logged once, and nothing leaks", async () => {
  _resetDataRights();
  const logs = [];
  const warn = console.warn; console.warn = (m) => logs.push(m);
  try {
    const env = await makeEnv({ missing: "characters" });
    const r1 = await go(env, "GET", "/api/me/export", KEY);
    assert.equal(r1.status, 503);
    assert.deepEqual(await r1.json(), { error: "data rights not available" });
    assert.equal((await go(env, "GET", "/api/me/export", KEY)).status, 503);
    const env2 = await makeEnv({ missing: "DELETE FROM users" });
    assert.equal((await erase(env2, KEY)).status, 503);
    assert.equal(logs.length, 1);
  } finally { console.warn = warn; }
});

test("handleDataRights returns null for any other path", async () => {
  assert.equal(await handleDataRights(req("GET", "/api/me"), await makeEnv(), { path: "/me", now: NOW }), null);
  assert.equal(await handleDataRights(req("GET", "/api/me/exports"), await makeEnv(), { path: "/me/exports", now: NOW }), null);
});

test("erase source drops the member-key cache and discloses the account rows it leaves", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../infrastructure/worker/data-rights.js", import.meta.url), "utf8");
  assert.match(src, /invalidateMembersCache\(\);/);
  assert.match(src, /accounts, account_keys/);
});
