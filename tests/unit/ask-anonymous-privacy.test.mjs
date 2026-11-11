// Audit 2026-11-06 finding 4: GET /api/ask with no key and no id used to return the newest SHARED turn of any member (their question and the
// answer) to anyone on the internet, and a member ask with no `share` field defaults to shared. Anonymous visitors now get no turn from that
// read; signed-in members still see the party's shared asks; a guest still polls their own just-created ask by its random id.
// Real Worker over an in-memory SQLite D1. No network, no AI, made-up key.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const SALT = "salt-for-tests-0123456789", KEY = "member-key-for-tests-0123456789ab";
const room = { fetch: async () => new Response("ok") };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function makeEnv() {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('santa', ?, '2026-11-01T00:00:00Z')").run(await sha256Hex(`${SALT}:${KEY}`));
  return { DB, KEY_SALT: SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
const HDR = { anon: {}, member: { Authorization: `Board ${KEY}` } };
async function api(env, method, path, who, body) {
  const init = { method, headers: { ...HDR[who], "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const silence = console.error; console.error = () => {};
  try { return await worker.fetch(new Request(`https://api.test/api${path}`, init), env, ctx); } finally { console.error = silence; }
}
const seed = (env, id, by, q, a, share, at) => env.DB.raw.prepare(
  "INSERT INTO ask_turns (id, by_name, question, answer, status, share, created_at) VALUES (?, ?, ?, ?, 'answered', ?, ?)"
).run(id, by, q, a, share, at);

test("anonymous GET /ask returns no turn, whatever is shared", async () => {
  const env = await makeEnv();
  seed(env, "1762000000010", "Bible Boi", "MEMBER-QUESTION-77 my number is 555-0100", "MEMBER-ANSWER-77", 1, "2026-11-05T10:00:00Z");
  const res = await api(env, "GET", "/ask", "anon");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ask, null);
  assert.equal(typeof body.limit.left, "number", "the guest allowance still comes back");
  assert.doesNotMatch(JSON.stringify(body), /MEMBER-QUESTION-77|MEMBER-ANSWER-77|555-0100/);
});

test("a member ask posted with no share field (default shared) is still not readable by an anonymous visitor", async () => {
  const env = await makeEnv();
  const posted = await api(env, "POST", "/intent", "member", { kind: "ask", text: "PRIVATE-PROBE-77 where is my gold" });
  assert.equal(posted.status, 200);
  const anon = JSON.stringify(await (await api(env, "GET", "/ask", "anon")).json());
  assert.doesNotMatch(anon, /PRIVATE-PROBE-77/);
  const row = env.DB.raw.prepare("SELECT question, share FROM ask_turns").get();
  assert.match(row.question, /PRIVATE-PROBE-77/, "the turn exists");
  assert.equal(Number(row.share), 1, "share semantics for members are unchanged");
});

test("a signed-in member still sees the party's shared asks and their own, and not another member's private one", async () => {
  const env = await makeEnv();
  seed(env, "1762000000011", "Bible Boi", "shared question", "shared answer", 1, "2026-11-05T10:00:00Z");
  let body = await (await api(env, "GET", "/ask", "member")).json();
  assert.equal(body.ask.text, "shared question");
  seed(env, "1762000000012", "Street Rat", "other private", "x", 0, "2026-11-05T11:00:00Z");
  body = await (await api(env, "GET", "/ask", "member")).json();
  assert.equal(body.ask.text, "shared question", "someone else's private turn stays private");
  seed(env, "1762000000013", "Santa", "my own private", "mine", 0, "2026-11-05T12:00:00Z");
  body = await (await api(env, "GET", "/ask", "member")).json();
  assert.equal(body.ask.text, "my own private");
});

test("a guest still polls their own just-created ask by its random id (and the anonymous latest read stays empty)", async () => {
  const env = await makeEnv();
  const posted = await (await api(env, "POST", "/intent", "anon", { kind: "ask", patch: { text: "where is onyxia", share: true } })).json();
  assert.match(posted.id, UUID);
  const poll = await api(env, "GET", `/ask?id=${encodeURIComponent(posted.id)}`, "anon");
  assert.equal(poll.status, 200);
  assert.equal((await poll.json()).ask.text, "where is onyxia");
  assert.equal((await (await api(env, "GET", "/ask", "anon")).json()).ask, null, "even a guest's shared ask is not returned to the next visitor");
});

test("anonymous with a timestamp id is still refused", async () => {
  const env = await makeEnv();
  seed(env, "1762000000014", "Bible Boi", "q", "a", 1, "2026-11-05T10:00:00Z");
  assert.equal((await api(env, "GET", "/ask?id=1762000000014", "anon")).status, 401);
});
