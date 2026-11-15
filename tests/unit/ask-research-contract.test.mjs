// W4a: with ASK_RESEARCH on, a question the library cannot answer still gets a model answer (no code-written refusal), model knowledge is worded as a
// Classic value, the deleters become labellers, and mention/link/hidden-field safety holds. With the flag off nothing changes (W0's golden test covers that).
// Fictional names only; no network (fetch stubbed). Run: node --test tests/unit/ask-research-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { answerWithAi, buildAnswerCacheKey, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { lintResearchAnswer } from "../../infrastructure/worker/answer-lint.js";
import { ABSTAIN_LINE } from "../../infrastructure/worker/self-rag.js";
import { NOT_PUBLISHED_LINE } from "../../infrastructure/worker/ask-build.js";
import { RESEARCH_RULES } from "../../infrastructure/worker/research/rules.js";
import { defuseLinks, neutraliseMentions } from "../../infrastructure/worker/research/label.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
let sent = [];
let fetchUrls = [];
let aiCalls = 0;
let aiThrows = false;
let reply = () => "Mira tanks tonight.\n-# Sources: classes/tanking";
// Outside providers answer through fetch (groq shape; gemini is only counted); the Workers AI binding answers through env.AI.run. Both record the request.
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push(body);
  fetchUrls.push(String(url));
  return new Response(JSON.stringify({ choices: [{ message: { content: reply(body) } }], candidates: [{ content: { parts: [{ text: reply(body) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
};
const fakeAi = { run: async (_model, inputs) => { aiCalls++; sent.push(inputs); if (aiThrows) throw new Error("workers ai down"); return { response: reply(inputs), usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
test.after(() => { globalThis.fetch = realFetch; });

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(12), goals: f("OWNHIDDEN tank the Deadmines", false) }, updated: "x" },
  { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), spec_path: f("frost OTHERSECRETSPEC", false), goals: f("OTHERHIDDENGOAL text", false), level: f(9) }, updated: "x" },
];
const TANK_PAGE = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };

let n = 0;
async function ask(question, { research = true, pages = [TANK_PAGE], sheets = SHEETS, share = true, by = "Red Fox", memberSlug = "red-fox", respond, provider = "groq", throws = false } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = schemaDb();
  for (const p of pages) DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets));
  const env = { DB, AI: fakeAi, GROQ_API_KEY: "test-key-not-real", GEMINI_API_KEY: "test-gemini-not-real", AI_GATEWAY_ID: "gw", CLOUDFLARE_ACCOUNT_ID: "acct", ...(research ? { ASK_RESEARCH: "on" } : {}), BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  const id = `rc${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, 'groq', 'thinking', ?, 'x')").run(id, by, question, share ? 1 : 0);
  sent = []; fetchUrls = []; aiCalls = 0; aiThrows = throws;
  reply = respond || (() => "Mira tanks tonight.\n-# Sources: classes/tanking");
  const silence = console.error; console.error = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug, question, provider, share, journey: "curious", isMember: true }); } finally { console.error = silence; }
  const row = DB.raw.prepare("SELECT answer, cites_json, model, status FROM ask_turns WHERE id = ?").get(id);
  return { answer: row.answer, row: { ...row }, calls: sent.length, aiCalls, fetchUrls: fetchUrls.slice(), bodies: sent.slice(), prompt: sent.map((b) => (b.messages || []).map((m) => m.content).join("\n")).join("\n=====\n") };
}
const ABSTAIN_Q = "tell me about the weather";
const SOURCES = "\n-# Sources: general Classic-era knowledge, unconfirmed";

test("mention-in-title: @everyone, <@id> and <@&id> from a library title never reach the prompt or the answer", async () => {
  const bad = { ...TANK_PAGE, title: "Tanking @everyone <@123456> <@&987654> <@!555>" };
  const r = await ask("who tanks tonight", { pages: [bad], respond: () => "Read Tanking @everyone <@123456> <@&987654> <@!555> for who tanks tonight.\n-# Sources: classes/tanking" });
  const RAW = /@everyone|@here|<@[!&]?\d+>/i;
  assert.ok(!RAW.test(r.prompt), "prompt must not carry a live mention from a title");
  assert.ok(!RAW.test(r.answer), `answer carries a live mention: ${r.answer}`);
  // an answer the model writes from general knowledge is cleaned the same way
  const g = await ask(ABSTAIN_Q, { respond: () => `Weather is not in the game. Ping @everyone or <@777> or <@&888>.${SOURCES}` });
  assert.ok(!RAW.test(g.answer), g.answer);
  assert.equal(neutraliseMentions("hi @here <@1> <@&2> <@!3> @EVERYONE").match(/@here|@everyone|<@[!&]?\d+>/gi), null);
});

test("masked-link host spoof is rejected: the visible host must be the real host", async () => {
  const r = await ask(ABSTAIN_Q, { respond: () => `Check [github.com](https://evil.example/login) and [docs](<https://user@evil.example/x>) and https://evil.example/bare for the weather.${SOURCES}` });
  assert.ok(!/evil\.example/.test(r.answer.replace(/`[^`]*`/g, "")), `a clickable evil host survived: ${r.answer}`);
  assert.ok(!/\]\(<?https?:\/\/evil/.test(r.answer));
  // helper: an honest label stays, a spoofed one and a userinfo url go
  assert.match(defuseLinks("[the docs](<https://example.org/a>)"), /\[the docs\]\(<https:\/\/example\.org\/a>\)/);
  assert.ok(!/\]\(/.test(defuseLinks("[example.org](<https://evil.test/a>)")));
  assert.ok(!/\]\(/.test(defuseLinks("[example.org](<https://example.org@evil.test/a>)")));
  assert.ok(!/\]\(/.test(defuseLinks("[x](<javascript:alert(1)>)")));
});

test("hidden sheet fields: another member's never reach the prompt or the answer; the asker's own never on a public ask", async () => {
  for (const q of [ABSTAIN_Q, "who tanks tonight"]) {
    const r = await ask(q, { share: true });
    assert.equal(r.calls >= 1, true);
    for (const secret of ["OTHERSECRETSPEC", "OTHERHIDDENGOAL", "OWNHIDDEN"]) {
      assert.ok(!r.prompt.includes(secret), `${secret} reached the prompt for "${q}"`);
      assert.ok(!r.answer.includes(secret), `${secret} reached the answer for "${q}"`);
    }
  }
});

test("lint: two confidence words fail, banter-only fails, a clean answer passes", () => {
  const ok = "**Pick Frost: it kills faster at your level.**\nIt has the better opener.\n*Go on, the wand is waiting.*\n-# Sources: Classic-era knowledge · likely · about 2 years old";
  assert.deepEqual(lintResearchAnswer(ok).failures, []);
  assert.ok(lintResearchAnswer(ok.replace("likely", "likely and unconfirmed")).failures.includes("two_confidence_words"));
  assert.ok(lintResearchAnswer(ok.replace("likely", "confirmed likely")).failures.includes("two_confidence_words"));
  assert.ok(lintResearchAnswer(ok.replace("Sources: Classic-era knowledge · likely · about 2 years old", "Sources: Classic-era knowledge")).failures.includes("no_confidence_word"));
  const banter = "*Ha, the weather is always cursed in Azeroth.*\n-# Sources: general knowledge · unconfirmed";
  assert.ok(lintResearchAnswer(banter).failures.includes("banter_only"));
  assert.ok(lintResearchAnswer("*One joke.*\n*Two jokes.*\n**A real answer sentence here.**\n-# Sources: x · likely").failures.includes("multiple_banter"));
  assert.ok(lintResearchAnswer(`**${ABSTAIN_LINE}**\n-# Sources: none · unconfirmed`).failures.includes("refusal"));
  assert.ok(lintResearchAnswer("**Ask someone else about that.**\n-# Sources: none · unconfirmed").failures.includes("refusal"));
});

test("a model-sourced number is worded as a Classic value, not deleted and not stated bare", async () => {
  const r = await ask(ABSTAIN_Q, { respond: () => `**The weather is not a game system.**\nThe zone event lasts 45 minutes in Classic. Mira likes it.${SOURCES}` });
  assert.ok(r.calls === 1);
  assert.match(r.answer, /45 minutes[^.\n]*not confirmed for Forever/i, r.answer);
  assert.match(r.answer, /Mira likes it/);
  assert.ok(!r.answer.includes(NOT_PUBLISHED_LINE) && !r.answer.includes(ABSTAIN_LINE));
});

test("a long answer is cut on a sentence, never mid-sentence, and stays under 2000 characters; a normal one stays short", async () => {
  const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i % 4} says the same plain thing about the weather again.`).join(" ");
  const r = await ask(ABSTAIN_Q, { respond: () => `**The weather is flavour only.**\n${long}${SOURCES}` });
  assert.ok(r.answer.length < 2000, String(r.answer.length));
  const body = r.answer.split("\n").filter((l) => !/^\s*-#/.test(l)).join(" ").trim();
  assert.match(body, /[.!?…*]$/, `ends mid-sentence: ...${body.slice(-40)}`);
  const short = await ask(ABSTAIN_Q, { respond: () => `**The weather is flavour only.**\nNo game system reads it.${SOURCES}` });
  assert.ok(short.answer.length < 400, String(short.answer.length));
});

test("flag on: the code-written refusal is never returned, the model is called, and the prompt carries research rules and a larger token budget", async () => {
  const on = await ask(ABSTAIN_Q);
  assert.equal(on.calls, 1, "the provider must be called when the library has nothing");
  assert.ok(!on.answer.includes(ABSTAIN_LINE) && !on.answer.includes(NOT_PUBLISHED_LINE) && !/won't guess/i.test(on.answer));
  assert.notEqual(on.row.model, "abstain");
  assert.ok(on.prompt.includes(RESEARCH_RULES), "research rules in the prompt");
  assert.ok(!on.prompt.includes("The library has nothing on this question. Say so plainly"), "the old abstain rule must not be in the prompt");
  assert.equal(on.bodies[0].max_tokens, 600);
  assert.equal((await ask("who tanks tonight", { research: false, provider: "groq" })).bodies[0].max_tokens, 350, "flag off keeps the 350 budget");
  // the model itself writes the refusal: it is still not returned as the answer
  const echo = await ask(ABSTAIN_Q, { respond: () => `**${ABSTAIN_LINE}**` });
  assert.ok(!echo.answer.includes(ABSTAIN_LINE) && !echo.answer.includes(NOT_PUBLISHED_LINE), echo.answer);
  assert.ok(echo.answer.trim().length > 0);
  const echo2 = await ask(ABSTAIN_Q, { respond: () => NOT_PUBLISHED_LINE });
  assert.ok(!echo2.answer.includes(NOT_PUBLISHED_LINE), echo2.answer);
});

test("flag off: the old code-written abstain with zero model calls", async () => {
  const off = await ask(ABSTAIN_Q, { research: false });
  assert.equal(off.calls, 0);
  assert.equal(off.row.model, "library:abstain");
  assert.match(off.answer, /does not cover that yet/i);
});

test("a research answer from the model passes the research lint after finishing (one confidence word, a sources line)", async () => {
  const r = await ask(ABSTAIN_Q, { respond: () => `**The weather is flavour only in Classic.**\nNo game system reads it.\n*Bring an umbrella anyway.*\n-# Sources: general Classic-era knowledge · likely · unconfirmed` });
  assert.deepEqual(lintResearchAnswer(r.answer).failures.filter((x) => x !== "first_sentence_not_bold"), [], r.answer);
  const words = (r.answer.split("\n").find((l) => /^-#\s*Sources?:/i.test(l)) || "").match(/\b(?:confirmed|likely|unconfirmed)\b/gi) || [];
  assert.equal(words.length, 1, r.answer);
});

test("cache keys differ between modes; the off key is unchanged by the new parameter", async () => {
  const base = { provider: "groq", model: "m", systemPrompt: "S", userPrompt: "U" };
  const a = await buildAnswerCacheKey(base);
  const b = await buildAnswerCacheKey({ ...base, research: true });
  assert.notEqual(a, b);
  assert.equal(a, await buildAnswerCacheKey({ ...base, research: false }));
});

test("provider forcing (a): flag on, with a Gemini key and the AI binding present, Gemini is never called and Workers AI is", async () => {
  for (const [q, p] of [[ABSTAIN_Q, "gemini"], ["who tanks tonight", "gemini"], [ABSTAIN_Q, "groq"]]) {
    const r = await ask(q, { provider: p });
    assert.equal(r.aiCalls, 1, `${q}/${p}`);
    assert.deepEqual(r.fetchUrls, [], "no outside provider request of any kind");
  }
});

test("provider forcing (b): Workers AI throws -> no Gemini or other outside call; library facts plus an honest line, or an honest line alone; never the old refusal", async () => {
  const withLib = await ask("who tanks tonight", { provider: "gemini", throws: true });
  assert.deepEqual(withLib.fetchUrls, []);
  assert.match(withLib.answer, /Who tanks tonight is agreed in the party channel/);
  assert.match(withLib.answer, /out of reach/i);
  const noLib = await ask(ABSTAIN_Q, { provider: "gemini", throws: true });
  assert.deepEqual(noLib.fetchUrls, []);
  assert.ok(noLib.answer.trim().length > 0 && /out of reach/i.test(noLib.answer), noLib.answer);
  for (const a of [withLib.answer, noLib.answer]) assert.ok(!a.includes(ABSTAIN_LINE) && !a.includes(NOT_PUBLISHED_LINE) && !/won't guess/i.test(a), a);
});

test("provider forcing (c): flag off, the requested provider is used as before (Gemini asked -> Gemini fetch, no Workers AI)", async () => {
  const r = await ask("who tanks tonight", { research: false, provider: "gemini" });
  assert.equal(r.aiCalls, 0);
  assert.ok(r.fetchUrls.length >= 1 && r.fetchUrls.every((u) => /generativelanguage|gateway|google-ai-studio/i.test(u)), r.fetchUrls.join(","));
});
