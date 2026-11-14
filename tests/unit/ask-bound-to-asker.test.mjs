// GET /api/ask?id= returns a PRIVATE (share 0) random-id turn only to its asker: a member by their key, a guest by the secret POST /intent gave their
// page. The id alone no longer reads it. Shared turns, the admin, turns asked before guest secrets existed and guessable timestamp ids keep their rules.
// Fictional data only. No network, no AI (the model call is stubbed and never awaited). Run: node --test tests/unit/ask-bound-to-asker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { insertAskTurn, guestSecretHash, RELOAD_ANSWER_LINE, privateTurnAccess } from "../../infrastructure/worker/answer-ux.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const KEY_RED = "member-key-for-tests-red-0123456789", KEY_BLUE = "member-key-for-tests-blue-012345678";
const KEY_SALT = "salt-for-tests-0123456789";
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const MIGRATION_0008 = readFileSync(new URL("../../infrastructure/migrations/0008_discord_events_legacy_tenant.sql", import.meta.url), "utf8");
const Q = "zq private question text";

async function makeEnv() {
  const DB = schemaDb();
  DB.raw.exec(MIGRATION_0008);
  for (const [slug, key] of [["red-fox", KEY_RED], ["blue-owl", KEY_BLUE]]) DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES (?, ?, '2026-11-01T00:00:00Z')").run(slug, await sha256Hex(`${KEY_SALT}:${key}`));
  const room = { fetch: async () => new Response("ok") };
  return {
    DB, BOARD_ADMIN_TOKEN: ADMIN, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room },
    AI: { run: async () => ({ response: "**Fictional answer.**", usage: { prompt_tokens: 1, completion_tokens: 1 } }) },
  };
}
const WHO = { anon: {}, red: { Authorization: `Board ${KEY_RED}` }, blue: { Authorization: `Board ${KEY_BLUE}` }, admin: { Authorization: `Bearer ${ADMIN}` } };
let ip = 0;
async function api(env, method, path, who = "anon", body) {
  const init = { method, headers: { ...WHO[who], "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${(ip++ % 200) + 1}` } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const q = [console.error, console.warn, console.log]; console.error = console.warn = console.log = () => {};
  try { const r = await worker.fetch(new Request(`${ORIGIN}/api${path}`, init), env, ctx); return { status: r.status, body: await r.json().catch(() => null) }; }
  finally { [console.error, console.warn, console.log] = q; }
}
const answered = (env, id) => env.DB.raw.prepare("UPDATE ask_turns SET status = 'answered', answer = 'zq private answer', answered_at = created_at WHERE id = ?").run(id);

test("a guest ask returns a secret; only its salted hash is stored", async () => {
  const env = await makeEnv();
  const r = await api(env, "POST", "/intent", "anon", { kind: "ask", patch: { text: Q } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.secret, /^[0-9a-f]{64}$/);
  const rows = env.DB.raw.prepare("SELECT asker_hash FROM ask_turn_askers WHERE intent_id = ?").all(r.body.id).map((x) => x.asker_hash);
  assert.deepEqual(rows, [await guestSecretHash(env, r.body.secret)]);
  assert.ok(!JSON.stringify(env.DB.raw.prepare("SELECT * FROM ask_turns").all()).includes(r.body.secret), "the secret itself is never stored");
});

test("a member's ask returns no secret", async () => {
  const env = await makeEnv();
  const r = await api(env, "POST", "/intent", "red", { kind: "ask", patch: { text: Q, share: false } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal("secret" in r.body, false);
});

test("a guest reads its own private turn only with its secret; the id alone gets one clear line and no question", async () => {
  const env = await makeEnv();
  const p = await api(env, "POST", "/intent", "anon", { kind: "ask", patch: { text: Q } });
  answered(env, p.body.id);
  const own = await api(env, "GET", `/ask?id=${p.body.id}&s=${p.body.secret}`);
  assert.equal(own.body.ask.text, Q);
  for (const path of [`/ask?id=${p.body.id}`, `/ask?id=${p.body.id}&s=${"0".repeat(64)}`, `/ask?id=${p.body.id}&s=short`]) {
    const r = await api(env, "GET", path);
    assert.equal(r.status, 200);
    assert.equal(r.body.ask.answer, RELOAD_ANSWER_LINE, path);
    assert.ok(!JSON.stringify(r.body).includes("zq"), `${path}: no question or answer text`);
  }
});

test("another member's key does not read a guest's or a member's private turn; the asker's own key does", async () => {
  const env = await makeEnv();
  const g = await api(env, "POST", "/intent", "anon", { kind: "ask", patch: { text: Q } });
  answered(env, g.body.id);
  assert.equal((await api(env, "GET", `/ask?id=${g.body.id}`, "blue")).body.ask.answer, RELOAD_ANSWER_LINE);
  const m = await api(env, "POST", "/intent", "red", { kind: "ask", patch: { text: Q, share: false } });
  answered(env, m.body.id);
  assert.equal((await api(env, "GET", `/ask?id=${m.body.id}`, "red")).body.ask.text, Q, "the asker's own key");
  for (const who of ["blue", "anon"]) {
    const r = await api(env, "GET", `/ask?id=${m.body.id}`, who);
    assert.equal(r.body.ask, null, who);
    assert.ok(!JSON.stringify(r.body).includes("zq"), who);
  }
});

test("the admin reads any private turn", async () => {
  const env = await makeEnv();
  const g = await api(env, "POST", "/intent", "anon", { kind: "ask", patch: { text: Q } });
  answered(env, g.body.id);
  assert.equal((await api(env, "GET", `/ask?id=${g.body.id}`, "admin")).body.ask.text, Q);
});

test("a shared turn stays readable by its id (shared answers are for the group)", async () => {
  const env = await makeEnv();
  const s = await api(env, "POST", "/intent", "red", { kind: "ask", patch: { text: Q, share: true } });
  answered(env, s.body.id);
  for (const who of ["blue", "anon"]) assert.equal((await api(env, "GET", `/ask?id=${s.body.id}`, who)).body.ask.text, Q, who);
});

test("a guest turn asked before secrets existed (no asker row) is still read by its id, as before", async () => {
  const env = await makeEnv();
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
  await insertAskTurn(env, { id, byName: "Visitor", question: Q, provider: "workers-ai", share: false, createdAt: new Date().toISOString() }, {});
  answered(env, id);
  assert.equal((await api(env, "GET", `/ask?id=${id}`)).body.ask.text, Q);
});

test("privateTurnAccess: no salt or no row is never ok", async () => {
  assert.equal(await privateTurnAccess({ DB: null }, { id: "x", by_name: "Visitor" }, {}), "none");
  const env = await makeEnv();
  assert.equal(await privateTurnAccess(env, null, {}), "none");
});

// ---- from the outside review of the first version ----
import { readFileSync as readSrc } from "node:fs";

test("R1: the page sends its key on /ask?id= too, so a member's own private answer shows", () => {
  const src = readSrc(new URL("../../js/brain.js", import.meta.url), "utf8");
  assert.match(src, /const routePath = String\(route\)\.split\("\?"\)\[0\]/);
  assert.match(src, /routePath === "\/ask"/);
  assert.doesNotMatch(src, /\|\| route === "\/ask" \|\|/);
});

test("R2: a guest's private answer never travels on the socket, not even to a socket that knows the ask id", async () => {
  const { answerWithAi } = await import("../../infrastructure/worker/ai-models.js");
  const env = await makeEnv();
  const sent = [];
  env.BOARD_ROOM = { idFromName: () => "r", get: () => ({ fetch: async (_u, init) => { if (init && init.body) sent.push(String(init.body)); return new Response("ok"); } }) };
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000a2";
  await insertAskTurn(env, { id, byName: "Visitor", question: Q, provider: "workers-ai", share: false, createdAt: new Date().toISOString() }, { guestSecret: "a".repeat(64) });
  const q = [console.error, console.warn, console.log]; console.error = console.warn = console.log = () => {};
  try { await answerWithAi({ env, origin: ORIGIN, intentId: id, by: "Visitor", question: Q, provider: "workers-ai", share: false, isMember: false }); }
  finally { [console.error, console.warn, console.log] = q; }
  assert.ok(sent.length > 0);
  for (const m of sent) { assert.ok(!m.includes("zq"), m); assert.ok(!m.includes("forAsk"), m); }
});

test("R3: a guest turn listed in ask_turn_legacy reads by id (a new guest turn always has its hash row: see the next test)", async () => {
  const env = await makeEnv();
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000a3";
  env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, status, share, created_at) VALUES (?, 'Visitor', ?, 'zq a', 'answered', 0, '2026-10-01T00:00:00Z')").run(id, Q);
  env.DB.raw.prepare("INSERT INTO ask_turn_legacy (intent_id) VALUES (?)").run(id);
  assert.equal((await api(env, "GET", `/ask?id=${id}`)).body.ask.text, Q);
});

test("R3: a guest ask whose secret hash cannot be stored fails; no turn is written without it", async () => {
  const env = await makeEnv();
  env.DB.raw.exec("DROP TABLE ask_turn_askers");
  const r = await api(env, "POST", "/intent", "anon", { kind: "ask", patch: { text: Q } });
  assert.ok(r.status >= 500, `status ${r.status}`);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM ask_turns").get().n, 0);
});

test("R4a: a member turn without a hash row, not legacy, is not read by name; legacy is read by the member's own key only", async () => {
  const env = await makeEnv();
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000a4";
  env.DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, answer, status, share, created_at) VALUES (?, 'red-fox', ?, 'zq a', 'answered', 0, '2026-10-01T00:00:00Z')").run(id, Q);
  assert.equal((await api(env, "GET", `/ask?id=${id}`, "red")).body.ask, null, "no hash, not legacy");
  env.DB.raw.prepare("INSERT INTO ask_turn_legacy (intent_id) VALUES (?)").run(id);
  assert.equal((await api(env, "GET", `/ask?id=${id}`, "red")).body.ask.text, Q, "legacy, own key");
  assert.equal((await api(env, "GET", `/ask?id=${id}`, "blue")).body.ask, null, "legacy, another key");
});

test("R4b: a member named Visitor does not get guests' private turns from the no-id latest read", async () => {
  const env = await makeEnv();
  env.DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('visitor', ?, '2026-11-01T00:00:00Z')").run(await sha256Hex(`${KEY_SALT}:member-key-for-tests-visitor-0123456`));
  WHO.visitor = { Authorization: "Board member-key-for-tests-visitor-0123456" };
  const g = await api(env, "POST", "/intent", "anon", { kind: "ask", patch: { text: Q } });
  answered(env, g.body.id);
  const r = await api(env, "GET", "/ask", "visitor");
  assert.ok(!JSON.stringify(r.body).includes("zq"), JSON.stringify(r.body));
});

test("R6: GET /ask answers are never cached", async () => {
  const env = await makeEnv();
  const init = { headers: { "CF-Connecting-IP": "198.51.100.250" } };
  const r = await worker.fetch(new Request(`${ORIGIN}/api/ask?id=aaaaaaaa-bbbb-4ccc-8ddd-0000000000ff`, init), env, ctx);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
});
