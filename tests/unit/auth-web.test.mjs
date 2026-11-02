// Web Discord login (Q18): state, PKCE, replay, session expiry, logout, the feature flag and the missing-table fallback.
// A stubbed Discord and an in-memory D1; no network. Run: node --test tests/unit/auth-web.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { handleWebAuth, webSessionHash, pkceChallenge, _resetWebAuth, SESS_COOKIE, PRE_COOKIE } from "../../infrastructure/worker/web-auth.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const FAKE_ID = "100000000000000001"; // made-up snowflake
const CTX = { waitUntil() {}, passThroughOnException() {} };
const NOW = Date.parse("2026-11-02T12:00:00Z");

// In-memory D1 that understands only the statements web-auth.js issues.
function makeDb({ missing = false } = {}) {
  const users = new Map(), sessions = new Map();
  const log = [];
  const run = (sql, a) => {
    log.push(sql);
    if (missing) throw new Error("D1_ERROR: no such table: sessions_v2");
    if (/^INSERT INTO users/.test(sql)) { users.set(a[0], { discord_user_id: a[0], display_name: a[1], created_at: users.get(a[0])?.created_at || a[2] }); return { meta: { changes: 1 } }; }
    if (/^DELETE FROM sessions_v2 WHERE expires_at/.test(sql)) { for (const [k, v] of sessions) if (v.expires_at < a[0]) sessions.delete(k); return { meta: { changes: 0 } }; }
    if (/^INSERT INTO sessions_v2/.test(sql)) { sessions.set(a[0], { token_hash: a[0], discord_user_id: a[1], created_at: a[2], expires_at: a[3], last_seen_at: a[4] }); return { meta: { changes: 1 } }; }
    if (/^DELETE FROM sessions_v2 WHERE discord_user_id/.test(sql)) {
      const mine = [...sessions.values()].filter((s) => s.discord_user_id === a[0]).sort((x, y) => (y.created_at < x.created_at ? -1 : 1));
      for (const s of mine.slice(a[2])) sessions.delete(s.token_hash);
      return { meta: { changes: 0 } };
    }
    if (/^DELETE FROM sessions_v2 WHERE token_hash/.test(sql)) return { meta: { changes: sessions.delete(a[0]) ? 1 : 0 } };
    if (/^UPDATE sessions_v2 SET last_seen_at/.test(sql)) { const s = sessions.get(a[1]); if (s) s.last_seen_at = a[0]; return { meta: { changes: 1 } }; }
    throw new Error("unexpected statement: " + sql);
  };
  const prepare = (sql) => {
    let a = [];
    const o = {
      bind: (...x) => { a = x; return o; },
      run: async () => run(sql, a),
      all: async () => ({ results: [] }),
      first: async () => {
        log.push(sql);
        if (missing) throw new Error("D1_ERROR: no such table: sessions_v2");
        if (/FROM members/i.test(sql)) return null;
        if (/FROM sessions_v2 s JOIN users/.test(sql)) { const s = sessions.get(a[0]); return s ? { ...s, display_name: users.get(s.discord_user_id)?.display_name ?? null } : null; }
        return null;
      },
      _run: () => run(sql, a),
    };
    return o;
  };
  const db = { prepare, batch: async (list) => list.map((s) => s._run()), users, sessions, log };
  return db;
}

function discordStub({ usedCodes = new Set(), id = FAKE_ID, tokenStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/oauth2/token")) {
      const p = new URLSearchParams(String(init.body));
      if (usedCodes.has(p.get("code")) || tokenStatus !== 200) return new Response("{}", { status: tokenStatus === 200 ? 400 : tokenStatus });
      usedCodes.add(p.get("code"));
      return new Response(JSON.stringify({ access_token: "discord-access-token-stub" }), { status: 200 });
    }
    if (String(url).endsWith("/users/@me")) return new Response(JSON.stringify({ id, username: "stubuser", global_name: "Stub User" }), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const baseEnv = (extra = {}) => ({
  WEB_LOGIN: "on", DISCORD_CLIENT_ID: "123456789012345678", DISCORD_CLIENT_SECRET: "test-only-secret-not-real",
  USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "salt-for-tests-0123456789", ALLOWED_ORIGINS: "https://leeroy.test",
  BOARD_PUBLIC_URL: "https://leeroy.test", API_ORIGIN: "https://api.leeroy.test", DB: makeDb(), ...extra,
});
const req = (method, path, headers = {}) => new Request(`https://api.leeroy.test${path}`, { method, headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } });
const web = (env, request, deps, now = NOW) => handleWebAuth(request, env, { path: new URL(request.url).pathname.replace(/^\/api/, ""), ip: "203.0.113.7", now, deps });
const cookiesOf = (res) => res.headers.getSetCookie();
const cookieVal = (res, name) => { const c = cookiesOf(res).find((x) => x.startsWith(name + "=")); return c ? c.slice(name.length + 1).split(";")[0] : null; };

// Runs /start and returns { state, pre } (the pre-session cookie value).
async function begin(env) {
  _resetWebAuth();
  const res = await web(env, req("GET", "/api/auth/discord/start"));
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("Location"));
  return { res, loc, state: loc.searchParams.get("state"), pre: cookieVal(res, PRE_COOKIE) };
}
const callbackReq = (state, pre, code = "abcdef123456") => req("GET", `/api/auth/discord/callback?code=${code}&state=${state}`, pre ? { Cookie: `${PRE_COOKIE}=${pre}` } : {});

test("start: redirects to Discord with state, PKCE S256 and a Secure HttpOnly Lax pre-session cookie", async () => {
  const { res, loc, state, pre } = await begin(baseEnv());
  assert.equal(loc.origin + loc.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://api.leeroy.test/api/auth/discord/callback");
  assert.equal(loc.searchParams.get("scope"), "identify");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const [cs, verifier] = pre.split(".");
  assert.equal(cs, state);
  assert.equal(loc.searchParams.get("code_challenge"), await pkceChallenge(verifier));
  const raw = cookiesOf(res)[0];
  for (const f of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=600"]) assert.ok(raw.includes(f), f);
  assert.ok(!raw.includes("Domain="), "__Host- cookies carry no Domain");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("callback happy path: user upserted, only the hash is stored, __Host-sess is Secure HttpOnly Lax, PKCE verifier is sent", async () => {
  const env = baseEnv(), stub = discordStub();
  const { state, pre } = await begin(env);
  const res = await web(env, callbackReq(state, pre), { fetch: stub });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://leeroy.test/?login=ok");
  const sess = cookieVal(res, SESS_COOKIE);
  assert.match(sess, /^[A-Za-z0-9_-]{43}$/);
  const raw = cookiesOf(res).find((c) => c.startsWith(SESS_COOKIE));
  for (const f of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) assert.ok(raw.includes(f), f);
  assert.ok(!raw.includes("Domain="));
  assert.equal(cookieVal(res, PRE_COOKIE), "", "pre-session cookie is cleared");
  assert.equal(env.DB.users.get(FAKE_ID).display_name, "Stub User");
  const row = [...env.DB.sessions.values()][0];
  assert.equal(row.token_hash, await webSessionHash(sess));
  assert.notEqual(row.token_hash, sess);
  assert.ok(row.expires_at > row.created_at);
  assert.ok(!JSON.stringify([...env.DB.sessions.values()]).includes(sess), "the raw token is never stored");
  const form = new URLSearchParams(String(stub.calls[0].init.body));
  assert.equal(form.get("code_verifier"), pre.split(".")[1]);
  assert.equal(form.get("redirect_uri"), "https://api.leeroy.test/api/auth/discord/callback");
});

test("callback: state mismatch, missing cookie, missing state and a forged cookie are refused and never reach Discord", async () => {
  const env = baseEnv(), stub = discordStub();
  const { state, pre } = await begin(env);
  const other = "B".repeat(43);
  for (const r of [callbackReq(other, pre), callbackReq(state, null), callbackReq("", pre), callbackReq(state, `${other}.${pre.split(".")[1]}`), callbackReq(state, "garbage")]) {
    const res = await web(env, r, { fetch: stub });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "https://leeroy.test/?login=state");
    assert.equal(cookiesOf(res).some((c) => c.startsWith(SESS_COOKIE)), false);
  }
  assert.equal(stub.calls.length, 0);
  assert.equal(env.DB.sessions.size, 0);
});

test("callback replay: the same state and cookie a second time creates no second session", async () => {
  const env = baseEnv(), stub = discordStub();
  const { state, pre } = await begin(env);
  assert.equal((await web(env, callbackReq(state, pre), { fetch: stub })).headers.get("Location"), "https://leeroy.test/?login=ok");
  const again = await web(env, callbackReq(state, pre), { fetch: stub });
  assert.equal(again.headers.get("Location"), "https://leeroy.test/?login=state");
  assert.equal(env.DB.sessions.size, 1);
  assert.equal(stub.calls.length, 2, "one token exchange and one @me call, nothing more");
});

test("callback replay of a Discord code (fresh state) is refused by Discord and creates no session", async () => {
  const env = baseEnv(), stub = discordStub({ usedCodes: new Set(["abcdef123456"]) });
  const { state, pre } = await begin(env);
  const res = await web(env, callbackReq(state, pre), { fetch: stub });
  assert.equal(res.headers.get("Location"), "https://leeroy.test/?login=exchange");
  assert.equal(env.DB.sessions.size, 0);
});

test("callback: Discord error param and a bad @me id fail closed", async () => {
  const env = baseEnv();
  let s = await begin(env);
  const denied = await web(env, req("GET", `/api/auth/discord/callback?error=access_denied&state=${s.state}`, { Cookie: `${PRE_COOKIE}=${s.pre}` }), { fetch: discordStub() });
  assert.equal(denied.headers.get("Location"), "https://leeroy.test/?login=denied");
  s = await begin(env);
  const bad = await web(env, callbackReq(s.state, s.pre), { fetch: discordStub({ id: "12abc" }) });
  assert.equal(bad.headers.get("Location"), "https://leeroy.test/?login=exchange");
  assert.equal(env.DB.sessions.size, 0);
});

test("callback keeps at most 10 sessions per user", async () => {
  const env = baseEnv();
  for (let i = 0; i < 12; i++) {
    const s = await begin(env);
    await web(env, callbackReq(s.state, s.pre, `code${i}abcdef`), { fetch: discordStub() }, NOW + i * 1000);
  }
  assert.equal(env.DB.sessions.size, 10);
});

async function signedIn(env, now = NOW) {
  const s = await begin(env);
  const res = await web(env, callbackReq(s.state, s.pre), { fetch: discordStub() }, now);
  return cookieVal(res, SESS_COOKIE);
}
const meReq = (cookie) => new Request("https://api.leeroy.test/api/me", { headers: { "CF-Connecting-IP": "203.0.113.7", ...(cookie ? { Cookie: `${SESS_COOKIE}=${cookie}` } : {}) } });

test("GET /api/me: a valid session works, an expired one is 401 and its row is deleted", async () => {
  const env = baseEnv();
  const sess = await signedIn(env, Date.now());
  const ok = await worker.fetch(meReq(sess), env, CTX);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.via, "web-session");
  assert.equal(body.name, "Stub User");
  // age the row past its expiry
  const row = [...env.DB.sessions.values()][0];
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  row.created_at = new Date(Date.now() - 2000).toISOString();
  const expired = await worker.fetch(meReq(sess), env, CTX);
  assert.equal(expired.status, 401);
  assert.equal(env.DB.sessions.size, 0);
});

test("GET /api/me: no cookie, no key is 401; a forged cookie is 401; the legacy board key still works; the flag off ignores a good cookie", async () => {
  const env = baseEnv();
  assert.equal((await worker.fetch(meReq(null), env, CTX)).status, 401);
  assert.equal((await worker.fetch(meReq("C".repeat(43)), env, CTX)).status, 401);
  const sess = await signedIn(env, Date.now());
  assert.equal((await worker.fetch(meReq(sess), { ...env, WEB_LOGIN: "off" }, CTX)).status, 401);
  const key = "member-key-for-tests-0123456789ab";
  const hash = await sha256Hex(`${env.KEY_SALT}:${key}`);
  const legacy = { ...env, DB: { ...env.DB, prepare: (sql) => (/FROM members/i.test(sql) ? { bind: () => ({ all: async () => ({ results: [{ slug: "santa", key_hash: hash, name: "Santa" }] }), first: async () => ({ slug: "santa", key_hash: hash, name: "Santa" }) }), all: async () => ({ results: [{ slug: "santa", key_hash: hash, name: "Santa" }] }) } : env.DB.prepare(sql)) } };
  const res = await worker.fetch(new Request("https://api.leeroy.test/api/me", { headers: { Authorization: `Board ${key}` } }), legacy, CTX);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).slug, "santa");
});

test("logout: revokes the row, clears the cookie, the old cookie is then 401; no Origin is refused", async () => {
  const env = baseEnv();
  const sess = await signedIn(env, Date.now());
  const refused = await web(env, req("POST", "/api/auth/logout", { Cookie: `${SESS_COOKIE}=${sess}` }));
  assert.equal(refused.status, 403);
  assert.equal(env.DB.sessions.size, 1);
  const res = await web(env, req("POST", "/api/auth/logout", { Cookie: `${SESS_COOKIE}=${sess}`, Origin: "https://leeroy.test" }));
  assert.equal(res.status, 200);
  assert.equal(env.DB.sessions.size, 0);
  const c = cookiesOf(res).find((x) => x.startsWith(SESS_COOKIE));
  assert.ok(c.includes("Max-Age=0") && c.includes("Secure") && c.includes("HttpOnly"));
  assert.equal((await worker.fetch(meReq(sess), env, CTX)).status, 401);
  assert.equal((await web(env, req("GET", "/api/auth/logout", { Origin: "https://leeroy.test" }))).status, 405);
});

test("flag off (default): all three routes are 404 and /api/me ignores cookies", async () => {
  for (const flag of [undefined, "", "off", "0"]) {
    const env = baseEnv({ WEB_LOGIN: flag });
    for (const [m, p] of [["GET", "/api/auth/discord/start"], ["GET", "/api/auth/discord/callback"], ["POST", "/api/auth/logout"]]) {
      const res = await worker.fetch(req(m, p, { Origin: "https://leeroy.test" }), env, CTX);
      assert.equal(res.status, 404, `${m} ${p} with WEB_LOGIN=${flag}`);
      assert.equal(res.headers.get("Set-Cookie"), null);
    }
  }
});

test("missing tables: callback answers 503 (log once), /api/me falls back to 401 and logout still clears", async () => {
  const env = baseEnv({ DB: makeDb({ missing: true }) });
  const warn = console.warn; let warns = 0; console.warn = () => { warns++; };
  try {
    const s = await begin(env);
    const res = await web(env, callbackReq(s.state, s.pre), { fetch: discordStub() });
    assert.equal(res.status, 503);
    assert.equal(cookiesOf(res).some((c) => c.startsWith(SESS_COOKIE)), false);
    assert.equal((await worker.fetch(meReq("D".repeat(43)), env, CTX)).status, 401);
    const out = await web(env, req("POST", "/api/auth/logout", { Cookie: `${SESS_COOKIE}=${"D".repeat(43)}`, Origin: "https://leeroy.test" }));
    assert.equal(out.status, 200);
  } finally { console.warn = warn; }
  assert.equal(warns, 1, "logged once");
});

test("no secret value appears in any response or log line", async () => {
  const env = baseEnv(), seen = [];
  const logs = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a) => seen.push(a.join(" "));
  try {
    const s = await begin(env);
    const res = await web(env, callbackReq(s.state, s.pre), { fetch: discordStub() });
    seen.push(res.headers.get("Location"), await res.text());
  } finally { [console.log, console.warn, console.error] = logs; }
  assert.ok(!seen.join("\n").includes("test-only-secret-not-real"));
});
