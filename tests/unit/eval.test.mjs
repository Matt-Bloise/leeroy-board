// Unit tests for the model bake-off runner (worker/eval.js), the model allow-list and the POST /admin/eval gate.
// Fake providers only: no network, no AI, no real D1.
// Run: node --test tests/unit/eval.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../infrastructure/worker/index.js";
import { runEval, validateEvalRequest, evalEnabled, EVAL_LIMITS, PROVIDER_MIN_GAP_MS, defaultBudgetVerdict } from "../../infrastructure/worker/eval.js";
import { dispatchToProvider, modelAllowed, EVAL_MODEL_ALLOWLIST, PROMPT_VARIANTS } from "../../infrastructure/worker/ai-models.js";

const sample = JSON.parse(readFileSync(new URL("../fixtures/bake-off-sample.json", import.meta.url), "utf8"));
const GOOD = "**A short, friendly dungeon is the usual start.**\n\n-# Sources: [Basics](<https://leeroy.party/#library.d.basics>)";

function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, advance: (ms) => { t += ms; }, sleeps };
}

function makeDeps(over = {}) {
  const clock = fakeClock();
  const calls = [];
  const deps = {
    now: clock.now,
    sleep: clock.sleep,
    lastCallAt: new Map(),
    cooldownUntil: new Map(),
    configured: () => true,
    budgetVerdict: async () => null,
    buildInputs: async (_env, a) => ({ systemPrompt: `sys:${a.promptVariant}`, userPrompt: `q:${a.question}`, isCoach: false, parsedPages: [], askerIsMember: a.isMember !== false, persona: { format: { chatMaxChars: 1200 } } }),
    finish: async (_env, a) => ({ answer: a.rawAnswer, cites: [] }),
    dispatch: async (a) => {
      calls.push(a);
      clock.advance(300);
      return { answer: GOOD, model: a.model || "default-model", provider: a.provider };
    },
    ...over,
  };
  return { deps, calls, clock };
}

const req = (extra = {}) => ({
  ...validateEvalRequest({
    questions: sample.questions.slice(0, 4),
    candidates: [
      { label: "gem", provider: "gemini", model: "gemini-3.5-flash-lite" },
      { label: "llama", provider: "workers-ai" },
    ],
    ...extra,
  }),
});

test("sample fixture validates as a request", () => {
  const r = validateEvalRequest({ questions: sample.questions, candidates: [{ label: "a", provider: "workers-ai" }] });
  assert.equal(r.error, undefined);
  assert.equal(r.questions.length, 8);
  assert.equal(r.questions[6].asker, "visitor");
});

test("validation: limits, allow-list, duplicates, variants, cursor", () => {
  const q = [{ id: "a", text: "hi" }];
  const c = [{ label: "x", provider: "workers-ai" }];
  assert.match(validateEvalRequest(null).error, /JSON object/);
  assert.match(validateEvalRequest({ questions: [], candidates: c }).error, /questions/);
  assert.match(validateEvalRequest({ questions: Array.from({ length: 41 }, (_, i) => ({ id: `q${i}`, text: "t" })), candidates: c }).error, /questions/);
  assert.match(validateEvalRequest({ questions: q, candidates: Array.from({ length: 7 }, (_, i) => ({ label: `c${i}`, provider: "groq" })) }).error, /candidates/);
  assert.match(validateEvalRequest({ questions: Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, text: "t" })), candidates: Array.from({ length: 4 }, (_, i) => ({ label: `c${i}`, provider: "groq" })) }).error, /120/);
  assert.match(validateEvalRequest({ questions: q, candidates: [{ label: "x", provider: "claude" }] }).error, /provider/);
  assert.match(validateEvalRequest({ questions: q, candidates: [{ label: "x", provider: "groq", model: "gpt-4o" }] }).error, /allow-list/);
  assert.match(validateEvalRequest({ questions: q, candidates: [{ label: "x", provider: "groq", promptVariant: "wild" }] }).error, /promptVariant/);
  assert.match(validateEvalRequest({ questions: [...q, ...q], candidates: c }).error, /duplicate question/);
  assert.match(validateEvalRequest({ questions: q, candidates: [...c, ...c] }).error, /duplicate candidate/);
  assert.match(validateEvalRequest({ questions: q, candidates: c, cursor: 2 }).error, /cursor/);
  assert.match(validateEvalRequest({ questions: q, candidates: c, maxCalls: 7 }).error, /maxCalls/);
  assert.match(validateEvalRequest({ questions: q, candidates: c, jobId: "bad id!" }).error, /jobId/);
  assert.equal(validateEvalRequest({ questions: q, candidates: c, jobId: "job-1", cursor: 1 }).jobId, "job-1");
});

test("allow-list: free providers only, no Claude, named models only", () => {
  assert.equal(EVAL_MODEL_ALLOWLIST.claude, undefined);
  assert.ok(modelAllowed("gemini", "gemini-3.5-flash-lite"));
  assert.ok(modelAllowed("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"));
  assert.ok(!modelAllowed("gemini", "gemini-9-ultra"));
  assert.ok(!modelAllowed("claude", "claude-haiku-4-5-20251001"));
  assert.deepEqual(PROMPT_VARIANTS[0], "production");
});

test("one request makes at most 6 calls, returns a cursor, and cells are question-major", async () => {
  const { deps, calls } = makeDeps();
  const out = await runEval({}, req({ jobId: "j1" }), deps);
  assert.equal(out.jobId, "j1");
  assert.equal(out.total, 8);
  assert.equal(out.callsMade, 6);
  assert.equal(calls.length, 6);
  assert.equal(out.nextCursor, 6);
  assert.deepEqual(out.results.map((r) => [r.questionId, r.candidate]), [
    ["s1", "gem"], ["s1", "llama"], ["s2", "gem"], ["s2", "llama"], ["s3", "gem"], ["s3", "llama"],
  ]);
  const next = await runEval({}, req({ cursor: out.nextCursor }), deps);
  assert.equal(next.results.length, 2);
  assert.equal(next.nextCursor, null);
});

test("result cells carry answer, ms, chars, rawChars and lint; the model override reaches the provider", async () => {
  const { deps, calls } = makeDeps();
  const out = await runEval({}, req({ maxCalls: 2 }), deps);
  const r = out.results[0];
  assert.equal(r.ok, true);
  assert.equal(r.answer, GOOD);
  assert.equal(r.chars, GOOD.length);
  assert.equal(r.rawChars, GOOD.length);
  assert.ok(r.ms >= 300);
  assert.equal(r.lint.pass, true);
  assert.equal(calls[0].model, "gemini-3.5-flash-lite");
  assert.equal(calls[1].model, undefined);
  assert.equal(calls[0].budgetKind, "eval");
  assert.equal(calls[0].timeoutMs, EVAL_LIMITS.callTimeoutMs);
});

test("the visitor flag reaches lint: a member addressed to a visitor fails", async () => {
  const { deps } = makeDeps({ dispatch: async () => ({ answer: "**Santa, the roster is public.**", model: "m" }) });
  const r = validateEvalRequest({ questions: [sample.questions[6]], candidates: [{ label: "x", provider: "groq" }] });
  const out = await runEval({}, r, deps);
  assert.ok(out.results[0].lint.failures.includes("non_member_addressed"));
});

test("pacing: a 1 s gap between calls and the per-provider minimum gap (gemini)", async () => {
  const { deps, clock } = makeDeps();
  const r = validateEvalRequest({ questions: sample.questions.slice(0, 2), candidates: [{ label: "g", provider: "gemini" }] });
  await runEval({}, r, deps);
  assert.equal(clock.sleeps.length, 1);
  assert.ok(clock.sleeps[0] >= PROVIDER_MIN_GAP_MS.gemini - 300 - 1, `slept ${clock.sleeps[0]}`);
  assert.ok(PROVIDER_MIN_GAP_MS.gemini >= 4000, "gemini free tier is about 15 requests per minute");
});

test("a request never runs past its time budget: stoppedForTime with a resumable cursor", async () => {
  const { deps, clock } = makeDeps({});
  const slow = deps.dispatch;
  deps.dispatch = async (a) => { clock.advance(7000); return slow(a); };
  const r = validateEvalRequest({ questions: sample.questions, candidates: [{ label: "w", provider: "workers-ai" }] });
  const out = await runEval({}, r, deps);
  assert.equal(out.stoppedForTime, true);
  assert.ok(out.callsMade >= 1 && out.callsMade < 6);
  assert.ok(out.elapsedMs <= EVAL_LIMITS.requestBudgetMs);
  assert.equal(out.nextCursor, out.callsMade);
});

test("budget: stopped for budget returns partial results and no further Workers AI call", async () => {
  let n = 0;
  const { deps, calls } = makeDeps({ budgetVerdict: async () => (++n > 2 ? "eval_reserve" : null) });
  const r = validateEvalRequest({ questions: sample.questions, candidates: [{ label: "w", provider: "workers-ai" }] });
  const out = await runEval({}, r, deps);
  assert.equal(out.stoppedForBudget, true);
  assert.equal(calls.length, 2);
  assert.equal(out.results.length, 2);
  assert.equal(out.nextCursor, 2);
});

test("budget verdict is not asked for providers that do not use neurons", async () => {
  let asked = 0;
  const { deps } = makeDeps({ budgetVerdict: async () => { asked++; return "budget_global"; } });
  const r = validateEvalRequest({ questions: sample.questions.slice(0, 1), candidates: [{ label: "g", provider: "groq" }] });
  const out = await runEval({}, r, deps);
  assert.equal(asked, 0);
  assert.equal(out.results[0].ok, true);
});

test("defaultBudgetVerdict refuses with under 40 percent of the daily allowance left, and shares the production counter", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const envWith = (neurons) => ({
    AI_DAILY_NEURON_CAP: "10000",
    DB: { prepare: (sql) => ({ bind: (k) => ({ first: async () => (k === `ai_budget:${day}` ? { json: JSON.stringify({ neurons, asks: 0, cron: 0 }) } : null) }) }) },
  });
  assert.equal(await defaultBudgetVerdict(envWith(1000)), null);
  assert.equal(await defaultBudgetVerdict(envWith(6500)), "eval_reserve"); // 35% left
  assert.equal(await defaultBudgetVerdict(envWith(5900)), null); // 41% left
  assert.equal(await defaultBudgetVerdict(envWith(10000)), "budget_global");
});

test("a 429 is reported as rateLimited, not retried, and the provider cools down", async () => {
  let n = 0;
  const { deps, calls } = makeDeps({ dispatch: async (a) => { calls.push(a); n++; throw new Error("gemini API HTTP 429: quota"); } });
  const r = validateEvalRequest({ questions: sample.questions.slice(0, 3), candidates: [{ label: "g", provider: "gemini" }] });
  const out = await runEval({}, r, deps);
  assert.equal(n, 1);
  assert.equal(out.results[0].rateLimited, true);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].rateLimited, true);
  assert.equal(out.results[1].error, "rate_limited_cooldown");
  assert.equal(out.nextCursor, null);
});

test("unconfigured providers are cells with an error, not calls; other errors do not stop the job", async () => {
  const { deps, calls } = makeDeps({ configured: (_e, p) => p !== "groq" });
  const r = validateEvalRequest({ questions: sample.questions.slice(0, 1), candidates: [{ label: "g", provider: "groq" }, { label: "w", provider: "workers-ai" }] });
  const out = await runEval({}, r, deps);
  assert.equal(out.results[0].error, "provider_not_configured");
  assert.equal(out.results[1].ok, true);
  assert.equal(calls.length, 1);
});

test("the prompt variant is passed to the input builder and inputs are built once per question and variant", async () => {
  const seen = [];
  const { deps } = makeDeps();
  const base = deps.buildInputs;
  deps.buildInputs = async (e, a) => { seen.push(`${a.question}|${a.promptVariant}`); return base(e, a); };
  const r = validateEvalRequest({
    questions: sample.questions.slice(0, 1),
    candidates: [{ label: "a", provider: "groq", promptVariant: "plain" }, { label: "b", provider: "cerebras", promptVariant: "plain" }, { label: "c", provider: "github" }],
  });
  await runEval({}, r, deps);
  assert.equal(seen.length, 2);
  assert.ok(seen.some((s) => s.endsWith("|plain")) && seen.some((s) => s.endsWith("|production")));
});

// ---- dispatchToProvider model override (stubbed fetch) ----
test("dispatchToProvider: model override reaches the request; unlisted models are refused before any call", async () => {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push({ url: String(url), body: init && init.body });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const env = { GITHUB_MODELS_TOKEN: "t" };
    const out = await dispatchToProvider({ provider: "github", env, systemPrompt: "s", userPrompt: "u", deep: false, model: "gpt-4o" });
    assert.equal(out.model, "gpt-4o");
    assert.equal(JSON.parse(urls[0].body).model, "gpt-4o");
    await assert.rejects(dispatchToProvider({ provider: "github", env, systemPrompt: "s", userPrompt: "u", deep: false, model: "gpt-9" }), /not allowed/);
    assert.equal(urls.length, 1);
    const seen = [];
    const env2 = { AI: { run: async (model) => { seen.push(model); return { response: "hello" }; } }, DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } };
    const w = await dispatchToProvider({ provider: "workers-ai", env: env2, systemPrompt: "s", userPrompt: "u", deep: false, model: "@cf/meta/llama-3.1-8b-instruct-fp8", budgetKind: "eval" });
    assert.equal(w.model, "@cf/meta/llama-3.1-8b-instruct-fp8");
    assert.deepEqual(seen, ["@cf/meta/llama-3.1-8b-instruct-fp8"]);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- the route ----
test("EVAL_ENABLED: off by default (404 after the admin gate), on accepts the body check", async () => {
  assert.equal(evalEnabled({}), false);
  assert.equal(evalEnabled({ EVAL_ENABLED: "false" }), false);
  assert.equal(evalEnabled({ EVAL_ENABLED: "true" }), true);
  const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: {} }) }), first: async () => null, all: async () => ({ results: [] }) }), batch: async () => [] };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = (env, headers, body) => worker.fetch(new Request("https://api.test/api/admin/eval", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }), env, ctx);
  const admin = { Authorization: "Bearer admin-test-token" };
  const base = { BOARD_ADMIN_TOKEN: "admin-test-token", DB: db };
  assert.equal((await call(base, {}, "{}")).status, 401);
  assert.equal((await call(base, admin, "{}")).status, 404);
  assert.equal((await call({ ...base, EVAL_ENABLED: "true" }, {}, "{}")).status, 401);
  assert.equal((await call({ ...base, EVAL_ENABLED: "true" }, admin, "{}")).status, 400);
  assert.equal((await call({ ...base, EVAL_ENABLED: "true" }, admin, "not json")).status, 400);
});
