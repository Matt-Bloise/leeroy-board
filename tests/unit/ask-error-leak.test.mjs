// Security audit (Worker): a failed answer used to store the raw provider error (err.message) in ask_turns.answer, and GET /api/ask returned it to
// whoever holds the turn, a guest included. That text can carry an upstream response body, a config or binding name, or part of a credential.
// The visitor now gets one fixed line (or the bare "<provider> API HTTP <status>" the manual-answer path already allowed); the real error stays in the log.
// Real Worker over an in-memory SQLite D1, fake AI binding that throws. No network, no real keys.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { publicAskError, ASK_FAILED_LINE } from "../../infrastructure/worker/ai-models.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const LEAK = "UPSTREAM-LEAK-91 binding AI at /internal/cfg token-fragment-abcd1234";
const room = { fetch: async () => new Response("ok") };

async function askAsGuest(aiError) {
  const DB = schemaDb();
  const env = { DB, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "key-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room }, AI: { run: async () => { throw aiError; } } };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const quiet = console.error, quietWarn = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    const init = (method, body) => ({ method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const posted = await worker.fetch(new Request("https://api.test/api/intent", init("POST", { kind: "ask", text: "hello" })), env, ctx);
    assert.equal(posted.status, 200);
    const { id, secret } = await posted.json();
    await Promise.allSettled(pending);
    const read = await worker.fetch(new Request(`https://api.test/api/ask?id=${id}&s=${secret}`, init("GET")), env, ctx);
    return { text: await read.text(), row: DB.raw.prepare("SELECT answer, status FROM ask_turns WHERE id = ?").get(id) };
  } finally { console.error = quiet; console.warn = quietWarn; }
}

test("a failed guest ask never returns the raw provider error", async () => {
  const { text, row } = await askAsGuest(new Error(LEAK));
  assert.equal(row.status, "error", "the turn did fail (the path under test ran)");
  assert.doesNotMatch(text, /UPSTREAM-LEAK-91|token-fragment|internal\/cfg/, "GET /api/ask must not echo the provider error");
  assert.doesNotMatch(String(row.answer), /UPSTREAM-LEAK-91|token-fragment|internal\/cfg/, "and it is not stored either");
  assert.equal(row.answer, ASK_FAILED_LINE);
});

test("publicAskError keeps only a bare provider status, never a body, a binding or a secret name", () => {
  assert.equal(publicAskError(new Error("Gemini API HTTP 429: {\"error\":\"quota key=abc\"}")), "Gemini API HTTP 429");
  assert.equal(publicAskError(new Error("GEMINI_API_KEY secret is not configured on the Cloudflare Worker")), ASK_FAILED_LINE);
  assert.equal(publicAskError(new Error("Cloudflare Workers AI binding (env.AI) is not configured in wrangler.toml")), ASK_FAILED_LINE);
  assert.equal(publicAskError(undefined), ASK_FAILED_LINE);
});
