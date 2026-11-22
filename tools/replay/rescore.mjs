// Re-scores a replay results file with the NORMALISED scorer (score-normalised.mjs) next to the STRICT one (score.mjs, unchanged), and lists every difference. Read-only: nothing is written, nothing is sent.
//   node tools/replay/rescore.mjs <results.jsonl> --truth <truth.jsonl> [--tables <dir>] [--traits <traits.json>] [--library <dir>] [--max-misses 400]
// <results.jsonl>: a run.mjs results file made with --keep-answers (rows hold the answer text). --truth: the truth set the run was made from (records: id, kind, question, expected, entity_name, allowed_numbers).
// --tables / --traits: the client CSV export folder (with MANIFEST.json) and the traits file the truth set was built from; read only, outside the repo. With them the facts rows are rebuilt with the loader's own derivation
//   (tools/facts-load.mjs deriveTableRows, deriveTraitRows), so a cited id such as spelllevels:98572 maps to its claim and value, and "another rank / another entity" can be told. Without --tables only the ids are exempted.
// --library: the library facts folder (default: data/library of this checkout; public data).
// Output: per-kind strict and normalised exact rates, unsupported (strict and the one-meaning definition), both pass-bar verdicts, every FLIP (not exact -> exact, with the matched text), every anomaly (exact -> not exact),
//   and every normalised miss with an automatic CLASS. Nothing here changes a verdict of record: the strict report stays the number the pass bar is judged on until a human reads the flips.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, parseArgs, die, REPO_ROOT } from "./common.mjs";
import { scoreTruthItem, summarize } from "./score.mjs";
import { evaluateBar, PASS_BAR, INFORMATIONAL_KINDS, INFORMATIONAL_LABEL } from "./pass-bar.mjs";
import { scoreNormalised, normalisedSummary, buildRowIndex, loadLibrary, rowIdsIn } from "./score-normalised.mjs";

// -> rows (facts-load's own derivation). The tables are verified against MANIFEST.json by loadVerifiedTable inside deriveTableRows.
export async function loadFactRows(tablesDir, traitsFile = null) {
  // facts-load.mjs imports the Worker modules, which import each other in a cycle: loaded first on its own it fails ("FACT_KINDS before initialization"). Entering the cycle at game-facts-lookup.js first is the order that initialises.
  await import("../../infrastructure/worker/game-facts-lookup.js");
  const { deriveTableRows, deriveTraitRows } = await import("../facts-load.mjs");
  const manifest = JSON.parse(readFileSync(path.join(tablesDir, "MANIFEST.json"), "utf8"));
  const rows = [...deriveTableRows(tablesDir, manifest).rows];
  if (traitsFile) {
    const parsed = JSON.parse(readFileSync(traitsFile, "utf8"));
    rows.push(...deriveTraitRows(parsed, manifest.build).rows);
  }
  return rows;
}

const flat = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const exp = (r) => `${r.expected && r.expected.value}${r.expected && r.expected.unit ? " " + r.expected.unit : ""}`;
const context = (text, start, end, n = 40) => {
  const a = Math.max(0, start - n), b = Math.min(text.length, end + n);
  return `${a > 0 ? "..." : ""}${flat(text.slice(a, start), 999)} [[${flat(text.slice(start, end), 999)}]] ${flat(text.slice(end, b), 999)}${b < text.length ? "..." : ""}`;
};

// results: rows of the results file (header/sent/aborted lines already removed); truth: records by id. ctx: {index, library}.
export function rescore(results, truth, ctx = {}) {
  const byId = new Map(truth.map((t) => [t.id, t]));
  const strictRows = [];
  const norm = new Map();
  const detail = [];
  const notes = { scored_rows: 0, no_truth_record: 0, no_answer: 0, strict_drift: 0 };
  for (const r of results) {
    if (!r.scored) continue;
    notes.scored_rows++;
    const rec = byId.get(r.id);
    if (!rec || !rec.expected) { notes.no_truth_record++; continue; }
    const answer = typeof r.answer === "string" ? r.answer : null;
    if (answer === null) notes.no_answer++;
    const raw = { reason: r.reason, model: r.model, status: r.status };
    const strict = scoreTruthItem(rec, raw, answer);
    if (r.scores && typeof r.scores.exact === "boolean" && r.scores.exact !== strict.exact) notes.strict_drift++;
    const n = scoreNormalised(rec, { ...raw, degraded: strict.degraded }, answer, ctx);
    strictRows.push({ ...r, scores: strict });
    norm.set(r.id, n);
    detail.push({ id: r.id, kind: r.kind, rec, answer, strict, n });
  }
  const strictSummary = summarize(strictRows);
  const normSummary = normalisedSummary(strictRows, norm);
  const kinds = [...new Set(detail.map((d) => d.kind))].sort();
  const per_kind = {};
  for (const k of kinds) {
    const ds = detail.filter((d) => d.kind === k);
    const cls = {};
    for (const d of ds) if (!d.n.exact) cls[d.n.class || "no-figure"] = (cls[d.n.class || "no-figure"] || 0) + 1;
    per_kind[k] = {
      n: ds.length,
      strict_exact: ds.filter((d) => d.strict.exact).length,
      norm_exact: ds.filter((d) => d.n.exact).length,
      strict_unsup_answers: ds.filter((d) => d.strict.unsupported_count > 0).length,
      strict_unsup_figures: ds.reduce((a, d) => a + d.strict.unsupported_count, 0),
      norm_unsup_answers: ds.filter((d) => d.n.unsupported_count > 0).length,
      norm_unsup_figures: ds.reduce((a, d) => a + d.n.unsupported_count, 0),
      classes: cls,
    };
  }
  return {
    notes, per_kind, kinds,
    strict: { summary: strictSummary, bar: evaluateBar(strictSummary) },
    normalised: { summary: normSummary, bar: evaluateBar(normSummary) },
    flips: detail.filter((d) => !d.strict.exact && d.n.exact),
    anomalies: detail.filter((d) => d.strict.exact && !d.n.exact),
    misses: detail.filter((d) => !d.n.exact),
    examples: detail.flatMap((d) => d.n.unsupported.map((u) => ({ id: d.id, kind: d.kind, ...u }))).slice(0, 3),
  };
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1).padStart(5) + "%" : "  n/a");
export function formatReport(rep, { maxMisses = 400 } = {}) {
  const L = [];
  const n = rep.notes;
  L.push(`rows: ${n.scored_rows} scored; ${n.no_truth_record} without a truth record (skipped); ${n.no_answer} without answer text (counted not exact); strict scores that differ from the ones stored in the results file: ${n.strict_drift}`);
  L.push("");
  L.push(`${"kind".padEnd(22)} ${"n".padStart(4)} | ${"strict exact".padStart(14)} ${"norm exact".padStart(14)} | ${"strict unsup ans".padStart(18)} ${"norm unsup ans".padStart(18)} | ${"unsup figures s/n".padStart(18)}`);
  const line = (label, p) => `${label.padEnd(22)} ${String(p.n).padStart(4)} | ${(String(p.strict_exact) + " " + pct(p.strict_exact, p.n)).padStart(14)} ${(String(p.norm_exact) + " " + pct(p.norm_exact, p.n)).padStart(14)} | ${(String(p.strict_unsup_answers) + " " + pct(p.strict_unsup_answers, p.n)).padStart(18)} ${(String(p.norm_unsup_answers) + " " + pct(p.norm_unsup_answers, p.n)).padStart(18)} | ${(p.strict_unsup_figures + " / " + p.norm_unsup_figures).padStart(18)}`;
  const all = { n: 0, strict_exact: 0, norm_exact: 0, strict_unsup_answers: 0, strict_unsup_figures: 0, norm_unsup_answers: 0, norm_unsup_figures: 0 };
  for (const k of rep.kinds) {
    const p = rep.per_kind[k];
    L.push(line(INFORMATIONAL_KINDS.includes(k) ? `${k} *` : k, p));
    for (const f of Object.keys(all)) all[f] += p[f];
  }
  L.push(line("ALL", all));
  if (rep.kinds.some((k) => INFORMATIONAL_KINDS.includes(k))) L.push(`* ${INFORMATIONAL_LABEL}`);
  L.push("");
  L.push("normalised misses by class (human classification of spell_level and spell_cooldown misses comes from the list below):");
  for (const k of rep.kinds) L.push(`  ${k}: ${Object.entries(rep.per_kind[k].classes).sort().map(([c, v]) => `${c} ${v}`).join(", ") || "none"}`);
  L.push("");
  for (const [label, r] of [["STRICT (scorer of record, unchanged)", rep.strict], ["NORMALISED (bar numbers unchanged: exact >= " + PASS_BAR.exact_rate_min + ", unsupported <= " + PASS_BAR.unsupported_rate_max + ", degraded <= " + PASS_BAR.degraded_rate_max + ", budget >= " + PASS_BAR.within_budget_rate_min + ")", rep.normalised]]) {
    L.push(`pass bar ${label}: ${r.bar.pass ? "PASS" : "FAIL"}`);
    for (const f of r.bar.failures) L.push(`  - ${f}`);
  }
  L.push("");
  L.push(`FLIPS not exact (strict) -> exact (normalised): ${rep.flips.length}`);
  for (const d of rep.flips) L.push(`  ${d.id} | ${d.kind} | expected ${exp(d.rec)} | ${d.n.matched ? context(d.answer, d.n.matched.start, d.n.matched.end) : "(no match text)"}`);
  L.push("");
  L.push(`ANOMALIES exact (strict) -> not exact (normalised): ${rep.anomalies.length}`);
  for (const d of rep.anomalies) L.push(`  ${d.id} | ${d.kind} | expected ${exp(d.rec)} | why ${d.n.why || "-"} | class ${d.n.class}`);
  L.push("");
  L.push(`UNSUPPORTED (one meaning: a figure no cited row, no allowed number and no library fact for the entity holds): examples`);
  if (!rep.examples.length) L.push("  none");
  for (const e of rep.examples) L.push(`  ${e.id} | ${e.kind} | figure ${e.raw}${e.unit ? " (" + e.unit + ")" : ""} | ${flat(e.context, 60)}`);
  L.push("");
  L.push(`MISSES under normalised: ${rep.misses.length}${rep.misses.length > maxMisses ? ` (first ${maxMisses} shown)` : ""}`);
  for (const d of rep.misses.slice(0, maxMisses)) {
    L.push(`  ${d.id} | ${d.kind} | ${d.rec.entity_name || "-"} | expected ${exp(d.rec)} | cited ${rowIdsIn(d.answer || "").join(",") || "-"} | ${d.n.class}${d.n.why ? " (" + d.n.why + ")" : ""} | ${flat(d.answer, 120)}`);
  }
  return L.join("\n");
}

async function main() {
  const a = parseArgs(process.argv.slice(2), { truth: "value", tables: "value", traits: "value", library: "value", "max-misses": "value" });
  if (a._.length !== 1 || !a.truth) die("usage: node tools/replay/rescore.mjs <results.jsonl> --truth <truth.jsonl> [--tables <dir>] [--traits <traits.json>] [--library <dir>] [--max-misses N]");
  if (a.traits && !a.tables) die("--traits needs --tables");
  try {
    const results = readJsonl(a._[0]).filter((r) => !r.type);
    const truth = readJsonl(a.truth).filter((r) => r && r.type !== "header" && typeof r.id === "string");
    if (!results.some((r) => typeof r.answer === "string")) die("the results file holds no answer text: the run needs --keep-answers");
    const ctx = {};
    if (a.tables) {
      if (!existsSync(path.join(a.tables, "MANIFEST.json"))) die("--tables: no MANIFEST.json there");
      ctx.index = buildRowIndex(await loadFactRows(a.tables, a.traits || null));
    }
    const libDir = a.library || path.join(REPO_ROOT, "data", "library");
    ctx.library = loadLibrary(libDir);
    console.log(`facts rows: ${ctx.index ? ctx.index.byId.size : "not loaded (no --tables): only bracketed ids are exempted, no cited-row support"}; library pages: ${ctx.library.pages}`);
    console.log(formatReport(rescore(results, truth, ctx), { maxMisses: a["max-misses"] ? Number(a["max-misses"]) : 400 }));
  } catch (e) { die(e.message); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
