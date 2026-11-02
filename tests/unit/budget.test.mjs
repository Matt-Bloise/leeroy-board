// Pure unit tests for infrastructure/worker/budget.js. No network, no real D1, no AI.
// Run: node --test tests/unit/budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateNeurons, tokensFromChars, utcDayKey, secondsToUtcMidnight, overCap, dailyCap,
  loadBudget, recordUsage, DEFAULT_DAILY_CAP, CRON_RESERVE,
} from "../../infrastructure/worker/budget.js";

const M70 = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Tiny in-memory stand-in for env.DB covering prepare/bind/first/run on kv_state.
function fakeEnv({ failRead = false, failWrite = false } = {}) {
  const rows = new Map();
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async first() {
          if (failRead) throw new Error("read failed");
          return rows.has(args[0]) ? { json: rows.get(args[0]) } : null;
        },
        async run() {
          if (failWrite) throw new Error("write failed");
          assert.match(sql, /INSERT OR REPLACE INTO kv_state/);
          rows.set(args[0], args[1]);
          return {};
        },
      };
    },
  };
  return { DB, rows };
}

test("estimateNeurons matches the published 70B rates", () => {
  assert.equal(estimateNeurons(M70, 1e6, 0), 26668);
  assert.equal(estimateNeurons(M70, 0, 1e6), 204805);
  assert.ok(Math.abs(estimateNeurons(M70, 1500, 150) - (1500 * 26668 + 150 * 204805) / 1e6) < 1e-9);
});

test("estimateNeurons uses the 70B rates for unknown models and tolerates bad input", () => {
  assert.equal(estimateNeurons("@cf/other/model", 1e6, 1e6), 26668 + 204805);
  assert.equal(estimateNeurons(M70, -5, "x"), 0);
});

test("tokensFromChars is ceil(n/4)", () => {
  assert.equal(tokensFromChars(0), 0);
  assert.equal(tokensFromChars(1), 1);
  assert.equal(tokensFromChars(4), 1);
  assert.equal(tokensFromChars(6000), 1500);
  assert.equal(tokensFromChars(6001), 1501);
});

test("utcDayKey uses the UTC date", () => {
  assert.equal(utcDayKey(new Date("2026-11-02T23:59:59Z")), "2026-11-02");
  assert.equal(utcDayKey(new Date("2026-11-03T00:00:00Z")), "2026-11-03");
});

test("secondsToUtcMidnight counts down to 00:00 UTC", () => {
  assert.equal(secondsToUtcMidnight(new Date("2026-11-02T23:59:00Z")), 60);
  assert.equal(secondsToUtcMidnight(new Date("2026-11-02T00:00:00Z")), 86400);
  assert.equal(secondsToUtcMidnight(new Date("2026-12-31T12:00:00Z")), 43200);
});

test("overCap compares with the reserve subtracted", () => {
  assert.equal(overCap(7999, 8000), false);
  assert.equal(overCap(8000, 8000), true);
  assert.equal(overCap(6499, 8000, CRON_RESERVE), false);
  assert.equal(overCap(6500, 8000, CRON_RESERVE), true);
});

test("dailyCap reads AI_DAILY_NEURON_CAP when numeric, else 8000", () => {
  assert.equal(dailyCap({}), DEFAULT_DAILY_CAP);
  assert.equal(dailyCap({ AI_DAILY_NEURON_CAP: "5000" }), 5000);
  assert.equal(dailyCap({ AI_DAILY_NEURON_CAP: "abc" }), 8000);
  assert.equal(dailyCap({ AI_DAILY_NEURON_CAP: "0" }), 8000);
});

test("loadBudget returns zeros when nothing is stored", async () => {
  assert.deepEqual(await loadBudget(fakeEnv(), new Date("2026-11-02T10:00:00Z")), { neurons: 0, asks: 0, cron: 0 });
});

test("recordUsage accumulates per kind and per UTC day", async () => {
  const env = fakeEnv();
  const d1 = new Date("2026-11-02T10:00:00Z");
  await recordUsage(env, "ask", 120.5, d1);
  await recordUsage(env, "ask", 100, d1);
  await recordUsage(env, "cron", 300, d1);
  assert.deepEqual(await loadBudget(env, d1), { neurons: 520.5, asks: 2, cron: 1 });
  assert.ok(env.rows.has("ai_budget:2026-11-02"));
  assert.deepEqual(await loadBudget(env, new Date("2026-11-03T00:00:01Z")), { neurons: 0, asks: 0, cron: 0 });
});

test("budget reads and writes fail open", async () => {
  assert.deepEqual(await loadBudget(fakeEnv({ failRead: true })), { neurons: 0, asks: 0, cron: 0 });
  await assert.doesNotReject(recordUsage(fakeEnv({ failWrite: true }), "ask", 10));
  await assert.doesNotReject(recordUsage({}, "ask", 10));
});
