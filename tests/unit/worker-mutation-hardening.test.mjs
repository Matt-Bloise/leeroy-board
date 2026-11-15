// Mutation-driven hardening for the Worker's auth, privacy, signature, rate-limit and size-cap code.
// Every test below was written red-first: a hand-made mutant (one flipped condition in infrastructure/worker/) survived the
// existing suite, and the test kills it. Each test names the mutant it kills. No network, no real D1, no secrets (throwaway keys only).
// Run: node --test tests/unit/worker-mutation-hardening.test.mjs
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import worker from "../../infrastructure/worker/index.js";
import { authenticate, keyFromRequest, getMembers, invalidateMembersCache, hashKey } from "../../infrastructure/worker/auth.js";
import { publicParty, partyForMember } from "../../infrastructure/worker/sheet-privacy.js";
import { allowedOrigins, originVerdict } from "../../infrastructure/worker/cors.js";
import { readJsonCapped, questionTooLong, pickSignupPatch, MAX_BODY_BYTES, MAX_QUESTION_CHARS, SIGNUP_VALUE_MAX } from "../../infrastructure/worker/limits.js";
import { verifyDiscordSignature } from "../../infrastructure/worker/discord.js";
import { isFreshTimestamp } from "../../infrastructure/worker/discord-safety.js";
import { handleWebAuth, _resetWebAuth, WEB } from "../../infrastructure/worker/web-auth.js";
import { handleAccount, _resetAccountLimits, ACCOUNT, sessionHash } from "../../infrastructure/worker/account.js";
import { guestIpKey } from "../../infrastructure/worker/guest-key.js";
import { sha256Hex, timingSafeEqualStr } from "../../infrastructure/worker/crypto.js";
import { PUBLIC_DATA_DOCS, PUBLIC_ATLAS_DOCS } from "../../infrastructure/worker/public-docs.js";
import { isDeniedKvKey } from "../../infrastructure/worker/config.js";

const CTX = { waitUntil() {}, passThroughOnException() {} };
const KEY_SALT = "salt-for-tests-0123456789";
const USER_SALT = "user-salt-for-tests-0123456789";

// ---------------------------------------------------------------- auth.js: key shape is a pre-filter that holds even when the hash is stored
async function envWithMember(key) {
  const key_hash = await sha256Hex(`${KEY_SALT}:${key}`);
  return { KEY_SALT, DB: { prepare: () => ({ all: async () => ({ results: [{ slug: "member-a", key_hash }] }) }) } };
}
const boardReq = (key, method = "GET") => new Request("https://w.test/api/me", { method, headers: { Authorization: `Board ${key}` } });

test("authenticate: a stored key is refused when its shape is outside 22..64 characters (kills KEY_RE {1,64} and {22,} mutants)", async () => {
  for (const [len, ok] of [[21, false], [22, true], [64, true], [65, false]]) {
    invalidateMembersCache();
    const key = "k".repeat(len);
    const who = await authenticate(boardReq(key), await envWithMember(key));
    assert.equal(Boolean(who && who.slug), ok, `length ${len}`);
  }
});

test("keyFromRequest: anything after the key makes the header malformed (kills the dropped end anchor)", () => {
  const key = "a".repeat(30);
  const h = (v) => new Request("https://w.test/", { headers: { Authorization: v } });
  assert.equal(keyFromRequest(h(`Board ${key}`)), key);
  assert.equal(keyFromRequest(h(`Board ${key} extra`)), null);
  assert.equal(keyFromRequest(h(`Board ${key}\t${key}`)), null);
  assert.equal(keyFromRequest(h(`Bearer ${key}`)), null, "Bearer is the admin token scheme, never a member key");
});

test("getMembers: the in-isolate cache expires after 15 minutes (kills a stretched TTL)", async () => {
  invalidateMembersCache();
  let reads = 0;
  const env = { DB: { prepare: () => ({ all: async () => { reads++; return { results: [] }; } }) } };
  let now = 1_800_000_000_000;
  const clock = mock.method(Date, "now", () => now);
  try {
    await getMembers(env); await getMembers(env);
    assert.equal(reads, 1, "second read inside the window comes from the cache");
    now += 14 * 60 * 1000; await getMembers(env);
    assert.equal(reads, 1, "still cached at 14 minutes");
    now += 2 * 60 * 1000; await getMembers(env);
    assert.equal(reads, 2, "re-read after 16 minutes");
  } finally { clock.mock.restore(); invalidateMembersCache(); }
});

// ---------------------------------------------------------------- index.js: an unset admin token must never match a literal "undefined"
function makeWorkerEnv(extra = {}) {
  const stmt = () => {
    const o = { bind: () => o, all: async () => ({ results: [] }), first: async () => ({ "1": 1 }), run: async () => ({ meta: { changes: 0 } }) };
    return o;
  };
  return { DB: { prepare: stmt, batch: async () => [] }, KEY_SALT, USER_SALT, ALLOWED_ORIGINS: "", ...extra };
}
const call = (env, path, headers = {}) => worker.fetch(new Request(`https://w.test${path}`, { headers }), env, CTX);

test("no BOARD_ADMIN_TOKEN configured: 'Bearer undefined' is not an admin on /me or /health (kills dropped token guards)", async () => {
  invalidateMembersCache();
  const env = makeWorkerEnv(); // BOARD_ADMIN_TOKEN absent
  for (const scheme of ["Bearer undefined", "Board undefined"]) {
    const me = await call(env, "/api/me", { Authorization: scheme });
    assert.equal(me.status, 401, `/me with ${scheme}`);
    const health = await (await call(env, "/api/health", { Authorization: scheme })).json();
    assert.equal(health.ok, true);
    assert.equal("aiProvider" in health, false, `/health must stay minimal for ${scheme}`);
    assert.equal("providers" in health, false);
  }
  // And with a token configured, a wrong or empty key still gets the minimal body.
  const withToken = makeWorkerEnv({ BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef" });
  for (const hdr of [{}, { Authorization: "Bearer wrong" }, { Authorization: "Bearer " }]) {
    const body = await (await call(withToken, "/api/health", hdr)).json();
    assert.equal("aiProvider" in body, false);
  }
});

test("document writes: the public allow list and the deny list never overlap, and private keys are refused for the admin token", async () => {
  // Invariant behind PUT /data/* and /atlas/*: the deny check in index.js is defense in depth because no public name is denied.
  for (const name of [...PUBLIC_DATA_DOCS, ...PUBLIC_ATLAS_DOCS]) assert.equal(isDeniedKvKey(name), false, name);
  const admin = "admin-token-for-tests-0123456789abcdef";
  const env = makeWorkerEnv({ BOARD_ADMIN_TOKEN: admin });
  for (const name of ["persona", "config:x", "private:x", "votes:1", "secret-thing", "ai_budget:2026"]) {
    const r = await worker.fetch(new Request(`https://w.test/api/data/${name}`, { method: "PUT", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: "{}" }), env, CTX);
    assert.equal(r.status, 403, name);
  }
});

// ---------------------------------------------------------------- sheet-privacy.js: hidden-field handling
test("publicParty fails closed: only an explicit visible:true shows a field; missing, falsy and non-boolean flags are hidden", () => {
  const out = publicParty([{ slug: "a", fields: { race: { value: "x" }, class: { value: "y", visible: true }, goals: { value: "z", visible: false }, level: { value: 1, visible: 0 }, launch_state: { value: "q", visible: "true" }, professions: { value: "p", visible: null } } }]);
  assert.deepEqual(Object.keys(out[0].fields), ["class"]);
});

test("publicParty: a field name the code has never heard of is hidden unless it says visible:true", () => {
  const out = publicParty([{ slug: "a", fields: { future_field: { value: "x" }, other_field: { value: "y", visible: false }, shown_field: { value: "z", visible: true } } }]);
  assert.deepEqual(Object.keys(out[0].fields), ["shown_field"]);
});

test("partyForMember: with no owner slug every sheet is stripped, including a slug-less sheet (kills the dropped ownerSlug guard)", () => {
  const sheet = { name: "Member A", fields: { goals: { value: "secret", visible: false }, level: { value: 5, visible: true } } }; // no slug at all
  for (const owner of [undefined, null, ""]) {
    const out = partyForMember([sheet], owner);
    assert.equal(out[0].fields.goals, undefined, `owner ${JSON.stringify(owner)}`);
    assert.equal(out[0].fields.level.value, 5);
  }
  const mine = partyForMember([{ slug: "a", fields: { goals: { value: "s", visible: false } } }], "a");
  assert.equal(mine[0].fields.goals.value, "s", "the owner still sees their own hidden field");
  const other = partyForMember([{ slug: "a", fields: { goals: { value: "s", visible: false } } }], "b");
  assert.equal(other[0].fields.goals, undefined, "another member does not");
});

// ---------------------------------------------------------------- cors.js
test("allowedOrigins: only bare scheme://host[:port] entries count (kills the loosened origin regex)", () => {
  const set = allowedOrigins({ ALLOWED_ORIGINS: "https://a.example, https://b.example/path, https://, http://c.example:8080, https://d.example/, *, javascript:alert(1)" });
  assert.deepEqual([...set].sort(), ["http://c.example:8080", "https://a.example"]);
  assert.equal(originVerdict(new Request("https://w.test/", { headers: { Origin: "https://b.example/path" } }), { ALLOWED_ORIGINS: "https://b.example/path" }).ok, false);
  assert.equal(originVerdict(new Request("https://w.test/", { headers: { Origin: "https://evil.example" } }), { ALLOWED_ORIGINS: "*" }).ok, false, "a wildcard entry is never honoured");
});

// ---------------------------------------------------------------- limits.js: size caps
const fakeReq = (text, declared) => ({
  headers: { get: (k) => (k.toLowerCase() === "content-length" && declared !== undefined ? String(declared) : null) },
  textCalls: 0,
  async text() { this.textCalls++; return text; },
});

test("readJsonCapped: a declared length over the cap is refused before the body is read; exactly the cap is accepted (kills >= and dropped check)", async () => {
  const over = fakeReq("{}", MAX_BODY_BYTES + 1);
  assert.deepEqual(await readJsonCapped(over), { tooLarge: true });
  assert.equal(over.textCalls, 0, "the body must not be read once the declared length is over the cap");
  const atCap = fakeReq('{"a":1}', MAX_BODY_BYTES);
  assert.deepEqual(await readJsonCapped(atCap), { body: { a: 1 } });
  const exact = '{"p":"' + "x".repeat(MAX_BODY_BYTES - 8) + '"}';
  assert.equal(new TextEncoder().encode(exact).length, MAX_BODY_BYTES);
  assert.equal((await readJsonCapped(fakeReq(exact))).tooLarge, undefined, "a body of exactly the cap is accepted");
  assert.deepEqual(await readJsonCapped(fakeReq(exact + " ")), { tooLarge: true }, "one byte more is refused");
  assert.deepEqual(await readJsonCapped(fakeReq("x".repeat(40), 5), 10), { tooLarge: true }, "an understated Content-Length cannot dodge the real byte count");
});

test("questionTooLong counts characters, not UTF-16 units, and the limit itself is allowed (kills .length and >=)", () => {
  assert.equal(questionTooLong("a".repeat(MAX_QUESTION_CHARS)), false);
  assert.equal(questionTooLong("a".repeat(MAX_QUESTION_CHARS + 1)), true);
  const astral = "\u{1F600}".repeat(MAX_QUESTION_CHARS); // 2000 characters, 4000 UTF-16 units
  assert.equal(questionTooLong(astral), false);
  assert.equal(questionTooLong(astral + "\u{1F600}"), true);
});

test("pickSignupPatch: value cap is inclusive at 200, numbers and booleans pass, objects and arrays do not (kills >= and the dropped number case)", () => {
  assert.deepEqual(pickSignupPatch({ pack: "p".repeat(SIGNUP_VALUE_MAX) }).patch, { pack: "p".repeat(SIGNUP_VALUE_MAX) });
  assert.match(pickSignupPatch({ pack: "p".repeat(SIGNUP_VALUE_MAX + 1) }).error, /pack/);
  assert.deepEqual(pickSignupPatch({ rsvp: true, when: 20 }).patch, { rsvp: true, when: 20 });
  assert.ok(pickSignupPatch({ rsvp: { a: 1 } }).error);
  assert.ok(pickSignupPatch({ rsvp: ["yes"] }).error);
  assert.deepEqual(pickSignupPatch({ slug: "someone-else", name: "x", updated: "y" }).patch, {}, "identity fields are never writable");
});

// ---------------------------------------------------------------- Discord signature
test("verifyDiscordSignature: a signature over the body alone (no timestamp) is refused when the timestamp header is missing", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const body = '{"type":1}';
  const sigNoTs = sign(null, Buffer.from(body), privateKey).toString("hex");
  const noTs = new Request("https://w.test/discord", { method: "POST", headers: { "X-Signature-Ed25519": sigNoTs }, body });
  assert.equal(await verifyDiscordSignature(noTs, body, pub), false);
  const ts = "1700000000";
  const sig = sign(null, Buffer.from(ts + body), privateKey).toString("hex");
  const ok = new Request("https://w.test/discord", { method: "POST", headers: { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts }, body });
  assert.equal(await verifyDiscordSignature(ok, body, pub), true);
  assert.equal(await verifyDiscordSignature(ok, body, ""), false, "no configured public key never verifies");
  assert.equal(await verifyDiscordSignature(ok, body + " ", pub), false, "a changed body never verifies");
  assert.equal(await verifyDiscordSignature(ok, body, pub.replace(/^./, (c) => (c === "0" ? "1" : "0"))), false, "a different key never verifies");
});

test("isFreshTimestamp: only plain digits up to 15 characters are timestamps (kills the loosened digit pattern)", () => {
  assert.equal(isFreshTimestamp("1000000000000000", 1000000000000000), false, "16 digits");
  assert.equal(isFreshTimestamp("100000000000000", 100000000000000), true, "15 digits");
  assert.equal(isFreshTimestamp("1700000000x", 1700000000), false);
  assert.equal(isFreshTimestamp("-1700000000", 1700000000), false);
});

// ---------------------------------------------------------------- web-auth.js and account.js rate limits
test("web login start: 20 requests a minute per IP, the 21st is a 429 with Retry-After (kills >=, x100 and a removed limiter)", async () => {
  _resetWebAuth();
  const env = { WEB_LOGIN: "on", DISCORD_CLIENT_ID: "123456789012345678", DB: {} };
  const now = Date.parse("2026-11-02T12:00:30Z");
  const go = (ip, t = now) => handleWebAuth(new Request("https://w.test/api/auth/discord/start"), env, { path: "/auth/discord/start", ip, now: t });
  for (let i = 1; i <= WEB.perMin; i++) assert.equal((await go("203.0.113.1")).status, 302, `request ${i}`);
  const limited = await go("203.0.113.1");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal((await go("203.0.113.2")).status, 302, "another IP is unaffected");
  assert.equal((await go("203.0.113.1", now + 60_000)).status, 302, "a new minute starts a new window");
  _resetWebAuth();
});

const acctEnv = (db = {}) => ({ USER_SALT, DISCORD_CLIENT_ID: "123456789012345678", DISCORD_CLIENT_SECRET: "throwaway-secret-0123456789", DB: db });
const post = (path, body, headers = {}) => new Request(`https://w.test/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
const NOW = Date.parse("2026-11-02T12:00:30Z");

test("POST /auth/discord: refuses a request with no Origin header (kills the dropped Origin check)", async () => {
  _resetAccountLimits();
  const [status, body] = await handleAccount(post("/auth/discord", '{"code":"abcdef123"}'), acctEnv(), { path: "/auth/discord", ip: "198.51.100.1", now: NOW });
  assert.equal(status, 403);
  assert.equal(body.error, "origin not allowed");
});

test("POST /auth/discord: 10 a minute per IP, the 11th is a 429 (kills a removed or loosened limiter)", async () => {
  _resetAccountLimits();
  const go = (ip, t = NOW) => handleAccount(post("/auth/discord", '{"code":"!"}', { Origin: "https://leeroy.party" }), acctEnv(), { path: "/auth/discord", ip, now: t });
  for (let i = 1; i <= ACCOUNT.loginPerMin; i++) assert.equal((await go("198.51.100.2"))[0], 400, `request ${i}`);
  const [status, , headers] = await go("198.51.100.2");
  assert.equal(status, 429);
  assert.equal(headers["Retry-After"], "60");
  assert.equal((await go("198.51.100.3"))[0], 400, "another IP is unaffected");
  _resetAccountLimits();
});

test("POST /auth/discord: a body over 1 KiB is a 413 before it is parsed (kills the loosened body cap)", async () => {
  _resetAccountLimits();
  const big = JSON.stringify({ code: "abcdef123", pad: "x".repeat(ACCOUNT.bodyMax + 10) });
  const [status, body] = await handleAccount(post("/auth/discord", big, { Origin: "https://leeroy.party" }), acctEnv(), { path: "/auth/discord", ip: "198.51.100.4", now: NOW });
  assert.equal(status, 413);
  assert.equal(body.error, "body too large");
  _resetAccountLimits();
});

test("bad session tokens are counted: the 11th failure in a minute is a 429, even for a request that would have been valid", async () => {
  _resetAccountLimits();
  const token = "T".repeat(43);
  const th = await sessionHash(token);
  const db = { prepare: () => { const o = { bind: () => o, first: async () => ({ token_hash: th, user_key: "u", expires_at: NOW + 1e6, last_seen: NOW }), run: async () => ({ meta: { changes: 1 } }) }; return o; } };
  const bad = () => handleAccount(new Request("https://w.test/api/me", { headers: { Authorization: "Bearer nope" } }), acctEnv(db), { path: "/me", ip: "198.51.100.5", now: NOW });
  for (let i = 1; i <= ACCOUNT.failPerMin; i++) assert.equal((await bad())[0], 401, `failure ${i}`);
  assert.equal((await bad())[0], 429, "11th failure is slowed down");
  const good = await handleAccount(new Request("https://w.test/api/me", { headers: { Authorization: `Bearer ${token}` } }), acctEnv(db), { path: "/me", ip: "198.51.100.5", now: NOW });
  assert.equal(good[0], 429, "a valid token from a throttled IP waits too");
  const other = await handleAccount(new Request("https://w.test/api/me", { headers: { Authorization: `Bearer ${token}` } }), acctEnv(db), { path: "/me", ip: "198.51.100.6", now: NOW });
  assert.equal(other[0], 200, "another IP is unaffected");
  _resetAccountLimits();
});

test("PUT /state/prefs: a document over the 16 KiB cap is a 413 even when it fits the transport slack (kills the loosened docMax)", async () => {
  _resetAccountLimits();
  const token = "S".repeat(43);
  const th = await sessionHash(token);
  const db = { prepare: (sql) => { const o = { bind: () => o, first: async () => (/FROM sessions/.test(sql) ? { token_hash: th, user_key: "u", expires_at: NOW + 1e6, last_seen: NOW } : null), run: async () => ({ meta: { changes: 1 } }) }; return o; } };
  const put = (text) => handleAccount(new Request("https://w.test/api/state/prefs", { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: text }), acctEnv(db), { path: "/state/prefs", ip: "198.51.100.7", now: NOW });
  const base = '{"keys":{}}';
  const exact = base + " ".repeat(ACCOUNT.docMax - base.length);
  assert.equal((await put(exact))[0], 200, "exactly the cap is accepted");
  const over = exact + " ".repeat(10);
  assert.equal((await put(over))[0], 413);
  _resetAccountLimits();
});

// ---------------------------------------------------------------- guest-key.js and crypto.js
test("guestIpKey is domain separated: it is exactly sha256(salt:guest-ask:ip) and differs from the bare salt:ip hash (kills the dropped label)", async () => {
  assert.equal(await guestIpKey("203.0.113.9", USER_SALT), await sha256Hex(`${USER_SALT}:guest-ask:203.0.113.9`));
  assert.notEqual(await guestIpKey("203.0.113.9", USER_SALT), await sha256Hex(`${USER_SALT}:203.0.113.9`));
  assert.notEqual(await guestIpKey("203.0.113.9", USER_SALT), await hashKey({ KEY_SALT: USER_SALT }, "203.0.113.9"));
});

test("timingSafeEqualStr: a length difference alone is a mismatch, even when the shorter string is a zero-padded prefix", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abc\u0000"), false);
  assert.equal(timingSafeEqualStr("abc\u0000", "abc"), false);
  assert.equal(timingSafeEqualStr("abc", "abd"), false);
  assert.equal(timingSafeEqualStr("", ""), true);
});
