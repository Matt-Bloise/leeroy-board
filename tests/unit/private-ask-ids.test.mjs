// A private (share 0) ask's id reaches no socket but its asker's. The id is the credential at GET /api/ask?id=, so a socket that sees it can read the
// private question. Drives the real answerWithAi on the success, reused and error paths (the error path forced by a failing answer write), and sends
// every broadcast through BoardRoom to an anonymous, a member, a web-session and the asker's own guest socket. Fictional data, no network, no AI.
// Run: node --test tests/unit/private-ask-ids.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { insertAskTurn } from "../../infrastructure/worker/answer-ux.js";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

let n = 0;
const newId = () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, "0")}`;

function makeEnv({ failAnswerWrite = false } = {}) {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES ('raids/onyxias-lair','raids','Onyxia','Onyxia',?,?,'2026-11-01T00:00:00Z')")
    .run("[]", JSON.stringify([{ key: "onyxia.open", value: "Onyxia opens on 2026-12-09 for a fictional raid", depth: "must" }]));
  if (failAnswerWrite) {
    const real = DB.prepare.bind(DB);
    DB.prepare = (sql) => (/^UPDATE ask_turns SET answer = \?, cites_json/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("zq write failed"); } }) } : real(sql));
  }
  const sent = [];
  const room = { fetch: async (_u, init) => { if (init && init.body) sent.push(String(init.body)); return new Response("ok"); } };
  const env = {
    DB, sent, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "key-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef",
    BOARD_ROOM: { idFromName: () => "r", get: () => room },
    AI: { run: async () => ({ response: "**Onyxia opens on 2026-12-09.**\n\n-# Sources: raids/onyxias-lair", usage: { prompt_tokens: 5, completion_tokens: 5 } }) },
  };
  return env;
}

async function ask(env, { id = newId(), slug = "red-fox", by = "Red Fox", share = false, isMember = true, question = "When does Onyxia open?" } = {}) {
  await insertAskTurn(env, { id, byName: by, question, provider: "workers-ai", share, createdAt: new Date().toISOString() }, slug ? { slug } : {});
  const silence = [console.error, console.warn, console.log]; console.error = console.warn = console.log = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug: slug || undefined, question, provider: "workers-ai", share, isMember }); }
  finally { [console.error, console.warn, console.log] = silence; }
  return id;
}

// Every message the Worker handed the room, as each audience receives it.
function audiences(env, askId) {
  const got = { anon: [], member: [], web: [], owner: [], otherGuest: [] };
  const sock = (aud, sink) => ({ deserializeAttachment: () => aud, send: (m) => sink.push(m) });
  for (const m of env.sent) {
    const ctx = { getWebSockets: () => [sock({}, got.anon), sock({ member: true }, got.member), sock({ member: true, web: true }, got.web), sock({ ask: askId }, got.owner), sock({ ask: newId() }, got.otherGuest)], setWebSocketAutoResponse() {} };
    new BoardRoom(ctx, {}).broadcast(m);
  }
  return got;
}
const seenBy = (got, id) => Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.some((m) => m.includes(id))]));

const CASES = [
  ["a member's private ask, answered", { share: false, isMember: true }, false],
  ["a member's private ask, failed", { share: false, isMember: true }, true],
  ["a guest's ask, answered", { share: false, isMember: false, slug: "", by: "Visitor" }, false],
  ["a guest's ask, failed", { share: false, isMember: false, slug: "", by: "Visitor" }, true],
];
for (const [name, opts, fail] of CASES) {
  test(`${name}: its id reaches no member, web, anonymous or other guest socket`, async () => {
    const env = makeEnv({ failAnswerWrite: fail });
    const id = await ask(env, opts);
    assert.ok(env.sent.length > 0, "the Worker broadcast something");
    const seen = seenBy(audiences(env, id), id);
    assert.deepEqual({ ...seen, owner: undefined }, { anon: false, member: false, web: false, owner: undefined, otherGuest: false }, JSON.stringify(env.sent));
    if (fail) assert.ok(env.sent.some((m) => /"status":"error"/.test(m)), "the error path ran");
  });
}

test("a shared ask's id still reaches members (shared answers are for the group)", async () => {
  const env = makeEnv();
  const id = await ask(env, { share: true });
  const seen = seenBy(audiences(env, id), id);
  assert.equal(seen.member, true);
  assert.equal(seen.anon, false);
});

test("the private error item carries no id, name, question or error text", async () => {
  const env = makeEnv({ failAnswerWrite: true });
  const id = await ask(env, { share: false, question: "zq private question" });
  const err = env.sent.map((m) => JSON.parse(m)).find((m) => m.type === "intent" && m.item && m.item.status === "error");
  assert.ok(err, JSON.stringify(env.sent));
  assert.deepEqual(Object.keys(err.item).sort(), ["at", "kind", "status"]);
  assert.ok(!JSON.stringify(err).includes(id) && !JSON.stringify(err).includes("zq"));
});
