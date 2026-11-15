#!/usr/bin/env node
// Per-stage CPU profile of the /ask retrieval and ranking path, against the Cloudflare free plan's 10 ms CPU per request.
// Zero dependencies: it loads the real worker modules (rank-core, self-rag, answer-lint, privacy/outbound-guard) and the real
// data/library, then runs the 200 fictional questions of tests/fixtures/ask-cpu/questions.json (the 80 of the golden set plus
// 120 generated from the library's own titles and fact keys) through each stage and reports median, p95, max and cold start.
//
//   node tools/bench-ask-cpu.mjs [--rounds N] [--json]
//
// Node/V8 timing is a PROXY for Workers: same engine family, but not the same JIT tiering, isolate reuse or CPU accounting.
// Use it to compare before and after on one machine, never as a promise about the 10 ms limit. Times are CPU time of the
// calling thread (process.cpuUsage), in milliseconds, per question; "cold" is the first run of a stage in a fresh process.
// Stages: parse (library JSON -> pages + idf corpus, once per isolate), clean, rank, relevant, context, guard, support, lint.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const ROUNDS = Math.max(1, Number(args[args.indexOf("--rounds") + 1]) || 5);
const JSON_OUT = args.includes("--json");

const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const imp = async (rel) => import(path.join(root, rel));

export async function loadLibrary() {
  const lib = path.join(root, "data", "library");
  const index = JSON.parse(fs.readFileSync(path.join(lib, "index.json"), "utf8"));
  const byId = {};
  for (const c of index.categories) for (const p of JSON.parse(fs.readFileSync(path.join(lib, `${c.key}.json`), "utf8")).pages) byId[p.id] = p;
  return index.pages.map((h) => byId[h.id]).filter(Boolean);
}
export const loadQuestions = () => JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "ask-cpu", "questions.json"), "utf8")).questions;

// Fictional roster (A to E): no real member name anywhere.
export const ROSTER = { members: ["A", "B", "C", "D", "E"].map((x, i) => ({ display: `Member ${x}`, aliases: [`Tester${x}`], firstNames: [`Person${x}`], characterNames: [`Hero${x}`], discordIds: [`1000000000000000${i}${i}`] })) };

// A stand-in answer for the lint and support stages, built from the retrieved facts the way a model would phrase them.
const answerFor = (rel, q) => {
  const top = rel.hits.slice(0, 3);
  if (!top.length) return "The Library does not cover that yet, so I won't guess.\n-#  Sources: none";
  return `**${top[0].value.slice(0, 120)}.** ${top.slice(1).map((h) => h.value.slice(0, 140)).join(" ")} That is what the Library shows for "${q.slice(0, 60)}".\n-#  Sources: ${[...new Set(top.map((h) => h.page))].join(", ")}`;
};

export async function run() {
  const t0 = cpuMs();
  const core = await imp("infrastructure/worker/rank-core.js");
  const rag = await imp("infrastructure/worker/self-rag.js");
  const lint = await imp("infrastructure/worker/answer-lint.js");
  const guard = await imp("infrastructure/worker/privacy/outbound-guard.js");
  const importMs = cpuMs() - t0;
  const questions = loadQuestions();

  const stages = {};
  const rec = (name, ms, cold) => { const s = (stages[name] ||= { cold, samples: [] }); s.samples.push(ms); };
  const time = (name, fn, cold = false) => { const a = cpuMs(); const v = fn(); rec(name, cpuMs() - a, cold); return v; };

  // parse: once per isolate in production (15 min cache), so reported as cold only.
  const tp = cpuMs();
  const pages = await loadLibrary();
  const hays = core.factHays(pages);
  const parseMs = cpuMs() - tp;

  const results = [];
  for (let round = 0; round < ROUNDS; round++) {
    questions.forEach((q, qi) => {
      const first = round === 0 && qi === 0;
      const cleaned = time("clean", () => rag.cleanQuestion(q, ["Member A"]), first);
      const r = time("rank", () => core.rank(cleaned, pages, { hays }), first);
      const rel = time("relevant", () => rag.selectRelevant(r.hits, r.words, hays), first);
      const ctx = time("context", () => {
        const hits = rel.hits;
        const shownFacts = hits.slice(0, 20).map((h) => h.value).join(" ");
        const ids = new Set(hits.slice(0, 20).map((h) => h.page));
        const grounding = rag.groundingWithIds([shownFacts, q].join(" "), ids, rel.abstain);
        const topFactHits = hits.slice(0, 8).map((h) => `- [${h.page}] ${h.key}: ${h.value}`);
        return { grounding, prompt: `Top Library Facts and Pages:\n${topFactHits.join("\n")}\n\nQuestion:\n${q}`, ids };
      }, first);
      time("guard", () => guard.scanUserText([q], ROSTER), first);
      guard.scanBody({ messages: [{ role: "user", content: ctx.prompt }] }, ROSTER); // warm, untimed
      const answer = answerFor(rel, q);
      time("support", () => rag.supportCheck(answer, ctx.grounding), first);
      time("lint", () => lint.lintAnswer(answer, { asker: { isMember: true } }), first);
      if (round === 0) results.push({ q, words: r.words, ranked: r.hits.map((h) => `${h.page}~${h.key}~${h.score}`), kept: rel.hits.map((h) => `${h.page}~${h.key}`), abstain: rel.abstain });
    });
  }
  stages.parse = { cold: true, samples: [parseMs] };
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
  const table = {};
  for (const [name, s] of Object.entries(stages)) {
    const warm = s.cold && name !== "parse" ? s.samples.slice(1) : s.samples;
    table[name] = { cold_ms: name === "parse" ? s.samples[0] : s.samples[0], median_ms: q(warm, 0.5), p95_ms: q(warm, 0.95), max_ms: Math.max(...warm), n: warm.length };
  }
  const total = questions.map((_, i) => ["clean", "rank", "relevant", "context", "guard", "support", "lint"].reduce((n, k) => n + stages[k].samples[stages[k].samples.length - questions.length + i], 0));
  table["TOTAL(per question)"] = { cold_ms: importMs + parseMs, median_ms: q(total, 0.5), p95_ms: q(total, 0.95), max_ms: Math.max(...total), n: total.length };
  return { table, results, importMs, pages: pages.length, facts: hays.length, questions: questions.length, rounds: ROUNDS };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await run();
  if (JSON_OUT) console.log(JSON.stringify({ ...out, results: undefined }, null, 1));
  else {
    console.log(`ask-cpu bench: ${out.questions} questions x ${out.rounds} rounds, ${out.pages} pages, ${out.facts} facts; module import ${out.importMs.toFixed(1)} ms (cold, not per request)`);
    console.log("stage".padEnd(22), "cold".padStart(9), "median".padStart(9), "p95".padStart(9), "max".padStart(9), "  (ms of thread CPU; Node proxy, not Workers)");
    for (const [k, v] of Object.entries(out.table)) console.log(k.padEnd(22), ...[v.cold_ms, v.median_ms, v.p95_ms, v.max_ms].map((x) => x.toFixed(3).padStart(9)));
  }
}
