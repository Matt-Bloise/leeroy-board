// Activity sign-in (POST /api/auth/discord) must not need a DISCORD_CLIENT_ID var: the id is the public app id,
// defaulted the same way POST /api/token defaults it. Fictional code and secret; no real Discord call.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";

const APP_ID = "1561857940174938114";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const baseEnv = { USER_SALT: "fictional-user-salt-0123456789abcdef", ALLOWED_ORIGINS: "https://leeroy.test", DISCORD_CLIENT_SECRET: "fictional-secret" };

async function signIn(env) {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), body: String(init && init.body || "") }); return new Response("{}", { status: 400 }); };
  const silence = console.error; console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://api.test/api/auth/discord", { method: "POST", headers: { Origin: "https://leeroy.test", "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77" }, body: JSON.stringify({ code: "fictionalcode123" }) }), env, ctx);
    return { res, seen };
  } finally { globalThis.fetch = realFetch; console.error = silence; }
}

test("no DISCORD_CLIENT_ID var: sign-in still reaches Discord with the app id, not 'worker not configured'", async () => {
  const { res, seen } = await signIn({ ...baseEnv });
  const body = await res.json().catch(() => ({}));
  assert.notEqual(body.error, "worker not configured");
  const tok = seen.find((s) => /oauth2\/token/.test(s.url));
  assert.ok(tok, "the token exchange was attempted");
  assert.equal(new URLSearchParams(tok.body).get("client_id"), APP_ID);
});

test("a DISCORD_CLIENT_ID var still wins", async () => {
  const { seen } = await signIn({ ...baseEnv, DISCORD_CLIENT_ID: "999" });
  const tok = seen.find((s) => /oauth2\/token/.test(s.url));
  assert.equal(new URLSearchParams(tok.body).get("client_id"), "999");
});

test("no client secret: still refuses as not configured", async () => {
  const env = { ...baseEnv }; delete env.DISCORD_CLIENT_SECRET;
  const { res, seen } = await signIn(env);
  assert.equal(res.status, 500);
  assert.equal(seen.length, 0);
});
