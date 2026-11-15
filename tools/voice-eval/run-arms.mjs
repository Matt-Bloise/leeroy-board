// Voice A/B arm runner. Generates the answers for the 38 frozen prompts under three arms, so the blind pairwise harness (make-tasks.mjs) can judge them.
// Question it answers: did the MODEL or the PROMPT/DELETERS cause the voice regression?
//   prod-prompt-llama : the production /ask prompt (research off: buildAnswerInputs + finishAnswerText) answered by Workers AI Llama 3.3 70B
//   restored-llama    : the research-mode prompt and finishing (research rules, labeller, tokenised prompt) answered by the same Llama
//   restored-claude   : the same research-mode prompt, tokenised and guarded as research/claude.js does, answered by Claude
// Files the judge side may see use neutral names arm1..arm3; mapping.json (private) holds the real ones.
//
// Exactly one mode: --emit-prompts --out DIR | --ingest-answers DIR [--out DIR] (offline, no keys, env never read; see offline.mjs and README) | --dry-run (canned replies) | --live.
// Live (keys ONLY from the environment, only under --live; never from argv; never written anywhere):
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... ANTHROPIC_API_KEY=... node tools/voice-eval/run-arms.mjs --live --yes --out runs/arms1 --seed 7
// Options: --out DIR (required) --seed N --dry-run --yes --max-spend TOKENS (default 400000) --claude-model ID (else env CLAUDE_VOICE_MODEL, else claude-haiku-5-5)
//          --arms name,name (default all three)
// Outputs in --out: arm1.jsonl arm2.jsonl arm3.jsonl ({id, answer}), mapping.json (private), usage.json (counts, ids, latency; no prompt or answer text, no key).
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPrompts, frozenHashes, HERE, mulberry32, shuffled } from "./lib.mjs";
import { emitPrompts, ingestAnswers } from "./offline.mjs";
import {
  ARMS, MODEL_ID_RE, DEFAULT_CLAUDE_MODEL, WORKERS_AI_MODEL, seedDb, makeEnv, planItem, finishItem, estimateIn, estimateOut,
  workersAiAdapter, claudeAdapter, fakeAdapter, resetCaches,
} from "./arms.mjs";

export const DEFAULT_MAX_SPEND = 400000;
const FLAGS = { "--out": 1, "--seed": 1, "--dry-run": 0, "--yes": 0, "--max-spend": 1, "--claude-model": 1, "--arms": 1, "--live": 0, "--emit-prompts": 0, "--ingest-answers": 1 };
const NEED = { "workers-ai": ["CF_ACCOUNT_ID", "CF_API_TOKEN"], claude: ["ANTHROPIC_API_KEY"] };

// Strict argv: known flags only. An error never echoes what was typed (it could be a key pasted by mistake).
export function parseArgs(argv) {
  const o = { dryRun: false, yes: false, seed: 1, maxSpend: DEFAULT_MAX_SPEND, out: null, claudeModel: null, arms: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!Object.prototype.hasOwnProperty.call(FLAGS, a)) return { error: "unknown option (credentials are read from environment variables only, never from arguments)" };
    const val = FLAGS[a] ? argv[++i] : null;
    if (FLAGS[a] && (val === undefined || val.startsWith("--"))) return { error: `${a} needs a value` };
    if (a === "--out") o.out = val;
    else if (a === "--seed") { if (!/^\d{1,9}$/.test(val)) return { error: "--seed must be a non-negative integer" }; o.seed = Number(val); }
    else if (a === "--max-spend") { if (!/^\d{1,12}$/.test(val)) return { error: "--max-spend must be a non-negative integer" }; o.maxSpend = Number(val); }
    else if (a === "--claude-model") { if (!MODEL_ID_RE.test(val)) return { error: "--claude-model is not a model id" }; o.claudeModel = val; }
    else if (a === "--arms") o.arms = val.split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--live") o.live = true;
    else if (a === "--emit-prompts") o.emit = true;
    else if (a === "--ingest-answers") o.ingest = val;
  }
  const modes = [o.dryRun, o.live, o.emit, Boolean(o.ingest)].filter(Boolean).length;
  if (modes !== 1) return { error: "choose exactly one mode: --emit-prompts, --ingest-answers DIR, --dry-run or --live" };
  if (o.yes && !o.live) return { error: "--yes only applies to --live" };
  if (!o.out && o.ingest) o.out = o.ingest; // ingest writes the arm files next to the answers unless --out says otherwise
  if (!o.out) return { error: "--out DIR is required" };
  return { opts: o };
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

export async function main(argv, { env = process.env, fetchImpl = globalThis.fetch, log = console.log, err = console.error, prompts = null } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) { err(`run-arms: ${parsed.error}`); return 2; }
  const o = parsed.opts;

  // The frozen prompts only.
  const promptList = prompts || JSON.parse(readFileSync(join(HERE, "prompts.json"), "utf8"));
  if (!prompts && hashPrompts(promptList) !== frozenHashes().prompts) { err("run-arms: prompts.json does not match its frozen hash"); return 2; }

  // Offline modes: no keys, no network, no environment reads at all.
  if (o.emit || o.ingest) {
    const fn = o.emit ? emitPrompts : ingestAnswers;
    return fn({ o, promptList, log, err });
  }

  let arms = ARMS;
  if (o.arms) {
    arms = ARMS.filter((a) => o.arms.includes(a.name));
    if (arms.length !== o.arms.length || !arms.length) { err(`run-arms: --arms takes names from: ${ARMS.map((a) => a.name).join(", ")}`); return 2; }
  }
  const claudeModel = o.claudeModel || (MODEL_ID_RE.test(String(env.CLAUDE_VOICE_MODEL || "").trim()) ? String(env.CLAUDE_VOICE_MODEL).trim() : DEFAULT_CLAUDE_MODEL);

  // Neutral names, shuffled by the seed so arm1 is not always the production arm. The mapping is private.
  const order = shuffled(ARMS.map((a) => a.name), mulberry32(`${o.seed}:arms`));
  const neutral = Object.fromEntries(order.map((n, i) => [n, `arm${i + 1}`]));

  // Keys are read only under --live. Names of missing variables are printed, never values.
  const dry = !o.live;
  if (o.live) {
    const needed = [...new Set(arms.flatMap((a) => NEED[a.provider]))];
    const missing = needed.filter((k) => !String(env[k] || "").trim());
    if (missing.length) { err(`run-arms: --live needs environment variables: ${missing.join(", ")}`); return 5; }
  }

  // Phase 1 (local only): build every prompt through the Worker's own code.
  resetCaches(); // the Worker caches the parsed library for 15 minutes; a fresh database must not see an earlier one's pages
  const DB = seedDb(promptList);
  const wenv = makeEnv(DB);
  const plan = [];
  for (const arm of arms) for (const p of promptList) plan.push(await planItem(wenv, arm, p, o.seed));

  const calls = plan.filter((it) => !it.composed && !it.blocked);
  const estIn = calls.reduce((s, it) => s + estimateIn(it), 0);
  const estOut = calls.reduce((s, it) => s + estimateOut(it), 0);
  const est = { calls: calls.length, inputTokens: estIn, outputTokens: estOut, total: estIn + estOut };
  log(`run-arms: ${promptList.length} prompts x ${arms.length} arms; ${est.calls} model calls; estimated tokens: ${estIn} in + ${estOut} out (max) = ${est.total}; limit ${o.maxSpend}; mode ${dry ? "dry (no network)" : "LIVE"}`);
  if (est.total > o.maxSpend) { err(`run-arms: refused: the estimate ${est.total} is over --max-spend ${o.maxSpend}`); return 3; }
  if (!dry && !o.yes) { err("run-arms: refused: credentials are present and this would call the providers; add --yes to send"); return 4; }

  // Phase 2: the calls, one at a time.
  const adapterFor = (arm) => {
    if (dry) return fakeAdapter({ seed: o.seed, armName: arm.name });
    if (arm.provider === "claude") return claudeAdapter({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), model: claudeModel, fetchImpl });
    return workersAiAdapter({ accountId: String(env.CF_ACCOUNT_ID).trim(), token: String(env.CF_API_TOKEN).trim(), fetchImpl, seed: o.seed });
  };
  const adapters = new Map(arms.map((a) => [a.name, adapterFor(a)]));
  const rows = new Map(arms.map((a) => [a.name, []]));
  const usage = [];
  let spent = 0;
  for (const it of plan) {
    const entry = { arm: neutral[it.arm.name], id: it.p.id, provider: it.arm.provider, model: it.arm.provider === "claude" ? claudeModel : WORKERS_AI_MODEL, status: "ok", attempts: 0, latencyMs: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, retrieval: it.inputs.retrieval && it.inputs.retrieval.abstain ? "abstain" : it.inputs.retrieved ? "library" : "skipped", followUp: Boolean(it.previousQuestion) };
    usage.push(entry);
    if (it.blocked) { entry.status = "blocked"; entry.error = it.blocked; continue; }
    let answer = null;
    if (it.composed) {
      entry.provider = "code"; entry.model = "code-written";
      const r = await finishItem(wenv, it, "");
      if (r.answer) answer = r.answer; else { entry.status = "error"; entry.error = r.error; }
    } else {
      entry.estimatedInputTokens = estimateIn(it); entry.estimatedOutputTokens = estimateOut(it);
      const maxAttempts = it.arm.provider === "workers-ai" && it.arm.research ? 2 : 1; // the Worker retries an unusable research reply once; nothing else is retried
      for (let a = 1; a <= maxAttempts && answer === null; a++) {
        entry.attempts = a;
        if (spent + estimateIn(it) + estimateOut(it) > o.maxSpend) { entry.status = "stopped"; entry.error = "max-spend"; break; }
        const t0 = performance.now();
        let res;
        try { res = await adapters.get(it.arm.name)({ system: it.system, user: it.user, gen: it.arm.gen, id: it.p.id }); }
        catch (e) { entry.latencyMs += Math.round(performance.now() - t0); entry.status = "error"; entry.error = (e && e.code) || "error"; break; }
        entry.latencyMs += Math.round(performance.now() - t0);
        entry.inputTokens += res.usage.input; entry.outputTokens += res.usage.output;
        spent += (res.usage.input || estimateIn(it)) + (res.usage.output || estimateOut(it));
        const r = await finishItem(wenv, it, res.text);
        if (r.answer) { answer = r.answer; entry.status = "ok"; delete entry.error; } else { entry.status = "error"; entry.error = r.error; }
      }
    }
    if (answer !== null) rows.get(it.arm.name).push({ id: it.p.id, answer });
  }

  // Outputs.
  mkdirSync(o.out, { recursive: true });
  const incomplete = [];
  for (const arm of arms) {
    const list = rows.get(arm.name);
    writeFileSync(join(o.out, `${neutral[arm.name]}.jsonl`), jsonl(list), "utf8");
    if (list.length !== promptList.length) incomplete.push(neutral[arm.name]);
    log(`run-arms: ${neutral[arm.name]}: ${list.length}/${promptList.length} rows`);
  }
  writeFileSync(join(o.out, "mapping.json"), JSON.stringify({ private: true, note: "arm names for the judge-facing files; keep away from judges", seed: o.seed, mode: dry ? "dry" : "live", claudeModel, workersAiModel: WORKERS_AI_MODEL, arms: Object.fromEntries(arms.map((a) => [neutral[a.name], a.name])) }, null, 2) + "\n", "utf8");
  const sum = (k) => usage.reduce((s, u) => s + u[k], 0);
  writeFileSync(join(o.out, "usage.json"), JSON.stringify({ private: true, seed: o.seed, mode: dry ? "dry" : "live", estimate: est, maxSpend: o.maxSpend, totals: { calls: usage.filter((u) => u.attempts > 0).length, attempts: sum("attempts"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), latencyMs: sum("latencyMs") }, calls: usage }, null, 2) + "\n", "utf8");
  log(`run-arms: wrote ${arms.length} arm files, mapping.json and usage.json to ${o.out}`);
  if (incomplete.length) { err(`run-arms: incomplete arms: ${incomplete.join(", ")} (see usage.json for the error codes)`); return 1; }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`run-arms: failed: ${e && e.name}`); process.exitCode = 1; });
}
