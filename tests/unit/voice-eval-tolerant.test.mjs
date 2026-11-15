// Tolerant mode of the voice-eval task builder: a missing or mistyped arm answer is reported, never crashes, never defaulted.
// Run: node --test tests/unit/voice-eval-tolerant.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTasks } from "../../tools/voice-eval/make-tasks.mjs";
import { aggregate, formatReport } from "../../tools/voice-eval/aggregate.mjs";

const DIR = fileURLToPath(new URL("../../tools/voice-eval/", import.meta.url));
const prompts = JSON.parse(readFileSync(join(DIR, "prompts.json"), "utf8"));
const rubric = readFileSync(join(DIR, "rubric.md"), "utf8");
const core = prompts.filter((p) => p.set === "core");
const lab = (id) => id.replace(/\d/g, (d) => "abcdefghij"[d]);
const answers = (colour) => Object.fromEntries(core.map((p) => [p.id, `The ${colour} answer to ${lab(p.id)}. It keeps to the library.`]));
const mk = (extra = {}) => ({ prompts, rubric, seed: 5, ...extra });

test("strict mode still throws on a missing or mistyped answer", () => {
  const a = answers("red"), b = answers("blue");
  delete b[core[0].id];
  assert.throws(() => buildTasks(mk({ arms: { armone: a, armtwo: b } })), /missing answer/);
  const c = answers("blue");
  c[core[1].id] = { not: "a string" };
  assert.throws(() => buildTasks(mk({ arms: { armone: a, armtwo: c } })), /missing answer/);
});

test("tolerant mode drops the prompt for every arm, lists it, and keeps all pairs balanced", () => {
  const a = answers("red"), b = answers("blue");
  delete b[core[0].id];
  b[core[1].id] = 42;
  b[core[2].id] = "   ";
  const { tasks, mapping } = buildTasks(mk({ arms: { armone: a, armtwo: b }, tolerant: true }));
  assert.deepEqual(mapping.excluded.map((e) => e.promptId).sort(), core.slice(0, 3).map((p) => p.id).sort());
  assert.ok(mapping.excluded.every((e) => e.arms.length === 1 && e.arms[0] === "armtwo"));
  const per = new Map();
  for (const e of Object.values(mapping.tasks)) per.set(e.promptId, (per.get(e.promptId) || 0) + 1);
  assert.equal(per.size, core.length - 3);
  assert.ok([...per.values()].every((n) => n === 2), "each remaining prompt has both orders");
  assert.ok(!tasks.some((t) => core.slice(0, 3).some((p) => p.id === t.promptId)));
  assert.equal(mapping.armStats.armone.n, core.length - 3);
});

test("tolerant mode with nothing wrong excludes nothing and equals the strict build apart from the empty list", () => {
  const arms = { armone: answers("red"), armtwo: answers("blue") };
  const strict = buildTasks(mk({ arms }));
  const tol = buildTasks(mk({ arms, tolerant: true }));
  assert.deepEqual(tol.mapping.excluded, []);
  assert.equal(strict.mapping.excluded, undefined);
  assert.deepEqual(tol.tasks, strict.tasks);
});

test("tolerant mode refuses when no prompt has answers in every arm", () => {
  const a = answers("red"), b = {};
  assert.throws(() => buildTasks(mk({ arms: { armone: a, armtwo: b }, tolerant: true })), /nothing to judge/);
});

test("aggregate reports the excluded prompts and still scores the rest", () => {
  const a = answers("red"), b = answers("blue");
  delete b[core[0].id];
  const { tasks, mapping } = buildTasks(mk({ arms: { armone: a, armtwo: b }, tolerant: true }));
  const verdicts = tasks.map((t) => ({ taskId: t.taskId, verdict: mapping.tasks[t.taskId].armA === "armone" ? "A" : "B" }));
  const rep = aggregate(mapping, verdicts, { candidate: "armone" });
  assert.equal(rep.excluded.length, 1);
  const text = formatReport(rep);
  assert.match(text, /Excluded for every arm/);
  assert.ok(text.includes(core[0].id));
});
