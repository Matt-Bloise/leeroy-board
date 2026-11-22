// Worker security follow-up: the sign-in, character and erase routes read their body through a capped reader (413 past the cap, and a chunked body
// with no Content-Length is cut off, not read to the end); a provider error never puts provider text in a stored or logged ask line.
// Real Worker over an in-memory SQLite D1, fictional data, no network.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { webSessionHash, SESS_COOKIE } from "../../infrastructure/worker/web-auth.js";
import { CONFIRM_PHRASE } from "../../infrastructure/worker/data-rights.js";
import { shortProviderError } from "../../infrastructure/worker/ai-models.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://leeroy.test", CTX = { waitUntil() {}, passThroughOnException() {} };
const U1 = "100000000000000001", T1 = "t-one", TOK = "A".repeat(43);
const NOW = Date.now(), ISO = (ms) => new Date(ms).toISOString();
const room = { fetch: async () => new Response("ok") };

async function makeEnv() {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'Tester One', ?)").run(U1, ISO(NOW));
  DB.raw.prepare("INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES (?, '200000000000000001', 'Guild', 'active', ?)").run(T1, ISO(NOW));
  DB.raw.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(await webSessionHash(TOK), U1, ISO(NOW - 1000), ISO(NOW + 86400000), ISO(NOW));
  return { DB, env: { DB, WEB_LOGIN: "on", CHARS_V1: "on", DATA_RIGHTS: "on", ALLOWED_ORIGINS: ORIGIN, KEY_SALT: "k".repeat(24), USER_SALT: "u".repeat(24), DISCORD_CLIENT_SECRET: "x", BOARD_ROOM: { idFromName: () => "r", get: () => room } } };
}

// A body of `bytes` bytes in 64 KiB chunks with no Content-Length (what chunked transfer looks like to the Worker).
function chunked(bytes) {
  let sent = 0, pulled = 0;
  const stream = new ReadableStream({ pull(c) { if (sent >= bytes) return c.close(); const n = Math.min(65536, bytes - sent); sent += n; pulled += n; c.enqueue(new Uint8Array(n).fill(97)); } });
  return { stream, pulled: () => pulled };
}
const hdr = { Origin: ORIGIN, Cookie: `${SESS_COOKIE}=${TOK}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" };
const call = (env, path, body, extra = {}) => worker.fetch(new Request(`https://api.leeroy.test${path}`, { method: "POST", headers: hdr, body, ...extra }), env, CTX);

test("POST /api/auth/discord: a declared oversize body is 413, a chunked oversize body is cut off, a normal body reaches the code check", async () => {
  const { env } = await makeEnv();
  assert.equal((await call(env, "/api/auth/discord", "a".repeat(5000))).status, 413);
  const { stream, pulled } = chunked(8 * 1024 * 1024);
  const res = await call(env, "/api/auth/discord", stream, { duplex: "half" });
  assert.equal(res.status, 413);
  assert.ok(pulled() < 1024 * 1024, `read ${pulled()} bytes before refusing`);
  assert.equal((await call(env, "/api/auth/discord", JSON.stringify({ code: "" }))).status, 400);
});

test("POST /api/me/characters: a chunked oversize body is cut off; a normal body still adds a character", async () => {
  const { env, DB } = await makeEnv();
  const { stream, pulled } = chunked(8 * 1024 * 1024);
  const res = await call(env, "/api/me/characters", stream, { duplex: "half" });
  assert.equal(res.status, 413);
  assert.ok(pulled() < 1024 * 1024, `read ${pulled()} bytes before refusing`);
  const ok = await call(env, "/api/me/characters", JSON.stringify({ name: "Pip Fizzwick", class: "Mage", race: "Gnome", ruleset: "Normal", faction: "Alliance", region: "Americas" }));
  assert.equal(ok.status, 201);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM characters").get().n, 1);
});

test("POST /api/me/erase: an oversize body (declared or chunked) is 413 before anything is deleted; the confirm body still works", async () => {
  const { env } = await makeEnv();
  assert.equal((await call(env, "/api/me/erase", "a".repeat(5000))).status, 413);
  const { stream, pulled } = chunked(8 * 1024 * 1024);
  const res = await call(env, "/api/me/erase", stream, { duplex: "half" });
  assert.equal(res.status, 413);
  assert.ok(pulled() < 1024 * 1024, `read ${pulled()} bytes before refusing`);
  assert.equal((await call(env, "/api/me/erase", JSON.stringify({ confirm: "nope" }))).status, 400);
  assert.equal((await call(env, "/api/me/erase", JSON.stringify({ confirm: CONFIRM_PHRASE }))).status, 200);
});

test("shortProviderError never carries provider message text: a marker in the message, a name or a status field is absent", () => {
  const MARK = "PROVIDER-MARKER-77 secret-binding-name sk-live-abcdef0123456789abcdef";
  assert.equal(shortProviderError(new Error(MARK)), "provider error (Error)");
  assert.equal(shortProviderError(Object.assign(new Error(MARK), { name: "AbortLike", status: 503 })), "provider error (AbortLike status 503)");
  assert.doesNotMatch(shortProviderError(Object.assign(new Error(MARK), { name: MARK })), /MARKER|secret-binding|sk-live/);
  assert.doesNotMatch(shortProviderError(MARK), /MARKER|secret-binding|sk-live/);
  assert.equal(shortProviderError(Object.assign(new Error(MARK), { code: "ai_timeout" })), "provider timeout");
  assert.equal(shortProviderError(new Error("groq API HTTP 500: " + MARK)), "groq API HTTP 500");
});

test("a failed ask: the provider error text appears in neither the stored turn, the response nor any log line", async () => {
  const MARK = "PROVIDER-MARKER-91 hidden-binding";
  const DB = schemaDb();
  const env = { DB, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "key-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room }, AI: { run: async () => { throw new Error(MARK); } } };
  const pending = [], logged = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const keep = { e: console.error, w: console.warn, l: console.log };
  const grab = (...a) => logged.push(a.map(String).join(" "));
  console.error = grab; console.warn = grab; console.log = grab;
  try {
    const init = (method, body) => ({ method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const posted = await worker.fetch(new Request("https://api.test/api/intent", init("POST", { kind: "ask", text: "hello" })), env, ctx);
    const { id, secret } = await posted.json();
    await Promise.allSettled(pending);
    const read = await worker.fetch(new Request(`https://api.test/api/ask?id=${id}&s=${secret}`, init("GET")), env, ctx);
    const text = await read.text();
    const row = DB.raw.prepare("SELECT answer, model, status FROM ask_turns WHERE id = ?").get(id);
    assert.equal(row.status, "error", "the failure path ran");
    for (const [label, s] of [["response", text], ["stored turn", JSON.stringify(row)], ["log", logged.join("\n")]]) assert.doesNotMatch(s, /PROVIDER-MARKER|hidden-binding/, label);
  } finally { console.error = keep.e; console.warn = keep.w; console.log = keep.l; }
});
