// USER_SALT and KEY_SALT are Worker secrets. A missing one must fail closed with a clear error and must not crash the Worker.
// Made-up values only. No network, no AI, no real D1.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { saltProblems, requireSalt, SaltMissingError, saltErrorBody } from "../../infrastructure/worker/salts.js";
import { authenticate } from "../../infrastructure/worker/auth.js";
import { guestIpKey } from "../../infrastructure/worker/guest-key.js";
import { voterHash } from "../../infrastructure/worker/votes.js";
import { handleAccount } from "../../infrastructure/worker/account.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const USER_SALT = "user-salt-for-tests-0123456789";
const KEY_SALT = "key-salt-for-tests-0123456789";
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const MEMBER_KEY = "member-key-for-tests-0123456789ab";
const ctx = { waitUntil() {}, passThroughOnException() {} };

const db = (memberHash) => ({
  prepare: () => {
    const o = { bind: () => o, all: async () => ({ results: memberHash ? [{ slug: "santa", key_hash: memberHash }] : [] }), first: async () => null, run: async () => ({ meta: {} }) };
    return o;
  },
  batch: async () => [],
});

test("saltProblems names missing, empty and short salts, never values", () => {
  assert.deepEqual(saltProblems({}), ["USER_SALT", "KEY_SALT"]);
  assert.deepEqual(saltProblems({ USER_SALT: "", KEY_SALT: "short" }), ["USER_SALT", "KEY_SALT"]);
  assert.deepEqual(saltProblems({ USER_SALT, KEY_SALT }), []);
  assert.deepEqual(saltProblems({ USER_SALT }), ["KEY_SALT"]);
});

test("requireSalt throws SaltMissingError naming the secret, not a value", () => {
  assert.throws(() => requireSalt({ USER_SALT: "short" }, "USER_SALT"), (e) => {
    assert.ok(e instanceof SaltMissingError);
    assert.match(e.message, /USER_SALT is not configured/);
    assert.ok(!e.message.includes("short"));
    return true;
  });
  assert.equal(requireSalt({ USER_SALT }, "USER_SALT"), USER_SALT);
  assert.equal(saltErrorBody(["KEY_SALT"]).error, "salt_not_configured");
});

test("no pure helper falls back to an unsalted hash", () => {
  assert.throws(() => guestIpKey("203.0.113.7", undefined), SaltMissingError);
  assert.throws(() => voterHash("user-1", "0a1b2c3d", undefined), SaltMissingError);
});

test("authenticate: a valid key is refused when KEY_SALT is missing, accepted when set", async () => {
  const memberHash = await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`);
  const req = () => new Request("https://api.test/api/me", { headers: { Authorization: `Board ${MEMBER_KEY}` } });
  assert.deepEqual(await authenticate(req(), { DB: db(memberHash) }), { configured: false });
  assert.deepEqual(await authenticate(req(), { DB: db(memberHash), KEY_SALT }), { slug: "santa" });
});

test("account routes answer 503 salt_not_configured when USER_SALT is missing", async () => {
  const [status, body] = await handleAccount(new Request("https://api.test/api/me"), { DB: db() }, { path: "/me", ip: "203.0.113.9", now: 1 });
  assert.equal(status, 503);
  assert.equal(body.error, "salt_not_configured");
  assert.deepEqual(body.missing, ["USER_SALT"]);
});

test("Worker: a guest ask without USER_SALT is a 503, not a crash and not an unsalted write", async () => {
  const env = { DB: db(), ALLOWED_ORIGINS: "" };
  const silence = console.error; console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://api.test/api/intent", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ kind: "ask", q: "hi" }),
    }), env, ctx);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "salt_not_configured");
    assert.deepEqual(body.missing, ["USER_SALT"]);
  } finally { console.error = silence; }
});

test("Worker: the guest ask read path also refuses without USER_SALT, and health still answers", async () => {
  const env = { DB: db(), ALLOWED_ORIGINS: "", BOARD_ADMIN_TOKEN: ADMIN };
  const ask = await worker.fetch(new Request("https://api.test/api/ask"), env, ctx);
  assert.equal(ask.status, 503);
  const health = await worker.fetch(new Request("https://api.test/api/health", { headers: { Authorization: `Bearer ${ADMIN}` } }), env, ctx);
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).saltsMissing, ["USER_SALT", "KEY_SALT"]);
  const publicHealth = await worker.fetch(new Request("https://api.test/api/health"), env, ctx);
  assert.equal(publicHealth.status, 200);
  assert.equal("saltsMissing" in (await publicHealth.json()), false);
});
