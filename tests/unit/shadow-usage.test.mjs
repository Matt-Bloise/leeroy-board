// Measured Anthropic usage per compose for the shadow recorder: tryResearchClaude's optional result.usage (summed over compose and a retry send, integers clamped to 0..1e7),
// the shadow route's input_tokens / output_tokens (integers or null) and the replay runner's per-item and summary token numbers. Offline.
// Run: node --test tests/unit/shadow-usage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tryResearchClaude, resetResearchClaudeForTests, measuredUsage, sumMeasured, MEASURED_CLAMP } from "../../infrastructure/worker/research/claude.js";
import { tokenStats, formatSummary } from "../../tools/replay/run.mjs";

const KEY = ["sk", "ant", "api03", "FAKE" + "FAKE", "1234567890"].join("-");
const OKTXT = "**Short answer first.**\nThat is how Classic handled it.\n-# Sources: general Classic-era knowledge · unconfirmed";
const env = { ANTHROPIC_API_KEY: KEY, ASK_RESEARCH: "on", RESEARCH_NAMES: "real", RESEARCH_CLAUDE_MONTHLY_TOKENS: "5000000",
  DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ json: "1" }] }), run: async () => ({}) }) }) } };
const run = (call) => tryResearchClaude({ env, priv: null, deep: true, hardEndAt: Date.now() + 20000, real: { system: "You are Leeroy.", user: "Asker: Bob (member)\nWhat first?", friend: ["What first?", "Bob"] }, call });
test.beforeEach(() => resetResearchClaudeForTests());

test("a compose reports its measured usage", async () => {
  const r = await run(async () => ({ answer: OKTXT, model: "m", usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5 } }));
  assert.deepEqual(r.usage, { input_tokens: 1200, output_tokens: 340 });
});

test("compose + retry send: the usage of both sends is summed", async () => {
  let n = 0;
  const r = await run(async () => {
    n++;
    if (n === 1) throw Object.assign(new Error("Anthropic API HTTP 529"), { status: 529, usage: { input_tokens: 1000, output_tokens: 7 } });
    return { answer: OKTXT, model: "m", usage: { input_tokens: 900, output_tokens: 300 } };
  });
  assert.equal(n, 2);
  assert.deepEqual(r.usage, { input_tokens: 1900, output_tokens: 307 });
});

test("no usable usage: the field is absent, never zero", async () => {
  for (const usage of [undefined, null, "x", {}, { input_tokens: 5 }, { input_tokens: NaN, output_tokens: 3 }, { input_tokens: -1, output_tokens: 3 }, { input_tokens: "9", output_tokens: 3 }, [1, 2]]) {
    const r = await run(async () => ({ answer: OKTXT, model: "m", usage }));
    assert.ok(r.answer, "still answers");
    assert.ok(!("usage" in r), JSON.stringify(usage));
  }
});

test("hostile values are clamped to 0..1e7 and floored to integers", () => {
  assert.deepEqual(measuredUsage({ input_tokens: 1e12, output_tokens: Infinity }), null);
  assert.deepEqual(measuredUsage({ input_tokens: 1e12, output_tokens: 12.9 }), { input_tokens: MEASURED_CLAMP, output_tokens: 12 });
  assert.deepEqual(sumMeasured([{ input_tokens: 9e6, output_tokens: 1 }, { input_tokens: 9e6, output_tokens: 2 }]), { input_tokens: MEASURED_CLAMP, output_tokens: 3 });
  assert.equal(sumMeasured([null, {}]), null);
  assert.equal(MEASURED_CLAMP, 1e7);
});

test("a failed compose carries no usage", async () => {
  const r = await run(async () => { throw Object.assign(new Error("Anthropic API HTTP 401"), { status: 401 }); });
  assert.ok(!r.answer && !("usage" in r));
});

test("replay: tokenStats and the summary line", () => {
  const rows = [{ id: "a", input_tokens: 1000, output_tokens: 100 }, { id: "b", input_tokens: 3000, output_tokens: 300 }, { id: "c", input_tokens: null, output_tokens: null }, { id: "d", input_tokens: 1.5, output_tokens: 2 }, { type: "header" }];
  assert.deepEqual(tokenStats(rows), { items_with_usage: 2, input_total: 4000, output_total: 400, input_mean: 2000, output_mean: 200 });
  assert.equal(tokenStats([]).input_mean, null);
  const text = formatSummary([{ id: "a", kind: "pair", input_tokens: 1000, output_tokens: 100 }, { id: "b", kind: "pair", input_tokens: 3000, output_tokens: 300 }]);
  assert.match(text, /tokens \(measured, 2 of 2 items\): input 4000 total, 2000 mean; output 400 total, 200 mean/);
  assert.match(formatSummary([{ id: "a", kind: "pair" }]), /tokens: no measured usage/);
});
