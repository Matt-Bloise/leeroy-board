// PROMPT_PREFIX_ORDER: the same parts in a new order, off by default. Run: node --test tests/unit/prompt-prefix-order.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSystemPrompt, buildSystemPromptParts } from "../../infrastructure/worker/persona.js";
import { callAnthropicClaude, promptPrefixOrderOn } from "../../infrastructure/worker/ai-models.js";

const persona = {
  system: "SYSTEM TEXT", journeys: { guided: "GUIDED TEXT", curious: "CURIOUS TEXT" }, format: { chatMaxChars: 900 },
  bits: [{ id: "tank", text: "TANK BIT", when: "Tank seats, aggro", safe: true }, { id: "gold", text: "GOLD BIT", when: "Gold and riding costs", safe: true }],
  examples: [{ q: "how do mounts work", a: "MOUNT ANSWER", journey: "curious", tags: ["mounts"] }, { q: "which dungeon first", a: "DUNGEON ANSWER", journey: "guided", tags: ["dungeons"] }],
  avoid: ["Never ping people."],
};
const QUESTIONS = ["who holds aggro on the tank seat?", "how much gold for riding", "which dungeon first", "how do mounts work", "what is the cast time of fireball", "hello"];
const lines = (t) => t.split("\n").filter((l) => l !== "").sort();
const join = (p) => [...p.stable, ...p.variable].join("\n\n");

test("the flag is off by default and only the word on turns it on", () => {
  assert.equal(promptPrefixOrderOn({}), false);
  assert.equal(promptPrefixOrderOn({ PROMPT_PREFIX_ORDER: "off" }), false);
  assert.equal(promptPrefixOrderOn({ PROMPT_PREFIX_ORDER: "on" }), true);
  assert.match(fs.readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8"), /^PROMPT_PREFIX_ORDER = "off"/m);
});

test("same parts, new order: every line of the old prompt is in the new one and nothing else is, for every question, journey and coach setting", () => {
  for (const q of QUESTIONS) for (const journey of ["guided", "curious", "unknown"]) for (const isCoach of [false, true]) {
    const o = { journey, question: q, partySummary: "Party: five friends", libraryStamp: "stamp9", isCoach, coachPrompt: "COACH TEXT" };
    assert.deepEqual(lines(join(buildSystemPromptParts(persona, o))), lines(buildSystemPrompt(persona, o)), `${q}/${journey}/${isCoach}`);
  }
});

test("the stable block is identical across questions, journeys and library stamps (that is what makes it cacheable); the question-dependent parts are only in the variable block", () => {
  const stables = new Set();
  for (const q of QUESTIONS) for (const journey of ["guided", "curious"]) for (const stamp of ["a", "b"]) stables.add(buildSystemPromptParts(persona, { journey, question: q, libraryStamp: stamp, partySummary: "x" }).stable.join("\n\n"));
  assert.equal(stables.size, 1);
  const p = buildSystemPromptParts(persona, { question: "tank aggro", libraryStamp: "S1" });
  assert.ok(!p.stable.join("\n").includes("TANK BIT") && !p.stable.join("\n").includes("S1") && !p.stable.join("\n").includes("CURIOUS TEXT"));
  assert.ok(p.variable.join("\n").includes("TANK BIT") && p.variable.join("\n").includes("Library-Epoch: S1"));
});

async function bodyOf(opts) {
  let sent = null;
  const env = { ANTHROPIC_API_KEY: "sk-test-key-not-real", __fetch: null };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }); };
  try { await callAnthropicClaude({ env, userPrompt: "u", deep: false, skipCache: true, ...opts }); } finally { globalThis.fetch = realFetch; }
  return sent;
}

test("callAnthropicClaude: a stable prefix becomes its own cached block; a prefix that does not match, or none, sends one cached block as before; research (wantUsage) never caches", async () => {
  const stable = "STABLE", sys = `${stable}\n\nVARIABLE`;
  let b = await bodyOf({ systemPrompt: sys, systemCachePrefix: stable });
  assert.deepEqual(b.system, [{ type: "text", text: "STABLE", cache_control: { type: "ephemeral" } }, { type: "text", text: "VARIABLE" }]);
  b = await bodyOf({ systemPrompt: sys });
  assert.deepEqual(b.system, [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }]);
  b = await bodyOf({ systemPrompt: sys, systemCachePrefix: "OTHER" });
  assert.deepEqual(b.system, [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }]);
  b = await bodyOf({ systemPrompt: sys, systemCachePrefix: stable, wantUsage: true });
  assert.deepEqual(b.system, [{ type: "text", text: sys }]);
});
