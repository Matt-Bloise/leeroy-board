// Measures real latency of the research Claude hop: a Sonnet-class compose and a Haiku-class retry, non-streaming, max_tokens 700, a prompt of a few thousand tokens.
// Inputs (all from the environment at run time; nothing is read from or written to the repo):
//   ANTHROPIC_API_KEY     direct key (x-api-key). Sent to api.anthropic.com, to a gateway in non-BYOK mode, or to a LATENCY_ENDPOINT override.
//   LATENCY_GATEWAY_URL   AI Gateway base, e.g. https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic  (POSTs to <base>/v1/messages)
//   CF_AIG_TOKEN          gateway token (cf-aig-authorization). Sent only to a LATENCY_GATEWAY_URL gateway. With BYOK the gateway holds the Anthropic key and ANTHROPIC_API_KEY is not needed.
//   LATENCY_ENDPOINT      full URL override (for example a Worker preview route that forwards the same body). Takes precedence over the gateway URL. Treated as a direct endpoint: only x-api-key (when ANTHROPIC_API_KEY is set) is sent, never cf-aig-authorization.
//   LATENCY_MODEL_DEEP / LATENCY_MODEL_FAST   model ids (defaults claude-sonnet-5-5 / claude-haiku-5-5, the research defaults; unverified until a real call)
// Flags:   --n N (default 20 per phase) --prompt-chars C (default 12000, roughly 3-4k tokens) --pause-ms P (default 500) --compose-limit-ms (6000) --retry-limit-ms (3000)
//          --compose-p95-ms (5000) --retry-p95-ms (2500) --live (REQUIRED for any real request; without it the run is a dry run) --dry-run (accepted, same as the default) --json
// Output:  per phase: latency median/p95/max, time to first byte (response headers), token counts, share over the timeout, status counts; then PASS/FAIL against the p95 gates.
//          Default is a DRY RUN against a loopback fake endpoint: no key is used and no request leaves the machine, even when a key is set. A live run needs --live AND a credential.
//          Exit code: 0 when RESULT is PASS, 1 when RESULT is FAIL (dry or live), 2 on a usage or configuration error. Gates are inclusive: p95 <= gate passes; any failed call fails the phase.
//          Only numbers and fixed words are printed: never a key, a header, a prompt or a reply. Every string that is printed passes through a scrub of the secret values.
// Safety:  sends fictional prompts only (a run-time check refuses a body containing any roster name). Spend: n x 2 calls of about 4k input and up to 700 output tokens.
import http from "node:http";
import { fileURLToPath } from "node:url";
import { researchMembers, genericAliases } from "../infrastructure/worker/privacy/roster-config.js";
import { questionFor, sheetsFor, systemPromptFor, userPromptFor, summarise } from "./research-synthetic.mjs";

export const DEFAULTS = { n: 20, promptChars: 12000, pauseMs: 500, composeLimitMs: 6000, retryLimitMs: 3000, composeP95Ms: 5000, retryP95Ms: 2500, maxTokens: 700, hardCapMs: 30000 };
const MODEL_DEEP = "claude-sonnet-5-5";
const MODEL_FAST = "claude-haiku-5-5";

export function secretsIn(env) {
  return [env.ANTHROPIC_API_KEY, env.CF_AIG_TOKEN].filter((v) => typeof v === "string" && v.length >= 8);
}
export function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
}

// Where the request goes and which headers authenticate it. Throws a message with no values when nothing is configured.
export function resolveTarget(env) {
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  // Credential rule: send only what the chosen endpoint needs. Direct (api.anthropic.com) and LATENCY_ENDPOINT get x-api-key only; only a gateway gets cf-aig-authorization.
  const gateway = Boolean(env.LATENCY_GATEWAY_URL) && !env.LATENCY_ENDPOINT;
  if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  if (gateway && env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  let url;
  if (env.LATENCY_ENDPOINT) url = env.LATENCY_ENDPOINT;
  else if (gateway) url = `${env.LATENCY_GATEWAY_URL.replace(/\/+$/, "")}/v1/messages`;
  else url = "https://api.anthropic.com/v1/messages";
  if (!env.ANTHROPIC_API_KEY && !(gateway && env.CF_AIG_TOKEN) && !env.LATENCY_ENDPOINT) {
    throw new Error("no credential in the environment: set ANTHROPIC_API_KEY, or LATENCY_GATEWAY_URL with CF_AIG_TOKEN (BYOK), or LATENCY_ENDPOINT; or drop --live for a dry run");
  }
  return { url, headers };
}

function refuseFriendText(bodyText) {
  const lower = bodyText.toLowerCase();
  for (const m of researchMembers()) {
    for (const n of [m.display, ...(m.aliases || [])]) {
      const k = String(n).toLowerCase();
      if (k.length >= 4 && !genericAliases.includes(k) && lower.includes(k)) throw new Error("refusing to send: the synthetic prompt contains a roster name");
    }
  }
}

export function buildBody(i, model, { promptChars = DEFAULTS.promptChars, maxTokens = DEFAULTS.maxTokens, question: questionOverride } = {}) {
  const question = questionOverride ?? questionFor(i, { nonce: `${Date.now().toString(36)}-${i}` }); // the nonce keeps every prompt unique so no cache can answer it
  const system = systemPromptFor(Math.floor(promptChars / 3));
  const user = userPromptFor({ question, sheets: sheetsFor(), chars: Math.floor((promptChars * 2) / 3) });
  const body = { model, max_tokens: maxTokens, system: [{ type: "text", text: system }], messages: [{ role: "user", content: user }] };
  const text = JSON.stringify(body);
  refuseFriendText(text);
  return text;
}

// One non-streaming call. Never throws: returns { ok, status, ttfbMs, totalMs, inputTokens, outputTokens, error } where error is a fixed class, never a message with values.
export async function callOnce({ fetchImpl = fetch, target, bodyText, hardCapMs = DEFAULTS.hardCapMs, secrets = [] }) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), hardCapMs);
  try {
    const resp = await fetchImpl(target.url, { method: "POST", headers: target.headers, body: bodyText, redirect: "error", signal: ctl.signal });
    const ttfbMs = performance.now() - t0;
    const raw = await resp.text();
    const totalMs = performance.now() - t0;
    let usage = null;
    try { usage = JSON.parse(raw).usage || null; } catch {}
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { ok: resp.ok, status: resp.status, ttfbMs, totalMs, inputTokens: num(usage && usage.input_tokens), outputTokens: num(usage && usage.output_tokens), error: resp.ok ? null : `http-${resp.status}` };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    // The message is dropped on purpose (it could echo a URL or header); only a scrubbed error name survives.
    return { ok: false, status: 0, ttfbMs: null, totalMs: performance.now() - t0, inputTokens: null, outputTokens: null, error: aborted ? "hard-cap" : `fetch-${scrub(e && e.name ? e.name : "error", secrets).replace(/[^A-Za-z0-9-]/g, "").slice(0, 24) || "error"}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPhase({ label, model, n, limitMs, p95GateMs, target, fetchImpl, promptChars, pauseMs = 0, secrets = [], maxTokens }) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(await callOnce({ fetchImpl, target, bodyText: buildBody(i, model, { promptChars, maxTokens }), secrets }));
    if (pauseMs > 0 && i < n - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }
  const good = rows.filter((r) => r.ok);
  const lat = summarise(good.map((r) => r.totalMs));
  const ttfb = summarise(good.map((r) => r.ttfbMs));
  const status = {};
  for (const r of rows) status[r.error || "200"] = (status[r.error || "200"] || 0) + 1;
  const avg = (k) => { const v = good.map((r) => r[k]).filter((x) => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  // Failed calls count as over the limit: a timeout that never answered must not improve the share.
  const over = rows.filter((r) => !r.ok || r.totalMs > limitMs).length;
  return {
    label, model, n, ok: good.length, status, limitMs, p95GateMs,
    latency: lat, ttfb, inputTokensAvg: avg("inputTokens"), outputTokensAvg: avg("outputTokens"),
    overLimit: over, overLimitShare: n ? over / n : NaN,
    // Any failed call (timeout, 429, http error) fails the phase: p95 over successes alone would hide them.
    failed: rows.length - good.length,
    pass: rows.length > 0 && good.length === rows.length && lat.p95 <= p95GateMs,
  };
}

const f = (n) => (Number.isFinite(n) ? Math.round(n) : "n/a");
export function format(r) {
  const lines = [r.dryRun ? "DRY RUN: fake local endpoint, these numbers say nothing about Anthropic" : "LIVE RUN against the configured endpoint", `n=${r.phases[0].n} per phase, prompt_chars~${r.promptChars}`, ""];
  for (const p of r.phases) {
    lines.push(`${p.label} (${p.model}) ok=${p.ok}/${p.n} status=${JSON.stringify(p.status)}`);
    lines.push(`  latency ms  median ${f(p.latency.median)}  p95 ${f(p.latency.p95)}  max ${f(p.latency.max)}   (gate p95 <= ${p.p95GateMs}, inclusive)`);
    lines.push(`  ttfb ms     median ${f(p.ttfb.median)}  p95 ${f(p.ttfb.p95)}  max ${f(p.ttfb.max)}   (response headers; non-streaming, so this is close to total)`);
    lines.push(`  tokens avg  input ${p.inputTokensAvg ?? "n/a"}  output ${p.outputTokensAvg ?? "n/a"}`);
    lines.push(`  over ${p.limitMs} ms (planned timeout): ${p.overLimit}/${p.n} = ${(p.overLimitShare * 100).toFixed(1)}%   failures count as over`);
    lines.push(`  ${p.pass ? "PASS" : "FAIL"}${p.failed ? ` (${p.failed} failed call${p.failed === 1 ? "" : "s"}; any failed call fails the phase)` : ""}`);
  }
  lines.push("", r.ok ? "RESULT: PASS" : "RESULT: FAIL");
  if (r.dryRun) lines.push("Dry run is the default. No request left this machine. To send real requests add --live (needs ANTHROPIC_API_KEY, or LATENCY_GATEWAY_URL with CF_AIG_TOKEN, or LATENCY_ENDPOINT).");
  return lines.join("\n");
}

// ---- the fake endpoint used by --dry-run -----------------------------------------------------------------------------------------------------------
export function startFakeEndpoint({ delayMs = 20, inputTokens = 3500, outputTokens = 420 } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "fake", type: "message", content: [{ type: "text", text: "fake reply" }], usage: { input_tokens: inputTokens, output_tokens: outputTokens } }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/messages` })));
}

export async function measure(opts, env = process.env, fetchImpl = fetch) {
  const o = { ...DEFAULTS, ...opts };
  const secrets = secretsIn(env);
  let fake = null;
  let target;
  const dry = o.live !== true; // live only on an explicit --live
  if (dry) {
    fake = await startFakeEndpoint(o.fake || {});
    target = { url: fake.url, headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" } }; // no credential of any kind in dry-run
  } else {
    target = resolveTarget(env);
  }
  try {
    const common = { target, fetchImpl, promptChars: o.promptChars, pauseMs: dry ? 0 : o.pauseMs, secrets, maxTokens: o.maxTokens, n: o.n };
    const compose = await runPhase({ ...common, label: "compose", model: env.LATENCY_MODEL_DEEP || MODEL_DEEP, limitMs: o.composeLimitMs, p95GateMs: o.composeP95Ms });
    const retry = await runPhase({ ...common, label: "retry", model: env.LATENCY_MODEL_FAST || MODEL_FAST, limitMs: o.retryLimitMs, p95GateMs: o.retryP95Ms });
    return { dryRun: dry, promptChars: o.promptChars, phases: [compose, retry], ok: compose.pass && retry.pass };
  } finally {
    if (fake) await new Promise((r) => fake.server.close(r));
  }
}

export function parseArgs(argv) {
  const o = { live: false, dryRun: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => { const v = Number(argv[++i]); if (!Number.isFinite(v) || v < 0) throw new Error(`${a} needs a non-negative number`); return v; };
    if (a === "--live") { o.live = true; o.dryRun = false; }
    else if (a === "--dry-run") { o.live = false; o.dryRun = true; }
    else if (a === "--json") o.json = true;
    else if (a === "--n") o.n = Math.max(1, Math.floor(num()));
    else if (a === "--prompt-chars") o.promptChars = Math.floor(num());
    else if (a === "--pause-ms") o.pauseMs = num();
    else if (a === "--compose-limit-ms") o.composeLimitMs = num();
    else if (a === "--retry-limit-ms") o.retryLimitMs = num();
    else if (a === "--compose-p95-ms") o.composeP95Ms = num();
    else if (a === "--retry-p95-ms") o.retryP95Ms = num();
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const secrets = secretsIn(process.env);
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = await measure(opts);
    process.stdout.write(`${scrub(opts.json ? JSON.stringify(r, null, 2) : format(r), secrets)}\n`);
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(`measure-claude-latency: ${scrub(e.message, secrets)}\n`);
    process.exitCode = 2;
  }
}
