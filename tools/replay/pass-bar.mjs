// The replay harness pass numbers, fixed BEFORE any run (docs/runbooks/replay-harness.md). tests/unit/replay-harness.test.mjs pins every value:
// changing one means changing the test and the runbook in the same PR, in view of the reviewer.
// Units (all rates are fractions of SCORED items, see score.mjs summarize):
//   exact_rate          scored truth items whose answer states the expected number in a plausible context and does not contradict it
//   unsupported_rate    scored truth items whose answer holds at least one number nothing supports (not the expected one, not in the entity's rows, not in the question, not a small bare counter)
//   degraded_rate       scored items the Worker answered with a non-ok reason, a +degraded model label, or a status other than answered
//   within_budget_rate  scored items whose compose latency_ms is under WITHIN_BUDGET_MS
export const WITHIN_BUDGET_MS = 22000; // the ask's hard end (shadow-ask runbook)
export const PASS_BAR = Object.freeze({
  exact_rate_min: 0.9,
  unsupported_rate_max: 0.02,
  degraded_rate_max: 0.05,
  within_budget_rate_min: 0.95,
  min_scored_per_kind: 30,
  required_kinds: Object.freeze(["spell_level", "item_level_req"]),
});

// Informational kinds: reported as their own kind with the label below, never part of the pass/fail decision or the required-kinds rule. trait_prereq rests on the edge rule "TraitEdge type 2: left is the prerequisite of right",
// which agrees with the legacy table on 21 of 23 comparable edges (the two that differ are in redesigned trees), so it is likely, not sure.
export const INFORMATIONAL_KINDS = Object.freeze(["trait_prereq"]);
export const INFORMATIONAL_LABEL = "likely, not counted toward the bar";

// Pair corpora (Leeroy versus the Worker): rubric scores come from a separate blind grading step (grade-pack.mjs).
export const RUBRIC_DIMENSIONS = Object.freeze(["tone", "helpfulness", "groundedness"]);
export const RUBRIC_MIN = 1;
export const RUBRIC_MAX = 5;
export const PAIR_RULE = Object.freeze({
  min_graded: 30,
  dimension_margin: 0.25, // worker mean of each dimension must be >= local mean minus this
  groundedness_floor: 4.0, // worker groundedness mean must be >= this
  low_groundedness_max_share: 0.05, // share of items with worker groundedness <= 2
  non_loss_min: 0.7, // share of items where the worker total (sum of the three) is >= the local total
});

const fmt = (v) => (v === null || v === undefined ? "n/a" : v.toFixed(3));

// summary: the object score.mjs summarize() returns. Returns {pass, failures[]}.
export function evaluateBar(summary) {
  const failures = [];
  const kinds = summary && summary.by_kind ? summary.by_kind : {};
  for (const k of PASS_BAR.required_kinds) if (!kinds[k]) failures.push(`required kind missing: ${k}`);
  const check = (label, s) => {
    if (s.exact_scored < PASS_BAR.min_scored_per_kind) failures.push(`${label}: only ${s.exact_scored} scored (need ${PASS_BAR.min_scored_per_kind})`);
    if (s.exact_rate === null || s.exact_rate < PASS_BAR.exact_rate_min) failures.push(`${label}: exact_rate ${fmt(s.exact_rate)} < ${PASS_BAR.exact_rate_min}`);
    if (s.unsupported_rate === null || s.unsupported_rate > PASS_BAR.unsupported_rate_max) failures.push(`${label}: unsupported_rate ${fmt(s.unsupported_rate)} > ${PASS_BAR.unsupported_rate_max}`);
    if (s.degraded_rate === null || s.degraded_rate > PASS_BAR.degraded_rate_max) failures.push(`${label}: degraded_rate ${fmt(s.degraded_rate)} > ${PASS_BAR.degraded_rate_max}`);
    if (s.within_budget_rate === null || s.within_budget_rate < PASS_BAR.within_budget_rate_min) failures.push(`${label}: within_budget_rate ${fmt(s.within_budget_rate)} < ${PASS_BAR.within_budget_rate_min}`);
  };
  const counted = Object.entries(kinds).filter(([k]) => !INFORMATIONAL_KINDS.includes(k));
  for (const [k, s] of counted) check(k, s);
  if (!counted.length) failures.push("no scored truth items");
  return { pass: failures.length === 0, failures };
}

// Pair rule over merged grades: [{local:{tone,helpfulness,groundedness}, worker:{...}}]
export function evaluatePairRule(items) {
  const failures = [];
  const n = items.length;
  if (n < PAIR_RULE.min_graded) failures.push(`only ${n} graded (need ${PAIR_RULE.min_graded})`);
  if (!n) return { pass: false, failures, means: null };
  const mean = (side, d) => items.reduce((a, x) => a + x[side][d], 0) / n;
  const means = {};
  for (const d of RUBRIC_DIMENSIONS) {
    means[d] = { local: mean("local", d), worker: mean("worker", d) };
    if (means[d].worker < means[d].local - PAIR_RULE.dimension_margin) failures.push(`${d}: worker ${means[d].worker.toFixed(2)} < local ${means[d].local.toFixed(2)} - ${PAIR_RULE.dimension_margin}`);
  }
  if (means.groundedness.worker < PAIR_RULE.groundedness_floor) failures.push(`groundedness mean ${means.groundedness.worker.toFixed(2)} < ${PAIR_RULE.groundedness_floor}`);
  const low = items.filter((x) => x.worker.groundedness <= 2).length / n;
  if (low > PAIR_RULE.low_groundedness_max_share) failures.push(`low groundedness share ${low.toFixed(3)} > ${PAIR_RULE.low_groundedness_max_share}`);
  const total = (o) => RUBRIC_DIMENSIONS.reduce((a, d) => a + o[d], 0);
  const nonLoss = items.filter((x) => total(x.worker) >= total(x.local)).length / n;
  if (nonLoss < PAIR_RULE.non_loss_min) failures.push(`non-loss share ${nonLoss.toFixed(3)} < ${PAIR_RULE.non_loss_min}`);
  return { pass: failures.length === 0, failures, means, non_loss: nonLoss, low_groundedness: low };
}
