// Unit tests for tools/measure-research-cpu.mjs and tools/measure-claude-latency.mjs. Fictional text only. No network except a loopback fake endpoint, no key.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measure as measureCpu, format as formatCpu, parseArgs as parseCpuArgs, verdict as cpuVerdict, PROXY_NOTICE } from "../../tools/measure-research-cpu.mjs";
import { measure as measureLat, format as formatLat, parseArgs as parseLatArgs, scrub, resolveTarget, runPhase, callOnce, buildBody, DEFAULTS } from "../../tools/measure-claude-latency.mjs";
import { researchMembers, genericAliases } from "../../infrastructure/worker/privacy/roster-config.js";
import { questionFor, summarise, percentile } from "../../tools/research-synthetic.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (script, args, env = {}) => spawnSync(process.execPath, [path.join(root, "tools", script), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const FAKE_KEY = "sk-ant-api03-FAKEKEYFORTESTSONLY1234567890abcdef";

// Every string a friend could own: roster display names and aliases (except plain game words), plus every synthetic question.
function friendStrings() {
  const out = [];
  for (const m of researchMembers()) for (const n of [m.display, ...m.aliases]) if (String(n).length >= 4 && !["mage", "tank"].includes(String(n).toLowerCase())) out.push(String(n));
  return out;
}
const assertNoFriendText = (text) => {
  for (const n of friendStrings()) assert.ok(!text.toLowerCase().includes(n.toLowerCase()), "output must not contain a roster name");
  for (let i = 0; i < 10; i++) assert.ok(!text.includes(questionFor(i).slice(0, 30)), "output must not contain prompt text");
};

test("percentile and summarise are nearest-rank", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  const s = summarise([5, 1, 3]);
  assert.deepEqual([s.n, s.median, s.max], [3, 3, 5]);
});

test("cpu tool: small run produces stages, compares to the budget and states the proxy limit", () => {
  const r = measureCpu({ iterations: 5, budgetMs: 100000 });
  assert.equal(r.iterations, 5);
  for (const k of ["prompt build", "tokenise", "guards", "clean+label", "total"]) assert.ok(Number.isFinite(r.stages[k].wall.median), k);
  assert.equal(r.ok, true);
  const text = formatCpu(r);
  assert.ok(text.includes("PROXY ONLY") && text.includes("not Worker CPU") && text.includes("Workers observability"));
  assert.ok(PROXY_NOTICE.includes("authoritative"));
  assertNoFriendText(text);
});

test("cpu tool: a tiny budget fails and exits 1; default budget is 10 ms; env and flag configure it", () => {
  const r = measureCpu({ iterations: 5, budgetMs: 0.000001 });
  assert.equal(r.ok, false);
  assert.match(formatCpu(r), /OVER/);
  assert.equal(parseCpuArgs([], {}).budgetMs, 10);
  assert.equal(parseCpuArgs([], { RESEARCH_CPU_BUDGET_MS: "7" }).budgetMs, 7);
  assert.equal(parseCpuArgs(["--budget-ms", "3"], { RESEARCH_CPU_BUDGET_MS: "7" }).budgetMs, 3);
  assert.equal(parseCpuArgs([], {}).iterations, 100);
  assert.throws(() => parseCpuArgs(["--bogus"], {}));
  const p = run("measure-research-cpu.mjs", ["--iterations", "3", "--budget-ms", "0.000001"]);
  assert.equal(p.status, 1);
  assertNoFriendText(p.stdout + p.stderr);
});

test("latency tool: dry run uses a fake endpoint, needs no key, passes, and prints no secret or friend text", async () => {
  const r = await measureLat({ dryRun: true, n: 3 }, {});
  assert.equal(r.dryRun, true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases.map((p) => [p.label, p.ok, p.n]), [["compose", 3, 3], ["retry", 3, 3]]);
  assert.equal(r.phases[0].inputTokensAvg, 3500);
  assert.equal(r.phases[0].overLimit, 0);
  const text = formatLat(r);
  assert.match(text, /DRY RUN/);
  assertNoFriendText(text);
  const p = run("measure-claude-latency.mjs", ["--dry-run", "--n", "2"], { ANTHROPIC_API_KEY: FAKE_KEY });
  assert.equal(p.status, 0, p.stderr);
  assert.ok(!(p.stdout + p.stderr).includes(FAKE_KEY));
  assert.ok(!(p.stdout + p.stderr).includes("FAKEKEYFORTESTS"));
  assertNoFriendText(p.stdout + p.stderr);
});

test("latency tool: share over the limit, failures count as over, gates fail the run", async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 30)); return new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }); };
  const target = { url: "http://x.invalid/v1/messages", headers: {} };
  const over = await runPhase({ label: "compose", model: "m", n: 4, limitMs: 10, p95GateMs: 1000, target, fetchImpl: slow, promptChars: 600 });
  assert.equal(over.overLimit, 4);
  assert.equal(over.overLimitShare, 1);
  assert.equal(over.pass, true); // p95 30 ms is under its 1000 ms gate even though every call exceeded the 10 ms limit
  const tight = await runPhase({ label: "retry", model: "m", n: 3, limitMs: 10, p95GateMs: 5, target, fetchImpl: slow, promptChars: 600 });
  assert.equal(tight.pass, false);
  const failing = async () => new Response("{}", { status: 529 });
  const bad = await runPhase({ label: "compose", model: "m", n: 3, limitMs: 6000, p95GateMs: 5000, target, fetchImpl: failing, promptChars: 600 });
  assert.equal(bad.ok, 0);
  assert.equal(bad.overLimitShare, 1);
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.status, { "http-529": 3 });
});

test("latency tool: the key is sent as a header only and never printed, even when a transport error echoes it", async () => {
  const env = { ANTHROPIC_API_KEY: FAKE_KEY };
  const target = resolveTarget(env);
  assert.equal(target.headers["x-api-key"], FAKE_KEY);
  assert.equal(target.url, "https://api.anthropic.com/v1/messages");
  const seen = [];
  const echoing = async (url, init) => { seen.push(init.body); const e = new Error(`connect failed for ${url} with key ${FAKE_KEY}`); e.name = `Err${FAKE_KEY}`; throw e; };
  const res = await callOnce({ fetchImpl: echoing, target, bodyText: buildBody(0, "m", { promptChars: 600 }), secrets: [FAKE_KEY] });
  assert.equal(res.ok, false);
  assert.ok(!JSON.stringify(res).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(res).includes("FAKEKEYFORTESTS"));
  assert.ok(!seen[0].includes(FAKE_KEY), "the key is not in the body");
  assert.equal(scrub(`a ${FAKE_KEY} b sk-ant-zzzzzzzz c`, [FAKE_KEY]), "a [redacted] b [redacted] c");
  const phase = await runPhase({ label: "compose", model: "m", n: 2, limitMs: 1, p95GateMs: 1, target, fetchImpl: echoing, promptChars: 600, secrets: [FAKE_KEY] });
  assert.ok(!JSON.stringify(phase).includes("FAKEKEYFORTESTS"));
});

test("latency tool: a live run with no credential refuses with exit 2; gateway BYOK needs only the token", () => {
  const p = run("measure-claude-latency.mjs", ["--live", "--n", "1"]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /no credential/);
  assert.throws(() => resolveTarget({ LATENCY_GATEWAY_URL: "https://gw.invalid/v1/a/b/anthropic" }));
  const t = resolveTarget({ LATENCY_GATEWAY_URL: "https://gw.invalid/v1/a/b/anthropic/", CF_AIG_TOKEN: "tokentokentoken" });
  assert.equal(t.url, "https://gw.invalid/v1/a/b/anthropic/v1/messages");
  assert.ok(!("x-api-key" in t.headers));
  assert.equal(t.headers["cf-aig-authorization"], "Bearer tokentokentoken");
  assert.equal(resolveTarget({ LATENCY_ENDPOINT: "https://preview.invalid/x", ANTHROPIC_API_KEY: FAKE_KEY }).url, "https://preview.invalid/x");
});

test("latency tool: each endpoint gets only the credential it needs", () => {
  const key = FAKE_KEY, tok = "tokentokentoken";
  const both = { ANTHROPIC_API_KEY: key, CF_AIG_TOKEN: tok };
  // LATENCY_ENDPOINT is a direct-style endpoint: x-api-key only, never the gateway token.
  const ep = resolveTarget({ ...both, LATENCY_ENDPOINT: "https://preview.invalid/x", LATENCY_GATEWAY_URL: "https://gw.invalid/v1/a/b/anthropic" });
  assert.equal(ep.headers["x-api-key"], key);
  assert.ok(!("cf-aig-authorization" in ep.headers));
  // endpoint with only the gateway token: no credential at all is sent
  const epTok = resolveTarget({ CF_AIG_TOKEN: tok, LATENCY_ENDPOINT: "https://preview.invalid/x" });
  assert.ok(!("cf-aig-authorization" in epTok.headers) && !("x-api-key" in epTok.headers));
  // direct Anthropic: x-api-key only
  const direct = resolveTarget(both);
  assert.equal(direct.url, "https://api.anthropic.com/v1/messages");
  assert.equal(direct.headers["x-api-key"], key);
  assert.ok(!("cf-aig-authorization" in direct.headers));
  // gateway: token, plus the key for non-BYOK
  const gw = resolveTarget({ ...both, LATENCY_GATEWAY_URL: "https://gw.invalid/v1/a/b/anthropic" });
  assert.equal(gw.headers["cf-aig-authorization"], `Bearer ${tok}`);
  assert.equal(gw.headers["x-api-key"], key);
});

test("latency tool: any failed call fails the phase (1 ok + 29 timeouts, 29 x 429)", async () => {
  const target = { url: "http://x.invalid/v1/messages", headers: {} };
  let c = 0;
  const oneOkThenTimeouts = async () => {
    if (c++ === 0) return new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    const e = new Error("t"); e.name = "AbortError"; throw e;
  };
  const a = await runPhase({ label: "compose", model: "m", n: 30, limitMs: 6000, p95GateMs: 5000, target, fetchImpl: oneOkThenTimeouts, promptChars: 600 });
  assert.equal(a.ok, 1);
  assert.equal(a.failed, 29);
  assert.equal(a.pass, false);
  assert.deepEqual(a.status, { "200": 1, "hard-cap": 29 });
  let d = 0;
  const oneOkThen429 = async () => new Response(d++ === 0 ? JSON.stringify({ usage: {} }) : "{}", { status: d === 1 ? 200 : 429 });
  const b = await runPhase({ label: "retry", model: "m", n: 30, limitMs: 3000, p95GateMs: 2500, target, fetchImpl: oneOkThen429, promptChars: 600 });
  assert.equal(b.failed, 29);
  assert.equal(b.pass, false);
  const text = formatLat({ dryRun: false, promptChars: 600, phases: [a, b], ok: false });
  assert.match(text, /RESULT: FAIL/);
  assert.match(text, /29 failed calls/);
  // all-success with the same gates still passes
  const good = async () => new Response(JSON.stringify({ usage: {} }), { status: 200 });
  assert.equal((await runPhase({ label: "x", model: "m", n: 5, limitMs: 6000, p95GateMs: 5000, target, fetchImpl: good, promptChars: 600 })).pass, true);
});

test("latency tool: dry run is the default; a key without --live sends nothing off the machine", async () => {
  assert.deepEqual(parseLatArgs([]), { live: false, dryRun: true, json: false });
  assert.deepEqual(parseLatArgs(["--live"]), { live: true, dryRun: false, json: false });
  const urls = [];
  const spy = async (url, init) => { urls.push(String(url)); return fetch(url, init); };
  const r = await measureLat({ n: 2 }, { ANTHROPIC_API_KEY: FAKE_KEY, CF_AIG_TOKEN: "tokentokentoken", LATENCY_ENDPOINT: "https://preview.invalid/x" }, spy);
  assert.equal(r.dryRun, true);
  assert.equal(urls.length, 4);
  for (const u of urls) assert.ok(u.startsWith("http://127.0.0.1:"), "only the loopback fake is contacted");
  const p = run("measure-claude-latency.mjs", ["--n", "2"], { ANTHROPIC_API_KEY: FAKE_KEY, LATENCY_ENDPOINT: "http://127.0.0.1:9/never" });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /DRY RUN/);
  assert.match(p.stdout, /add --live/);
  assert.ok(!(p.stdout + p.stderr).includes(FAKE_KEY));
});

test("latency tool: guard pins (roster-name refusal, no credential in dry run, default gates, exit code)", async () => {
  // refuseFriendText: removing the call in buildBody makes this stop throwing.
  const name = friendStrings().find((n) => !genericAliases.includes(n.toLowerCase()));
  assert.ok(name);
  assert.throws(() => buildBody(0, "m", { promptChars: 600, question: `please ask about ${name} tonight` }), /roster name/);
  // dry run sends no credential of any kind, even with both set in the environment.
  const seen = [];
  const spy = async (url, init) => { seen.push(init.headers); return fetch(url, init); };
  await measureLat({ n: 1 }, { ANTHROPIC_API_KEY: FAKE_KEY, CF_AIG_TOKEN: "tokentokentoken" }, spy);
  assert.ok(seen.length === 2);
  for (const h of seen) assert.deepEqual(Object.keys(h).sort(), ["anthropic-version", "content-type"]);
  // default gates
  assert.equal(DEFAULTS.composeP95Ms, 5000);
  assert.equal(DEFAULTS.retryP95Ms, 2500);
  const r = await measureLat({ n: 1 }, {});
  assert.deepEqual(r.phases.map((p) => p.p95GateMs), [5000, 2500]);
  // dry-run exit code follows RESULT
  const fail = run("measure-claude-latency.mjs", ["--n", "2", "--compose-p95-ms", "0", "--retry-p95-ms", "0"]);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /RESULT: FAIL/);
  assert.equal(run("measure-claude-latency.mjs", ["--n", "2"]).status, 0);
});

test("cpu tool: the verdict needs the p95 term and the gate is inclusive", () => {
  assert.equal(cpuVerdict({ median: 1, p95: 20 }, 10, 1).ok, false, "median under, p95 over must fail");
  assert.equal(cpuVerdict({ median: 20, p95: 1 }, 10, 1).ok, false);
  assert.equal(cpuVerdict({ median: 10, p95: 10 }, 10, 1).ok, true, "equal to the budget passes");
  assert.equal(cpuVerdict({ median: 1, p95: 1 }, 10, 50).ok, true, "the mean does not gate");
});

test("latency tool: request shape is non-streaming, max_tokens 700, prompt of a few thousand tokens, unique per call, no roster name", () => {
  const a = JSON.parse(buildBody(0, "model-x"));
  assert.equal(a.max_tokens, 700);
  assert.equal(a.model, "model-x");
  assert.ok(!("stream" in a));
  const chars = JSON.stringify(a).length;
  assert.ok(chars > 10000 && chars < 20000, `prompt chars ${chars}`);
  assert.notEqual(buildBody(1, "m"), buildBody(2, "m"));
  assert.deepEqual(parseLatArgs(["--n", "7", "--dry-run"]), { live: false, dryRun: true, json: false, n: 7 });
});
