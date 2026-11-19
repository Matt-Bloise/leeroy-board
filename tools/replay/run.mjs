// Replay runner: drives the signed shadow route (POST /api/shadow/ask, docs/runbooks/shadow-ask.md), one item at a time, and scores what comes back.
//   node tools/replay/run.mjs <token-file> --in <items.jsonl> --max-items N [--out results.jsonl | --resume results.jsonl] [--delay-s 660] [--max-wait-s 900] [--keep-answers] [--base https://api.leeroy.party]
//   node tools/replay/run.mjs --summarize <results.jsonl>        (no network: re-prints the summary table and the pass-bar verdict)
// --in: a truth set from truth-gen.mjs, or a private pair corpus whose records have at least {id, question} and optionally {asker_slug, local_answer, sources, fictional}.
// <token-file>: holds the Discord bot token; read, used to derive the SHADOW key (shadowKey in listener-config.js, the same derivation tools/shadow-ask.mjs uses) and never printed.
//   Run it only on the owner's machine: the shadow key can read answers as any roster member.
// --max-items: required, 1..20 (the route's daily cap). The run sends at most that many calls, then stops cleanly.
// Rate limits (shadow-ask runbook): 6 an hour, 20 a day. The runner spaces calls by --delay-s (default 660 s), also tracks the rolling windows from the sent_at stamps in the results file, and stops
//   (exit 0, resumable) rather than wait longer than --max-wait-s. A 429 from the route stops the run the same way and the item is retried on --resume. 401/404/409 stop the run (config problem).
// Results: one JSON line per item: id, kind, ok, status, model, latency_ms, reason, within_budget, answer_length, answer_sha256, http_status, scored, sent_at, scores. The answer text is stored ONLY with --keep-answers.
// --out and --resume paths inside this repo checkout are refused. Questions and answers are never printed.
// Exit: 0 clean stop (finished, max-items, or rate window), 1 stopped on an error, 2 usage.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shadowKey, signListen } from "../../infrastructure/worker/listener-config.js";
import { MAX_QUESTION_CHARS } from "../../infrastructure/worker/limits.js";
import { appendOut, assertOutsideRepo, readJsonl, sha256, parseArgs, die, DEFAULT_OUT_DIR } from "./common.mjs";
import { scoreTruthItem, summarize, withinBudget, degraded } from "./score.mjs";
import { evaluateBar, PASS_BAR } from "./pass-bar.mjs";

export const SHADOW_PER_HOUR = 6;
export const SHADOW_PER_DAY = 20;
export const BODY_MAX = 4096;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WORKER_SETS = ["answered", "degraded", "error", "refused", "store-failed"];

export function checkBase(base) {
  let u;
  try { u = new URL(base); } catch { throw new Error("refusing: the base URL is not a URL"); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && local))) throw new Error("refusing: the base URL must be https (http only for localhost or 127.0.0.1) and carry no credentials");
  return u;
}

// How long (ms) until one more call fits the route's 6/hour and 20/day windows, given the send times so far. Mirrors the Worker's own computation.
export function waitMs(times, now) {
  const hits = times.filter((t) => now - t < DAY_MS).sort((a, b) => a - b);
  let wait = 0;
  const lastHour = hits.filter((t) => now - t < HOUR_MS);
  if (lastHour.length >= SHADOW_PER_HOUR) wait = Math.max(wait, lastHour[lastHour.length - SHADOW_PER_HOUR] + HOUR_MS - now);
  if (hits.length >= SHADOW_PER_DAY) wait = Math.max(wait, hits[hits.length - SHADOW_PER_DAY] + DAY_MS - now);
  return Math.max(0, wait);
}

export function buildBody(rec) {
  const payload = { purpose: "shadow-ask", question: String(rec.question).trim() };
  if (typeof rec.asker_slug === "string" && rec.asker_slug) payload.as = rec.asker_slug;
  let localOmitted = false;
  if (typeof rec.local_answer === "string" && rec.local_answer.trim()) {
    const withLocal = JSON.stringify({ ...payload, local_answer: rec.local_answer.trim() });
    if (Buffer.byteLength(withLocal) <= BODY_MAX) return { body: withLocal, localOmitted };
    localOmitted = true; // the Worker refuses a body over 4 KB; the local answer is left out rather than cut (a cut could split a secret the Worker's scan needs whole)
  }
  return { body: JSON.stringify(payload), localOmitted };
}

export function loadItems(file) {
  const seen = new Set();
  const items = [];
  for (const r of readJsonl(file)) {
    if (!r || r.type === "header") continue;
    if (typeof r.id !== "string" || !r.id || typeof r.question !== "string" || !r.question.trim()) continue;
    if (seen.has(r.id)) continue;
    if (Array.from(r.question.trim()).length > MAX_QUESTION_CHARS) continue;
    seen.add(r.id);
    items.push(r);
  }
  return items;
}

// deps: {fetchImpl, sleep(ms), now()}. Returns {stop, sent, results}. stop: "done" | "max-items" | "rate-window" | "rate-limited" | "error:<what>".
export async function runReplay(opts, deps = {}) {
  const { tokenFile, input, outPath, maxItems, delayMs = 660000, maxWaitMs = 900000, base = "https://api.leeroy.party", keepAnswers = false, log = () => {} } = opts;
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());
  const target = checkBase(base);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > SHADOW_PER_DAY) throw new Error(`--max-items must be an integer from 1 to ${SHADOW_PER_DAY}`);
  assertOutsideRepo(outPath);
  let token = "";
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch { throw new Error("cannot read the token file"); }
  const key = await shadowKey(token);
  if (!key) throw new Error("the token file does not hold a usable token");

  const items = loadItems(input);
  const prior = existsSync(outPath) ? readJsonl(outPath) : [];
  const done = new Set(prior.map((r) => r.id));
  const times = prior.map((r) => r.sent_at).filter(Number.isFinite);
  const todo = items.filter((r) => !done.has(r.id));
  const results = [...prior];
  let sent = 0;
  let stop = "done";
  const url = `${target.origin}/api/shadow/ask`;

  for (const rec of todo) {
    if (sent >= maxItems) { stop = "max-items"; break; }
    const wait = waitMs(times, now());
    if (wait > maxWaitMs) { stop = "rate-window"; log(`rate window: next call fits in ${Math.ceil(wait / 1000)} s (over --max-wait-s); resume later`); break; }
    if (wait > 0) await sleep(wait);
    if (sent > 0 && delayMs > 0) await sleep(delayMs);
    const { body, localOmitted } = buildBody(rec);
    if (Buffer.byteLength(body) > BODY_MAX) { // the question alone is too big: record as unscored, no call, no allowance used
      const row = { id: rec.id, kind: rec.kind || "pair", ok: false, status: "not-sent", model: null, latency_ms: null, reason: "body:too-large", within_budget: false, answer_length: 0, answer_sha256: null, http_status: 0, scored: false, sent_at: null, scores: null };
      appendOut(outPath, JSON.stringify(row) + "\n"); results.push(row); continue;
    }
    const ts = String(Math.floor(now() / 1000));
    const sentAt = now();
    let res, text = "";
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(key, ts, body) },
        body,
        redirect: "error", // a redirect would replay the signed body to another host: refuse it
        signal: AbortSignal.timeout(60000),
      });
      text = await res.text();
    } catch {
      times.push(sentAt); // unknown whether the call counted: assume it did
      stop = "error:request-failed"; break;
    }
    sent++;
    if (res.status === 429) { stop = "rate-limited"; const ra = Number(res.headers.get("Retry-After")); log(`the route rate-limited the run${Number.isFinite(ra) ? ` (retry after ${ra} s)` : ""}; resume later`); break; }
    if ([401, 404, 409].includes(res.status)) { stop = `error:http-${res.status}`; break; }
    if (![400, 413].includes(res.status)) times.push(sentAt); // 400/413 are refused before the limiter
    if (res.status === 503) { stop = "error:http-503"; break; }
    let out;
    try { out = JSON.parse(text); } catch { out = {}; }
    const answer = typeof out.answer === "string" ? out.answer : null;
    const scored = WORKER_SETS.includes(out.status) && (res.status === 200 || res.status === 500);
    const row = {
      id: rec.id, kind: rec.kind || "pair", ok: out.ok === true, status: typeof out.status === "string" ? out.status : `http-${res.status}`,
      model: typeof out.model === "string" ? out.model : null, latency_ms: Number.isFinite(out.latency_ms) ? out.latency_ms : null,
      reason: typeof out.reason === "string" ? out.reason : null, within_budget: withinBudget(out.latency_ms),
      answer_length: answer ? Array.from(answer).length : 0, answer_sha256: answer ? sha256(answer) : null,
      http_status: res.status, scored, sent_at: sentAt, local_omitted: localOmitted || undefined, scores: null,
    };
    if (scored) row.scores = rec.expected ? scoreTruthItem(rec, row, answer) : { degraded: degraded(row) };
    if (keepAnswers && answer !== null) row.answer = answer;
    appendOut(outPath, JSON.stringify(row) + "\n");
    results.push(row);
    log(`item ${sent}/${Math.min(maxItems, todo.length)} ${row.kind} http ${res.status} ${row.status} ${row.latency_ms === null ? "-" : row.latency_ms + " ms"}`);
  }
  if (stop === "done" && sent >= maxItems && todo.length > sent) stop = "max-items";
  return { stop, sent, results, remaining: todo.length - sent };
}

const pct = (v) => (v === null || v === undefined ? "  n/a" : (v * 100).toFixed(1).padStart(5) + "%");
const ms = (v) => (v === null || v === undefined ? "   n/a" : String(Math.round(v)).padStart(6));
export function formatSummary(results) {
  const s = summarize(results);
  const lines = [];
  const row = (label, g) => `${label.padEnd(16)} ${String(g.n).padStart(4)} ${String(g.scored).padStart(6)} ${String(g.exact_scored).padStart(6)} ${pct(g.exact_rate)} ${pct(g.unsupported_rate)} ${pct(g.degraded_rate)} ${pct(g.within_budget_rate)} ${ms(g.latency_p50_ms)} ${ms(g.latency_p95_ms)}`;
  lines.push(`${"kind".padEnd(16)} ${"n".padStart(4)} ${"scored".padStart(6)} ${"truth".padStart(6)} ${"exact".padStart(6)} ${"unsup".padStart(6)} ${"degr".padStart(6)} ${"budget".padStart(6)} ${"p50ms".padStart(6)} ${"p95ms".padStart(6)}`);
  for (const [k, g] of Object.entries(s.by_kind).sort()) lines.push(row(k, g));
  lines.push(row("ALL", s));
  if (results.some((r) => r.scores && typeof r.scores.exact === "boolean")) {
    const v = evaluateBar(s);
    lines.push(v.pass ? "pass bar: PASS" : "pass bar: FAIL (a first run against a Worker with no game_facts table is expected to fail: it is the baseline)");
    for (const f of v.failures) lines.push(`  - ${f}`);
    lines.push(`bar: exact >= ${PASS_BAR.exact_rate_min}, unsupported <= ${PASS_BAR.unsupported_rate_max}, degraded <= ${PASS_BAR.degraded_rate_max}, budget >= ${PASS_BAR.within_budget_rate_min}, >= ${PASS_BAR.min_scored_per_kind} scored per kind`);
  }
  return lines.join("\n");
}

async function main() {
  const a = parseArgs(process.argv.slice(2), { in: "value", out: "value", resume: "value", "max-items": "value", "delay-s": "value", "max-wait-s": "value", "keep-answers": "bool", base: "value", summarize: "value" });
  if (a.summarize) {
    try { console.log(formatSummary(readJsonl(a.summarize))); } catch (e) { die(e.message); }
    return;
  }
  const usage = "usage: node tools/replay/run.mjs <token-file> --in <items.jsonl> --max-items N [--out file | --resume results.jsonl] [--delay-s N] [--max-wait-s N] [--keep-answers] [--base url]";
  if (a._.length !== 1 || !a.in || a["max-items"] === undefined) die(usage);
  if (a.out && a.resume && path.resolve(a.out) !== path.resolve(a.resume)) die("--out and --resume name different files; give only --resume to continue a run");
  let outPath = a.resume || a.out;
  if (a.resume && !existsSync(a.resume)) die("--resume: that results file does not exist");
  if (!outPath) outPath = path.join(DEFAULT_OUT_DIR, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const num = (v, d) => (v === undefined ? d : Number(v));
  let r;
  try {
    r = await runReplay({
      tokenFile: a._[0], input: a.in, outPath, maxItems: Number(a["max-items"]), delayMs: num(a["delay-s"], 660) * 1000, maxWaitMs: num(a["max-wait-s"], 900) * 1000,
      base: a.base || "https://api.leeroy.party", keepAnswers: Boolean(a["keep-answers"]), log: (m) => console.log(m),
    });
  } catch (e) { die(e.message); }
  console.log(`stopped: ${r.stop}; sent ${r.sent}; remaining ${r.remaining}; results: ${path.resolve(outPath)}`);
  console.log(formatSummary(r.results));
  process.exit(r.stop.startsWith("error:") ? 1 : 0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
