// Authorization matrix for every Worker route: who may call it (anonymous, member, admin).
// Three checks keep it honest:
//   1. ROUTES (exported by index.js) and the hand-written table below list exactly the same routes.
//   2. Every route condition in index.js and account.js is covered by ROUTES, so a route added to the code but not listed fails.
//   3. Each route is called through the real Worker fetch as each principal; a refusal (401/403) must happen exactly when the table says so.
// No network, no real D1, no AI. Run: node --test tests/unit/authz.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { ROUTES } from "../../infrastructure/worker/index.js";
import { PUBLIC_DATA_DOCS, PUBLIC_ATLAS_DOCS } from "../../infrastructure/worker/public-docs.js";
import { CONFIG_KEYS } from "../../infrastructure/worker/config.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const A = "anonymous", M = "member", D = "admin";
const PUBLIC = [A, M, D];
const MEMBER = [M, D]; // the admin token also resolves to a member (resolveMemberAuth), so admin is always a member too
const ADMIN = [D];
const MEMBER_OR_SESSION = [M];
const SESSION = [M]; // per-user Discord session token (account.js): neither anonymous nor the admin token

// route -> principals allowed through. Hand written on purpose; do not generate it from the code.
const TABLE = {
  "POST /discord": PUBLIC, // Discord signs the request; the signature is checked inside the handler, not a board key
  "GET /discord/commands": PUBLIC,
  "GET /votes": PUBLIC,
  "GET /me": MEMBER,
  "POST /probe": PUBLIC,
  "ANY /sheet": MEMBER,
  "POST /announce": ADMIN,
  "PUT /vocab": ADMIN,
  "PUT /config/:key": ADMIN, // admin-gated config rows (name_map, discord_members, ...), write only
  "POST /admin/members": ADMIN,
  "PUT /persona": ADMIN,
  "POST /dispatch": MEMBER,
  "GET /intents": ADMIN,
  "POST /ack": ADMIN,
  "POST /answer": ADMIN,
  "GET /signups": PUBLIC,
  "POST /signups": MEMBER,
  "ANY /live": PUBLIC, // WebSocket upgrade into the room, read only for the page
  "GET /state": PUBLIC,
  "POST /token": PUBLIC, // Discord OAuth code exchange
  "POST /auth/discord": PUBLIC, // login, rate limited
  "GET /auth/discord/start": PUBLIC, // Q18 web login, 404 unless WEB_LOGIN is on; sets only a short-lived state cookie
  "GET /auth/discord/callback": PUBLIC, // Q18: authenticated by the state cookie plus Discord's code, not by a board key
  "POST /auth/logout": PUBLIC, // Q18: acts on the caller's own cookie session only; needs an Origin header
  "ANY /me": SESSION, // DELETE and HEAD reach account.js (GET /me is the board key route above)
  "ANY /state/:doc": SESSION,
  "GET /me/export": MEMBER_OR_SESSION, // Q59: 404 unless DATA_RIGHTS is on; then a member key or web session. The admin token is refused.
  "POST /me/erase": MEMBER_OR_SESSION, // Q59: same, plus an Origin header and a confirm body
  "GET /ask": PUBLIC, // anonymous callers only see shared or visitor turns
  "GET /wiki/snapshots": ADMIN,
  "GET /wiki/proposals": ADMIN,
  "PUT /wiki/page": ADMIN,
  "GET /bootstrap": PUBLIC,
  "GET /library/*": PUBLIC,
  "GET /data/*": PUBLIC, // only the names in PUBLIC_DATA_DOCS, see the allow list test
  "PUT /data/*": ADMIN,
  "GET /atlas/*": PUBLIC, // only the names in PUBLIC_ATLAS_DOCS
  "PUT /atlas/*": ADMIN,
  "POST /intent": PUBLIC, // anonymous may only send kind "ask"; every other kind needs a member (own test below)
  "POST /refresh": MEMBER,
  "GET /": PUBLIC,
  "GET /health": PUBLIC, // anonymous gets the minimal body; provider detail is for the admin token (own test below)
};

// ---- 1. the table and ROUTES agree
test("ROUTES and the authorization table list exactly the same routes", () => {
  assert.equal(new Set(ROUTES).size, ROUTES.length, "ROUTES has a duplicate");
  const listed = Object.keys(TABLE).sort();
  const exported = [...ROUTES].sort();
  assert.deepEqual(exported.filter((r) => !listed.includes(r)), [], "route in ROUTES but missing from the authz table");
  assert.deepEqual(listed.filter((r) => !exported.includes(r)), [], "route in the authz table but missing from ROUTES");
});

test("every table entry names only known principals and is never empty", () => {
  for (const [route, who] of Object.entries(TABLE)) {
    assert.ok(who.length > 0, route);
    for (const p of who) assert.ok([A, M, D].includes(p), `${route}: ${p}`);
  }
});

// ---- 2. every route condition in the code is covered by ROUTES
const pathMatches = (pattern, path) => {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  const re = new RegExp("^" + pattern.replace(/:[a-z]+/g, "[^/]+") + "$");
  return re.test(path);
};
const covered = (method, path) => ROUTES.some((r) => {
  const [m, p] = r.split(" ");
  return (m === "ANY" || m === method || method === "ANY") && pathMatches(p, path);
});
const read = (f) => readFileSync(new URL(`../../infrastructure/worker/${f}`, import.meta.url), "utf8");
const INDEX = read("index.js"), ACCOUNT = read("account.js");

test("every path literal handled in index.js and account.js is covered by ROUTES", () => {
  const found = new Set();
  for (const src of [INDEX, ACCOUNT]) {
    for (const m of src.matchAll(/\bpath === "(\/[^"]*)"/g)) found.add(m[1]);
    for (const m of src.matchAll(/\bpath\.startsWith\("(\/[^"]+)"\)/g)) found.add(m[1] + "x"); // "/" alone is string handling, not a route
  }
  found.add("/config/x"); // path.match(/^\/config\/([^/]+)$/) in index.js
  found.add("/state/prefs"); // /^\/state\/([a-z-]{1,32})$/ in account.js
  assert.ok(INDEX.includes("/^\\/config\\/([^/]+)$/") && ACCOUNT.includes("/^\\/state\\/(["), "regex route moved: update this test");
  const missing = [...found].filter((p) => !covered("ANY", p));
  assert.deepEqual(missing, [], "route handled in code but not listed in ROUTES and the authz table");
});

test("every method plus path pair in index.js is covered by ROUTES", () => {
  const pairs = new Set();
  for (const m of INDEX.matchAll(/req\.method === "([A-Z]+)" && path === "(\/[^"]*)"/g)) pairs.add(`${m[1]} ${m[2]}`);
  for (const m of INDEX.matchAll(/path === "(\/[^"]*)" && req\.method === "([A-Z]+)"/g)) pairs.add(`${m[2]} ${m[1]}`);
  for (const m of INDEX.matchAll(/req\.method === "([A-Z]+)" && path\.startsWith\("(\/[^"]*)"\)/g)) pairs.add(`${m[1]} ${m[2]}x`);
  assert.ok(pairs.size > 15, "scan found too few routes; the handler layout changed, update this test");
  const missing = [...pairs].filter((p) => { const [m, path] = p.split(" "); return !covered(m, path); });
  assert.deepEqual(missing, []);
});

test("a route that exists but is not in the table fails the check", () => {
  // Self-test of the guard: a made-up route is reported as uncovered.
  assert.equal(covered("GET", "/some-new-route"), false);
  assert.equal(covered("PUT", "/config/name_map"), true);
});

// ---- 3. the matrix through the real Worker
const ADMIN_TOKEN = "admin-token-for-tests-0123456789abcdef";
const MEMBER_KEY = "member-key-for-tests-0123456789ab";
const KEY_SALT = "salt-for-tests-0123456789";

async function makeEnv() {
  const memberHash = await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`);
  const docs = new Set([...PUBLIC_DATA_DOCS, ...PUBLIC_ATLAS_DOCS, "persona", "name_map", "discord_members", "vocab", "secret"]);
  const stmt = (sql) => {
    let args = [];
    const o = {
      bind: (...a) => { args = a; return o; },
      all: async () => ({ results: /FROM members/i.test(sql) ? [{ slug: "santa", key_hash: memberHash }] : [] }),
      first: async () => (/FROM kv_state WHERE key = \?/i.test(sql) && docs.has(args[0]) ? { json: "{}", updated_at: "1" } : null),
      run: async () => ({ meta: { changes: 0, last_row_id: 1 } }),
    };
    return o;
  };
  return {
    DB: { prepare: stmt, batch: async () => [] },
    BOARD_ADMIN_TOKEN: ADMIN_TOKEN,
    KEY_SALT,
    USER_SALT: "user-salt-for-tests-0123456789",
    ALLOWED_ORIGINS: "",
  };
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
const HEADERS = {
  [A]: {},
  [M]: { Authorization: `Board ${MEMBER_KEY}` },
  [D]: { Authorization: `Bearer ${ADMIN_TOKEN}` },
};

// A concrete request for each route. Docs that are not on the allow list use a private name.
const CALLS = {
  "POST /discord": ["POST", "/api/discord", "{}"],
  "GET /discord/commands": ["GET", "/api/discord/commands"],
  "GET /votes": ["GET", "/api/votes"],
  "GET /me": ["GET", "/api/me"],
  "POST /probe": ["POST", "/api/probe", "{}"],
  "ANY /sheet": ["GET", "/api/sheet"],
  "POST /announce": ["POST", "/api/announce", "{}"],
  "PUT /vocab": ["PUT", "/api/vocab", "{}"],
  "PUT /config/:key": ["PUT", `/api/config/${CONFIG_KEYS[0]}`, "{}"],
  "POST /admin/members": ["POST", "/api/admin/members", "{}"],
  "PUT /persona": ["PUT", "/api/persona", "{}"],
  "POST /dispatch": ["POST", "/api/dispatch", "{}"],
  "GET /intents": ["GET", "/api/intents"],
  "POST /ack": ["POST", "/api/ack", "{}"],
  "POST /answer": ["POST", "/api/answer", "{}"],
  "GET /signups": ["GET", "/api/signups"],
  "POST /signups": ["POST", "/api/signups", "{}"],
  "ANY /live": ["GET", "/api/live"],
  "GET /state": ["GET", "/api/state"],
  "POST /token": ["POST", "/api/token", "{}"],
  "POST /auth/discord": ["POST", "/api/auth/discord", "{}"],
  "GET /auth/discord/start": ["GET", "/api/auth/discord/start"],
  "GET /auth/discord/callback": ["GET", "/api/auth/discord/callback"],
  "POST /auth/logout": ["POST", "/api/auth/logout", "{}"],
  "ANY /me": ["DELETE", "/api/me"],
  "ANY /state/:doc": ["GET", "/api/state/prefs"],
  "GET /me/export": ["GET", "/api/me/export"],
  "POST /me/erase": ["POST", "/api/me/erase", "{}"],
  "GET /ask": ["GET", "/api/ask"],
  "GET /wiki/snapshots": ["GET", "/api/wiki/snapshots"],
  "GET /wiki/proposals": ["GET", "/api/wiki/proposals"],
  "PUT /wiki/page": ["PUT", "/api/wiki/page", "{}"],
  "GET /bootstrap": ["GET", "/api/bootstrap"],
  "GET /library/*": ["GET", "/api/library/index.json"],
  "GET /data/*": ["GET", "/api/data/party.json"],
  "PUT /data/*": ["PUT", "/api/data/party.json", "{}"],
  "GET /atlas/*": ["GET", "/api/atlas/marks.json"],
  "PUT /atlas/*": ["PUT", "/api/atlas/marks.json", "{}"],
  "POST /intent": ["POST", "/api/intent", JSON.stringify({ kind: "ask", q: "hi" })],
  "POST /refresh": ["POST", "/api/refresh", "{}"],
  "GET /": ["GET", "/"],
  "GET /health": ["GET", "/health"],
};
// Routes whose caller is not a board key (Discord signature, session token): only the anonymous refusal can be asserted here.
const NOT_BOARD_KEY = new Set(["GET /me/export", "POST /me/erase", "POST /discord", "POST /auth/discord", "ANY /me", "ANY /state/:doc", "GET /me/export", "POST /me/erase", "GET /auth/discord/start", "GET /auth/discord/callback", "POST /auth/logout"]);

async function call(env, route, principal, override) {
  const [method, path, body, extra] = override || CALLS[route];
  const init = { method, headers: { ...extra, ...HEADERS[principal], "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" } };
  if (body !== undefined) init.body = body;
  const silence = console.error;
  console.error = () => {};
  try {
    return await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  } finally {
    console.error = silence;
  }
}
// Tests make no outbound calls (AI, Discord, source sites): any fetch from the Worker gets a 599 and is counted.
let outbound = 0;
globalThis.fetch = async () => { outbound += 1; return new Response("blocked in tests", { status: 599 }); };
test.after(() => assert.equal(outbound, 0, "the matrix made an outbound request"));
const refused = (res) => res.status === 401 || res.status === 403;

test("every route has a concrete request in the matrix", () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(TABLE).sort());
});

for (const [route, allowed] of Object.entries(TABLE)) {
  if (NOT_BOARD_KEY.has(route)) continue;
  for (const principal of [A, M, D]) {
    const want = allowed.includes(principal);
    test(`${route}: ${principal} is ${want ? "let through" : "refused"}`, async () => {
      const res = await call(await makeEnv(), route, principal);
      assert.equal(refused(res), !want, `${route} as ${principal} answered ${res.status}`);
    });
  }
}

test("session routes refuse a request without a session token, and a board key or the admin token is not a session", async () => {
  for (const route of ["ANY /me", "ANY /state/:doc"]) {
    for (const principal of [A, M, D]) {
      const res = await call(await makeEnv(), route, principal);
      assert.equal(res.status, 401, `${route} as ${principal}`);
    }
  }
});

test("POST /auth/discord is open to every principal: a bad code is a 400, never a 401", async () => {
  for (const principal of [A, M, D]) {
    const env = { ...(await makeEnv()), ALLOWED_ORIGINS: "https://leeroy.test", DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "y" };
    const res = await call(env, "POST /auth/discord", principal, ["POST", "/api/auth/discord", "{}", { Origin: "https://leeroy.test" }]);
    assert.equal(res.status, 400, principal);
  }
});

test("web login routes (Q18): 404 with the flag off, and with it on never a 401 for anonymous, member key or admin token", async () => {
  const web = ["GET /auth/discord/start", "GET /auth/discord/callback", "POST /auth/logout"];
  for (const route of web) {
    for (const principal of [A, M, D]) {
      assert.equal((await call(await makeEnv(), route, principal)).status, 404, `${route} as ${principal} with the flag off`);
      const env = { ...(await makeEnv()), WEB_LOGIN: "on", DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "y", ALLOWED_ORIGINS: "https://leeroy.test" };
      const res = await call(env, route, principal, [CALLS[route][0], CALLS[route][1], CALLS[route][2], { Origin: "https://leeroy.test" }]);
      assert.notEqual(res.status, 401, `${route} as ${principal}`);
      assert.ok(res.status < 500, `${route} as ${principal} answered ${res.status}`);
    }
  }
});

test("data rights routes (Q59): 404 for every principal with the flag off; with it on anonymous and the admin token are 401, a member key is not", async () => {
  for (const route of ["GET /me/export", "POST /me/erase"]) {
    for (const principal of [A, M, D]) {
      assert.equal((await call(await makeEnv(), route, principal)).status, 404, `${route} as ${principal} with the flag off`);
      const env = { ...(await makeEnv()), DATA_RIGHTS: "on", ALLOWED_ORIGINS: "https://leeroy.test" };
      const extra = { Origin: "https://leeroy.test" };
      const res = await call(env, route, principal, [CALLS[route][0], CALLS[route][1], CALLS[route][2], extra]);
      if (principal === M) assert.notEqual(res.status, 401, `${route} as member`);
      else assert.equal(res.status, 401, `${route} as ${principal}`);
    }
  }
});

test("GET /api/me with the web flag on and no cookie or key is 401 for anonymous", async () => {
  const env = { ...(await makeEnv()), WEB_LOGIN: "on" };
  assert.equal((await call(env, "GET /me", A)).status, 401);
});

test("POST /discord refuses an unsigned request from every principal", async () => {
  for (const principal of [A, M, D]) {
    const res = await call(await makeEnv(), "POST /discord", principal);
    assert.ok(res.status >= 400, `${principal} answered ${res.status}`);
  }
});

test("admin-gated routes answer 503, not open, when no admin token is configured", async () => {
  for (const [route, allowed] of Object.entries(TABLE)) {
    if (allowed.length !== 1 || allowed[0] !== D) continue;
    const env = await makeEnv();
    delete env.BOARD_ADMIN_TOKEN;
    for (const principal of [A, M]) {
      const res = await call(env, route, principal);
      assert.ok(res.status >= 400, `${route} as ${principal} answered ${res.status} with no admin token set`);
    }
  }
});

test("POST /intent: anonymous may only ask, any other kind needs a member", async () => {
  const env = await makeEnv();
  for (const kind of ["signup", "journey", "launch", "fix", "refresh"]) {
    const body = JSON.stringify({ kind });
    assert.equal((await call(env, "POST /intent", A, ["POST", "/api/intent", body])).status, 401, kind);
    const asMember = await call(env, "POST /intent", M, ["POST", "/api/intent", body]);
    assert.equal(refused(asMember), false, `${kind} as member answered ${asMember.status}`);
  }
  const ask = await call(env, "POST /intent", A, ["POST", "/api/intent", JSON.stringify({ kind: "ask", q: "hi" })]);
  assert.equal(refused(ask), false, `ask as anonymous answered ${ask.status}`);
});

test("GET /health: provider detail is admin only", async () => {
  const env = await makeEnv();
  for (const principal of [A, M]) {
    const body = await (await call(env, "GET /health", principal)).json();
    assert.equal(body.providers, undefined, principal);
  }
  const res = await call(env, "GET /health", D);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).providers, "admin gets provider detail");
});

test("the admin token is also a member; a member key is not an admin", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "GET /me", D)).status, 200);
  assert.equal((await call(env, "PUT /vocab", M)).status, 401);
});

// ---- public-data allow-list routes (public-docs.js)
const PRINCIPALS = [A, M, D];
test("GET /api/data/<name> serves exactly PUBLIC_DATA_DOCS to every principal", async () => {
  for (const principal of PRINCIPALS) {
    for (const name of PUBLIC_DATA_DOCS) {
      const res = await call(await makeEnv(), "GET /data/*", principal, ["GET", `/api/data/${name}.json`]);
      assert.equal(res.status, 200, `${name} as ${principal}`);
    }
    for (const name of ["persona", "name_map", "discord_members", "vocab", "secret", ...PUBLIC_ATLAS_DOCS]) {
      const res = await call(await makeEnv(), "GET /data/*", principal, ["GET", `/api/data/${name}.json`]);
      assert.equal(res.status, 404, `${name} as ${principal}`);
    }
  }
});

test("GET /api/atlas/<name> serves exactly PUBLIC_ATLAS_DOCS to every principal", async () => {
  for (const principal of PRINCIPALS) {
    for (const name of PUBLIC_ATLAS_DOCS) {
      const res = await call(await makeEnv(), "GET /atlas/*", principal, ["GET", `/api/atlas/${name}.json`]);
      assert.equal(res.status, 200, `${name} as ${principal}`);
    }
    for (const name of ["persona", "name_map", "party", ...PUBLIC_DATA_DOCS].filter((n) => !PUBLIC_ATLAS_DOCS.has(n))) {
      const res = await call(await makeEnv(), "GET /atlas/*", principal, ["GET", `/api/atlas/${name}.json`]);
      assert.equal(res.status, 404, `${name} as ${principal}`);
    }
  }
});

// ---- admin-gated config routes
test("PUT /api/config/<key> is admin only for every config key, and there is no GET", async () => {
  assert.ok(CONFIG_KEYS.length > 0);
  for (const key of CONFIG_KEYS) {
    for (const principal of [A, M]) {
      const res = await call(await makeEnv(), "PUT /config/:key", principal, ["PUT", `/api/config/${key}`, "{}"]);
      assert.equal(res.status, 401, `${key} as ${principal}`);
    }
    const asAdmin = await call(await makeEnv(), "PUT /config/:key", D, ["PUT", `/api/config/${key}`, "{}"]);
    assert.equal(refused(asAdmin), false, `${key} as admin answered ${asAdmin.status}`);
    for (const principal of PRINCIPALS) {
      const res = await call(await makeEnv(), "PUT /config/:key", principal, ["GET", `/api/config/${key}`]);
      assert.equal(res.status, 404, `GET ${key} as ${principal}`);
    }
  }
});
