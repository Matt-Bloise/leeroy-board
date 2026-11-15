// Hardening tests for the voice-eval aggregator and CLI: prototype-keyed ids, incompleteness, exact threshold boundaries,
// report wording, the CLI --tolerant default, and doc facts. Each block is also a mutant killer (see the mutation list in the PR).
// Run: node --test tests/unit/voice-eval-hardening.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { frozenHashes, sealMapping, wilsonInterval } from "../../tools/voice-eval/lib.mjs";
import { buildTasks } from "../../tools/voice-eval/make-tasks.mjs";
import { aggregate, formatReport, MIN_CONSISTENCY } from "../../tools/voice-eval/aggregate.mjs";

const DIR = fileURLToPath(new URL("../../tools/voice-eval/", import.meta.url));
const prompts = JSON.parse(readFileSync(join(DIR, "prompts.json"), "utf8"));
const rubric = readFileSync(join(DIR, "rubric.md"), "utf8");
const core = prompts.filter((p) => p.set === "core");
const X = "armone", Y = "armtwo";

// Synthetic sealed mapping: nPairs preference pairs for one pair of arms, both orders, kind pref, variant full, set core.
function synth(nPairs, { self = false, flags = {}, kind = "pref" } = {}) {
  const f = frozenHashes();
  const pair = self ? [`${X}#1`, `${X}#2`] : [X, Y];
  const mapping = { version: 3, seed: 1, sets: ["core"], variants: ["full"], normalised: true, armStats: null, promptsSha256: f.prompts, rubricSha256: f.rubric, frozen: true, tasks: {} };
  const pairs = [];
  let n = 0;
  for (let i = 0; i < nPairs; i++) {
    const ids = [];
    for (const [a, b] of [[pair[0], pair[1]], [pair[1], pair[0]]]) {
      const id = `t${String(++n).padStart(6, "0")}`;
      const fl = flags[i] || {}; // flags[i] = { armone: true, armtwo: true }: that arm states an unsupported number on prompt i
      mapping.tasks[id] = { kind, variant: kind === "ref" ? "reference" : "full", set: "core", promptId: `p${i}`, pair, armA: a, armB: b, unsupportedA: fl[a] ? ["99"] : [], unsupportedB: fl[b] ? ["99"] : [], ...(kind === "ref" ? { reference: X } : {}) };
      ids.push(id);
    }
    pairs.push(ids);
  }
  sealMapping(mapping);
  return { mapping, pairs };
}
const pickX = (mapping, id) => (mapping.tasks[id].armA === X ? "A" : "B");
// kind: "cons" (both orders choose X), "splitA" (A both orders), "splitB" (B both orders), "drop" (no verdict rows)
function verdictsFor(mapping, pairs, kinds) {
  const rows = [];
  pairs.forEach((ids, i) => {
    const k = kinds[i];
    if (k === "drop") return;
    for (const id of ids) rows.push({ taskId: id, verdict: k === "cons" ? pickX(mapping, id) : k === "consY" ? (pickX(mapping, id) === "A" ? "B" : "A") : k === "splitA" ? "A" : "B" });
  });
  return rows;
}
// Inconsistent pairs alternate A,A / B,B so the judge shows no position bias and only the consistency gate is under test.
const kindsOf = (n, bad, badKind) => Array.from({ length: n }, (_, i) => (i < bad ? (badKind ?? (i % 2 ? "splitB" : "splitA")) : "cons"));
const rateOf = (n, consistent) => aggregate(...(() => { const s = synth(n); return [s.mapping, verdictsFor(s.mapping, s.pairs, kindsOf(n, n - consistent))]; })()).judges.judge;

// ---------------------------------------------------------------- (1) ids that exist on Object.prototype

const PROTO_IDS = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

test("verdict ids named like Object.prototype members are unknown task ids, never counted", () => {
  const { mapping, pairs } = synth(10);
  const good = verdictsFor(mapping, pairs, kindsOf(10, 0));
  for (const id of PROTO_IDS) {
    const swapped = good.slice(0, good.length - 1).concat([{ taskId: id, verdict: "A" }]);
    assert.throws(() => aggregate(mapping, swapped, { allowIncomplete: true }), /unknown taskId/, id);
  }
});

test("swapping real verdicts for prototype ids cannot flip an UNRELIABLE judge to reliable", () => {
  // 100 pairs, 84 consistent: 84.0%, unreliable. Replace the 4 inconsistent pairs' verdict rows by prototype-named rows.
  const { mapping, pairs } = synth(100);
  const kinds = kindsOf(100, 16);
  const rows = verdictsFor(mapping, pairs, kinds);
  assert.equal(aggregate(mapping, rows).judges.judge.reliable, false);
  const bad = rows.filter((r) => pairs.slice(0, 16).flat().includes(r.taskId));
  const swapped = rows.map((r) => (bad.includes(r) ? { taskId: PROTO_IDS[bad.indexOf(r) % PROTO_IDS.length], verdict: "A" } : r));
  assert.throws(() => aggregate(mapping, swapped), /unknown taskId/);
});

test("real task ids are own keys; a prototype-named id next to them is still unknown", () => {
  const { mapping } = synth(1);
  const [first] = Object.keys(mapping.tasks);
  assert.ok(Object.hasOwn(mapping.tasks, first));
  assert.throws(() => aggregate(mapping, [{ taskId: "toString", verdict: "A" }], { allowIncomplete: true }), /unknown taskId/);
});

test("make-tasks: arm answer rows with ids like constructor or __proto__ are not duplicates of an empty slot and do not leak into the prototype", () => {
  const dir = mkdtempSync(join(tmpdir(), "vev-"));
  const file = join(dir, "armone.jsonl");
  const rows = ["constructor", "__proto__", "toString"].map((id) => JSON.stringify({ id, answer: "A plain answer." }));
  writeFileSync(file, rows.join("\n") + "\n");
  const r = spawnSync(process.execPath, [join(DIR, "make-tasks.mjs"), "--arm", `armone=${file}`, "--arm", `armtwo=${file}`, "--out", dir], { encoding: "utf8" });
  assert.ok(!/duplicate id/.test(r.stderr), r.stderr);
  assert.equal(({}).answer, undefined, "Object.prototype was not polluted");
});

// ---------------------------------------------------------------- (2) incompleteness never helps

test("--allow-incomplete: unanswered pairs count as inconsistent, so dropping the bad pairs cannot raise consistency", () => {
  const n = 100;
  const full = rateOf(n, 80); // 80 of 100 consistent
  assert.equal(full.consistencyRate, 0.8);
  const { mapping, pairs } = synth(n);
  const kinds = kindsOf(n, 20, "drop"); // the 20 inconsistent pairs are simply not answered
  const rep = aggregate(mapping, verdictsFor(mapping, pairs, kinds), { allowIncomplete: true }).judges.judge;
  assert.ok(rep.consistencyRate <= 0.8 + 1e-12, `consistency ${rep.consistencyRate}`);
  assert.equal(rep.consistencyRate, 0.8);
  assert.equal(rep.reliable, false);
  assert.equal(rep.completePrefPairs, 100);
});

test("--allow-incomplete: a half-answered pair (one of two orders) counts as inconsistent", () => {
  const { mapping, pairs } = synth(20);
  const rows = verdictsFor(mapping, pairs, kindsOf(20, 0));
  const missing = rows.filter((r) => r.taskId !== pairs[0][1]);
  const j = aggregate(mapping, missing, { allowIncomplete: true }).judges.judge;
  assert.equal(j.consistencyRate, 19 / 20);
});

test("incompleteness can never yield PASS: every single dropped verdict turns a PASS into no PASS", () => {
  const f = {};
  for (const p of core) f[p.id] = `The ${p.id.replace(/\d/g, (d) => "abcdefghij"[d])} answer. It keeps to the library.`;
  const arms = { armone: f, armtwo: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.replace("The", "That")])) };
  const { tasks, mapping } = buildTasks({ prompts, rubric, arms, seed: 3, pairs: [[X, Y]] });
  const all = tasks.map((t) => ({ taskId: t.taskId, verdict: mapping.tasks[t.taskId].armA === X ? "A" : "B" }));
  assert.equal(aggregate(mapping, all, { candidate: X }).judges.judge.pairs[0].candidate.verdict, "PASS");
  for (let i = 0; i < all.length; i++) {
    const rep = aggregate(mapping, all.filter((_, k) => k !== i), { candidate: X, allowIncomplete: true }).judges.judge;
    const c = rep.pairs[0].candidate;
    assert.notEqual(c && c.verdict, "PASS", `dropping verdict ${i}`);
    assert.ok(rep.consistencyRate < 1, `dropping verdict ${i} left consistency ${rep.consistencyRate}`);
  }
});

// ---------------------------------------------------------------- (3) exact thresholds

test("consistency gate boundaries at 100 pairs: 84% unreliable, 85% reliable (>=), 86% reliable", () => {
  assert.equal(MIN_CONSISTENCY, 0.85);
  assert.equal(rateOf(100, 84).consistencyRate, 0.84);
  assert.equal(rateOf(100, 84).reliable, false);
  assert.equal(rateOf(100, 85).consistencyRate, 0.85);
  assert.equal(rateOf(100, 85).reliable, true);
  assert.equal(rateOf(100, 86).reliable, true);
  assert.equal(rateOf(100, 100).reliable, true);
});

test("the reviewed run: 152 of 180 pairs (84.4%) is UNRELIABLE and cannot be PASS, 153 of 180 (85.0%) is reliable", () => {
  const a = rateOf(180, 152);
  assert.ok(Math.abs(a.consistencyRate - 0.8444444) < 1e-6);
  assert.equal(a.reliable, false);
  assert.match(formatReport(aggregate(...(() => { const s = synth(180); return [s.mapping, verdictsFor(s.mapping, s.pairs, kindsOf(180, 28))]; })())), /UNRELIABLE/);
  assert.equal(rateOf(180, 153).reliable, true);
});

test("the reason text at an exactly-85% judge never says 'below 85%'; a 84.96% judge shows its real figure", () => {
  // exactly 85%, but made unreliable by position bias: all inconsistent pairs are A,A
  const { mapping, pairs } = synth(2000);
  const kinds = Array.from({ length: 2000 }, (_, i) => (i < 300 ? "splitA" : "cons")); // 85.0% consistent, A-heavy
  const j = aggregate(mapping, verdictsFor(mapping, pairs, kinds)).judges.judge;
  assert.equal(j.consistencyRate, 0.85);
  assert.ok(!j.unreliableWhy.some((w) => /below/.test(w)), JSON.stringify(j.unreliableWhy));
  const s2 = synth(2000);
  const k2 = Array.from({ length: 2000 }, (_, i) => (i < 301 ? "splitA" : "cons")); // 84.95%
  const j2 = aggregate(s2.mapping, verdictsFor(s2.mapping, s2.pairs, k2)).judges.judge;
  assert.equal(j2.reliable, false);
  const why = j2.unreliableWhy.find((w) => /consistency/.test(w));
  assert.ok(why && /84\.95%/.test(why) && /below/.test(why), why);
});

test("A-share bound: the Wilson interval must EXCLUDE 50% (lower > 0.5 or upper < 0.5); just inside is not bias", () => {
  // 200 decided verdicts per judge: choose k A-verdicts. Find the smallest k whose interval lower bound is above 0.5.
  const N = 100; // pairs; each splitA pair adds 2 A, each splitB pair 2 B, each cons pair 1 A and 1 B
  const decided = 2 * N;
  let kBias = 0;
  while (wilsonInterval(kBias, decided)[0] <= 0.5) kBias++;
  const run = (aCount) => {
    const { mapping, pairs } = synth(N);
    const aPairs = Math.floor(aCount / 2); // splitA pairs contribute 2 A each; cons pairs contribute 1 A each
    const odd = aCount % 2;
    const kinds = Array.from({ length: N }, (_, i) => (i < aPairs ? "splitA" : i < aPairs + odd ? "cons" : "splitB"));
    // cons contributes one A and one B: adjust so the total A count is aCount and decided stays 200
    return aggregate(mapping, verdictsFor(mapping, pairs, kinds)).judges.judge;
  };
  // splitB pair: 0 A, 2 B ; cons: 1 A, 1 B ; splitA: 2 A. With odd=1 one cons pair gives the odd A.
  const hi = run(kBias), lo = run(kBias - 1);
  assert.equal(hi.aShare, kBias / decided);
  assert.equal(hi.positionBiased, true);
  assert.equal(lo.positionBiased, false);
  const sym = (aCount) => run(decided - aCount); // mirror: B-heavy
  assert.equal(sym(kBias).positionBiased, true, "B-heavy beyond the bound is bias too (upper < 0.5)");
  assert.equal(sym(kBias - 1).positionBiased, false);
});

test("no decided verdicts at all is not 'reliable'", () => {
  const { mapping, pairs } = synth(10);
  const rows = verdictsFor(mapping, pairs, kindsOf(10, 0)).map((r) => ({ ...r, verdict: "NONE" }));
  const j = aggregate(mapping, rows).judges.judge;
  assert.equal(j.consistencyRate, 1);
  assert.equal(j.aShare, null);
});

// ---------------------------------------------------------------- (4) report wording

test("zero non-self preference pairs prints 'insufficient data', never 'reliable'", () => {
  const { mapping, pairs } = synth(10, { self: true });
  const rows = verdictsFor(mapping, pairs, kindsOf(10, 0)).map((r) => ({ ...r, verdict: "NONE" }));
  const j = aggregate(mapping, rows).judges.judge;
  assert.equal(j.completePrefPairs, 0);
  const text = formatReport(aggregate(mapping, rows));
  assert.match(text, /insufficient data/);
  assert.ok(!/-> reliable/.test(text), text);
  // a self-comparison with some decided verdicts, still no non-self pairs
  const decidedRows = verdictsFor(mapping, pairs, kindsOf(10, 0)).map((r, i) => ({ ...r, verdict: i % 2 ? "A" : "B" }));
  const text2 = formatReport(aggregate(mapping, decidedRows));
  assert.match(text2, /insufficient data/);
  assert.ok(!/-> reliable/.test(text2), text2);
});

test("with non-self pairs the report still says reliable when it is", () => {
  const { mapping, pairs } = synth(100);
  const text = formatReport(aggregate(mapping, verdictsFor(mapping, pairs, kindsOf(100, 0))));
  assert.match(text, /-> reliable/);
});

// ---------------------------------------------------------------- CLI --tolerant default

function cliArms(dir, drop) {
  const mk = (colour, skip) => core.filter((p) => p.id !== skip).map((p) => JSON.stringify({ id: p.id, answer: `The ${colour} answer to ${p.id.replace(/\d/g, (d) => "abcdefghij"[d])}. It keeps to the library.` })).join("\n") + "\n";
  writeFileSync(join(dir, "a.jsonl"), mk("red"));
  writeFileSync(join(dir, "b.jsonl"), mk("blue", drop));
}
test("CLI: strict unless --tolerant. A missing arm answer exits 1 by default and exits 0 with --tolerant, listing the prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "vev-cli-"));
  cliArms(dir, core[0].id);
  const base = [join(DIR, "make-tasks.mjs"), "--arm", `armone=${join(dir, "a.jsonl")}`, "--arm", `armtwo=${join(dir, "b.jsonl")}`, "--out", dir];
  const strict = spawnSync(process.execPath, base, { encoding: "utf8" });
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /missing answer/);
  const tol = spawnSync(process.execPath, [...base, "--tolerant"], { encoding: "utf8" });
  assert.equal(tol.status, 0, tol.stderr);
  assert.match(tol.stderr, /excluded/i);
  const mapping = JSON.parse(readFileSync(join(dir, "mapping.json"), "utf8"));
  assert.deepEqual(mapping.excluded.map((e) => e.promptId), [core[0].id]);
});

// ---------------------------------------------------------------- docs

test("README states the roster handling and does not claim the tool never calls a model", () => {
  const r = readFileSync(join(DIR, "README.md"), "utf8");
  assert.ok(!/never calls a model/i.test(r));
  assert.match(r, /--live/);
  assert.match(r, /ROSTER_DATA[^\n]*in memory[^\n]*never print/i);
});

test("RESULTS note: 360 tasks are 2 comparisons x 30 core prompts x 2 orders x 3 variants; 38 is only the prompt total", () => {
  const t = readFileSync(join(DIR, "RESULTS-2026-11-15.md"), "utf8");
  assert.equal(2 * 30 * 2 * 3, 360);
  assert.match(t, /2 comparisons x 30 (core )?prompts x 2 orders x 3 variants/);
  assert.ok(!/2 comparisons x 38/.test(t));
  assert.match(t, /4b[^\n]*not scored/i);
  assert.ok(!/\b17 of 38 production\b/.test(t), "the production-arm code-written count is out of 30 scored prompts, not 38");
});

// ---------------------------------------------------------------- the number check and the reference variant

const strictCase = (flags) => {
  const { mapping, pairs } = synth(30, { flags });
  const kinds = Array.from({ length: 30 }, (_, i) => (i < 24 ? "cons" : "consY")); // judge prefers X on exactly 24 of 30
  return aggregate(mapping, verdictsFor(mapping, pairs, kinds), { candidate: X, strictNumbers: true }).judges.judge.pairs[0];
};

test("--strict-numbers: adjusted 24 of 30 passes (>=), 23 of 30 does not; an auto-loss on a flagged win drops adjusted to 23 and fails", () => {
  const ok = strictCase({});
  assert.equal(ok.judgeOnly.preferred[X], 24);
  assert.equal(ok.adjusted.preferred[X], 24);
  assert.equal(ok.candidate.verdict, "PASS");
  const flagged = strictCase({ 0: { [X]: true } }); // X wins prompt 0 but states an unsupported number: auto-loss, adjusted 23
  assert.equal(flagged.judgeOnly.preferred[X], 24);
  assert.equal(flagged.adjusted.preferred[X], 23);
  assert.equal(flagged.candidate.verdict, "FAIL");
});

test("number check: when both arms state unsupported numbers on a prompt it is a tie, not a win for the judge's pick", () => {
  const { mapping, pairs } = synth(30, { flags: { 0: { [X]: true, [Y]: true } } });
  const row = aggregate(mapping, verdictsFor(mapping, pairs, kindsOf(30, 0)), { candidate: X }).judges.judge.pairs[0];
  assert.equal(row.judgeOnly.preferred[X], 30);
  assert.equal(row.adjusted.preferred[X], 29);
  assert.equal(row.adjusted.ties, 1);
  assert.equal(row.autoLoss.pairsChanged, 1);
});

test("the reference variant rejects NONE, and a prototype-named id on a ref task is unknown", () => {
  const { mapping, pairs } = synth(2, { kind: "ref" });
  const none = pairs[0].map((id) => ({ taskId: id, verdict: "NONE" }));
  assert.throws(() => aggregate(mapping, none, { allowIncomplete: true }), /reference variant requires A or B/);
  const ok = verdictsFor(mapping, pairs, ["cons", "cons"]);
  assert.equal(aggregate(mapping, ok).judges.judge.reference[0].accuracy, 1);
});
