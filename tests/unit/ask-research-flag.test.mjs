// W0: the ASK_RESEARCH flag and the seam in answerWithAi. Flag off must be byte-identical to the pre-seam code path.
// Golden file tests/unit/fixtures/ask-research-golden.json was recorded from the code BEFORE the seam existed (UPDATE_GOLDEN=1 re-records; do not, unless the ask path changed on purpose).
// No network (fetch stubbed), no AI, fictional names only. Run: node --test tests/unit/ask-research-flag.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { answerWithAi, invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { invalidatePersonaCache } from "../../infrastructure/worker/persona.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, "utf8");
const GOLDEN = ROOT + "tests/unit/fixtures/ask-research-golden.json";

const realFetch = globalThis.fetch;
let sent = [];
globalThis.fetch = async (url, init) => {
  sent.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ choices: [{ message: { content: "Mira tanks tonight. -# Sources: classes/tanking" } }] }), { status: 200, headers: { "content-type": "application/json" } });
};
test.after(() => { globalThis.fetch = realFetch; });

const QUESTIONS = ["who tanks tonight", "what does Mira bring to the raid", "how do I get the tanking gear", "tell me about the weather"];
let n = 0;
async function ask(question, envExtra = {}) {
  invalidatePersonaCache();
  invalidatePagesCache();
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO lib_pages (id, category, title, blurb, aliases_json, facts_json, updated_at) VALUES ('classes/tanking', 'classes', 'Tanking', 'Who tanks', '[]', ?, '2026-11-01T00:00:00Z')").run(JSON.stringify([{ key: "tanking.tonight", value: "Who tanks tonight is agreed in the party channel." }]));
  // W4a: with the flag on the model call is Workers AI only (research/provider.js), so a flag-on run answers through this binding (same text as the fetch stub) instead of groq.
  const aiBinding = envExtra.ASK_RESEARCH === "on" && !envExtra.IS_PR_PREVIEW ? { AI: { run: async (_m, inputs) => { sent.push(inputs); return { response: "Mira tanks tonight. -# Sources: classes/tanking", usage: { prompt_tokens: 5, completion_tokens: 5 } }; } } } : {};
  const env = { DB, GROQ_API_KEY: "test-key-not-real", AI_GATEWAY_ID: "gw", CLOUDFLARE_ACCOUNT_ID: "acct", BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: async () => new Response("ok") }) }, ...aiBinding, ...envExtra };
  const id = `r${++n}`;
  DB.raw.prepare("INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, 'Mira', ?, 'groq', 'thinking', 1, 'x')").run(id, question);
  sent = [];
  const silence = console.error; console.error = () => {};
  try { await answerWithAi({ env, origin: "https://worker.test", intentId: id, by: "Mira", question, provider: "groq", share: true, journey: "curious", isMember: true }); } finally { console.error = silence; }
  const row = DB.raw.prepare("SELECT answer, cites_json, model, status FROM ask_turns WHERE id = ?").get(id);
  // hashed: the default persona text names real display names and must not be copied into a fixture
  return { row: { ...row }, prompts: sent.map((b) => crypto.createHash("sha256").update(JSON.stringify(b.messages || b)).digest("hex")) };
}

test("flag-off-golden: ask_turns row and outbound prompts match the pre-seam recording", async () => {
  const got = {};
  for (const q of QUESTIONS) got[q] = await ask(q, { ASK_RESEARCH: "off" });
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
  assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
  // the flag unset behaves the same as off
  for (const q of QUESTIONS) assert.deepEqual(await ask(q), got[q]);
});

test("flag-declared: ASK_RESEARCH is declared in [vars] (on or off, the owner decides) and in the runbook; it is a [vars] flag, not a Flagship key", () => {
  const toml = read("infrastructure/wrangler.toml");
  assert.match(toml.slice(toml.indexOf("[vars]")), /^ASK_RESEARCH = "(on|off)"/m);
  assert.ok(read("docs/runbooks/flags.md").includes("`ASK_RESEARCH`"));
  assert.ok(!read("infrastructure/flagship-flags.txt").includes("ASK_RESEARCH"));
});

test("stub-never-ships: the stub reports not handled", async () => {
  const { researchAnswer } = await import("../../infrastructure/worker/research/index.js");
  assert.deepEqual(await researchAnswer({ question: "who tanks tonight" }), { handled: false });
});

const OLD = (q) => ask(q, { ASK_RESEARCH: "off" });
// W4a: flag on changes the provider (Workers AI only) and the model label, and, for a question the library cannot answer, calls the model instead of returning the code-written abstain.
// For a question the library answers, the answer, cites, status and the outbound prompt are still the old ones.
// (W4a review: research finishing puts an inline "-# Sources:" on its own line and turns the cited id into a link, so the text is compared up to the Sources line.)
// W-wire: with the flag on the prompt is tokenised (names become per-request tokens with a random nonce, research/claude.js), so its hash can no longer equal the flag-off prompt; it is checked in
// ask-research-claude.test.mjs. Here the answer and status still match the old ones, and the model is called exactly once (the prompt count).
const same = (r) => ({ answer: r.row.answer.split(/\s*-#\s*Sources?:/)[0].trim(), status: r.row.status, prompts: r.prompts.length });

test("flag on with the stub: a library-answered question gets the old answer and prompt, never an empty answer", async () => {
  for (const q of QUESTIONS.slice(0, 1)) {
    const on = await ask(q, { ASK_RESEARCH: "on" });
    assert.deepEqual(same(on), same(await OLD(q)));
    assert.ok(on.row.answer && on.row.answer.length > 0);
  }
});

test("flag on, the other golden questions: a question the library cannot answer gets a model answer of the research shape, not the code-written abstain", async () => {
  const { lintResearchAnswer } = await import("../../infrastructure/worker/answer-lint.js");
  for (const q of QUESTIONS.slice(1)) {
    const on = await ask(q, { ASK_RESEARCH: "on" });
    assert.equal(on.row.status, "answered");
    assert.equal(on.prompts.length, 1, `${q}: the model is called`);
    assert.ok(!/does not cover that yet|won't guess/i.test(on.row.answer), on.row.answer);
    assert.ok(on.row.answer.length > 0 && on.row.answer.length <= 2000);
    assert.deepEqual(lintResearchAnswer(on.row.answer).failures, [], `${q}: ${on.row.answer}`);
  }
});

test("flag-timeout-is-old-path: a Flagship binding that hangs, throws or says false cannot slow or change the old path (the flag reads [vars] only)", async () => {
  const q = QUESTIONS[0];
  const old = await OLD(q);
  for (const get of [() => new Promise(() => {}), () => { throw new Error("boom"); }, async () => { throw new Error("nope"); }, async () => false]) {
    assert.deepEqual(same(await ask(q, { ASK_RESEARCH: "on", FLAGS: { getBooleanValue: get } })), same(old));
  }
});

test("preview-forced: a PR preview Worker is always off, even with the flag on and a true binding", async () => {
  const q = QUESTIONS[0];
  const off = await ask(q, { ASK_RESEARCH: "off", IS_PR_PREVIEW: "true" });
  const on = await ask(q, { ASK_RESEARCH: "on", IS_PR_PREVIEW: "true", FLAGS: { getBooleanValue: async () => true } });
  assert.deepEqual(on, off);
});
