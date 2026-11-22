// Blind grading packets for the Leeroy-versus-Worker comparison, and the step that unblinds the grades. docs/runbooks/replay-harness.md "Blind grading".
//   node tools/replay/grade-pack.mjs build --corpus <pairs.jsonl> --results <results.jsonl> --grader claude|external --out <packet.jsonl> [--seed N]
//   node tools/replay/grade-pack.mjs merge --key <packet.key.jsonl> --grades <grades.jsonl> [--out merged.jsonl]
// build: joins the corpus ({id, question, local_answer, fictional?}) with a results file run with --keep-answers (the Worker's answer text). Per item it randomises which answer is "A" and which "B", drops every label,
//   and writes {packet_id, question, A, B}. The A/B-to-source key goes to a SEPARATE file (<out>.key.jsonl) that never goes to a grader. Nothing is sent anywhere: the packets are files.
//   A corpus is PRIVATE unless every record says "fictional": true. A private corpus is refused unless --grader claude (the paid Claude API may see group data) and the packet header is marked private (do not commit,
//   do not send to Codex or Gemini). --grader external (Codex, Gemini) is allowed only when every record is flagged fictional: true.
//   The grader must be a different model family than the answer writer (the Worker's answers are Claude-written: header.writer_families); the header records it, and same_family_warning is set when the grader is Claude.
// merge: reads the grades ({packet_id, A:{tone,helpfulness,groundedness}, B:{...}}, integers 1..5), unblinds with the key, writes per-item {id, local, worker} and prints the aggregate and the decision-rule verdict only.
// All output paths inside this repo checkout are refused.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { assertOutsideRepo, writeOut, readJsonl, parseArgs, die, rng, shuffle, sha256 } from "./common.mjs";
import { RUBRIC_DIMENSIONS, RUBRIC_MIN, RUBRIC_MAX, PAIR_RULE, evaluatePairRule } from "./pass-bar.mjs";

export const RUBRIC_TEXT = `Score each answer 1-5 on each dimension. 1 = bad, 3 = acceptable, 5 = excellent. Score A and B independently; you do not know who wrote either.
tone: sounds like a friendly, in-voice game-group regular; not stiff, not rude, not padded.
helpfulness: answers what was asked, directly, with what the asker needs next; no dodging, no dumping.
groundedness: every game fact is correct or hedged; nothing invented; no numbers stated that the question or common knowledge do not support. An invented number caps this at 2.`;

// corpus: the pair-corpus records; corpusSha256: the hash of the corpus FILE; results: the lines of a run.mjs results file (header, markers and result rows).
// The join is bound: the results header must carry the corpus file's hash, and every joined row's question_sha256 must equal the hash of the corpus question. Ids that match with different text refuse the build.
// private is false only when EVERY corpus record and EVERY results row is flagged fictional: true.
export function buildPackets({ corpus, corpusSha256, results, grader, seed }) {
  if (!["claude", "external"].includes(grader)) throw new Error("--grader must be claude or external");
  const records = corpus.filter((r) => r && r.id && typeof r.question === "string");
  const ids = records.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("the corpus holds a duplicate id");
  const resHeader = results.find((r) => r && r.type === "header");
  const rows = results.filter((r) => r && r.id && !r.type);
  if (!resHeader || typeof resHeader.input_sha256 !== "string" || !corpusSha256 || resHeader.input_sha256 !== corpusSha256) throw new Error("refusing: the results were not produced from this corpus file (input hash differs or is missing)");
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error("the results hold a duplicate id");
  const allFictional = records.length > 0 && records.every((r) => r.fictional === true) && rows.length > 0 && rows.every((r) => r.fictional === true);
  const priv = !allFictional;
  if (priv && grader !== "claude") throw new Error("refusing: this input is private (every corpus record and every results row must be flagged fictional: true); only --grader claude may see it");
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mismatched = records.filter((rec) => { const r = byId.get(rec.id); return r && r.question_sha256 !== sha256(rec.question.trim()); }).length;
  if (mismatched) throw new Error(`refusing: ${mismatched} result row(s) match a corpus id but not its question text (hash differs): the results are from a different corpus`);
  const rand = seed === undefined ? (() => randomBytes(4).readUInt32BE(0) / 4294967296) : rng(Number(seed));
  const packets = [], key = [];
  let skipped = 0;
  const families = new Set();
  for (const rec of records) {
    const res = byId.get(rec.id);
    const worker = res && typeof res.answer === "string" ? res.answer : null;
    const local = typeof rec.local_answer === "string" && rec.local_answer.trim() ? rec.local_answer : null;
    if (worker === null || local === null) { skipped++; continue; }
    if (typeof res.model === "string") families.add(res.model.split(":")[0] || "unknown");
    const workerIsA = rand() < 0.5;
    const packetId = "p" + Array.from({ length: 12 }, () => Math.floor(rand() * 16).toString(16)).join("");
    packets.push({ packet_id: packetId, question: rec.question, A: workerIsA ? worker : local, B: workerIsA ? local : worker });
    key.push({ packet_id: packetId, id: rec.id, A: workerIsA ? "worker" : "local", B: workerIsA ? "local" : "worker" });
  }
  const shuffled = shuffle(packets.map((p, i) => i), rand);
  const header = {
    type: "header", private: priv, grader, rubric: { dimensions: RUBRIC_DIMENSIONS, min: RUBRIC_MIN, max: RUBRIC_MAX, text: RUBRIC_TEXT },
    writer_families: [...families].sort(), same_family_warning: grader === "claude" && families.has("claude"), n: packets.length,
    note: priv ? "PRIVATE: holds group text. Do not commit, do not send to any grader but Claude." : "fictional items only",
  };
  const packetText = [JSON.stringify(header), ...shuffled.map((i) => JSON.stringify(packets[i]))].join("\n") + "\n";
  const keyText = key.map((k) => JSON.stringify(k)).join("\n") + (key.length ? "\n" : "");
  return { header, packetText, keyText, skipped, n: packets.length };
}

const validGrade = (g) => g && typeof g === "object" && RUBRIC_DIMENSIONS.every((d) => Number.isInteger(g[d]) && g[d] >= RUBRIC_MIN && g[d] <= RUBRIC_MAX);

export function mergeGrades({ key, grades }) {
  const keyById = new Map(key.map((k) => [k.packet_id, k]));
  const merged = [];
  let invalid = 0, unknown = 0;
  const seen = new Set();
  for (const g of grades) {
    if (!g || g.type === "header") continue;
    const k = keyById.get(g.packet_id);
    if (!k) { unknown++; continue; }
    if (seen.has(g.packet_id) || !validGrade(g.A) || !validGrade(g.B)) { invalid++; continue; }
    seen.add(g.packet_id);
    const pick = (label) => (k[label] === "worker" ? "worker" : "local");
    const item = { id: k.id, local: null, worker: null };
    item[pick("A")] = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, g.A[d]]));
    item[pick("B")] = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, g.B[d]]));
    merged.push(item);
  }
  return { merged, invalid, unknown, missing: key.length - seen.size, verdict: evaluatePairRule(merged) };
}

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "build") {
    const a = parseArgs(rest, { corpus: "value", results: "value", grader: "value", out: "value", seed: "value" });
    if (!a.corpus || !a.results || !a.grader || !a.out) die("usage: node tools/replay/grade-pack.mjs build --corpus <pairs.jsonl> --results <results.jsonl> --grader claude|external --out <packet.jsonl> [--seed N]");
    const keyPath = a.out + ".key.jsonl";
    try { assertOutsideRepo(a.out); assertOutsideRepo(keyPath); } catch (e) { die(e.message); }
    let r;
    try { r = buildPackets({ corpus: readJsonl(a.corpus), corpusSha256: sha256(readFileSync(a.corpus)), results: readJsonl(a.results), grader: a.grader, seed: a.seed }); } catch (e) { die(e.message); }
    if (!r.n) die("no item has both a local answer and a kept Worker answer (run the replay with --keep-answers)", 1);
    writeOut(a.out, r.packetText); writeOut(keyPath, r.keyText);
    console.log(`packets: ${r.n} (skipped ${r.skipped}); private: ${r.header.private}; grader: ${a.grader}${r.header.same_family_warning ? "; WARNING: grader family equals the writer family (see runbook)" : ""}`);
    console.log(`packet file (send to the grader): ${path.resolve(a.out)}\nkey file (never send): ${path.resolve(keyPath)}`);
  } else if (cmd === "merge") {
    const a = parseArgs(rest, { key: "value", grades: "value", out: "value" });
    if (!a.key || !a.grades) die("usage: node tools/replay/grade-pack.mjs merge --key <packet.key.jsonl> --grades <grades.jsonl> [--out merged.jsonl]");
    if (a.out) try { assertOutsideRepo(a.out); } catch (e) { die(e.message); }
    const r = mergeGrades({ key: readJsonl(a.key), grades: readJsonl(a.grades) });
    if (a.out) writeOut(a.out, r.merged.map((m) => JSON.stringify(m)).join("\n") + (r.merged.length ? "\n" : ""));
    console.log(`graded ${r.merged.length}; invalid ${r.invalid}; unknown ${r.unknown}; missing ${r.missing}`);
    if (r.verdict.means) for (const d of RUBRIC_DIMENSIONS) console.log(`${d.padEnd(13)} local ${fmt(r.verdict.means[d].local)}  worker ${fmt(r.verdict.means[d].worker)}`);
    console.log(`decision rule (n >= ${PAIR_RULE.min_graded}): ${r.verdict.pass ? "PASS" : "FAIL"}`);
    for (const f of r.verdict.failures) console.log(`  - ${f}`);
  } else die("usage: node tools/replay/grade-pack.mjs build|merge ...");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
