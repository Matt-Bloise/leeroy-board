// Replay runner: drives the signed shadow route (POST /api/shadow/ask, docs/runbooks/shadow-ask.md), one item at a time, and scores what comes back.
//   node tools/replay/run.mjs <token-file> --in <items.jsonl> --max-items N [--out results.jsonl | --resume results.jsonl] [--delay-s 660] [--max-wait-s 900] [--keep-answers] [--base https://api.leeroy.party] [--allow-host host]
// --base host: api.leeroy.party, localhost and 127.0.0.1 are allowed; any other host needs --allow-host <host> (comma list ok). The host (not the path) is printed before the first call.
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
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shadowKey, signListen } from "../../infrastructure/worker/listener-config.js";
import { MAX_QUESTION_CHARS } from "../../infrastructure/worker/limits.js";
import { appendOut, assertOutsideRepo, readJsonl, sha256, parseArgs, die, withLock, DEFAULT_OUT_DIR } from "./common.mjs";
import { KINDS } from "./truth-gen.mjs";
import { scoreTruthItem, summarize, withinBudget, degraded } from "./score.mjs";
import { evaluateBar, PASS_BAR } from "./pass-bar.mjs";

export const SHADOW_PER_HOUR = 6;
export const SHADOW_PER_DAY = 20;
export const BODY_MAX = 4096;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WORKER_SETS = ["answered", "degraded", "error", "refused", "store-failed"];

export const DEFAULT_HOSTS = Object.freeze(["api.leeroy.party", "localhost", "127.0.0.1"]);
// https only (http only for localhost or 127.0.0.1), no credentials, and the host must be in DEFAULT_HOSTS or named with --allow-host: the signed body carries the shadow key's reach, so it only goes where the owner said.
export function checkBase(base, allowHosts = []) {
  let u;
  try { u = new URL(base); } catch { throw new Error("refusing: the base URL is not a URL"); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && local))) throw new Error("refusing: the base URL must be https (http only for localhost or 127.0.0.1) and carry no credentials");
  const allowed = new Set([...DEFAULT_HOSTS, ...allowHosts.map((h) => String(h).toLowerCase())]);
  if (!allowed.has(u.hostname.toLowerCase())) throw new Error(`refusing: host ${u.hostname} is not allowed; pass --allow-host ${u.hostname} to send there`);
  return u;
}

// Only fixed vocabularies reach stdout or the results file: a response cannot smuggle text through these fields.
export const KNOWN_KINDS = Object.freeze([...KINDS, "pair"]);
export const safeStatus = (v) => (WORKER_SETS.includes(v) ? v : "other");
export const safeKind = (v) => (v === undefined || v === null ? "pair" : KNOWN_KINDS.includes(v) ? v : "other");
// reason: the same pattern as safeReason in infrastructure/worker/shadow-ask.js. model: the same but it may also carry "+" and "[ ]" (the label is provider:model+research+degraded or [reason]).
export const safeReason = (r) => (typeof r === "string" && /^[a-z0-9][a-z0-9:@._-]{0,47}$/.test(r) ? r : r == null ? null : "other");
export const safeModel = (m) => (typeof m === "string" && /^[A-Za-z0-9\[][A-Za-z0-9:@._+\[\]-]{0,159}$/.test(m) ? m : m == null ? null : "other");

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
    if (seen.has(r.id)) throw new Error("the input holds a duplicate id: fix the corpus");
    if (Array.from(r.question.trim()).length > MAX_QUESTION_CHARS) continue;
    seen.add(r.id);
    items.push(r);
  }
  return items;
}

// deps: {fetchImpl, sleep(ms), now()}. Returns {stop, sent, results, remaining, unresolved}.
// stop: "done" | "max-items" | "rate-window" | "rate-limited" | "error:<what>".
// Results file lines: one header {type:"header", input_sha256}, then per attempt a {type:"sent"} marker written BEFORE the POST, then the result row (or {type:"aborted"} when the run stopped on that call).
// A marker with no result row (a crash, or an aborted call) is retried on resume but its time stays in the rate windows.
export async function runReplay(opts, deps = {}) {
  const { tokenFile, input, outPath, maxItems, delayMs = 660000, maxWaitMs = 900000, base = "https://api.leeroy.party", allowHosts = [], keepAnswers = false, log = () => {} } = opts;
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());
  const target = checkBase(base, allowHosts);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > SHADOW_PER_DAY) throw new Error(`--max-items must be an integer from 1 to ${SHADOW_PER_DAY}`);
  assertOutsideRepo(outPath);
  let token = "";
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch { throw new Error("cannot read the token file"); }
  const key = await shadowKey(token);
  if (!key) throw new Error("the token file does not hold a usable token");
  const items = loadItems(input);
  const inputSha = sha256(readFileSync(input));

  return withLock(outPath, async () => {
    const fresh = !existsSync(outPath) || statSync(outPath).size === 0;
    if (fresh) appendOut(outPath, JSON.stringify({ type: "header", tool: "tools/replay/run.mjs", input_sha256: inputSha }) + "\n");
    const lines = fresh ? [] : readJsonl(outPath);
    if (!fresh) {
      if (!lines[0] || lines[0].type !== "header" || typeof lines[0].input_sha256 !== "string") throw new Error("refusing to resume: the results file has no header line (not made by this tool)");
      if (lines[0].input_sha256 !== inputSha) throw new Error("refusing to resume: the results file was made from a different input file");
    }
    const prior = lines.filter((r) => !r.type);
    const ids = prior.map((r) => r.id);
    if (new Set(ids).size !== ids.length) throw new Error("the results file holds a duplicate id: it cannot be resumed");
    const done = new Set(ids);
    const times = [...new Set([...lines.filter((r) => r.type === "sent").map((r) => r.sent_at), ...prior.map((r) => r.sent_at)])].filter(Number.isFinite);
    const marked = new Set(lines.filter((r) => r.type === "sent").map((r) => r.id));
    const todo = items.filter((r) => !done.has(r.id));
    const unresolved = todo.filter((r) => marked.has(r.id)).length;
    const results = [...prior];
    let sent = 0;
    let stop = "done";
    const url = `${target.origin}/api/shadow/ask`;
    let announced = false;
    const abort = (rec, sentAt, status) => appendOut(outPath, JSON.stringify({ type: "aborted", id: rec.id, sent_at: sentAt, http_status: status }) + "\n");

    for (const rec of todo) {
      if (sent >= maxItems) { stop = "max-items"; break; }
      const wait = waitMs(times, now());
      if (wait > maxWaitMs) { stop = "rate-window"; log(`rate window: next call fits in ${Math.ceil(wait / 1000)} s (over --max-wait-s); resume later`); break; }
      if (wait > 0) await sleep(wait);
      if (sent > 0 && delayMs > 0) await sleep(delayMs);
      const { body, localOmitted } = buildBody(rec);
      const qHash = sha256(String(rec.question).trim());
      if (Buffer.byteLength(body) > BODY_MAX) { // the question alone is too big: recorded as unscored, no call, no allowance used
        const row = { id: rec.id, kind: safeKind(rec.kind), question_sha256: qHash, fictional: rec.fictional === true, ok: false, status: "not-sent", model: null, latency_ms: null, reason: "body:too-large", within_budget: false, degraded: false, answer_length: 0, answer_sha256: null, http_status: 0, scored: false, sent_at: null, scores: null };
        appendOut(outPath, JSON.stringify(row) + "\n"); results.push(row); continue;
      }
      if (!announced) { log(`sending to host ${target.host}`); announced = true; }
      const ts = String(Math.floor(now() / 1000));
      const sentAt = now();
      appendOut(outPath, JSON.stringify({ type: "sent", id: rec.id, sent_at: sentAt }) + "\n"); // before the POST: a crash mid-call still leaves the attempt on record
      times.push(sentAt);
      sent++; // an attempt counts even if the body cannot be read
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
        abort(rec, sentAt, 0);
        stop = "error:request-failed"; break;
      }
      if (res.status === 429) { abort(rec, sentAt, 429); stop = "rate-limited"; const ra = Number(res.headers.get("Retry-After")); log(`the route rate-limited the run${Number.isFinite(ra) ? ` (retry after ${Math.round(ra)} s)` : ""}; resume later`); break; }
      if ([401, 404, 409, 503].includes(res.status)) { abort(rec, sentAt, res.status); stop = `error:http-${res.status}`; break; }
      let out;
      try { out = JSON.parse(text); } catch { out = {}; }
      if (!out || typeof out !== "object") out = {};
      const answer = typeof out.answer === "string" ? out.answer : null;
      const scored = WORKER_SETS.includes(out.status) && (res.status === 200 || res.status === 500);
      const raw = { reason: out.reason, model: out.model, status: out.status };
      const row = {
        id: rec.id, kind: safeKind(rec.kind), question_sha256: qHash, fictional: rec.fictional === true, ok: out.ok === true,
        status: typeof out.status === "string" ? safeStatus(out.status) : `http-${res.status}`,
        model: safeModel(out.model), latency_ms: Number.isFinite(out.latency_ms) ? Math.round(out.latency_ms) : null,
        reason: safeReason(out.reason), within_budget: withinBudget(out.latency_ms), degraded: degraded(raw),
        answer_length: answer ? Array.from(answer).length : 0, answer_sha256: answer ? sha256(answer) : null,
        input_tokens: tokInt(out.input_tokens), output_tokens: tokInt(out.output_tokens), http_status: res.status, scored, sent_at: sentAt, local_omitted: localOmitted || undefined, scores: null,
      };
      if (scored) row.scores = rec.expected ? scoreTruthItem(rec, raw, answer) : { degraded: row.degraded };
      if (keepAnswers && answer !== null) row.answer = answer;
      appendOut(outPath, JSON.stringify(row) + "\n");
      results.push(row);
      log(`item ${sent}/${Math.min(maxItems, todo.length)} ${row.kind} http ${res.status} ${row.status} ${row.latency_ms === null ? "-" : row.latency_ms + " ms"}`);
    }
    if (stop === "done" && sent >= maxItems && todo.length > sent) stop = "max-items";
    return { stop, sent, results, remaining: todo.length - sent, unresolved };
  });
}

// Measured Anthropic tokens per compose (the Worker reports integers or null). Totals and mean per item over the items that reported both numbers.
const tokInt = (v) => (Number.isInteger(v) && v >= 0 && v <= 1e7 ? v : null);
export function tokenStats(rows) {
  const known = rows.filter((r) => !r.type && tokInt(r.input_tokens) !== null && tokInt(r.output_tokens) !== null);
  const input_total = known.reduce((a, r) => a + r.input_tokens, 0);
  const output_total = known.reduce((a, r) => a + r.output_tokens, 0);
  return { items_with_usage: known.length, input_total, output_total, input_mean: known.length ? input_total / known.length : null, output_mean: known.length ? output_total / known.length : null };
}
const pct = (v) => (v === null || v === undefined ? "  n/a" : (v * 100).toFixed(1).padStart(5) + "%");
const ms = (v) => (v === null || v === undefined ? "   n/a" : String(Math.round(v)).padStart(6));
export function formatSummary(rows) {
  const results = rows.filter((r) => !r.type); // header, sent and aborted lines are not results
  const s = summarize(results);
  const lines = [];
  const row = (label, g) => `${label.padEnd(16)} ${String(g.n).padStart(4)} ${String(g.scored).padStart(6)} ${String(g.exact_scored).padStart(6)} ${pct(g.exact_rate)} ${pct(g.unsupported_rate)} ${pct(g.degraded_rate)} ${pct(g.within_budget_rate)} ${ms(g.latency_p50_ms)} ${ms(g.latency_p95_ms)}`;
  lines.push(`${"kind".padEnd(16)} ${"n".padStart(4)} ${"scored".padStart(6)} ${"truth".padStart(6)} ${"exact".padStart(6)} ${"unsup".padStart(6)} ${"degr".padStart(6)} ${"budget".padStart(6)} ${"p50ms".padStart(6)} ${"p95ms".padStart(6)}`);
  for (const [k, g] of Object.entries(s.by_kind).sort()) lines.push(row(k, g));
  lines.push(row("ALL", s));
  const t = tokenStats(results);
  lines.push(t.items_with_usage ? `tokens (measured, ${t.items_with_usage} of ${results.length} items): input ${t.input_total} total, ${Math.round(t.input_mean)} mean; output ${t.output_total} total, ${Math.round(t.output_mean)} mean` : "tokens: no measured usage in these results");
  if (results.some((r) => r.scores && typeof r.scores.exact === "boolean")) {
    const v = evaluateBar(s);
    lines.push(v.pass ? "pass bar: PASS" : "pass bar: FAIL (a first run against a Worker with no game_facts table is expected to fail: it is the baseline)");
    for (const f of v.failures) lines.push(`  - ${f}`);
    lines.push(`bar: exact >= ${PASS_BAR.exact_rate_min}, unsupported <= ${PASS_BAR.unsupported_rate_max}, degraded <= ${PASS_BAR.degraded_rate_max}, budget >= ${PASS_BAR.within_budget_rate_min}, >= ${PASS_BAR.min_scored_per_kind} scored per kind`);
  }
  return lines.join("\n");
}

async function main() {
  const a = parseArgs(process.argv.slice(2), { in: "value", out: "value", resume: "value", "max-items": "value", "delay-s": "value", "max-wait-s": "value", "keep-answers": "bool", base: "value", "allow-host": "value", summarize: "value" });
  if (a.summarize) {
    try { console.log(formatSummary(readJsonl(a.summarize))); } catch (e) { die(e.message); }
    return;
  }
  const usage = "usage: node tools/replay/run.mjs <token-file> --in <items.jsonl> --max-items N [--out file | --resume results.jsonl] [--delay-s N] [--max-wait-s N] [--keep-answers] [--base url] [--allow-host host]";
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
      base: a.base || "https://api.leeroy.party", allowHosts: a["allow-host"] ? a["allow-host"].split(",").map((h) => h.trim()).filter(Boolean) : [], keepAnswers: Boolean(a["keep-answers"]), log: (m) => console.log(m),
    });
  } catch (e) { die(e.message); }
  console.log(`stopped: ${r.stop}; sent ${r.sent}; remaining ${r.remaining}; unresolved ${r.unresolved}; results: ${path.resolve(outPath)}`);
  console.log(formatSummary(r.results));
  process.exit(r.stop.startsWith("error:") ? 1 : 0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
