// Production bug (Nov 2026, after the Buffer fix): every real /ask Claude call ended "[claude:timeout]+degraded". Compose had a 6 s budget; Sonnet composing a real-names research answer (a large prompt, up to
// 700 output tokens, one non-streaming call) needs more, so the fetch was aborted and the 3 s Haiku retry timed out too. New split inside the ask's 22 s hard end (ASK_DEADLINE_MS 26 s minus a sixth, capped at 4 s):
// compose 16 s, then the Haiku-class retry min(remaining, 8 s) and only with at least 2.5 s left. The timeout reason names the send and its whole seconds: claude:timeout@compose-16s, claude:timeout@retry-6s.
// Platform limits relied on (developers.cloudflare.com/workers/runtime-apis/context/ and /workers/platform/limits/): ctx.waitUntil runs up to 30 s after the response is sent; Workers Free has no wall-clock limit while the
// HTTP request is connected; fetch wait time is not CPU time. discord.js DELIVERY_BUDGET_MS is 28 s from the ask's start.
// Offline: fake call, stub D1, mocked Date. Run: node --test tests/unit/ask-claude-budget.test.mjs
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { tryResearchClaude, resetResearchClaudeForTests, splitBudget, failReason, timeoutBucket, CLAUDE_COMPOSE_MS, CLAUDE_TIMEOUT_MS, CLAUDE_RETRY_MAX_MS, RETRY_MIN_MS } from "../../infrastructure/worker/research/claude.js";
import { ASK_DEADLINE_MS, AiTimeoutError } from "../../infrastructure/worker/ai-models.js";
import { hardEndMs } from "../../infrastructure/worker/research/no-wall.js";
import { DELIVERY_BUDGET_MS } from "../../infrastructure/worker/discord.js";

test.beforeEach(() => { resetResearchClaudeForTests(); });
test.afterEach(() => { mock.timers.reset(); });

// ---- constants -----------------------------------------------------------------------------------------------------------------------------------------
test("budget constants: compose gets a realistic share, the retry fits behind it, all of it inside the ask's hard end, the hard end inside the delivery budget and the 30 s waitUntil cap", () => {
  assert.equal(CLAUDE_COMPOSE_MS, 16000);
  assert.equal(CLAUDE_TIMEOUT_MS, 22000);
  assert.equal(CLAUDE_RETRY_MAX_MS, 8000);
  assert.ok(CLAUDE_COMPOSE_MS >= 15000, "compose must outlast a 15 s Sonnet answer");
  assert.ok(CLAUDE_COMPOSE_MS + RETRY_MIN_MS <= CLAUDE_TIMEOUT_MS, "a compose timeout still leaves the retry its minimum");
  assert.ok(CLAUDE_TIMEOUT_MS <= hardEndMs(ASK_DEADLINE_MS), `the Claude hop (${CLAUDE_TIMEOUT_MS}) ends by the ask's hard end (${hardEndMs(ASK_DEADLINE_MS)})`);
  assert.equal(ASK_DEADLINE_MS, 26000);
  // After the deadline the delivery edit needs at least its 2 s first-attempt floor, and the whole thing must end before the delivery budget, which sits under the 30 s waitUntil cap.
  assert.ok(ASK_DEADLINE_MS + 2000 <= DELIVERY_BUDGET_MS, "deadline plus the 2 s delivery floor fits the delivery budget");
  assert.ok(DELIVERY_BUDGET_MS < 30000, "the delivery budget is under the 30 s waitUntil cap");
});

test("splitBudget: compose never takes the retry's minimum; with room for one send it gets everything", () => {
  assert.deepEqual(splitBudget(22000), { compose: 16000, retry: 6000 });
  assert.deepEqual(splitBudget(21000), { compose: 16000, retry: 5000 });
  assert.deepEqual(splitBudget(18000), { compose: 15500, retry: 2500 });
  assert.deepEqual(splitBudget(5000), { compose: 2500, retry: 2500 });
  assert.deepEqual(splitBudget(4999), { compose: 4999, retry: 0 });
  assert.deepEqual(splitBudget(0), { compose: 0, retry: 0 });
  assert.deepEqual(splitBudget(-5), { compose: 0, retry: 0 });
  assert.deepEqual(splitBudget(NaN), { compose: 0, retry: 0 });
  assert.deepEqual(splitBudget(60000), { compose: 16000, retry: 8000 }, "the retry is capped");
  for (let r = 0; r <= 30000; r += 250) {
    const s = splitBudget(r);
    assert.ok(s.compose + s.retry <= r || s.retry === 0, String(r));
    assert.ok(s.compose <= CLAUDE_COMPOSE_MS || s.retry === 0);
    if (s.retry) assert.ok(s.retry >= RETRY_MIN_MS && s.retry <= CLAUDE_RETRY_MAX_MS, String(r));
  }
});

// ---- the reason class ----------------------------------------------------------------------------------------------------------------------------------
test("timeoutBucket and failReason: whole seconds, capped at two digits, stage only compose or retry, value-free", () => {
  assert.equal(timeoutBucket("compose", 16000), "@compose-16s");
  assert.equal(timeoutBucket("compose", 15600), "@compose-16s");
  assert.equal(timeoutBucket("retry", 6200), "@retry-6s");
  assert.equal(timeoutBucket("retry", 0), "@retry-0s");
  assert.equal(timeoutBucket("compose", 250000), "@compose-99s");
  assert.equal(timeoutBucket("compose", -5), "@compose-0s");
  assert.equal(timeoutBucket("weird", 5000), "");
  assert.equal(timeoutBucket("compose", NaN), "");
  const sent = { stage: "compose", at: Date.now() - 16100 };
  assert.equal(failReason(new AiTimeoutError("AI provider request", 16000), sent), "claude:timeout@compose-16s");
  assert.equal(failReason({ name: "TimeoutError" }, { stage: "retry", at: Date.now() - 6000 }), "claude:timeout@retry-6s");
  assert.equal(failReason(new AiTimeoutError("x", 1)), "claude:timeout", "no stage given: the plain class (other callers)");
  assert.equal(failReason(new Error("Anthropic API HTTP 529"), sent), "claude:http-529", "the bucket is for timeouts only");
  for (const r of [failReason(new AiTimeoutError("secret?", 1), sent)]) assert.match(r, /^claude:timeout@(compose|retry)-\d{1,2}s$/);
});

// ---- the hop, with a controlled clock -----------------------------------------------------------------------------------------------------------------
const baseEnv = () => ({
  ANTHROPIC_API_KEY: "sk-ant-FAKE-BUDGET-0000", ASK_RESEARCH: "on", RESEARCH_NAMES: "real", RESEARCH_CLAUDE_MONTHLY_TOKENS: "5000000",
  DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ json: "1" }] }), run: async () => ({}) }) }) },
});
const ANSWER = "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
// script: one entry per send: { takes: ms of fake wall time, then "ok" | "timeout" | "529" }
async function hop(script, { hardEndIn = CLAUDE_TIMEOUT_MS } = {}) {
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const start = Date.now();
  const sends = [];
  let i = 0;
  const call = async (a) => {
    const step = script[i++] || { takes: 0, then: "ok" };
    const at = Date.now() - start;
    sends.push({ model: a.modelOverride, at, ms: a.deadlineAt - Date.now(), deadlineAt: a.deadlineAt - start });
    // A real fetch is aborted at its deadline: the fake send never runs past it.
    const run = Math.min(step.takes, Math.max(0, a.deadlineAt - Date.now()));
    mock.timers.tick(run);
    if (step.takes > run || step.then === "timeout") throw new AiTimeoutError("AI provider request", run);
    if (step.then === "529") throw Object.assign(new Error("Anthropic API HTTP 529"), { status: 529 });
    return { answer: ANSWER, model: a.modelOverride, provider: "claude", usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const r = await tryResearchClaude({ env: baseEnv(), priv: null, deep: true, hardEndAt: start + hardEndIn, real: { system: "You are Leeroy.", user: "Asker: Bob (member)\nWhat should I level first?", friend: ["What should I level first?", "Bob"] }, call });
  return { r, sends, elapsed: Date.now() - start };
}

test("a Sonnet answer that takes 8 s or 15 s is a Claude answer (it used to be aborted at 6 s)", async () => {
  for (const takes of [8000, 15000]) {
    resetResearchClaudeForTests();
    const { r, sends } = await hop([{ takes, then: "ok" }]);
    assert.equal(r.reason, undefined, `${takes}: ${JSON.stringify(r)}`);
    assert.equal(r.provider, "claude");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].model, "claude-sonnet-5-5");
    assert.equal(sends[0].ms, CLAUDE_COMPOSE_MS, "compose's own deadline");
    mock.timers.reset();
  }
});

test("a 30 s upstream: compose aborts at 16 s, the Haiku-class retry gets the rest and aborts too, and the reason names the last send (claude:timeout@retry-6s; a retry only ever follows a compose failure)", async () => {
  const { r, sends, elapsed } = await hop([{ takes: 30000, then: "ok" }, { takes: 30000, then: "ok" }]);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].ms, 16000);
  assert.equal(sends[1].model, "claude-haiku-5-5");
  assert.equal(sends[1].at, 16000, "the retry starts right after the compose abort");
  assert.equal(sends[1].ms, 6000, "the retry gets what is left of the 22 s (under its 8 s cap)");
  assert.equal(r.reason, "claude:timeout@retry-6s");
  assert.ok(elapsed <= 22000, `the whole hop ends by the hard end (${elapsed})`);
});

test("compose times out and the Haiku-class retry answers in time: a Claude answer from the fast model", async () => {
  const { r, sends } = await hop([{ takes: 30000, then: "ok" }, { takes: 3000, then: "ok" }]);
  assert.equal(r.reason, undefined, JSON.stringify(r));
  assert.equal(r.model, "claude-haiku-5-5");
  assert.equal(sends.length, 2);
});

test("an overloaded compose (529) retries at once with up to 8 s, not the whole remainder", async () => {
  const { r, sends } = await hop([{ takes: 300, then: "529" }, { takes: 30000, then: "ok" }]);
  assert.equal(sends[1].ms, CLAUDE_RETRY_MAX_MS);
  assert.equal(r.reason, "claude:timeout@retry-8s");
});

test("a short ask deadline has room for one send only: compose takes it all, no retry, and the reason names compose", async () => {
  const { r, sends } = await hop([{ takes: 30000, then: "ok" }], { hardEndIn: 4000 });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].ms, 4000);
  assert.equal(r.reason, "claude:timeout@compose-4s");
});

test("compose leaves the retry its minimum when the start was slow (hard end 18 s away: compose 15.5 s, retry 2.5 s)", async () => {
  const { r, sends } = await hop([{ takes: 30000, then: "ok" }, { takes: 30000, then: "ok" }], { hardEndIn: 18000 });
  assert.equal(sends[0].ms, 15500);
  assert.equal(sends[1].ms, 2500);
  assert.equal(r.reason, "claude:timeout@retry-3s", "2.5 s rounds to 3");
});

test("no send of any kind is scheduled past the hard end", async () => {
  for (const hardEndIn of [3000, 5000, 9000, 12000, 18000, 22000, 40000]) {
    resetResearchClaudeForTests();
    const { sends } = await hop([{ takes: 40000, then: "ok" }, { takes: 40000, then: "ok" }], { hardEndIn });
    for (const s of sends) assert.ok(s.at + s.ms <= Math.min(hardEndIn, CLAUDE_TIMEOUT_MS) + 1, `hardEndIn ${hardEndIn}: send at ${s.at} + ${s.ms}`);
    mock.timers.reset();
  }
});
