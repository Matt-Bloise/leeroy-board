// W4a: with ASK_RESEARCH on, a question the library cannot answer still gets a model answer (no code-written refusal), model knowledge is worded as a
// Classic value, the deleters become labellers, and mention/link/hidden-field safety holds. With the flag off nothing changes (W0's golden test covers that).
// Fictional names only; no network (fetch stubbed). Run: node --test tests/unit/ask-research-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerWithAi, buildAnswerCacheKey, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { lintResearchAnswer, splitSentenceText } from "../../infrastructure/worker/answer-lint.js";
import { RESEARCH_DOWN_ANSWER } from "../../infrastructure/worker/research/provider.js";
import { ABSTAIN_LINE } from "../../infrastructure/worker/self-rag.js";
import { NOT_PUBLISHED_LINE } from "../../infrastructure/worker/ask-build.js";
import { RESEARCH_RULES, RESEARCH_VOICE_RULES, RESEARCH_STRUCTURE_RULES, RESEARCH_MAX_TOKENS, RESEARCH_HARD_CHARS, RESEARCH_FINAL_CHARS } from "../../infrastructure/worker/research/rules.js";
import { defuseLinks, neutraliseMentions, labelClassic, stripRefusals, takeSources, trimToSentences, fitToCap, researchPrepare, usableAnswer } from "../../infrastructure/worker/research/label.js";
import { runEval } from "../../infrastructure/worker/eval.js";
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
let aiOpts = [];
const fakeAi = { run: async (_model, inputs, opts) => { aiCalls++; aiOpts.push(opts); sent.push(inputs); if (aiThrows) throw new Error("workers ai down"); return { response: reply(inputs), usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
test.after(() => { globalThis.fetch = realFetch; });

const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), level: f(12), goals: f("OWNHIDDEN tank the Deadmines", false) }, updated: "x" },
  { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), spec_path: f("frost OTHERSECRETSPEC", false), goals: f("OTHERHIDDENGOAL text", false), level: f(9) }, updated: "x" },
];
const TANK_PAGE = { id: "classes/tanking", category: "classes", title: "Tanking", blurb: "Who tanks", facts: [{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }] };

let n = 0;
async function ask(question, { research = true, pages = [TANK_PAGE], sheets = SHEETS, share = true, by = "Red Fox", memberSlug = "red-fox", respond, provider = "groq", throws = false, db = null, envPatch = null, deep = false } = {}) {
  invalidatePersonaCache(); invalidatePagesCache(); invalidateConfigCache();
  const DB = db || schemaDb();
  for (const p of pages) DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES (?, ?, ?, ?, '[]', ?, '2026-11-01T00:00:00Z')").run(p.id, p.category, p.title, p.blurb, JSON.stringify(p.facts));
  DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(sheets));
  const env = { DB, AI: fakeAi, GROQ_API_KEY: "test-key-not-real", GEMINI_API_KEY: "test-gemini-not-real", AI_GATEWAY_ID: "gw", CLOUDFLARE_ACCOUNT_ID: "acct", ...(research ? { ASK_RESEARCH: "on" } : {}), BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) } };
  if (envPatch) envPatch(env);
  const id = `rc${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, 'groq', 'thinking', ?, 'x')").run(id, by, question, share ? 1 : 0);
  if (db) DB.raw.prepare("INSERT OR IGNORE INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").run(id, "a".repeat(64));
  sent = []; fetchUrls = []; aiCalls = 0; aiThrows = throws; aiOpts = [];
  reply = respond || (() => "Mira tanks tonight.\n-# Sources: classes/tanking");
  const silence = console.error; console.error = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by, memberSlug, question, provider, share, deep, journey: "curious", isMember: true }); } finally { console.error = silence; }
  const row = DB.raw.prepare("SELECT answer, cites_json, model, status FROM ask_turns WHERE id = ?").get(id);
  return { answer: row.answer, row: { ...row }, calls: sent.length, aiCalls, aiOpts: aiOpts.slice(), fetchUrls: fetchUrls.slice(), bodies: sent.slice(), prompt: sent.map((b) => (b.messages || []).map((m) => m.content).join("\n")).join("\n=====\n") };
}
const ABSTAIN_Q = "tell me about the weather";
const SOURCES = "\n-# Sources: general Classic-era knowledge, unconfirmed";

// Scaling check instead of a wall-clock limit (CI machines vary): linear work grows about 4x for 4x input, quadratic about 16x.
// Warm-up first, then the MEDIAN of 3 timings at n=5000 and at n=20000. ok when the big run is fast in absolute terms (under 50 ms) or the ratio stays under 9.
function scalesLinearly(run) {
  for (const n of [2000, 5000, 20000]) run(n);
  const time = (n) => { const t = process.hrtime.bigint(); run(n); return Number(process.hrtime.bigint() - t) / 1e6; };
  const median = (n) => [time(n), time(n), time(n)].sort((x, y) => x - y)[1];
  const small = Math.max(median(5000), 1), big = median(20000);
  return { small, big, ok: big < 50 || big / small < 9 };
}
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
  assert.match(defuseLinks("[the docs](<https://example.org/a>)", { allow: ["example.org"] }), /\[the docs\]\(<https:\/\/example\.org\/a>\)/);
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
  // round 3: a whole-italic answer is an answer; banter is the trailing italic run after real content
  assert.deepEqual(lintResearchAnswer("_Go to Blackrock Depths._\n-# Sources: general knowledge · unconfirmed").failures, []);
  assert.ok(lintResearchAnswer("**A real answer sentence here.**\n*One joke.*\n*Two jokes.*\n-# Sources: x · likely").failures.includes("multiple_banter"));
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
  assert.equal(on.bodies[0].max_tokens, RESEARCH_MAX_TOKENS);
  assert.ok(RESEARCH_MAX_TOKENS > 350);
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

// ---- W4a review round: fail-closed provider, eval, reuse, no dead end, links, length, takeSources, labeller, refusals, hostile input ----

test("fail-closed: a flag read that throws counts as ON for provider forcing; requested provider and deep never reach an outside provider", async () => {
  const boom = (env) => Object.defineProperty(env, "ASK_RESEARCH", { get() { throw new Error("flag read failed"); }, enumerable: true });
  for (const [p, deep] of [["gemini", false], ["gemini", true], ["claude", true]]) {
    const r = await ask(ABSTAIN_Q, { research: false, envPatch: boom, provider: p, deep });
    assert.equal(r.aiCalls, 1, `${p}/${deep}`);
    assert.deepEqual(r.fetchUrls, []);
  }
  const down = await ask("who tanks tonight", { research: false, envPatch: boom, provider: "gemini", throws: true });
  assert.deepEqual(down.fetchUrls, []);
});

test("eval: with the flag on every candidate is forced to Workers AI and gets the research prompt; a throwing flag read counts as on; flag off is unchanged", async () => {
  const run = async (envOver, depsOver) => {
    const seen = { dispatch: [], build: [], finish: [] };
    const deps = {
      now: () => 1_000_000, sleep: async () => {}, lastCallAt: new Map(), cooldownUntil: new Map(), configured: () => true, budgetVerdict: async () => null,
      buildInputs: async (_e, a) => { seen.build.push(a); return { systemPrompt: "S", userPrompt: "U", isCoach: false, parsedPages: [], askerIsMember: true, persona: null, groundingText: "", retrieval: { ids: [], abstain: true } }; },
      dispatch: async (a) => { seen.dispatch.push(a); return { answer: "**Use a shield.**", model: "m" }; },
      finish: async (_e, a) => { seen.finish.push(a); return { answer: "**Use a shield.**" }; },
      ...depsOver,
    };
    const req = { questions: [{ id: "q1", text: "Blue Owl asks about shields", journey: "curious" }], candidates: [{ label: "g", provider: "gemini", promptVariant: "production" }, { label: "c", provider: "claude", promptVariant: "production" }], cursor: 0, maxCalls: 5, jobId: "j" };
    await runEval(envOver, req, deps);
    return seen;
  };
  const on = await run({ ASK_RESEARCH: "on" });
  assert.deepEqual(on.dispatch.map((d) => d.provider), ["workers-ai", "workers-ai"]);
  assert.ok(on.build.every((b) => b.research === true) && on.finish.every((f) => f.research === true));
  const boom = {}; Object.defineProperty(boom, "ASK_RESEARCH", { get() { throw new Error("x"); }, enumerable: true });
  const failed = await run(boom);
  assert.deepEqual(failed.dispatch.map((d) => d.provider), ["workers-ai", "workers-ai"]);
  const off = await run({});
  assert.deepEqual(off.dispatch.map((d) => d.provider), ["gemini", "claude"]);
  assert.ok(off.build.every((b) => b.research === undefined));
});

test("reuse: a flag-off refusal followed by the same ask with the flag on is not returned; flag off still reuses it", async () => {
  const DB = schemaDb();
  const first = await ask(ABSTAIN_Q, { research: false, db: DB });
  assert.equal(first.calls, 0);
  DB.raw.prepare("UPDATE ask_turns SET answered_at = ? , status = 'answered' WHERE id = ?").run(new Date().toISOString(), `rc${n}`);
  const offAgain = await ask(ABSTAIN_Q, { research: false, db: DB });
  assert.equal(offAgain.row.model, "reused-answer", "flag off reuses within the window (control)");
  DB.raw.prepare("UPDATE ask_turns SET answered_at = ?, status = 'answered' WHERE id = ?").run(new Date().toISOString(), `rc${n - 1}`);
  const on = await ask(ABSTAIN_Q, { research: true, db: DB });
  assert.notEqual(on.row.model, "reused-answer");
  assert.equal(on.aiCalls, 1);
  assert.ok(!on.answer.includes(ABSTAIN_LINE));
});

test("no dead end: empty, refusal-only, banter-only and sources-only model output is retried once, then library facts or an honest line; never a fixed refusal", async () => {
  for (const bad of ["", "   ", `**${ABSTAIN_LINE}**`, "No idea, sorry.", "Check Wowhead for that one.", "I am unable to help with this request.", "As an AI I have no information on this.", "The tooltip says the library does not cover that yet.", "I cannot answer that because the available material contains no relevant details about it.", "https://example.org/only-a-link", "Sources: classes/tanking", "-# Sources: general knowledge · unconfirmed"]) {
    const r = await ask(ABSTAIN_Q, { respond: () => bad });
    // an empty reply already makes Workers AI throw (no retry, straight to the fallback); the others are retried once
    if (bad.trim()) assert.equal(r.aiCalls, 2, `one retry for ${JSON.stringify(bad)}`); else assert.ok(r.aiCalls >= 1);
    assert.ok(r.answer.trim().length > 0 && !r.answer.includes(ABSTAIN_LINE) && !/I can't confirm that/.test(r.answer), r.answer);
  }
  // the retry can succeed
  let k = 0;
  const r2 = await ask(ABSTAIN_Q, { respond: () => (k++ === 0 ? "No idea, sorry." : `**Weather is flavour only.**${SOURCES}`) });
  assert.equal(r2.aiCalls, 2);
  assert.match(r2.answer, /flavour only/);
  // with library facts the fallback is the facts plus the honest line
  const lib = await ask("who tanks tonight", { respond: () => "" });
  assert.match(lib.answer, /Who tanks tonight is agreed/);
  // a short real answer survives
  assert.ok(usableAnswer("**Use a shield.**"));
  const short = await ask(ABSTAIN_Q, { respond: () => `Use a shield.${SOURCES}` });
  assert.equal(short.aiCalls, 1);
  assert.match(short.answer, /Use a shield/);
  assert.ok(lintResearchAnswer("**Frost.**\n-# Sources: x · likely").failures.length === 0);
  for (const s of ["No idea, sorry.", "Check Wowhead for that one.", "The library does not cover that yet."]) assert.ok(lintResearchAnswer(`**${s}**\n-# Sources: x · likely`).failures.includes("refusal"), s);
});

test("refusals: only a sentence that IS a refusal is dropped; quoting the wording is advice and stays", () => {
  const keep = "The tooltip says not published yet, so use the shield build.";
  assert.equal(stripRefusals(keep), keep);
  assert.equal(stripRefusals("Use the shield build. The library does not cover that yet."), "Use the shield build.");
  assert.ok(!lintResearchAnswer(`**${keep}**\n-# Sources: x · likely`).failures.includes("refusal"));
});

test("links: exact host comparison, unicode dots, subdomain tricks, brand-word labels, invites, hostile board url, final assembled text", () => {
  const allow = { allow: ["github.com", "leeroy.party"] };
  const dead = (s) => !/\]\(/.test(defuseLinks(s, allow));
  assert.ok(dead("[github.com](<https://evil.github.io/x>)"), "github.io is not github.com");
  assert.ok(dead("[github.com](<https://github.com.evil.test/x>)"));
  assert.ok(dead("[github․com](<https://evil.test/x>)"), "U+2024 one dot leader");
  assert.ok(dead("[git hub . com](<https://evil.test/x>)"));
  assert.ok(dead("[GitHub login](<https://evil.example/login>)"), "brand label, host not on the allow-list");
  assert.match(defuseLinks("[GitHub login](<https://evil.example/login>)"), /GitHub login \(`evil\.example`\)/);
  assert.match(defuseLinks("[repo](<https://github.com/a/b>)", allow), /\]\(<https:\/\/github\.com\/a\/b>\)/);
  assert.ok(!/discord\.gg\/abc123/.test(defuseLinks("join discord.gg/abc123 or https://discord.com/invite/xyz")));
  assert.match(defuseLinks("join discord.gg/abc123"), /`discord\.gg`/);
});

test("links: the FINAL answer is defused (library Sources link on a hostile BOARD_PUBLIC_URL)", async () => {
  const r = await ask("who tanks tonight", { envPatch: (env) => { env.BOARD_PUBLIC_URL = "https://leeroy.party@evil.example"; } });
  assert.ok(!/\]\(<?https?:\/\/leeroy\.party@/.test(r.answer), r.answer);
  assert.ok(!/\]\(<?https?:\/\/[^)]*evil\.example/.test(r.answer), r.answer);
});

test("length: 2000 is enforced after sources, fallback and basis, also with ANSWER_FORMAT off", async () => {
  const long = Array.from({ length: 120 }, (_, i) => `Sentence ${i % 5} says the same plain thing about the weather again.`).join(" ");
  const bigSources = `-# Sources: ${Array.from({ length: 40 }, (_, i) => `a very long source label number ${i}`).join(" · ")} · unconfirmed`;
  for (const fmt of ["on", "off"]) {
    const r = await ask(ABSTAIN_Q, { respond: () => `**Weather is flavour only.**\n${long}\n${bigSources}`, envPatch: (env) => { env.ANSWER_FORMAT = fmt; } });
    assert.ok(r.answer.length <= 2000 && r.answer.length > 0, `${fmt}: ${r.answer.length}`);
    assert.equal((r.answer.match(/^-# Sources:/gm) || []).length, 1);
  }
  assert.ok(fitToCap("x ".repeat(3000) + "\n-# Sources: " + "y ".repeat(500), 1500).length <= 1500);
  const t = trimToSentences("Intro sentence here.\n```\ncode line one\ncode line two\n```\nAfter the fence we continue with more words here.", 60);
  assert.equal((t.match(/```/g) || []).length % 2, 0, t);
  assert.equal((trimToSentences("*An italic joke that runs long and long and long and long. More text here and here.*", 60).replace(/\*\*/g, "").match(/\*/g) || []).length % 2, 0);
});

test("takeSources: only '-# Sources:' lines, an inline one is split onto its own line, body lines are never swallowed, one confidence word", () => {
  const a = takeSources("Use a shield. -# Sources: classes/tanking · likely");
  assert.equal(a.body, "Use a shield.");
  assert.deepEqual(a.ids, ["classes/tanking"]);
  const b = takeSources("Sources: this plain line stays in the body\nUse a shield.\n  \n-# Sources: x · likely\n-# Sources: y · confirmed");
  assert.match(b.body, /Sources: this plain line stays/);
  assert.match(b.body, /Use a shield/);
  assert.equal(b.count, 2);
  const p = researchPrepare("Use a shield.\n-# Sources: x · likely\n-# Sources: y · confirmed", { groundingText: "", retrievedIds: new Set() });
  assert.equal(p.basis.confidence, "likely");
});

test("labeller: code fences, table rows, link labels, italics, abbreviations, existing disclaimers, markdown kept", () => {
  const G = "";
  const fence = labelClassic("Intro.\n```\nboss has 4500000 health\n```\nOutro.", G);
  assert.match(fence.text, /```\nboss has 4500000 health\n```\n\(Classic value, not confirmed for Forever\)\nOutro\./);
  const row = labelClassic("| Boss | HP |\n| Ragnaros | 4500000 |", G).text;
  assert.match(row, /\| Ragnaros \| 4500000 \| \(Classic value/);
  assert.ok(!/4500000 \(Classic/.test(row));
  const link = labelClassic("See [Patch 1.12 notes 9999](<https://example.org/a>) for it.", G);
  assert.equal(link.text, "See [Patch 1.12 notes 9999](<https://example.org/a>) for it (Classic value, not confirmed for Forever).", "a number in a link label is tagged, outside the link");
  assert.match(labelClassic("*The boss has 4500000 health.*", G).text, /^\*The boss has 4500000 health \(Classic value, not confirmed for Forever\)\.\*$/, "italics are not exempt");
  const abbr = labelClassic("It drops gear, e.g. a 9000 gold item, and more.", G).text;
  assert.equal((abbr.match(/\(Classic/g) || []).length, 1);
  assert.match(abbr, /e\.g\. a 9000 gold item, and more \(Classic value/);
  // an existing disclaimer covers only the clause it follows, not the rest of the sentence
  const partial = labelClassic("It lasts 4500 minutes (Classic), and drops 7777 gold.", G).text;
  assert.match(partial, /7777 gold, ?\(?|7777 gold \(Classic value/);
  assert.ok((partial.match(/\(Classic/g) || []).length >= 2, partial);
  const full = labelClassic("It lasts 4500 minutes (Classic value, not confirmed for Forever).", G).text;
  assert.equal(full, "It lasts 4500 minutes (Classic value, not confirmed for Forever).");
});

test("research finishing never uses the cite deleter: an unretrieved cited id is dropped from the link line and lowers confidence, nothing is restored", () => {
  const p = researchPrepare("**Use a shield.**\n-# Sources: classes/tanking, classes/ghost · confirmed", { groundingText: "", retrievedIds: new Set(["classes/tanking"]) });
  assert.match(p.text, /-# Sources: classes\/tanking$/);
  assert.equal(p.basis.confidence, "likely");
  const none = researchPrepare("**Use a shield.**\n-# Sources: classes/ghost · confirmed", { groundingText: "", retrievedIds: new Set() });
  assert.ok(!/ghost/.test(none.text) && none.basis.confidence !== "confirmed");
});

test("hostile input: forged placeholders do not clone links or print undefined; a long run of '[' is linear", () => {
  const forged = "[a](<https://leeroy.party/x>) \u00001\u0000 \u00009\u0000 \u0001 5 \u0001";
  const out = defuseLinks(forged, { allow: ["leeroy.party"] });
  assert.ok(!/undefined/.test(out) && (out.match(/\]\(</g) || []).length === 1, out);
  assert.ok(!/[\u0000-\u0008]/.test(out));
  const lin = scalesLinearly((n) => { defuseLinks("[".repeat(n * 5)); labelClassic("[".repeat(n * 5) + "](x)", ""); researchPrepare("[".repeat(n * 5), { groundingText: "" }); });
  assert.ok(lin.ok, `not linear: ${lin.small.toFixed(1)}ms -> ${lin.big.toFixed(1)}ms`);
});

// Each function gets its own scaling check, so a quadratic loop in ANY ONE of them fails by name (a combined workload would let a fast one hide behind the rest).
const SCALE_WORKLOADS = {
  "splitSentenceText (star run)": (n) => splitSentenceText("*".repeat(n)),
  "splitSentenceText (dotted star run)": (n) => splitSentenceText("a. " + "* ".repeat(n / 2)),
  "stripRefusals (star run)": (n) => stripRefusals("*".repeat(n)),
  "labelClassic (bracket run)": (n) => labelClassic("[".repeat(n) + "](x)", ""),
  "labelClassic (star run then a flagged number)": (n) => labelClassic("a. " + "*".repeat(n) + " 9999", ""),
  "trimToSentences (star runs)": (n) => trimToSentences("*".repeat(n) + " b. " + "*".repeat(n), 500),
  "defuseLinks (bracket run)": (n) => defuseLinks("[".repeat(n)),
};
for (const [name, work] of Object.entries(SCALE_WORKLOADS)) {
  test(`scaling: ${name} is linear in the input`, () => {
    const lin = scalesLinearly(work);
    assert.ok(lin.ok, `${name} not linear: ${lin.small.toFixed(1)}ms -> ${lin.big.toFixed(1)}ms (ratio ${(lin.big / lin.small).toFixed(1)})`);
  });
}

// ---- round 3 ----

test("round 3 (1): voice-compliant answers that point at what would settle it are answers, not refusals (one call, no outage line)", async () => {
  for (const reply of [
    "**Take Frost for levelling.** A Blizzard post would settle it.",
    "**Frost, probably.** Check Wowhead for the exact talent order.",
    "**Take Frost.** Blizzard has not published yet the Forever numbers, so treat Frost as the safe pick.",
  ]) {
    const r = await ask(ABSTAIN_Q, { respond: () => `${reply}${SOURCES}` });
    assert.equal(r.aiCalls, 1, reply);
    assert.match(r.answer, /Take Frost|Frost, probably/);
    assert.ok(!/out of reach/i.test(r.answer), r.answer);
  }
  assert.deepEqual(lintResearchAnswer("**Take Frost for levelling.** A Blizzard post would settle it.\n-# Sources: general · likely").failures, []);
  assert.deepEqual(lintResearchAnswer("**Frost, probably.** Check Wowhead for the exact talent order.\n-# Sources: general · likely").failures, []);
});

test("round 3 (2): the retry skips the gateway cache; the first call does not", async () => {
  let k = 0;
  const r = await ask(ABSTAIN_Q, { respond: () => (k++ === 0 ? "No idea, sorry." : `**Weather is flavour only.**${SOURCES}`) });
  assert.equal(r.aiCalls, 2);
  assert.equal(Boolean(r.aiOpts[0] && r.aiOpts[0].gateway && r.aiOpts[0].gateway.skipCache), false);
  assert.equal(r.aiOpts[1].gateway.skipCache, true);
});

test("round 3 (3,4,7,12): covered() on digit boundaries and every occurrence; one-line fences; code and link labels; nested code in a link; trim keeps the tag; U.S.", () => {
  const two = labelClassic("Frostbolt hits for 450 (Classic), and costs 50 gold in Forever.", "").text;
  assert.match(two, /450 \(Classic\), and costs 50 gold in Forever \(Classic value, not confirmed for Forever\)\.$/, two);
  const oneLine = labelClassic("A ```x 9999``` span.\nThen 8888 gold more.", "").text;
  assert.match(oneLine, /8888 gold more \(Classic value/, "a one-line fence does not open a block");
  assert.match(stripRefusals("| Use a shield. The library does not cover that yet. |"), /Use a shield/);
  assert.ok(!/does not cover/.test(stripRefusals("| Use a shield. The library does not cover that yet. |")), "pipe lines are not exempt");
  assert.match(labelClassic("Run `rank 9999 gear` first.", "").text, /Run `rank 9999 gear` first \(Classic value/);
  const nested = labelClassic("See [`Item 9999`](<https://example.org/a>) now.", "").text;
  assert.equal(nested, "See [`Item 9999`](<https://example.org/a>) now (Classic value, not confirmed for Forever).");
  assert.ok(!/[\u0000-\u0008]|undefined/.test(nested));
  assert.match(labelClassic("-# Note: it lasts 4500 minutes.", "").text, /^-# Note: it lasts 4500 minutes \(Classic value/, "a -# footer that is not Sources is labelled");
  const t = trimToSentences(`${labelClassic("Intro sentence here today. The boss has 4500000 health.", "").text}\nPadding sentence number one is here. Padding sentence number two is here too.`, 70);
  assert.ok(!t.includes("4500000") || t.includes("Classic value"), t);
  const us = labelClassic("Raids in the U.S. realm last 4500 minutes.", "").text;
  assert.match(us, /U\.S\. realm last 4500 minutes \(Classic value, not confirmed for Forever\)\.$/, us);
});

test("round 3 (5,6): refusal wordings that must not pass as answers; a whole-italic answer is an answer and its claims are tagged", async () => {
  for (const s of ["I am unable to help with this request.", "As an AI I have no information on this.", "The tooltip says the library does not cover that yet.", "I cannot answer that because the available material contains no relevant details.", "https://example.org/x"]) assert.equal(usableAnswer(s), false, s);
  assert.equal(usableAnswer("Sources: x\n"), false);
  assert.equal(usableAnswer("_Go to Blackrock Depths._"), true);
  assert.equal(usableAnswer("The tooltip says not published yet, so use the shield build."), true);
  const r = await ask(ABSTAIN_Q, { respond: () => `_Go to Blackrock Depths._${SOURCES}` });
  assert.equal(r.aiCalls, 1);
  assert.match(r.answer, /Go to Blackrock Depths \(Classic-era name, not confirmed for Forever\)\./);
});

test("round 3 (8): the first link pass keeps the board host", () => {
  const p = researchPrepare("**Go.** See [builds](<https://leeroy.party/builds/tank>) for it.", { groundingText: "", allow: ["leeroy.party"] });
  assert.match(p.text, /\[builds\]\(<https:\/\/leeroy\.party\/builds\/tank>\)/);
});

test("round 3 (9): a research row is marked and never reused by a flag-off ask after a rollback", async () => {
  const DB = schemaDb();
  const on = await ask(ABSTAIN_Q, { research: true, db: DB });
  assert.match(on.row.model, /\+research/);
  const off = await ask(ABSTAIN_Q, { research: false, db: DB });
  assert.notEqual(off.row.model, "reused-answer");
  assert.equal(off.row.model, "library:abstain", "the old abstain path answers again; the research text is not handed back");
});

test("round 3 (10): eval in research mode asks for the research token budget and does not fail the Sources/confidence line as unmasked", async () => {
  const seen = [];
  const deps = {
    now: () => 1_000_000, sleep: async () => {}, lastCallAt: new Map(), cooldownUntil: new Map(), configured: () => true, budgetVerdict: async () => null, research: true,
    buildInputs: async () => ({ systemPrompt: "S", userPrompt: "U", isCoach: false, parsedPages: [], askerIsMember: true, persona: { format: { chatMaxChars: 1200 } }, groundingText: "", retrieval: { ids: [], abstain: true } }),
    dispatch: async (a) => { seen.push(a); return { answer: "x", model: "m" }; },
    finish: async () => ({ answer: "Use a shield, it holds.\n-# Sources: general Classic-era knowledge · likely" }),
  };
  const out = await runEval({}, { questions: [{ id: "q1", text: "shields", journey: "curious" }], candidates: [{ label: "g", provider: "gemini", promptVariant: "production" }], cursor: 0, maxCalls: 2, jobId: "j" }, deps);
  assert.equal(seen[0].maxTokens, RESEARCH_MAX_TOKENS);
  assert.ok(!out.results[0].lint.failures.includes("sources_unmasked"), out.results[0].lint.failures.join(","));
  assert.ok(out.results[0].lint.research);
});

test("round 3 (11): research lint fails the stock dead ends, and not the library-backed or would-settle-it answers", () => {
  const f = (s) => lintResearchAnswer(s).failures;
  assert.ok(f("**I can't confirm that for Forever.**\n-# Sources: x · unconfirmed").includes("refusal"));
  assert.ok(f("**Ask an officer about that.**\n-# Sources: x · likely").includes("refusal"));
  assert.ok(f("**Take Frost.**\n-# Sources: x · likely\n-# Confidence: likely").includes("second_confidence_footer"));
  assert.ok(f("**My research hand is out of reach right now, so I have nothing solid on that yet.**").includes("outage_line"));
  assert.deepEqual(f("**Mira tanks tonight.**\n-# Sources: [Tanking](<https://leeroy.party/#library.classes.tanking>)"), [], "library-backed: no confidence word needed");
});

test("round 3 (12): the outage line carries no Sources/confidence tag; the wrangler comment describes research mode", async () => {
  const r = await ask(ABSTAIN_Q, { throws: true });
  assert.match(r.answer, /out of reach/i);
  assert.ok(!/-# Sources/.test(r.answer), r.answer);
  const toml = readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8");
  const line = toml.split("\n").find((l) => l.startsWith("ASK_RESEARCH"));
  assert.match(line, /Claude first.*then Workers AI, then library facts/); // W-wire: the comment was "Workers AI only" until Claude became the first hop
  assert.ok(!/stub handles nothing/.test(line));
});

// ---- round 4 ----

test("round 4 (1): factual negatives about the game are answers, not refusals; only the assistant/library being unable is a refusal", async () => {
  const cases = [
    ["**No, a hunter cannot use wands.** Hunters use bows, guns and crossbows; wands are for casters.", /hunter cannot use wands/],
    ["**You can't respec for free.** The cost starts at 1 gold and climbs.", /can't respec for free/],
    ["**Warriors cannot use wands.**", /Warriors cannot use wands/],
    ["**You can't go wrong with frost for levelling.** A frost mage cannot be caught easily and does not have mana trouble.", /can't go wrong with frost/],
    ["**Frost.** You do not have to drink as often.", /do not have to drink/],
  ];
  for (const [reply, expect] of cases) {
    const r = await ask(ABSTAIN_Q, { respond: () => `${reply}${SOURCES}` });
    assert.equal(r.aiCalls, 1, reply);
    assert.match(r.answer, expect, reply);
    assert.ok(!/out of reach/i.test(r.answer), r.answer);
  }
  for (const s of ["Rogues can't wear plate.", "You cannot trade soulbound items.", "Priests do not have a charge.", "That item is not available to Horde.", "Mages cannot tank."]) {
    assert.equal(usableAnswer(s), true, s);
    assert.equal(stripRefusals(s), s, s);
    assert.ok(!lintResearchAnswer(`${s}\n-# Sources: general · likely`).failures.includes("refusal"), s);
  }
  for (const s of ["I can't help with that.", "I cannot find anything on this.", "I don't have any information on that.", "The library does not cover that yet.", "No information is available on this."]) assert.equal(usableAnswer(s), false, s);
});

test("round 4 (2): an answer that starts with a long code fence keeps its prose; the fence is closed, never a bare ellipsis", async () => {
  const macro = Array.from({ length: 120 }, () => "/cast Frostbolt").join("\n");
  const r = await ask(ABSTAIN_Q, { respond: () => `\`\`\`\n${macro}\n\`\`\`\nUse this macro for levelling.${SOURCES}` });
  assert.ok(r.answer.length <= RESEARCH_FINAL_CHARS, String(r.answer.length));
  assert.match(r.answer, /Use this macro for levelling/);
  assert.equal((r.answer.match(/```/g) || []).length % 2, 0, "the fence is closed");
  assert.match(r.answer, /\/cast Frostbolt/);
  const t = trimToSentences(`\`\`\`\n${macro}\n\`\`\`\nUse this macro for levelling.`, 400);
  assert.ok(t.length <= 400 && /Use this macro/.test(t) && (t.match(/```/g) || []).length % 2 === 0 && t !== "…", t);
});

test("round 4 (3): italic banter alone is not an answer; the advice clause after a refusal clause stays; bullets and '5 * 3' survive trimming; long star runs are linear; outage lint fires on the real line; Sources lines with slashes still get the confidence check", () => {
  assert.equal(usableAnswer("*Oh, you sweet summer child.*"), false);
  assert.ok(lintResearchAnswer("*Oh, you sweet summer child.*\n-# Sources: general · unconfirmed").failures.includes("no_answer"));
  assert.equal(usableAnswer("_Go to Blackrock Depths._"), true);
  assert.match(stripRefusals("Blizzard has not published yet the Forever numbers, so treat Frost as the safe pick."), /Treat Frost as the safe pick\.$/);
  const bullets = trimToSentences("* first bullet is here and long enough to count\n* second bullet is here and long enough too\n* third bullet fills the rest of the space", 100);
  assert.match(bullets, /^\* first bullet/m);
  assert.match(trimToSentences("Compute 5 * 3 now please. Another long sentence follows here and here.", 40), /5 \* 3/);
  const lin2 = scalesLinearly((n) => {
    splitSentenceText("*".repeat(n));
    splitSentenceText("a. " + "* ".repeat(n / 2));
    stripRefusals("*".repeat(n));
    labelClassic("a. " + "*".repeat(n) + " 9999", "");
    trimToSentences("*".repeat(n) + " b. " + "*".repeat(n), 500);
  });
  assert.ok(lin2.ok, `not linear: ${lin2.small.toFixed(1)}ms -> ${lin2.big.toFixed(1)}ms`);
  assert.ok(lintResearchAnswer(`${RESEARCH_DOWN_ANSWER}\n-# Sources: general · unconfirmed`).failures.includes("outage_line"));
  assert.ok(lintResearchAnswer(RESEARCH_DOWN_ANSWER).failures.includes("outage_line"));
  for (const src of ["wowhead/classic guides", "and/or"]) assert.ok(lintResearchAnswer(`**Take Frost.**\n-# Sources: ${src}`).failures.includes("no_confidence_word"), src);
});

// ---- voice pass: the original Leeroy (archaeology 2026-11-15 sections 2b and 4) ----

test("voice: the research prompt carries the original-voice rules (testable features 1-13) after the structure rules, and persona.js is untouched", async () => {
  const on = await ask(ABSTAIN_Q);
  assert.ok(on.prompt.includes(RESEARCH_VOICE_RULES) && on.prompt.includes(RESEARCH_STRUCTURE_RULES));
  assert.ok(on.prompt.indexOf(RESEARCH_STRUCTURE_RULES) < on.prompt.indexOf(RESEARCH_VOICE_RULES));
  const v = RESEARCH_VOICE_RULES;
  for (const [what, re] of [
    ["Leeroy never Skippy", /you are Leeroy, never "Skippy"/],
    ["smug, well-read, theatrical suffering", /smug, well-read, theatrically long-suffering/],
    ["answer first, smile on the same line", /first sentence answers the question, and a smile may ride that same line/],
    ["one voice beat in the first screen", /one voice beat in the first screen/],
    ["at most one signature opener, only with a fact", /At most one signature opener or closing flourish, and only when it carries a fact/],
    ["running bits only if true", /running bit[^.]*only when it is true/],
    ["tease only the asker, never real life, end warm", /tease the ASKER, and only the asker[^;]*; never another member, and never real life[^.]*end warm/],
    ["match register, casual 1 to 4 sentences, no headers", /1 to 4 plain sentences and no headers/],
    ["information: bold labels, bullets, sources", /bold labels, short bullets and the sources line/],
    ["imperative advice with trade-offs", /imperative advice is fine[^.]*\./],
    ["length 600-900, never past 1500", /600 to 900 characters, never past 1500/],
    ["follow-up", /PREVIOUS_QUESTION/],
    ["what would settle it", /what would settle it/],
  ]) assert.match(v, re, what);
  assert.equal(RESEARCH_HARD_CHARS, 1500);
  assert.ok(RESEARCH_HARD_CHARS < 2000);
  // the old voice and the library-only rules are still in the prompt (persona untouched), research voice only in the research state
  assert.ok(on.prompt.includes("VOICE: a confident, playful, well-read friend"));
  const lib = await ask("who tanks tonight");
  assert.ok(!lib.prompt.includes(RESEARCH_VOICE_RULES), "a library-answered question keeps today's prompt");
  assert.ok(RESEARCH_RULES.includes(RESEARCH_VOICE_RULES) && RESEARCH_RULES.includes(RESEARCH_STRUCTURE_RULES));
});

test("voice: length bounds, hard 1500 and always under 2000, with a typical 600-900 character answer left whole", async () => {
  const typical = `**Frost, and the wand says so.** You asked, so: frost for the kiting, fire only if you enjoy being the loudest thing in the dungeon. ${"Frost slows what it burns and the pack never reaches you. ".repeat(8)}\n*Do try to stay out of the fire, friend.*${SOURCES}`;
  const t = await ask(ABSTAIN_Q, { respond: () => typical });
  assert.ok(t.answer.length > 600 && t.answer.length <= 1500, String(t.answer.length));
  assert.ok(t.answer.includes("loudest thing in the dungeon") && t.answer.includes("Do try to stay out of the fire"), "a 600-900 character answer is not cut");
  const long = Array.from({ length: 80 }, (_, i) => `Sentence ${i % 5} keeps going about the weather in plain words.`).join(" ");
  const l = await ask(ABSTAIN_Q, { respond: () => `**Weather is flavour only.**\n${long}${SOURCES}` });
  const body = l.answer.split("\n").filter((x) => !/^\s*-#/.test(x)).join(" ").trim();
  assert.ok(body.length <= RESEARCH_HARD_CHARS, `body ${body.length}`);
  assert.ok(l.answer.length <= RESEARCH_FINAL_CHARS && RESEARCH_FINAL_CHARS < 2000, `total ${l.answer.length}`);
  assert.ok(!/about 2 years old/.test(RESEARCH_STRUCTURE_RULES), "the invented-age example is gone");
  assert.match(body, /[.!?…*]$/);
});

test("provider forcing (c): flag off, the requested provider is used as before (Gemini asked -> Gemini fetch, no Workers AI)", async () => {
  const r = await ask("who tanks tonight", { research: false, provider: "gemini" });
  assert.equal(r.aiCalls, 0);
  assert.ok(r.fetchUrls.length >= 1 && r.fetchUrls.every((u) => /generativelanguage|gateway|google-ai-studio/i.test(u)), r.fetchUrls.join(","));
});
