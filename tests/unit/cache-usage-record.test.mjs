// Cache token counts are recorded (counts only) and the month counter counts cached tokens exactly as before. Run: node --test tests/unit/cache-usage-record.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { measuredUsage, sumMeasured, usageTokens } from "../../infrastructure/worker/research/claude.js";

const U = { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 5000, cache_read_input_tokens: 4000 };

test("measuredUsage keeps the cache write and read counts; absent or invalid fields are 0", () => {
  assert.deepEqual(measuredUsage(U), U);
  assert.deepEqual(measuredUsage({ input_tokens: 10, output_tokens: 5 }), { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  assert.equal(measuredUsage({ cache_read_input_tokens: 9 }), null, "no valid input and output: unknown, never a guess");
  assert.equal(measuredUsage({ ...U, cache_read_input_tokens: -4 }).cache_read_input_tokens, 0);
  assert.equal(measuredUsage({ ...U, cache_creation_input_tokens: 1e15 }).cache_creation_input_tokens, 1e7, "clamped");
});

test("sumMeasured adds all four fields over the sends of one ask", () => {
  assert.deepEqual(sumMeasured([U, U, null]), { input_tokens: 6, output_tokens: 4, cache_creation_input_tokens: 10000, cache_read_input_tokens: 8000 });
  assert.equal(sumMeasured([null, {}]), null);
});

test("the monthly counter still settles on input + output + cache write + cache read: its figure does not change", () => {
  assert.equal(usageTokens(U, 99999), 9005);
  const m = measuredUsage(U);
  assert.equal(usageTokens(U, 99999), m.input_tokens + m.output_tokens + m.cache_creation_input_tokens + m.cache_read_input_tokens, "the recorded counts add up to the counter");
  assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5 }, 99999), 15);
});
