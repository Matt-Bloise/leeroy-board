// PR 329 condition 5: the reservation estimate for the monthly Claude cap is a safe upper bound of real usage, and a reservation is always reconciled to the real count.
// Offline; fake D1. Run: node --test tests/unit/ask-research-estimate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, usageTokens, reserveTokens, adjustTokens, counterKey, USAGE_CLAMP } from "../../infrastructure/worker/research/claude.js";
import { RESEARCH_MAX_TOKENS } from "../../infrastructure/worker/research/rules.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const utf8 = (s) => new TextEncoder().encode(s).length;
// A deliberately pessimistic token count for a prompt: one token per UTF-8 byte for everything non-ASCII (no tokenizer does worse), and for ASCII one token per 1.3 bytes
// (random base64 / hex / symbol soup is about the worst a BPE vocabulary does).
const pessimisticInput = (s) => {
  let ascii = 0, wide = 0;
  for (const ch of s) { const b = utf8(ch); if (b === 1) ascii++; else wide += b; }
  return Math.ceil(ascii / 1.3 + wide);
};
const b64 = (n) => { let out = ""; let x = 12345; const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out += A[x % 64]; } return out; };

const WORST = [
  ["CJK", "中文字符测试".repeat(800)],
  ["emoji", "\u{1F600}\u{1F9D1}‍\u{1F4BB}".repeat(800)],
  ["Thai and Arabic", "สวัสดีครับ مرحبا بالعالم".repeat(300)],
  ["combining marks", "á̂̃̄é̂̃".repeat(800)],
  ["long fenced block of base64", "```\n" + b64(6000) + "\n```"],
  ["fenced code, dense symbols", "```js\n" + "{[(<>)]}=>;:,.!@#$%^&*|\\/~`".repeat(250) + "\n```"],
  ["digits", "3141592653589793238462643383279".repeat(150)],
  ["quotes and newlines (JSON escapes)", '"\n"\n"\n'.repeat(1500)],
];

test("estimate >= a pessimistic token count + the full max_tokens, for worst-case prompts in the system and in the user part", () => {
  for (const [name, text] of WORST) {
    for (const [sys, usr] of [[text, ""], ["", text], ["You are Leeroy.", text]]) {
      const need = pessimisticInput(sys + usr) + RESEARCH_MAX_TOKENS;
      const got = estimateTokens(sys, usr);
      assert.ok(got >= need, `${name}: estimate ${got} < pessimistic ${need}`);
    }
  }
});

test("the estimate is never optimistic against UTF-8 bytes for non-ASCII text (a token is at least one byte)", () => {
  for (const [name, text] of WORST.slice(0, 4)) assert.ok(estimateTokens("", text) - RESEARCH_MAX_TOKENS >= utf8(text), name);
});

test("the full max_tokens is always included, and a smaller max_tokens (the understand step) reserves less", () => {
  assert.ok(estimateTokens("", "") >= RESEARCH_MAX_TOKENS);
  assert.equal(estimateTokens("abc", "def", 120) + (RESEARCH_MAX_TOKENS - 120), estimateTokens("abc", "def"));
  assert.ok(estimateTokens("x", "y", -5) >= 0);
});

test("a margin sits on top of the input estimate: it is not chars/3", () => {
  const plain = "a".repeat(3000);
  const chars3 = Math.ceil(3000 / 3) + RESEARCH_MAX_TOKENS;
  assert.ok(estimateTokens(plain, "") > chars3, `${estimateTokens(plain, "")} should exceed the old chars/3 figure ${chars3}`);
});

test("scales linearly with the input; null and undefined parts count as empty", () => {
  const a = estimateTokens("", "中".repeat(1000)) - RESEARCH_MAX_TOKENS;
  const b = estimateTokens("", "中".repeat(10000)) - RESEARCH_MAX_TOKENS;
  assert.ok(b / a > 8 && b / a < 11, String(b / a));
  assert.equal(estimateTokens(null, undefined), estimateTokens("", ""));
});

// ---- reconciliation against the counter ----------------------------------------------------------------------------------
const rowOf = (db, key) => db.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(key);
const envWith = (start) => { const db = schemaDb(); if (start !== null) db.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(counterKey(new Date()), String(start)); return { DB: db }; };
const count = (e) => Number(rowOf(e.DB, counterKey(new Date())).json);

test("reservation then settle: the counter ends at the real usage, whether the real usage is below or above the estimate", async () => {
  for (const real of [40, 1500, 9000]) {
    const e = envWith(1000);
    const estimate = 3000;
    assert.equal(await reserveTokens(e, estimate, 1_000_000), true);
    assert.equal(count(e), 1000 + estimate);
    await adjustTokens(e, usageTokens({ input_tokens: real - 5, output_tokens: 5 }, estimate) - estimate);
    assert.equal(count(e), 1000 + real, `real ${real}`);
  }
});

test("an underestimate is reconciled UP past the cap (the spend is recorded), and the next reservation is then refused", async () => {
  const cap = 5000;
  const e = envWith(1000);
  assert.equal(await reserveTokens(e, 2000, cap), true); // 3000 of 5000
  await adjustTokens(e, usageTokens({ input_tokens: 5200, output_tokens: 700 }, 2000) - 2000); // real 5900
  assert.equal(count(e), 1000 + 5900, "recorded in full, not clamped to the cap");
  assert.equal(await reserveTokens(e, 1, cap), false, "over the cap: nothing further is admitted");
  assert.equal(count(e), 6900, "a refused reservation changes nothing");
});

test("the reservation check itself never admits an estimate that does not fit (cap check unaffected by reconcile-up)", async () => {
  const e = envWith(4000);
  assert.equal(await reserveTokens(e, 1001, 5000), false);
  assert.equal(await reserveTokens(e, 1000, 5000), true);
  assert.equal(count(e), 5000);
});

test("partial, missing or malformed usage settles at the estimate (no refund); a valid block settles to its sum including cache fields", () => {
  const E = 4321;
  for (const u of [undefined, null, {}, { input_tokens: 10 }, { output_tokens: 10 }, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: "x" }, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: -1 }, { input_tokens: 0, output_tokens: 0 }]) {
    assert.equal(usageTokens(u, E), E, JSON.stringify(u));
  }
  assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, E), 115);
  assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null }, E), 15);
  assert.equal(usageTokens({ input_tokens: 10.2, output_tokens: 5 }, E), 16, "fractions round up");
  assert.equal(usageTokens({ input_tokens: 9e9, output_tokens: 9e9 }, E), 2 * USAGE_CLAMP);
});

test("a worst-case prompt's estimate is >= its real cost for any believable tokenizer, so a failed reconcile cannot under-record", () => {
  // Real cost of a prompt <= UTF-8 bytes + the answer. The estimate covers exactly that for non-ASCII text, so even if the settle write fails and the reservation stands, spend is recorded in full.
  for (const [name, text] of WORST) {
    const worstReal = pessimisticInput(text) + RESEARCH_MAX_TOKENS;
    assert.ok(estimateTokens("", text) >= worstReal, name);
  }
});
