// tools/cf-budget-check.mjs: the pre-flight that refuses to start a preview spin-up or a production deploy when the daily budget (.github/cf-budget.json) is used up. A fake GitHub API; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { validateBudget, countToday, preflight, overrideLabels, utcDay, jobDidWork } from "../../tools/cf-budget-check.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const budget = validateBudget(JSON.parse(readFileSync(path.join(ROOT, ".github", "cf-budget.json"), "utf8")));
const NOW = new Date("2026-11-23T10:00:00Z");
const SPIN = budget.jobs.spinUp, DEPLOY = budget.jobs.deploy;

// A fake of the three GitHub endpoints the tool reads. runs: [{ id, event, created_at, jobs: [{ name, conclusion, started_at }] }] per workflow file.
function fakeGh({ runs = {}, prsOfCommit = [], fail = null, perPage = 100, jobsShort = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url), p = u.pathname;
    calls.push(`${u.pathname}${u.search}`);
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (fail && fail(p)) return json(500, {});
    let m;
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/runs$/.exec(p))) {
      const all = (runs[m[1]] || []).filter((r) => r.created_at.slice(0, 10) >= u.searchParams.get("created").replace(">=", ""));
      const page = Number(u.searchParams.get("page") || 1);
      return json(200, { total_count: all.length, workflow_runs: all.slice((page - 1) * perPage, page * perPage) });
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/.exec(p))) {
      const run = Object.values(runs).flat().find((r) => String(r.id) === m[1]);
      return json(200, { total_count: jobsShort ? run.jobs.length + 1 : run.jobs.length, jobs: run.jobs });
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/pulls$/.exec(p))) return json(200, prsOfCommit);
    return json(404, {});
  };
  return { fetchImpl, calls };
}
const job = (name, conclusion = "success", started = true, steps) => ({ name, conclusion, status: "completed", started_at: started ? "2026-11-23T01:00:00Z" : null, ...(steps ? { steps: steps.map((c) => ({ conclusion: c })) } : {}) });
const run = (id, jobs, event = "pull_request", at = "2026-11-23T01:00:00Z") => ({ id, event, created_at: at, jobs });
const base = { token: "t", repo: "o/r", runId: "999", now: NOW };

test("the budget file is valid, tracked in the repo, and says 3 spin-ups and 2 deploying merges a day", () => {
  assert.equal(budget.spinUpsPerDay, 3);
  assert.equal(budget.deployingMergesPerDay, 2);
  assert.equal(budget.overrideLabel, "cf-budget-override");
  for (const bad of [null, {}, { ...budget, version: 2 }, { ...budget, spinUpsPerDay: -1 }, { ...budget, spinUpsPerDay: 1.5 }, { ...budget, overrideLabel: "a;b" }, { ...budget, jobs: {} }, { ...budget, workflows: { spinUp: "" , deploy: "x" } }]) assert.throws(() => validateBudget(bad), /cf-budget/);
});

test("counts only today's runs of the other kind that have a started job; skipped jobs, other days, this run and other events do not count", async () => {
  const gh = fakeGh({ runs: { "pr-preview-cloudflare.yml": [
    run(1, [job(SPIN)]),                                  // counts
    run(2, [job(SPIN, "failure")]),                       // started and failed: it spent the deploy
    run(3, [job(SPIN, "cancelled")]),                     // started, then cancelled: counts
    run(4, [job(SPIN, "skipped", false)]),                // a light run: skipped
    run(5, [job("Fork policy and classify")]),            // no spin-up job at all
    run(6, [job(SPIN)], "pull_request", "2026-11-22T23:59:00Z"), // yesterday
    run(999, [job(SPIN)]),                                // this run
    run(7, [job(SPIN)], "schedule"),                      // another event
  ] } });
  const n = await countToday({ ...base, fetchImpl: gh.fetchImpl, day: utcDay(NOW), workflowFile: budget.workflows.spinUp, jobName: SPIN, events: ["pull_request"] });
  assert.equal(n, 3);
});

test("a spin-up inside the budget is allowed; at the budget it is refused with the reason; the label is the only way past", async () => {
  const two = fakeGh({ runs: { "pr-preview-cloudflare.yml": [run(1, [job(SPIN)]), run(2, [job(SPIN)])] } });
  const ok = await preflight({ ...base, kind: "spinup", budget, fetchImpl: two.fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [{ name: "ci-full" }] } }) });
  assert.equal(ok.ok, true); assert.equal(ok.used, 2); assert.equal(ok.limit, 3);
  const three = fakeGh({ runs: { "pr-preview-cloudflare.yml": [1, 2, 3].map((i) => run(i, [job(SPIN)])) } });
  const no = await preflight({ ...base, kind: "spinup", budget, fetchImpl: three.fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [{ name: "ci-full" }] } }) });
  assert.equal(no.ok, false);
  assert.match(no.lines.join("\n"), /REFUSING TO START/);
  assert.match(no.lines.join("\n"), /cf-budget-override/);
  const over = await preflight({ ...base, kind: "spinup", budget, fetchImpl: three.fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [{ name: "ci-full" }, { name: "cf-budget-override" }] } }) });
  assert.equal(over.ok, true); assert.equal(over.overridden, true);
  const lookalike = await preflight({ ...base, kind: "spinup", budget, fetchImpl: three.fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [{ name: "cf-budget-override-please" }, { name: "Cf-Budget-Override" }] } }) });
  assert.equal(lookalike.ok, false, "only the exact label name overrides");
});

test("a deploy counts push and manual runs; the label can be on a pull request merged into the commit, or the manual input", async () => {
  const gh = fakeGh({ runs: { "deploy-cloudflare.yml": [run(1, [job(DEPLOY)], "push"), run(2, [job(DEPLOY, "failure")], "workflow_dispatch"), run(3, [job("Post-deploy smoke")], "push")] }, prsOfCommit: [{ labels: [{ name: "x" }] }] });
  const no = await preflight({ ...base, kind: "deploy", budget, fetchImpl: gh.fetchImpl, eventName: "push", sha: "abc" });
  assert.equal(no.ok, false); assert.equal(no.used, 2);
  const withLabel = fakeGh({ runs: { "deploy-cloudflare.yml": [run(1, [job(DEPLOY)], "push"), run(2, [job(DEPLOY)], "push")] }, prsOfCommit: [{ labels: [{ name: "cf-budget-override" }] }] });
  assert.equal((await preflight({ ...base, kind: "deploy", budget, fetchImpl: withLabel.fetchImpl, eventName: "push", sha: "abc" })).ok, true);
  assert.equal((await preflight({ ...base, kind: "deploy", budget, fetchImpl: gh.fetchImpl, eventName: "workflow_dispatch", manualOverride: true })).ok, true, "the manual input overrides");
  assert.equal((await preflight({ ...base, kind: "deploy", budget, fetchImpl: gh.fetchImpl, eventName: "workflow_dispatch", manualOverride: false })).ok, false);
});

test("FAIL CLOSED: an API error, an incomplete jobs list, a malformed answer or a network error refuses, and only the label lets it through", async () => {
  const cases = [
    fakeGh({ fail: (p) => /\/runs$/.test(p) }),
    { fetchImpl: async () => { throw new Error("socket hang up"); } },
    { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) }) },
    { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) },
  ];
  for (const c of cases) {
    const r = await preflight({ ...base, kind: "spinup", budget, fetchImpl: c.fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [] } }) });
    assert.equal(r.ok, false, "refuses without a count");
    assert.match(r.lines.join("\n"), /Refusing to start \(fail closed\)/);
    const o = await preflight({ ...base, kind: "spinup", budget, fetchImpl: c.fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [{ name: "cf-budget-override" }] } }) });
    assert.equal(o.ok, true, "the label goes ahead even without a count");
  }
  // an unreadable event payload gives no override
  const gh = fakeGh({ fail: () => true });
  const r = await preflight({ ...base, kind: "spinup", budget, fetchImpl: gh.fetchImpl, eventName: "pull_request", readEvent: () => { throw new Error("no event file"); } });
  assert.equal(r.ok, false);
});

test("it reads every page of runs, and refuses to guess when there are more than 3,000", async () => {
  const many = Array.from({ length: 250 }, (_, i) => run(1000 + i, [job("Fork policy and classify")]));
  many.push(run(5000, [job(SPIN)]));
  const gh = fakeGh({ runs: { "pr-preview-cloudflare.yml": many }, perPage: 100 });
  const n = await countToday({ ...base, fetchImpl: gh.fetchImpl, day: utcDay(NOW), workflowFile: budget.workflows.spinUp, jobName: SPIN, events: ["pull_request"] });
  assert.equal(n, 1);
  assert.ok(gh.calls.filter((c) => /\/runs\?/.test(c)).length >= 3, "three pages of runs were read");
});

test("overrideLabels: pull request labels from the event file; for a push the labels of the pull requests of the commit; nothing for anything else", async () => {
  assert.deepEqual(await overrideLabels({ eventName: "pull_request", eventPath: "x", readEvent: () => ({ pull_request: { labels: [{ name: "a" }, { name: "b" }] } }) }), ["a", "b"]);
  const gh = fakeGh({ prsOfCommit: [{ labels: [{ name: "c" }] }, { labels: [] }] });
  assert.deepEqual(await overrideLabels({ fetchImpl: gh.fetchImpl, token: "t", repo: "o/r", eventName: "push", sha: "abc" }), ["c"]);
  assert.deepEqual(await overrideLabels({ eventName: "schedule" }), []);
});

test("workflow wiring: the preview spin-up and the production deploy cannot start without the pre-flight, which is read-only", () => {
  const preview = parse(readFileSync(path.join(ROOT, ".github", "workflows", "pr-preview-cloudflare.yml"), "utf8")).jobs;
  assert.ok(preview["deploy-pr-preview"].needs.includes("budget-gate"));
  assert.equal(preview["teardown-pr-preview"].needs, undefined, "a teardown is never held up by the budget");
  assert.deepEqual(preview["budget-gate"].permissions, { contents: "read", "pull-requests": "read", actions: "read" });
  assert.ok(preview["budget-gate"].steps.some((s) => /cf-budget-check\.mjs spinup/.test(s.run || "")));
  const deployWf = parse(readFileSync(path.join(ROOT, ".github", "workflows", "deploy-cloudflare.yml"), "utf8"));
  assert.equal(deployWf.jobs["deploy-production"].needs, "budget-gate");
  assert.deepEqual(deployWf.jobs["budget-gate"].permissions, { contents: "read", "pull-requests": "read", actions: "read", issues: "write" }, "issues: write only for the sticky notice");
  assert.ok(deployWf.jobs["budget-gate"].steps.some((s) => /cf-budget-check\.mjs deploy/.test(s.run || "")));
  assert.equal(deployWf.on.workflow_dispatch.inputs.budget_override.default, false, "the manual override is off by default");
  for (const j of [preview["budget-gate"], deployWf.jobs["budget-gate"]]) assert.ok(!JSON.stringify(j).includes("CLOUDFLARE"), "the pre-flight holds no Cloudflare secret and calls no Cloudflare API");
});

test("a runs list that the API cuts short (fewer runs readable than total_count) is a failure, not a smaller count", async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (/\/runs$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ total_count: 1500, workflow_runs: Number(u.searchParams.get("page")) === 1 ? Array.from({ length: 100 }, (_, i) => run(i + 1, [job("x")])) : [] }) };
    return { ok: true, status: 200, json: async () => ({ total_count: 1, jobs: [job("x")] }) };
  };
  await assert.rejects(countToday({ ...base, fetchImpl, day: utcDay(NOW), workflowFile: budget.workflows.spinUp, jobName: SPIN, events: ["pull_request"] }), /cut short|capped/);
});

// The real history of UTC 2026-11-23 as GitHub returned it (the job lists of the runs that matter), plus a started-then-failed run. 2 of 3 is the truth; the gate once said 3.
const REAL = {
  teardownOnly: run(45087359183, [job("Tear Down Ephemeral PR Environment", "success", true, ["success", "success", "skipped", "success"]), job("Fork policy and classify", "skipped", true), job(SPIN, "skipped", true)]),
  realSuccess1: run(45094433395, [job("Fork policy and classify", "success", true, ["success"]), job(SPIN, "success", true, ["success", "success", "skipped", "success"])]),
  cancelledBeforeFirstStep: run(45094433420, [job("Fork policy and classify", "cancelled", true, []), job(SPIN, "cancelled", true, [])]),
  realSuccess2: run(45096702412, [job("Fork policy and classify", "success", true, ["success"]), job(SPIN, "success", true, ["success", "success", "skipped", "success"])]),
  refusedAtGate: run(45096972399, [job("Cloudflare daily budget pre-flight (spin-up)", "failure", true, ["success", "failure", "skipped"]), job(SPIN, "skipped", true)]),
  startedThenFailed: run(45097000001, [job(SPIN, "failure", true, ["success", "failure", "skipped"])]),
};
const countSpin = (runs, extra = {}) => countToday({ ...base, runId: "999", fetchImpl: fakeGh({ runs: { "pr-preview-cloudflare.yml": runs } }).fetchImpl, day: utcDay(NOW), workflowFile: budget.workflows.spinUp, jobName: SPIN, events: ["pull_request"], ...extra });

test("today's real history counts 2 of 3: a teardown-only run, a duplicate cancelled before its first step and a run refused at the gate count zero", async () => {
  const history = [REAL.teardownOnly, REAL.realSuccess1, REAL.cancelledBeforeFirstStep, REAL.realSuccess2];
  assert.equal(await countSpin(history), 2);
  const r = await preflight({ ...base, kind: "spinup", budget, fetchImpl: fakeGh({ runs: { "pr-preview-cloudflare.yml": [...history, REAL.refusedAtGate] } }).fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [] } }) });
  assert.equal(r.ok, true, "the next spin-up goes through by itself, no label");
  assert.match(r.lines.join("\n"), /: 2 of 3/);
});

test("each kind of run on its own: teardown-only 0, real success 1, cancelled before the first step 0, refused at the gate 0, started then failed 1", async () => {
  assert.equal(await countSpin([REAL.teardownOnly]), 0);
  assert.equal(await countSpin([REAL.realSuccess1]), 1);
  assert.equal(await countSpin([REAL.cancelledBeforeFirstStep]), 0);
  assert.equal(await countSpin([REAL.refusedAtGate]), 0);
  assert.equal(await countSpin([REAL.startedThenFailed]), 1, "it spent the deploy");
  const cancelledMidway = run(45097000002, [job(SPIN, "cancelled", true, ["success", "success", "cancelled"])]);
  assert.equal(await countSpin([cancelledMidway]), 1, "started real work, then cancelled: counts");
  const stillRunning = run(45097000003, [{ name: SPIN, status: "in_progress", conclusion: null, started_at: "2026-11-23T02:00:00Z", steps: [{ conclusion: "success" }, { conclusion: null }] }]);
  assert.equal(await countSpin([stillRunning]), 1, "a spin-up running right now counts");
  assert.equal(jobDidWork({ name: SPIN, status: "queued", conclusion: null }), true, "waiting to run counts (it will spend)");
});

test("the deploy count is as honest: a deploy counts when the deploy job did work; refused at the gate (job skipped) or cancelled before its first step does not", async () => {
  const deploys = [
    run(1, [job("Cloudflare daily budget pre-flight (deploy)", "success", true, ["success"]), job(DEPLOY, "success", true, ["success", "success", "success"])], "push"),
    run(2, [job("Cloudflare daily budget pre-flight (deploy)", "failure", true, ["success", "failure"]), job(DEPLOY, "skipped", true)], "push"),
    run(3, [job(DEPLOY, "cancelled", true, [])], "push"),
    run(4, [job(DEPLOY, "failure", true, ["success", "failure"])], "workflow_dispatch"),
  ];
  const gh = fakeGh({ runs: { "deploy-cloudflare.yml": deploys } });
  const n = await countToday({ ...base, fetchImpl: gh.fetchImpl, day: utcDay(NOW), workflowFile: budget.workflows.deploy, jobName: DEPLOY, events: ["push", "workflow_dispatch"] });
  assert.equal(n, 2, "the real deploy and the one that started and failed");
});

test("a run whose jobs cannot be read is counted (fail closed) and named in the log", async () => {
  const gh = fakeGh({ runs: { "pr-preview-cloudflare.yml": [REAL.realSuccess1, run(777, [job(SPIN)])] }, fail: (p) => /runs\/777\/jobs$/.test(p) });
  const notes = [];
  assert.equal(await countToday({ ...base, fetchImpl: gh.fetchImpl, day: utcDay(NOW), workflowFile: budget.workflows.spinUp, jobName: SPIN, events: ["pull_request"], notes }), 2);
  assert.match(notes.join(" "), /run 777.*could not be read.*counted/);
  const short = fakeGh({ runs: { "pr-preview-cloudflare.yml": [run(888, [job(SPIN)])] }, jobsShort: true });
  const n2 = [];
  assert.equal(await countToday({ ...base, fetchImpl: short.fetchImpl, day: utcDay(NOW), workflowFile: budget.workflows.spinUp, jobName: SPIN, events: ["pull_request"], notes: n2 }), 1);
  assert.match(n2.join(" "), /run 888/);
  const r = await preflight({ ...base, kind: "spinup", budget, fetchImpl: gh.fetchImpl, eventName: "pull_request", readEvent: () => ({ pull_request: { labels: [] } }) });
  assert.match(r.lines.join("\n"), /run 777/, "the preflight log names the run");
});
