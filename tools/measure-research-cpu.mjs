// Measures the offline CPU of the /ask research path: name-map clone + tokenise, strict and cheap outbound guards, reply clean, label/lint.
// Inputs:  --iterations N (default 100) --budget-ms M (default 10, or env RESEARCH_CPU_BUDGET_MS) --prompt-chars C (prompt size, default 9000) --json
// Output:  median / p95 / max per stage and for the whole path, plus the first (cold) call, compared with the budget. Exit 1 when the median or p95 is over budget (a value equal to the budget passes).
// Safety:  reads nothing but the repo, sends nothing, prints only numbers (no question text, no names, no prompt text). No key is read or needed.
//
// PROXY WARNING: this is Node CPU on this PC (process.cpuUsage, plus performance.now wall time). It is only a PROXY for Worker CPU. Different engine build, different
// clock rules (workerd freezes timers during compute), different hardware. The authoritative number is the CPU time shown by Workers observability for a preview
// deploy (see docs/runbooks/research-latency.md). A pass here does not satisfy the flag-on condition; a fail here is a real warning.
import { fileURLToPath } from "node:url";
import { researchParty, prepareResearchPrivacy } from "../infrastructure/worker/research/claude.js";
import { guardUserText, guardBody } from "../infrastructure/worker/privacy/outbound-guard.js";
import { researchPrepare } from "../infrastructure/worker/research/label.js";
import { questionFor, sheetsFor, systemPromptFor, userPromptFor, SAMPLE_REPLY, FICTIONAL_ASKER, summarise } from "./research-synthetic.mjs";

export const DEFAULT_BUDGET_MS = 10;
export const PROXY_NOTICE =
  "PROXY ONLY: this is Node CPU on this machine, not Worker CPU. The authoritative number is the Workers observability CPU time of a preview deploy (docs/runbooks/research-latency.md).";

const cpuMs = (a) => (a.user + a.system) / 1000;
const STAGES = ["prompt build", "tokenise", "guards", "clean+label"];

// One ask, stage by stage. Returns { stage: {cpu, wall}, total: {cpu, wall} } in ms.
// Prompt build is timed as its own stage (the Worker does it per ask too).
export function runOnce(i, { promptChars = 9000 } = {}) {
  const out = {};
  const stage = (name, fn) => {
    const c0 = process.cpuUsage();
    const w0 = performance.now();
    const v = fn();
    out[name] = { cpu: cpuMs(process.cpuUsage(c0)), wall: performance.now() - w0 };
    return v;
  };
  const question = questionFor(i, { withRosterName: i % 3 === 0 });
  const previousQuestion = i % 2 === 0 ? questionFor(i + 1) : "";
  const sheets = sheetsFor();
  const prompts = stage("prompt build", () => ({
    systemPrompt: systemPromptFor(Math.floor(promptChars / 3)),
    userPrompt: userPromptFor({ question, previousQuestion, sheets, chars: Math.floor((promptChars * 2) / 3) }),
  }));

  const priv = stage("tokenise", () => {
    const party = researchParty(sheets, { signups: { roster: { [FICTIONAL_ASKER]: "yes" } }, tonight: { title: "dungeon night" } });
    return prepareResearchPrivacy({ ...prompts, question, previousQuestion, by: FICTIONAL_ASKER, party });
  });
  if (!priv.ok) throw new Error(`prepareResearchPrivacy failed: ${priv.reason}`);
  stage("guards", () => {
    guardUserText(priv.userSegments, priv.roster);
    for (const seg of priv.partySegments) guardUserText([seg], priv.roster);
    guardBody({ model: "m", max_tokens: 700, system: [{ type: "text", text: priv.system }], messages: [{ role: "user", content: priv.user }] }, priv.roster);
  });
  stage("clean+label", () => {
    const text = priv.clean(SAMPLE_REPLY);
    if (text === null) throw new Error("sample reply was flagged by clean()");
    return researchPrepare(text, { groundingText: priv.user, retrievedIds: null });
  });
  out.total = { cpu: STAGES.reduce((a, s) => a + out[s].cpu, 0), wall: STAGES.reduce((a, s) => a + out[s].wall, 0) };
  return out;
}

export function measure({ iterations = 100, budgetMs = DEFAULT_BUDGET_MS, promptChars = 9000 } = {}) {
  const cold = runOnce(0, { promptChars }); // first call in a fresh process: name-map compile, regex build (an isolate cold start looks like this)
  for (let i = 0; i < 3; i++) runOnce(i + 1, { promptChars });
  const rows = [];
  const c0 = process.cpuUsage();
  for (let i = 0; i < iterations; i++) rows.push(runOnce(i, { promptChars }));
  const cpuMean = cpuMs(process.cpuUsage(c0)) / iterations; // whole-loop CPU / iterations: exact even when per-call CPU is quantised
  const zero = rows.filter((r) => r.total.cpu === 0).length;
  const stages = {};
  for (const n of STAGES.concat("total")) stages[n] = { cpu: summarise(rows.map((r) => r[n].cpu)), wall: summarise(rows.map((r) => r[n].wall)) };
  // Per-call process.cpuUsage is quantised on some platforms (Windows: ~15.6 ms ticks, so most calls read 0 and a few read a whole tick). The verdict therefore uses
  // the synchronous wall time per ask (single-threaded, no I/O: wall is CPU plus scheduler and GC noise) and the loop-mean CPU is printed as a cross-check.
  const t = stages.total.wall;
  return {
    cpuMean,
    cpuQuantised: zero > iterations / 2,
    iterations,
    budgetMs,
    promptChars,
    cold: { cpu: cold.total.cpu, wall: cold.total.wall },
    stages,
    ...verdict(t, budgetMs, cpuMean),
  };
}

// Inclusive gates: median <= budget and p95 <= budget. The mean is informational and does not gate.
export function verdict(t, budgetMs, cpuMean) {
  return { pass: { median: t.median <= budgetMs, p95: t.p95 <= budgetMs, mean: cpuMean <= budgetMs }, ok: t.median <= budgetMs && t.p95 <= budgetMs };
}

const f = (n) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
export function format(r) {
  const lines = [PROXY_NOTICE, `iterations=${r.iterations} prompt_chars~${r.promptChars} budget_ms=${r.budgetMs}`, "", "stage            cpu median  cpu p95   cpu max   wall median  wall p95  wall max (ms)"];
  for (const [name, s] of Object.entries(r.stages)) {
    lines.push(`${name.padEnd(16)} ${f(s.cpu.median).padStart(10)} ${f(s.cpu.p95).padStart(8)} ${f(s.cpu.max).padStart(9)} ${f(s.wall.median).padStart(12)} ${f(s.wall.p95).padStart(9)} ${f(s.wall.max).padStart(9)}`);
  }
  lines.push("", `loop-mean CPU per ask: ${f(r.cpuMean)} ms`);
  if (r.cpuQuantised) lines.push("note: per-call CPU is quantised on this platform (most calls read 0); the verdict uses wall time per ask, which tracks CPU for this synchronous code");
  lines.push(`cold first call: cpu ${f(r.cold.cpu)} ms, wall ${f(r.cold.wall)} ms (not part of the percentiles)`);
  lines.push(`median ${r.pass.median ? "within" : "OVER"} budget; p95 ${r.pass.p95 ? "within" : "OVER"} budget (${r.budgetMs} ms, wall time per ask as the CPU stand-in)`);
  lines.push(r.ok ? "RESULT: within budget on this machine (a proxy; Workers observability is still required)" : "RESULT: OVER budget on this machine");
  return lines.join("\n");
}

export function parseArgs(argv, env = process.env) {
  const o = { iterations: 100, budgetMs: Number(env.RESEARCH_CPU_BUDGET_MS) > 0 ? Number(env.RESEARCH_CPU_BUDGET_MS) : DEFAULT_BUDGET_MS, promptChars: 9000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => { const v = Number(argv[++i]); if (!Number.isFinite(v) || v <= 0) throw new Error(`${a} needs a positive number`); return v; };
    if (a === "--iterations") o.iterations = Math.floor(num());
    else if (a === "--budget-ms") o.budgetMs = num();
    else if (a === "--prompt-chars") o.promptChars = Math.floor(num());
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = measure(opts);
    process.stdout.write(`${opts.json ? JSON.stringify({ proxy_notice: PROXY_NOTICE, ...r }, null, 2) : format(r)}\n`);
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(`measure-research-cpu: ${e.message}\n`);
    process.exitCode = 2;
  }
}
