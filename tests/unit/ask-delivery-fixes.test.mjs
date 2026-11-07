// Delivery fixes: question echo, no leaked {board:...} token or library stamp, no model-written chicken line, and the same member
// asking the same question twice within 10 minutes gets the same stored answer with no new model call. Fictional names only.
// Run: node --test tests/unit/ask-delivery-fixes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { quoteQuestion } from "../../infrastructure/worker/discord.js";
import { formatAnswer, stripEggLine, DEFAULT_EGG } from "../../infrastructure/worker/answer-format.js";
import { answerWithAi, finishAnswerText, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { insertAskTurn } from "../../infrastructure/worker/answer-ux.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

test("quoteQuestion is short, one line, and defuses mentions, brackets and links", () => {
  const q = quoteQuestion("what\nis  @everyone <@123> https://evil.test/x " + "z".repeat(400));
  assert.ok(q.startsWith("> **Q:** what is @​everyone"));
  assert.ok(!q.includes("\n") && !q.includes("<") && !q.includes("://"), "no live link");
  assert.ok(q.length < 200);
});

test("an unexpanded {board:...} token and a bare library stamp never reach the reader", () => {
  const raw = "**Onyxia opens Dec 9.**\n\n-# Sources: raids/onyxias-lair\n-# {board:abc123}\n-# b3eb27df\nb3eb27df\nSee {board:zzz} too.";
  const out = formatAnswer(raw, { pages: [{ id: "raids/onyxias-lair", title: "Onyxia" }], asker: { name: "Red Fox", isMember: true } });
  assert.ok(!/\{board:|b3eb27df/.test(out), out);
  assert.match(out, /-# Sources: \[Onyxia\]/);
});

test("a stray -# footer that is not Sources or a board link is dropped", () => {
  const out = formatAnswer("**A.**\n\n-# Sources: raids/onyxias-lair\n-# some flourish", { pages: [{ id: "raids/onyxias-lair", title: "Onyxia" }], asker: { name: "Red Fox", isMember: true } });
  assert.ok(!out.includes("flourish"));
  assert.match(out, /Sources/);
});

test("a model-written chicken line is stripped, inline or as a last paragraph", () => {
  assert.equal(stripEggLine(`**A.** Fine. ${DEFAULT_EGG.line}`, null), "**A.** Fine.");
  assert.equal(stripEggLine(`**A.**\n\n${DEFAULT_EGG.line}\n`, null), "**A.**");
  assert.equal(stripEggLine("**A.**", null), "**A.**");
});

test("finishAnswerText strips the model's chicken line even when the egg is not due", async () => {
  const env = { DB: schemaDb() };
  invalidateConfigCache();
  const r = await finishAnswerText(env, { rawAnswer: `**Holy Shield helps.**\n\n${DEFAULT_EGG.line}`, isCoach: false, parsedPages: [], by: "Red Fox", askerIsMember: true, persona: null, intentId: "no-egg-1" });
  assert.ok(!r.answer.includes("chicken"));
});

// ---- same question twice ----
function makeEnv() {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES ('raids/onyxias-lair','raids','Onyxia','Onyxia',?,?,'2026-11-01T00:00:00Z')").run("[]", JSON.stringify([{ key: "o.opens", value: "Onyxia opens on 2026-12-09." }]));
  const calls = [];
  const room = { fetch: async () => new Response("ok") };
  const env = {
    DB, USER_SALT: "user-salt-for-tests-0123456789", KEY_SALT: "key-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef",
    BOARD_ROOM: { idFromName: () => "r", get: () => room },
    AI: { run: async () => { calls.push(1); return { response: `**Onyxia opens on 2026-12-09 (answer ${calls.length}).**\n\n-# Sources: raids/onyxias-lair`, usage: { prompt_tokens: 5, completion_tokens: 5 } }; } },
  };
  return { env, calls };
}
let n = 0;
async function ask(env, { slug = "red-fox", by = "Red Fox", question = "When does Onyxia open?", share = true } = {}) {
  const id = `r${++n}`;
  await insertAskTurn(env, { id, byName: by, question, provider: "workers-ai", share, createdAt: new Date().toISOString() }, slug ? { slug } : {});
  const silence = [console.error, console.warn]; console.error = () => {}; console.warn = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug: slug, question, provider: "workers-ai", share, isMember: Boolean(slug) }); }
  finally { [console.error, console.warn] = silence; }
  return env.DB.raw.prepare("SELECT * FROM ask_turns WHERE id = ?").get(id);
}

test("the same member asking the same question again gets the same answer with no new model call", async () => {
  const { env, calls } = makeEnv();
  const first = await ask(env);
  assert.equal(first.status, "answered");
  const second = await ask(env, { question: "  when does onyxia open  " });
  assert.equal(second.answer, first.answer);
  assert.equal(calls.length, 1, "no second model call");
  assert.equal(second.model, "reused-answer");
});

test("a different question, a different member, a visitor, or a different visibility is not reused", async () => {
  const { env, calls } = makeEnv();
  await ask(env);
  await ask(env, { question: "When does Onyxia open again?" });
  await ask(env, { slug: "blue-owl", by: "Blue Owl" });
  await ask(env, { share: false });
  assert.equal(calls.length, 4);
  await ask(env, { slug: "", by: "Visitor" });
  await ask(env, { slug: "", by: "Visitor" });
  assert.equal(calls.length, 6, "visitors are never matched");
});

test("an answer older than 10 minutes is not reused", async () => {
  const { env, calls } = makeEnv();
  const first = await ask(env);
  env.DB.raw.prepare("UPDATE ask_turns SET answered_at = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), first.id);
  await ask(env);
  assert.equal(calls.length, 2);
});

test("quoteQuestion: nested link tricks, backticks, spoilers and strikethrough cannot come back or bleed", () => {
  const q = quoteQuestion("hthttps://tps://x `code` ||spoiler|| ~~strike~~ www.x.test");
  assert.ok(!q.includes("://"), q);
  assert.ok(!/[`|~]/.test(q.slice("> **Q:** ".length)), q);
  assert.equal(quoteQuestion(quoteQuestion("a").slice(9)), quoteQuestion("a"), "stable");
});

test("A, five other questions, then A again within 10 minutes is still reused", async () => {
  const { env, calls } = makeEnv();
  const first = await ask(env);
  for (const q of ["one?", "two?", "three?", "four?", "five?", "six?"]) await ask(env, { question: q });
  const before = calls.length;
  const again = await ask(env);
  assert.equal(calls.length, before, "no new model call");
  assert.equal(again.answer, first.answer);
});

test("a reused answer is not itself a reuse source: the window is measured from generation", async () => {
  const { env, calls } = makeEnv();
  const first = await ask(env);
  env.DB.raw.prepare("UPDATE ask_turns SET answered_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 60 * 1000).toISOString(), first.id);
  const reused = await ask(env);
  assert.equal(reused.model, "reused-answer");
  env.DB.raw.prepare("UPDATE ask_turns SET answered_at = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), first.id);
  const callsBefore = calls.length;
  await ask(env);
  assert.equal(calls.length, callsBefore + 1, "the original expired, so the reuse row cannot extend it");
});

test("the real Discord /ask path: a repeated question edits the reply with the stored answer and the quoted question, no second model call", async () => {
  const { env, calls } = makeEnv();
  const signer = createDiscordSigner();
  env.DISCORD_PUBLIC_KEY = signer.publicKeyHex;
  const patches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/messages/@original")) { if (init.method === "PATCH") patches.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    return new Response("{}", { status: 200 });
  };
  const interaction = (n) => ({
    id: `fix-int-${n}`, application_id: "fixture-app-0001", token: `fixture-token-${n}`, version: 1, type: 2,
    member: { user: { id: "fixture-user-0001", username: "fixture_tester", global_name: "Fixture Tester" }, nick: null, roles: [] },
    data: { id: "fixture-cmd-ask", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "when does onyxia open" }] },
  });
  try {
    for (const n of [1, 2]) {
      const pending = [];
      const res = await handleDiscordInteraction(signer.signedRequest(interaction(n)), env, { waitUntil: (p) => pending.push(p) }, "https://worker.test");
      assert.equal(res.status, 200);
      await Promise.allSettled(pending);
    }
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1, "one model call for two asks");
  assert.equal(patches.length, 2);
  assert.ok(patches[1].content.startsWith("> **Q:** when does onyxia open"), patches[1].content);
  const body = (c) => c.split("\n\n").slice(1).join("\n\n");
  assert.equal(body(patches[1].content), body(patches[0].content), "same answer text");
});

// ---- follow-up polish ----
test("quoteQuestion: an emoji at the 160 boundary never leaves a lone surrogate; * and _ are stripped", () => {
  const q = quoteQuestion("x".repeat(159) + "\u{1F525}\u{1F525}");
  const body = q.slice("> **Q:** ".length);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body), "no lone surrogate");
  assert.equal(Array.from(body).length, 160);
  assert.ok(!/[*_]/.test(quoteQuestion("**bold __under_ *x*").slice("> **Q:** ".length)));
});

test("stripEggLine ignores an egg line shorter than 8 characters", () => {
  assert.equal(stripEggLine("The raid opens Dec 9. Ok.", "Ok."), "The raid opens Dec 9. Ok.");
  assert.equal(stripEggLine("Fine. Extra chicken please.", "Extra chicken please."), "Fine.");
});

test("bad stored cites JSON does not turn a good stored answer into an error row", async () => {
  const { env, calls } = makeEnv();
  const first = await ask(env);
  env.DB.raw.prepare("UPDATE ask_turns SET cites_json = ? WHERE id = ?").run("{not json", first.id);
  const again = await ask(env);
  assert.equal(again.status, "answered");
  assert.equal(again.answer, first.answer);
  assert.equal(again.cites_json, "[]");
  assert.equal(calls.length, 1);
});

test("a member ask carries two hashes, yet the 50-row lookup still reaches about 50 turns back", async () => {
  const { env, calls } = makeEnv();
  const ask2 = async (question) => {
    const id = `d${++n}`;
    await insertAskTurn(env, { id, byName: "Red Fox", question, provider: "workers-ai", share: true, createdAt: new Date().toISOString() }, { slug: "red-fox", discordId: "100000000000000001" });
    const silence = [console.error, console.warn]; console.error = () => {}; console.warn = () => {};
    try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Red Fox", memberSlug: "red-fox", question, provider: "workers-ai", share: true, isMember: true }); }
    finally { [console.error, console.warn] = silence; }
    return env.DB.raw.prepare("SELECT * FROM ask_turns WHERE id = ?").get(id);
  };
  const first = await ask2("When does Onyxia open?");
  for (let i = 0; i < 30; i++) await ask2(`filler question number ${i}?`);
  const before = calls.length;
  const again = await ask2("When does Onyxia open?");
  assert.equal(calls.length, before, "reused: duplicates from the two hashes do not eat the limit");
  assert.equal(again.answer, first.answer);
});
