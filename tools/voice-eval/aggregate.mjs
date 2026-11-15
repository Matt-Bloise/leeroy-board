// Aggregates judge verdicts for the voice evaluation. No model is called here.
//
// Inputs : mapping.json (secret, from make-tasks.mjs) and verdicts.jsonl ({taskId, verdict[, judge]}); verdict is A, B or NONE.
//          "judge" is optional but must then be on every row; ids are trimmed and lower-cased. Each judge must cover every task.
// Output : a report per judge. Only order-consistent pairs count as a preference.
//
// Rules:
//  - A pair is the two order-swapped tasks for one prompt. Consistent = both name the same arm, or both say NONE (a tie).
//  - Preference rate = preferred / all complete pairs (ties and inconsistent pairs stay in the denominator: conservative).
//    The lower bound is the one-sided 95% Wilson lower bound on that rate.
//  - Pass criterion (only for the arm named with --candidate, against each other arm, 30 core prompts, the "full" question): at least
//    24 of 30, and the judge must be reliable. An unreliable judge never produces PASS.
//  - Automatic loss for unsupported numbers is ADVISORY: it is reported (a flag count per arm, the pairs it would change, the adjusted
//    result) but does not change PASS. With --strict-numbers the adjusted result must also reach 24 of 30.
//  - Judge reliability: order-swap consistency >= 85% over non-self PREFERENCE pairs (the reference variant has its own report), and no
//    position bias (the share of "A" verdicts has a 95% Wilson interval that contains 50%).
//  - Self-comparison: the first copy's share of decided judgements with a 95% Wilson interval; the check is that the interval contains
//    50%. All-NONE (no decided judgement) is a pass. There is no single-run 45-55 gate.
//  - Which-is-the-reference: accuracy over ALL judgements (two per prompt) with a 95% Wilson interval. "cannot-tell" needs the interval
//    inside 35-65%; "can-tell" an interval that excludes 50%; else "inconclusive". An unreliable judge gets no verdict. The two
//    judgements of a prompt are not independent, so the interval is optimistic; accuracy over consistent pairs only is shown beside it.
//  - Frozen inputs: the mapping must match the stored prompts/rubric hashes and its own content hash, or --allow-unfrozen is needed.
// Usage: node tools/voice-eval/aggregate.mjs --mapping mapping.json --verdicts verdicts.jsonl --candidate NAME [--json]
//        [--strict-numbers] [--cluster-size N] [--allow-unfrozen] [--allow-incomplete]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { wilsonLower, wilsonInterval, readJsonl, frozenHashes, mappingIntact, pairsNeededForBand } from "./lib.mjs";

export const MIN_CONSISTENCY = 0.85;
export const PASS_PREFERRED_OF_30 = 24;
export const CANNOT_TELL_BAND = [0.35, 0.65];
const DEFAULT_JUDGE = "judge";

function checkMapping(mapping, { allowUnfrozen }) {
  const warnings = [];
  if (!mappingIntact(mapping)) throw new Error("mapping.json was edited after make-tasks sealed it (content hash mismatch): refusing to score");
  const stored = frozenHashes();
  const same = mapping.promptsSha256 === stored.prompts && mapping.rubricSha256 === stored.rubric;
  if (mapping.frozen === false || !same) {
    const why = mapping.frozen === false ? "the run was built with --allow-unfrozen" : "the mapping's prompts/rubric hashes differ from prompts.sha256 / rubric.sha256";
    if (!allowUnfrozen) throw new Error(`unfrozen inputs: ${why}. Pass --allow-unfrozen to score anyway; the report will say so.`);
    warnings.push(`UNFROZEN: ${why}. Results are not comparable with frozen runs.`);
  }
  if (mapping.normalised !== true) {
    warnings.push("NOT NORMALISED: answers were shown as written (no make-tasks --normalise). Sources lines, tags and markdown can identify an arm without reading its voice.");
  }
  return warnings;
}

function normaliseVerdicts(mapping, verdicts) {
  if (!verdicts.length) throw new Error("verdict file is empty");
  const withJudge = verdicts.filter((v) => v && v.judge !== undefined && v.judge !== null && String(v.judge).trim() !== "").length;
  if (withJudge !== 0 && withJudge !== verdicts.length) throw new Error(`${verdicts.length - withJudge} of ${verdicts.length} verdict rows have no judge id while others do: split judges, fix the file`);
  const seen = new Set();
  const out = new Map(); // judge -> Map(taskId -> verdict)
  for (const v of verdicts) {
    const entry = v && typeof v.taskId === "string" && Object.hasOwn(mapping.tasks, v.taskId) ? mapping.tasks[v.taskId] : undefined; // own keys only: "constructor" or "toString" are not task ids
    if (!entry) throw new Error(`unknown taskId ${JSON.stringify(v && v.taskId)}`);
    const verdict = String(v.verdict ?? "").trim().toUpperCase();
    if (!["A", "B", "NONE"].includes(verdict)) throw new Error(`bad verdict ${JSON.stringify(v.verdict)} for ${v.taskId}: expected A, B or NONE`);
    if (entry.kind === "ref" && verdict === "NONE") throw new Error(`bad verdict NONE for ${v.taskId}: the reference variant requires A or B`);
    const judge = withJudge ? String(v.judge).trim().toLowerCase() : DEFAULT_JUDGE;
    const key = `${judge}\u0000${v.taskId}`;
    if (seen.has(key)) throw new Error(`duplicate verdict for ${v.taskId} from judge "${judge}"`);
    seen.add(key);
    if (!out.has(judge)) out.set(judge, new Map());
    out.get(judge).set(v.taskId, verdict);
  }
  return out;
}

const variantOf = (e) => e.variant ?? (e.kind === "ref" ? "reference" : "full");

function groupMapping(mapping) {
  const groups = new Map();
  for (const [taskId, e] of Object.entries(mapping.tasks)) {
    const key = [e.kind, variantOf(e), e.set, e.pair.join("\u0001"), e.promptId].join("\u0000");
    if (!groups.has(key)) groups.set(key, { kind: e.kind, variant: variantOf(e), set: e.set, pair: e.pair, promptId: e.promptId, tasks: [] });
    groups.get(key).tasks.push({ taskId, e });
  }
  return [...groups.values()];
}

const pickedArm = (e, verdict) => (verdict === "A" ? e.armA : verdict === "B" ? e.armB : null);
const isSelfPair = ([a, b]) => a.endsWith("#1") && b.endsWith("#2") && a.slice(0, -2) === b.slice(0, -2);

function emptyTally(arms) {
  return { preferred: { [arms[0]]: 0, [arms[1]]: 0 }, ties: 0, inconsistent: 0 };
}
function tallyStats(t, n, arms) {
  const [x, y] = arms;
  return {
    preferred: t.preferred, ties: t.ties, inconsistent: t.inconsistent,
    preferenceRate: { [x]: n ? t.preferred[x] / n : null, [y]: n ? t.preferred[y] / n : null },
    lowerBound95: { [x]: wilsonLower(t.preferred[x], n), [y]: wilsonLower(t.preferred[y], n) },
  };
}

function judgeReport(groups, verdictMap, { candidate, strictNumbers, clusterSize }) {
  const prefRows = new Map();
  const refRows = new Map();
  let prefNonSelf = 0, prefNonSelfConsistent = 0, aVerdicts = 0, decided = 0;

  for (const g of groups) {
    const rowKey = [g.kind, g.variant, g.set, g.pair.join("\u0001")].join("\u0000");
    const rows = g.kind === "pref" ? prefRows : refRows;
    if (!rows.has(rowKey)) {
      rows.set(rowKey, {
        kind: g.kind, variant: g.variant, set: g.set, arms: g.pair, self: isSelfPair(g.pair), n: 0, incomplete: 0,
        judgeOnly: emptyTally(g.pair), adjusted: emptyTally(g.pair), autoLossChanged: [], flagged: { [g.pair[0]]: 0, [g.pair[1]]: 0 },
        votes: { [g.pair[0]]: 0, [g.pair[1]]: 0 }, aVotes: 0, bVotes: 0, noneVotes: 0, consistentPairs: 0,
        nConsistent: 0, correct: 0, judgementCorrect: 0, judgementTotal: 0, reference: g.tasks[0].e.reference,
      });
    }
    const row = rows.get(rowKey);
    const verdicts = g.tasks.map((t) => ({ ...t, verdict: verdictMap.get(t.taskId) }));
    if (verdicts.some((t) => t.verdict === undefined) || verdicts.length !== 2) {
      row.incomplete++;
      // An unanswered or half-answered preference pair counts as INCONSISTENT in the consistency gate, so leaving pairs out can never raise it.
      if (g.kind === "pref" && !row.self) prefNonSelf++;
      continue;
    }
    row.n++;
    const picks = verdicts.map((t) => pickedArm(t.e, t.verdict));
    for (const t of verdicts) {
      if (t.verdict === "A") { row.aVotes++; aVerdicts++; decided++; } else if (t.verdict === "B") { row.bVotes++; decided++; } else row.noneVotes++;
    }
    for (const p of picks) if (p) row.votes[p]++;
    const consistent = picks[0] === picks[1];
    if (consistent) row.consistentPairs++;
    if (g.kind === "pref" && !row.self) { prefNonSelf++; if (consistent) prefNonSelfConsistent++; }

    if (g.kind === "ref") {
      for (const p of picks) {
        row.judgementTotal++;
        if (p === row.reference) row.judgementCorrect++;
      }
      if (consistent) {
        row.nConsistent++;
        if (picks[0] === row.reference) row.correct++;
      }
      continue;
    }

    // preference pair: the judge's verdicts alone
    const [x, y] = g.pair;
    let judgeWinner;
    if (!consistent) { row.judgeOnly.inconsistent++; judgeWinner = undefined; }
    else if (picks[0]) { row.judgeOnly.preferred[picks[0]]++; judgeWinner = picks[0]; }
    else { row.judgeOnly.ties++; judgeWinner = null; }
    if (row.self) continue; // identical answers: no number check, no adjusted result

    // advisory number check
    const unsupported = {};
    for (const t of verdicts) {
      unsupported[t.e.armA] = (t.e.unsupportedA || []).length > 0;
      unsupported[t.e.armB] = (t.e.unsupportedB || []).length > 0;
    }
    if (unsupported[x]) row.flagged[x]++;
    if (unsupported[y]) row.flagged[y]++;
    let adjustedWinner = judgeWinner;
    if (unsupported[x] !== unsupported[y]) adjustedWinner = unsupported[x] ? y : x;
    else if (unsupported[x] && unsupported[y]) adjustedWinner = null;
    if (adjustedWinner !== judgeWinner) {
      row.autoLossChanged.push({ promptId: g.promptId, flaggedArms: [x, y].filter((a) => unsupported[a]), judgeOnly: judgeWinner === undefined ? "inconsistent" : judgeWinner ?? "tie", adjusted: adjustedWinner ?? "tie" });
    }
    if (adjustedWinner === undefined) row.adjusted.inconsistent++;
    else if (adjustedWinner) row.adjusted.preferred[adjustedWinner]++;
    else row.adjusted.ties++;
  }

  const aShare = decided ? aVerdicts / decided : null;
  const aInterval = wilsonInterval(aVerdicts, decided);
  const positionBiased = decided > 0 && (aInterval[0] > 0.5 || aInterval[1] < 0.5);
  const consistencyRate = prefNonSelf ? prefNonSelfConsistent / prefNonSelf : null;
  const reliable = consistencyRate === null ? (decided > 0 ? !positionBiased : null) : consistencyRate >= MIN_CONSISTENCY && !positionBiased;
  const unreliableWhy = [];
  if (consistencyRate !== null && consistencyRate < MIN_CONSISTENCY) unreliableWhy.push(`order-swap consistency ${(Math.floor(consistencyRate * 10000) / 100).toFixed(2)}% is below the ${MIN_CONSISTENCY * 100}% gate`);
  if (positionBiased) unreliableWhy.push(`position bias: ${(aShare * 100).toFixed(1)}% of verdicts are "A" (95% interval ${(aInterval[0] * 100).toFixed(1)}-${(aInterval[1] * 100).toFixed(1)}% excludes 50%)`);

  const finishPref = (row) => {
    const [x, y] = row.arms;
    const out = {
      kind: "pref", variant: row.variant, set: row.set, arms: row.arms, self: row.self, n: row.n, incomplete: row.incomplete,
      clusters: clusterSize ? Math.ceil(row.n / clusterSize) : null,
      judgeOnly: tallyStats(row.judgeOnly, row.n, row.arms),
      adjusted: row.self ? null : tallyStats(row.adjusted, row.n, row.arms),
      numberFlags: row.self ? null : row.flagged,
      autoLoss: row.self ? null : { advisory: !strictNumbers, pairsChanged: row.autoLossChanged.length, changes: row.autoLossChanged },
      candidate: null, selfCheck: null,
    };
    out.preferred = out.judgeOnly.preferred; out.ties = row.judgeOnly.ties; out.inconsistent = row.judgeOnly.inconsistent;
    out.preferenceRate = out.judgeOnly.preferenceRate; out.lowerBound95 = out.judgeOnly.lowerBound95;
    if (row.self) {
      const decidedJudgements = row.votes[x] + row.votes[y];
      const ci = wilsonInterval(row.votes[x], decidedJudgements);
      const aTotal = row.aVotes + row.bVotes;
      out.selfCheck = {
        decidedJudgements, noneVerdicts: row.noneVotes,
        firstCopyShare: decidedJudgements ? row.votes[x] / decidedJudgements : null, interval95: ci,
        // No decided judgement at all (everything NONE) is the ideal result for identical answers.
        containsFifty: decidedJudgements === 0 || (ci[0] <= 0.5 && ci[1] >= 0.5),
        aShare: aTotal ? row.aVotes / aTotal : null, pairConsistency: row.n ? row.consistentPairs / row.n : null,
      };
    }
    if (candidate && !row.self && (x === candidate || y === candidate)) {
      const opp = x === candidate ? y : x;
      const j = row.judgeOnly.preferred[candidate], a = row.adjusted.preferred[candidate];
      const applies = row.variant === "full" && row.set === "core" && row.n === 30;
      let pass = null, why = null;
      if (applies) {
        if (!reliable) { pass = false; why = `judge unreliable: ${unreliableWhy.join("; ")}`; }
        else pass = j >= PASS_PREFERRED_OF_30 && (!strictNumbers || a >= PASS_PREFERRED_OF_30);
      }
      out.candidate = {
        name: candidate, opponent: opp, judgeOnlyPreferred: j, adjustedPreferred: a, required: PASS_PREFERRED_OF_30, strictNumbers: !!strictNumbers,
        judgeOnlyRate: row.n ? j / row.n : null, adjustedRate: row.n ? a / row.n : null,
        judgeOnlyLowerBound95: wilsonLower(j, row.n), adjustedLowerBound95: wilsonLower(a, row.n),
        judgeReliable: reliable, pass, passBlockedBy: why,
        verdict: pass === null ? "NO VERDICT (the pass criterion is for the full question on the 30 core prompts)" : pass ? "PASS" : why ? "NO PASS (unreliable judge)" : "FAIL",
      };
    }
    return out;
  };
  const finishRef = (row) => {
    const total = row.judgementTotal;
    const acc = total ? row.judgementCorrect / total : null;
    const interval = wilsonInterval(row.judgementCorrect, total);
    const inside = total > 0 && interval[0] >= CANNOT_TELL_BAND[0] && interval[1] <= CANNOT_TELL_BAND[1];
    const excludesHalf = total > 0 && (interval[0] > 0.5 || interval[1] < 0.5);
    const verdict = reliable === false ? "no verdict (unreliable judge)" : inside ? "cannot-tell" : excludesHalf ? (interval[0] > 0.5 ? "can-tell" : "can-tell-inverted") : "inconclusive";
    return {
      kind: "ref", variant: row.variant, set: row.set, arms: row.arms, reference: row.reference, n: row.n, incomplete: row.incomplete,
      clusters: clusterSize ? Math.ceil(row.n / clusterSize) : null,
      nJudgements: total, correct: row.judgementCorrect, accuracy: acc, interval95: interval, intervalInsideBand: inside,
      pairsNeededForCannotTell: pairsNeededForBand(...CANNOT_TELL_BAND), judgeReliable: reliable,
      consistentOnly: {
        n: row.nConsistent, correct: row.correct, accuracy: row.nConsistent ? row.correct / row.nConsistent : null,
        interval95: wilsonInterval(row.correct, row.nConsistent),
      },
      verdict,
    };
  };

  return {
    completePrefPairs: prefNonSelf, consistencyRate, aShare, aShareInterval95: aInterval, positionBiased,
    reliable, unreliableWhy,
    pairs: [...prefRows.values()].map(finishPref),
    reference: [...refRows.values()].map(finishRef),
  };
}

export function aggregate(mapping, verdicts, { candidate, allowUnfrozen = false, allowIncomplete = false, strictNumbers = false, clusterSize } = {}) {
  const warnings = checkMapping(mapping, { allowUnfrozen });
  const arms = new Set(Object.values(mapping.tasks).flatMap((e) => e.pair));
  if (candidate !== undefined && !arms.has(candidate)) throw new Error(`--candidate "${candidate}" is not an arm in this mapping (arms: ${[...arms].join(", ")})`);
  if (clusterSize !== undefined && (!Number.isInteger(clusterSize) || clusterSize < 1)) throw new Error("--cluster-size must be a positive integer");
  const byJudge = normaliseVerdicts(mapping, verdicts);
  const total = Object.keys(mapping.tasks).length;
  const groups = groupMapping(mapping);
  const judges = {};
  for (const [name, map] of byJudge) {
    if (map.size < total) {
      const msg = `judge "${name}" has ${map.size} of ${total} verdicts (${total - map.size} tasks unanswered)`;
      if (!allowIncomplete) throw new Error(`${msg}: refusing to score. Collect the rest, or pass --allow-incomplete.`);
      warnings.push(`INCOMPLETE: ${msg}.`);
    }
    judges[name] = judgeReport(groups, map, { candidate, strictNumbers, clusterSize });
  }
  const corePrompts = new Set(Object.values(mapping.tasks).filter((e) => e.set === "core").map((e) => e.promptId)).size;
  return {
    seed: mapping.seed, sets: mapping.sets, candidate: candidate ?? null, strictNumbers, minConsistency: MIN_CONSISTENCY,
    normalised: mapping.normalised === true, armStats: mapping.armStats ?? null, excluded: mapping.excluded ?? null,
    clusterSize: clusterSize ?? null, clusters: clusterSize ? Math.ceil(corePrompts / clusterSize) : null, corePrompts,
    frozen: warnings.every((w) => !w.startsWith("UNFROZEN")), warnings, judges,
  };
}

const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const ci = (a) => `${pct(a[0])} to ${pct(a[1])}`;

export function formatReport(rep) {
  const lines = [];
  for (const w of rep.warnings) lines.push(`WARNING ${w}`);
  lines.push(rep.candidate ? `Candidate: ${rep.candidate}${rep.strictNumbers ? " (--strict-numbers: the number check must also reach 24 of 30)" : ""}` : "No candidate named (--candidate NAME): counts are reported for both arms, no pass verdict.");
  if (rep.excluded && rep.excluded.length) lines.push(`Excluded for every arm (missing or mistyped answer, --tolerant): ${rep.excluded.length} prompt(s): ` + rep.excluded.map((e) => `${e.promptId} (${e.arms.join("+")})`).join(", "));
  if (rep.armStats) {
    lines.push(`Answer length in characters (${rep.normalised ? "after normalisation" : "as written"}): ` + Object.entries(rep.armStats).map(([a, s]) => `${a} mean ${s.meanCharsAfter} median ${s.medianCharsAfter}`).join("; "));
  }
  lines.push(rep.clusterSize
    ? `Independence: ${rep.corePrompts} core prompts in ${rep.clusters} clusters of about ${rep.clusterSize} (one writer per cluster); intervals treat every prompt as independent and are optimistic.`
    : "Independence: intervals treat every prompt as independent and are optimistic if arms were written in batches by separate agents; pass --cluster-size N to report the cluster count.");
  for (const [name, j] of Object.entries(rep.judges)) {
    lines.push(`Judge ${name}: order-swap consistency ${pct(j.consistencyRate)} over ${j.completePrefPairs} non-self preference pairs; A-share ${pct(j.aShare)} (95% ${ci(j.aShareInterval95)}) -> ${j.completePrefPairs === 0 && j.reliable !== false ? "insufficient data (no non-self preference pairs to test order-swap consistency)" : j.reliable === null ? "no data" : j.reliable ? "reliable" : `UNRELIABLE: ${j.unreliableWhy.join("; ")}`}`);
    for (const r of j.pairs) {
      const [x, y] = r.arms;
      const tag = `[${r.set}/${r.variant}]`;
      if (r.self) {
        const s = r.selfCheck;
        lines.push(`  ${tag} self-comparison ${x} vs ${y}: ${s.decidedJudgements} decided judgements (${s.noneVerdicts} NONE); ` + (s.decidedJudgements === 0
          ? "all NONE: no preference between identical answers"
          : `first-copy share ${pct(s.firstCopyShare)} (95% ${ci(s.interval95)}) -> ${s.containsFifty ? "interval contains 50%: no preference between identical answers" : "interval EXCLUDES 50%: the judge prefers one of two identical answers"}; A-share ${pct(s.aShare)}`));
        continue;
      }
      const jo = r.judgeOnly, ad = r.adjusted;
      lines.push(`  ${tag} ${x} vs ${y}: n=${r.n}${r.incomplete ? ` (+${r.incomplete} incomplete)` : ""}`);
      lines.push(`      judge only : ${x} ${jo.preferred[x]} (${pct(jo.preferenceRate[x])}, lower ${pct(jo.lowerBound95[x])})  ${y} ${jo.preferred[y]} (${pct(jo.preferenceRate[y])}, lower ${pct(jo.lowerBound95[y])})  ties ${jo.ties}  inconsistent ${jo.inconsistent}`);
      lines.push(`      + number check${r.autoLoss.advisory ? " (advisory)" : " (strict)"}: ${x} ${ad.preferred[x]}  ${y} ${ad.preferred[y]}  ties ${ad.ties}  inconsistent ${ad.inconsistent}; auto-loss changed ${r.autoLoss.pairsChanged} pair(s); number flags: ${x} ${r.numberFlags[x]} prompt(s), ${y} ${r.numberFlags[y]} prompt(s)`);
      for (const c of r.autoLoss.changes) lines.push(`        auto-loss on ${c.promptId} (flagged: ${c.flaggedArms.join(", ")}): judge ${c.judgeOnly} -> ${c.adjusted}`);
      if (r.candidate) {
        const c = r.candidate;
        lines.push(`      candidate ${c.name} vs ${c.opponent}: judge-only ${c.judgeOnlyPreferred}/${r.n}, adjusted ${c.adjustedPreferred}/${r.n} (need ${c.required} judge-only${c.strictNumbers ? " and adjusted" : ""}, judge reliable) -> ${c.verdict}${c.passBlockedBy ? ` (${c.passBlockedBy})` : ""}`);
      }
    }
    for (const r of j.reference) {
      lines.push(`  [${r.set}/${r.variant}] which-is-the-reference, ${r.reference} vs ${r.arms[1]}: ${r.nJudgements} judgements, accuracy ${pct(r.accuracy)} (95% ${ci(r.interval95)}; judgements of one prompt are not independent, so the interval is optimistic); consistent pairs only: ${r.consistentOnly.n}/${r.n}, ${pct(r.consistentOnly.accuracy)} -> ${r.verdict}`);
      if (r.verdict === "inconclusive") lines.push(`      a "cannot tell" verdict needs an interval inside 35-65%: about ${r.pairsNeededForCannotTell} judgements even at exactly 50% accuracy`);
    }
  }
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const o = { json: false, allowUnfrozen: false, allowIncomplete: false, strictNumbers: false };
  for (let i = 0; i < argv.length; i++) {
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
      return argv[++i];
    };
    if (argv[i] === "--mapping") o.mapping = v();
    else if (argv[i] === "--verdicts") o.verdicts = v();
    else if (argv[i] === "--candidate") o.candidate = v();
    else if (argv[i] === "--cluster-size") o.clusterSize = Number(v());
    else if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--strict-numbers") o.strictNumbers = true;
    else if (argv[i] === "--allow-unfrozen") o.allowUnfrozen = true;
    else if (argv[i] === "--allow-incomplete") o.allowIncomplete = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!o.mapping || !o.verdicts) throw new Error("usage: aggregate.mjs --mapping mapping.json --verdicts verdicts.jsonl [--candidate NAME] [--json] [--strict-numbers] [--cluster-size N] [--allow-unfrozen] [--allow-incomplete]");
  const rep = aggregate(JSON.parse(readFileSync(o.mapping, "utf8").replace(/^﻿/, "")), readJsonl(o.verdicts), o);
  console.log(o.json ? JSON.stringify(rep, null, 1) : formatReport(rep));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`aggregate: ${e.message}`);
    process.exit(1);
  }
}
