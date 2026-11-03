// More / Sources / Helpful / Off buttons (ANSWER_UX): split, delivery, button handler, feedback report, cleanup.
// Fake D1, fake fetch, fake Workers AI binding. No network, no AI calls, no real keys or ids.
// Run: node --test tests/unit/answer-ux.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatAnswerParts, formatAnswer, splitAnswerParts } from "../../infrastructure/worker/answer-format.js";
import { invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import worker from "../../infrastructure/worker/index.js";
import { splitForDiscord, cleanupAnswerUx, EXPIRED_TEXT } from "../../infrastructure/worker/answer-ux.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const PAGES = [{ id: "raids/onyxias-lair", category: "raids", title: "Onyxia's Lair", facts: [{ key: "onyxia.opens", value: "Onyxia's Lair opens on 2026-12-09." }] }].map((p) => ({
  ...p,
  as_of: "2026-11-01",
  blurb: p.title,
  aliases_json: "[]",
  facts_json: JSON.stringify(p.facts),
  open_json: "[]",
}));

const LONG_MORE = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. ${"detail ".repeat(120)}`).join("\n\n");
const MODEL_RAW =
  "**Onyxia's Lair opens on 2026-12-09.**\n\n" +
  "-# Sources: raids/onyxias-lair\n\n" +
  "---more---\n" +
  `${LONG_MORE}\n\n` +
  "---sources---\n" +
  "raids/onyxias-lair\nhttps://example.test/page";
const SHORT_RAW = "**Short one.**\n---more---\nExtra line about Matt and Skippy.";

// ---- fake D1 ----
function fakeDb() {
  const turns = new Map();
  const details = new Map();
  const feedback = new Map(); // `${intent}|${user}` -> row
  const writes = [];
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        if (/FROM ask_turns/i.test(sql)) return turns.get(args[0]) || null;
        if (/FROM answer_details/i.test(sql)) return details.get(args[0]) || null;
        if (/FROM kv_state/i.test(sql)) {
          const key = /key = '([a-z_]+)'/.exec(sql)?.[1] ?? args[0];
          return key === "persona" ? { json: JSON.stringify({ system: "S", ackLines: ["thinking line"], errorLines: ["Leeroy tripped."] }) } : null;
        }
        return null;
      },
      all: async () => {
        if (/FROM lib_pages/i.test(sql)) return { results: PAGES };
        if (/FROM answer_feedback WHERE created_at >= \? GROUP BY vote/i.test(sql)) {
          const tally = new Map();
          for (const f of feedback.values()) if (f.created_at >= args[0]) tally.set(f.vote, (tally.get(f.vote) || 0) + 1);
          return { results: [...tally].map(([vote, n]) => ({ vote, n })) };
        }
        if (/FROM answer_feedback f/i.test(sql)) {
          const rows = [...feedback.values()]
            .filter((f) => f.created_at >= args[0])
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .slice(0, 50)
            .map((f) => {
              const t = turns.get(f.intent_id);
              return { intent_id: f.intent_id, vote: f.vote, created_at: f.created_at, question: t ? t.question : null, answer: t && t.answer ? t.answer.slice(0, 160) : null };
            });
          return { results: rows };
        }
        return { results: [] };
      },
      run: async () => {
        writes.push({ sql, args });
        if (/^INSERT INTO ask_turns/i.test(sql)) turns.set(args[0], { id: args[0], question: args[2], answer: null, status: "thinking", model: args[3] });
        if (/^UPDATE ask_turns SET answer = \?, cites_json/i.test(sql)) {
          const [answer, cites, model, , , id] = args;
          turns.set(id, { ...turns.get(id), id, answer, cites, model, status: "answered" });
        }
        if (/^INSERT OR REPLACE INTO answer_details/i.test(sql)) {
          details.set(args[0], { intent_id: args[0], more: args[1], sources: args[2], asker_hash: args[3], message_id: args[4], created_at: args[5] });
        }
        if (/^UPDATE answer_details SET message_id/i.test(sql)) Object.assign(details.get(args[2]), { message_id: args[0], asker_hash: args[1] });
        if (/^INSERT INTO answer_feedback/i.test(sql)) {
          const [intent_id, user_hash, vote, created_at] = args;
          feedback.set(`${intent_id}|${user_hash}`, { intent_id, user_hash, vote, created_at });
        }
        if (/^DELETE FROM answer_details/i.test(sql)) for (const [k, v] of details) if (v.created_at < args[0]) details.delete(k);
        if (/^DELETE FROM answer_feedback/i.test(sql)) for (const [k, v] of feedback) if (v.created_at < args[0]) feedback.delete(k);
        return { success: true, meta: { changes: 1, last_row_id: writes.length } };
      },
    };
    return stmt;
  };
  return { prepare, batch: async (s) => { const out = []; for (const x of s) out.push(await x.run()); return out; }, turns, details, feedback, writes }; // a real batch runs every statement
}

const signer = createDiscordSigner();
const realFetch = globalThis.fetch;
const realLog = console.log;
test.beforeEach(() => {
  invalidatePagesCache();
  invalidatePersonaCache();
  console.log = () => {};
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

const askBody = (extra = {}, user = "fixture-user-0001", options = []) => ({
  id: "fixture-interaction-0001",
  application_id: "fixture-app-0001",
  token: "fixture-token-not-real",
  version: 1,
  type: 2,
  member: { user: { id: user, username: "fixture_tester", global_name: "Fixture Tester" }, nick: null, roles: [] },
  data: { id: "fixture-cmd-ask", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "when does onyxia open" }, ...options] },
  ...extra,
});

function buttonBody(customId, { user = "fixture-user-0001", messageId = "fixture-msg-0001" } = {}) {
  return {
    id: "fixture-interaction-0002",
    application_id: "fixture-app-0001",
    token: "fixture-token-not-real",
    version: 1,
    type: 3,
    member: { user: { id: user, username: "fixture_tester" }, roles: [] },
    message: { id: messageId },
    data: { custom_id: customId, component_type: 2 },
  };
}

// Runs /ask end to end. Returns the env, db, captured PATCH bodies and follow-up posts.
async function runAsk({ raw = MODEL_RAW, ux = "on", options = [], user } = {}) {
  const db = fakeDb();
  const patches = [];
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/messages/@original")) {
      if ((init.method || "GET") === "GET") return new Response(JSON.stringify({ id: "fixture-msg-0001" }), { status: 200 });
      patches.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/webhooks/")) {
      posts.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const env = {
    DB: db,
    DISCORD_PUBLIC_KEY: signer.publicKeyHex,
    USER_SALT: "fixture-salt-0123456789",
    ASK_DEADLINE_MS: "2000",
    ...(ux ? { ANSWER_UX: ux } : {}),
    BOARD_ROOM: { idFromName: () => "room", get: () => ({ fetch: async () => new Response("ok") }) },
    AI: { run: async () => ({ response: raw }) },
  };
  const pending = [];
  const waitUntil = (p) => pending.push(p);
  const res = await handleDiscordInteraction(signer.signedRequest(askBody({}, user, options)), env, { waitUntil }, "https://worker.test");
  await res.json();
  await Promise.allSettled(pending);
  const ids = [...db.turns.keys()];
  return { env, db, patches, posts, intentId: ids[0], click: (customId, o) => click(env, customId, o, posts, waitUntil, pending) };
}

async function click(env, customId, opts, posts, waitUntil, pending) {
  const before = posts.length;
  const res = await handleDiscordInteraction(signer.signedRequest(buttonBody(customId, opts)), env, { waitUntil }, "https://worker.test");
  const body = await res.json();
  await Promise.allSettled(pending);
  return { body, followups: posts.slice(before) };
}

const idsOf = (patch) => (patch.components || []).flatMap((r) => r.components.map((c) => c.custom_id));
const labelsOf = (patch) => (patch.components || []).flatMap((r) => r.components.map((c) => c.label));

// ---- split ----

test("splitAnswerParts separates main, more and sources at the markers", () => {
  const parts = splitAnswerParts("Main line.\n---more---\nMore text.\n---sources---\nraids/x\n");
  assert.deepEqual(parts, { main: "Main line.", more: "More text.", sources: "raids/x" });
  assert.deepEqual(splitAnswerParts("Plain."), { main: "Plain.", more: "", sources: "" });
  assert.deepEqual(splitAnswerParts("A\n---sources---\ns1\n---more---\nm1"), { main: "A", more: "m1", sources: "s1" });
});

test("formatAnswerParts keeps only the main part in the channel text and guards the extras", () => {
  const ctx = { ux: true, pages: [{ id: "raids/onyxias-lair", title: "Onyxia's Lair" }], boardUrl: "https://leeroy.party" };
  const out = formatAnswerParts("**Head.**\n---more---\nMatt knows [raids/onyxias-lair].\n---sources---\n- raids/onyxias-lair\n- https://example.test/p", ctx);
  assert.equal(out.main, "**Head.**");
  assert.equal(out.more, "Bloise knows.");
  assert.equal(out.sources, "• [Onyxia's Lair](<https://leeroy.party/#library.raids.onyxias-lair>)\n• <https://example.test/p>");
  assert.ok(!out.main.includes("---"));
});

test("without ux nothing is split", () => {
  const raw = "**Head.**\n---more---\nMore.";
  const out = formatAnswerParts(raw, {});
  assert.equal(out.more, "");
  assert.equal(out.main, formatAnswer(raw, {}));
});

test("splitForDiscord yields at most 4 parts of at most 1900 characters", () => {
  const parts = splitForDiscord("word ".repeat(5000));
  assert.equal(parts.length, 4);
  for (const p of parts) assert.ok(p.length <= 1900);
  assert.deepEqual(splitForDiscord("short"), ["short"]);
});

// ---- delivery ----

test("/ask with ANSWER_UX=on: the channel text loses the extras and the reply carries signed buttons", async () => {
  const { patches, intentId, db } = await runAsk();
  assert.equal(patches.length, 1, "exactly one PATCH");
  assert.ok(!patches[0].content.includes("---"));
  assert.ok(!patches[0].content.includes("Paragraph 1"));
  assert.deepEqual(labelsOf(patches[0]), ["More if you want it", "Sources", "Helpful", "Off"]);
  const ids = idsOf(patches[0]);
  assert.match(ids[0], new RegExp(`^leeroy:more:${intentId}:[0-9a-f]{12}$`));
  assert.match(ids[1], new RegExp(`^leeroy:sources:${intentId}:[0-9a-f]{12}$`));
  assert.match(ids[2], new RegExp(`^leeroy:fb:up:${intentId}:[0-9a-f]{12}$`));
  assert.match(ids[3], new RegExp(`^leeroy:fb:down:${intentId}:[0-9a-f]{12}$`));
  assert.equal(db.details.get(intentId).message_id, "fixture-msg-0001");
  assert.equal(db.details.get(intentId).asker_hash, null, "public answers store no asker hash");
});

test("buttons only appear when there is something to show; feedback is always there", async () => {
  const { patches } = await runAsk({ raw: "**Just this.**" });
  assert.deepEqual(labelsOf(patches[0]), ["Helpful", "Off"]);
  const { patches: p2 } = await runAsk({ raw: SHORT_RAW });
  assert.deepEqual(labelsOf(p2[0]), ["More if you want it", "Helpful", "Off"]);
});

test("ANSWER_UX off: no components, no extra writes, markers untouched", async () => {
  const { patches, db } = await runAsk({ ux: "" });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].components, undefined);
  assert.equal(db.details.size, 0);
});

test("one structured log row per answer, with a short request id and no question text", async () => {
  const lines = [];
  console.log = (l) => lines.push(String(l));
  await runAsk();
  const row = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r && r.evt === "answer");
  assert.ok(row, "answer log row");
  assert.match(row.reqid, /^[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(row).sort(), ["evt", "fallback", "model", "ms", "provider", "reqid", "status"]);
  assert.equal(row.status, "answered");
  assert.ok(!JSON.stringify(row).includes("onyxia"));
});

// ---- buttons ----

test("More: ephemeral reply in parts of at most 1900 characters, first in the reply, the rest as follow-ups", async () => {
  const { patches, click: c, posts } = await runAsk();
  const moreId = idsOf(patches[0])[0];
  const { body, followups } = await c(moreId);
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.deepEqual(body.data.allowed_mentions, { parse: [] });
  assert.ok(body.data.content.length <= 1900 && body.data.content.startsWith("Paragraph 1."));
  assert.ok(followups.length >= 1 && followups.length <= 3);
  for (const f of followups) {
    assert.equal(f.flags, 64);
    assert.ok(f.content.length <= 1900);
    assert.deepEqual(f.allowed_mentions, { parse: [] });
  }
  assert.equal(posts.length, followups.length);
});

test("Sources: ephemeral list of linked pages and wrapped addresses", async () => {
  const { patches, click: c } = await runAsk();
  const { body } = await c(idsOf(patches[0])[1]);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /\[Onyxia's Lair\]\(<https:\/\/leeroy\.party\/#library\.raids\.onyxias-lair>\)/);
  assert.match(body.data.content, /<https:\/\/example\.test\/page>/);
});

test("the detail text passes the voice guards", async () => {
  const { patches, click: c } = await runAsk({ raw: SHORT_RAW });
  const { body } = await c(idsOf(patches[0])[0]);
  assert.equal(body.data.content, "Extra line about Bloise and Leeroy.");
});

test("an expired row replies with the rebuild line", async () => {
  const { patches, click: c, db, intentId } = await runAsk();
  db.details.delete(intentId);
  const { body } = await c(idsOf(patches[0])[0]);
  assert.equal(body.data.content, EXPIRED_TEXT);
  assert.equal(body.data.flags, 64);
});

test("a click from a different message, a forged signature or a mangled id is refused", async () => {
  const { patches, click: c } = await runAsk();
  const moreId = idsOf(patches[0])[0];
  assert.equal((await c(moreId, { messageId: "some-other-message" })).body.data.content, "That button is not valid.");
  assert.equal((await c(moreId.replace(/.$/, (ch) => (ch === "0" ? "1" : "0")))).body.data.content, "That button is not valid.");
  assert.equal((await c("leeroy:more:abc")).body.data.content, "That button is not valid.");
  assert.equal((await c("leeroy:fb:up:1:000000000000")).body.data.content, "That button is not valid.");
});

test("a private answer's detail is refused to anyone but the asker", async () => {
  const { patches, click: c, db, intentId } = await runAsk({ options: [{ name: "private", type: 5, value: true }] });
  assert.ok(db.details.get(intentId).asker_hash, "asker hash stored for a private answer");
  assert.ok(!db.details.get(intentId).asker_hash.includes("fixture-user"), "hash, not the id");
  const moreId = idsOf(patches[0])[0];
  assert.match((await c(moreId, { user: "fixture-user-0002" })).body.data.content, /belongs to the person who asked/);
  assert.match((await c(moreId, { user: "fixture-user-0001" })).body.data.content, /^Paragraph 1\./);
});

test("Helpful and Off: one vote per user per answer, a second click changes it, the buttons stay", async () => {
  const { patches, click: c, db, intentId } = await runAsk();
  const [, , up, down] = idsOf(patches[0]);
  const first = await c(up);
  assert.equal(first.body.data.content, "Thanks, noted.");
  assert.equal(first.body.data.flags, 64);
  assert.equal(first.body.type, 4, "ephemeral reply, the original message and its buttons are untouched");
  assert.equal(db.feedback.size, 1);
  await c(down);
  assert.equal(db.feedback.size, 1, "same user, same answer: still one row");
  assert.equal([...db.feedback.values()][0].vote, -1);
  await c(up, { user: "fixture-user-0002" });
  assert.equal(db.feedback.size, 2);
  for (const row of db.feedback.values()) {
    assert.equal(row.intent_id, intentId);
    assert.match(row.user_hash, /^[0-9a-f]{64}$/);
    assert.ok(!/fixture-user/.test(row.user_hash));
  }
});

test("flag off: a leftover button gets a polite ephemeral reply and nothing is written", async () => {
  const on = await runAsk();
  const moreId = idsOf(on.patches[0])[0];
  const upId = idsOf(on.patches[0])[2];
  on.env.ANSWER_UX = "off";
  const more = await on.click(moreId);
  assert.match(more.body.data.content, /switched off/);
  const fb = await on.click(upId);
  assert.match(fb.body.data.content, /switched off/);
  assert.equal(on.db.feedback.size, 0);
});

test("answer buttons never reach the sign-up handler", async () => {
  const { patches, click: c, db } = await runAsk();
  await c(idsOf(patches[0])[2]);
  assert.ok(!db.writes.some((w) => /signups/i.test(w.sql) || w.args.some((a) => a === "signups")));
});

// ---- admin report ----

async function adminGet(env, path, token) {
  return worker.fetch(
    new Request(`https://api.test${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "CF-Connecting-IP": "203.0.113.9" } }),
    env,
    { waitUntil() {} }
  );
}

test("GET /api/admin/feedback: 401 without the token, counts and the latest rows with it, never user ids", async () => {
  const { patches, click: c, env, db } = await runAsk();
  const [, , up, down] = idsOf(patches[0]);
  await c(up);
  await c(down, { user: "fixture-user-0002" });
  env.BOARD_ADMIN_TOKEN = "fixture-admin-token-0123456789";
  assert.equal((await adminGet(env, "/api/admin/feedback")).status, 401);
  assert.equal((await adminGet(env, "/api/admin/feedback", "wrong-token")).status, 401);
  const res = await adminGet(env, "/api/admin/feedback?since=2020-01-01T00:00:00Z", env.BOARD_ADMIN_TOKEN);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.counts, { up: 1, down: 1, total: 2 });
  assert.equal(body.latest.length, 2);
  assert.equal(body.latest[0].question, "when does onyxia open");
  assert.ok(body.latest[0].answer.length <= 160);
  assert.ok(!text.includes("user_hash") && !text.includes("fixture-user"));
  for (const f of db.feedback.values()) assert.ok(!text.includes(f.user_hash));
  assert.equal((await adminGet(env, "/api/admin/feedback?since=not-a-date", env.BOARD_ADMIN_TOKEN)).status, 400);
});

// ---- cleanup ----

test("cron cleanup deletes answer_details after 30 days and answer_feedback after 90", async () => {
  const db = fakeDb();
  const now = Date.parse("2026-12-01T00:00:00Z");
  const day = 86400000;
  const iso = (d) => new Date(now - d * day).toISOString();
  db.details.set("old", { created_at: iso(31) });
  db.details.set("new", { created_at: iso(29) });
  db.feedback.set("a|u", { intent_id: "a", created_at: iso(91) });
  db.feedback.set("b|u", { intent_id: "b", created_at: iso(89) });
  await cleanupAnswerUx({ DB: db }, now);
  assert.deepEqual([...db.details.keys()], ["new"]);
  assert.deepEqual([...db.feedback.keys()], ["b|u"]);
  // Tables missing (migration not applied yet): no throw.
  await cleanupAnswerUx({ DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("no such table"); } }) }) } }, now);
});

// ---- hygiene ----

test("no 17 to 20 digit Discord id in the button code, the migration or this file", () => {
  for (const f of ["../../infrastructure/worker/answer-ux.js", "../../infrastructure/migrations/0004_answer_details_feedback.sql", "./answer-ux.test.mjs"]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/(?<![0-9])[0-9]{17,20}(?![0-9])/.test(text), `${f} contains a Discord-style id`);
  }
});
