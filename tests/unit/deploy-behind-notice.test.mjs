// A deploy refused by the budget pre-flight must never leave a fix undelivered silently: a sticky issue says "Production is behind master", a nightly catch-up workflow delivers it, the next successful
// deploy closes the notice. The github-script bodies of deploy-cloudflare.yml are compiled and run here against a fake GitHub client.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wf = parse(readFileSync(path.join(ROOT, ".github", "workflows", "deploy-cloudflare.yml"), "utf8"));
const catchup = parse(readFileSync(path.join(ROOT, ".github", "workflows", "deploy-catchup.yml"), "utf8"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const MARKER = "<!-- production-behind-master -->";

const scriptOf = (job, nameRe) => wf.jobs[job].steps.find((s) => nameRe.test(s.name)).with.script;
function fakeGithub(issues = []) {
  const log = { created: [], updated: [], comments: [] };
  const github = {
    paginate: async (fn, params) => (params.state === "open" ? issues.filter((i) => i.state === "open") : issues),
    rest: { issues: {
      listForRepo: () => {},
      create: async (a) => { log.created.push(a); issues.push({ number: 100 + issues.length, state: "open", body: a.body, title: a.title }); },
      update: async (a) => { log.updated.push(a); const i = issues.find((x) => x.number === a.issue_number); if (a.body) i.body = a.body; if (a.state) i.state = a.state; },
      createComment: async (a) => { log.comments.push(a); },
    } },
  };
  return { github, log, issues };
}
const mkCore = () => { const out = {}, notices = []; return { out, notices, setOutput: (k, v) => { out[k] = v; }, notice: (m) => notices.push(m), summary: { addHeading() { return this; }, addRaw() { return this; }, write: async () => {} } }; };
const run = (script, github, core, context) => new AsyncFunction("github", "context", "core", script)(github, context, core);
const ctx = (eventName, extra = {}) => ({ eventName, repo: { owner: "o", repo: "r" }, sha: "abcdef1234567", runId: 42, serverUrl: "https://github.com", ...extra });

test("the deploy workflow has no schedule: every run of it is a real deploy attempt, and the deploy job needs only master and the gate passing", () => {
  assert.equal(wf.on.schedule, undefined, "a no-op run of the deploy workflow would clear an earlier failure");
  assert.deepEqual(Object.keys(wf.on).sort(), ["push", "workflow_dispatch"]);
  assert.equal(wf.jobs["budget-gate"].permissions.issues, "write");
  assert.equal(wf.jobs["deploy-production"].permissions, undefined, "the production deploy job's token gains nothing");
  assert.equal(wf.jobs["deploy-production"].if, "github.ref == 'refs/heads/master'");
  assert.equal(wf.jobs["deploy-production"].needs, "budget-gate", "a failed gate skips the deploy");
  assert.equal(wf.jobs["budget-gate"].outputs, undefined);
  assert.equal(JSON.stringify(wf.jobs["budget-gate"]).includes("steps.scope"), false);
  for (const j of ["budget-gate", "clear-behind-notice"]) assert.equal(JSON.stringify(wf.jobs[j]).includes("CLOUDFLARE"), false, `${j} holds no Cloudflare secret`);
});

const catchupScript = catchup.jobs["catch-up"].steps[0].with.script;
test("the catch-up workflow is nightly at 00:25 UTC, master only, holds no Cloudflare secret, and has actions: write only on its one job", () => {
  assert.deepEqual(catchup.on, { schedule: [{ cron: "25 0 * * *" }] });
  assert.deepEqual(catchup.permissions, { contents: "read" });
  assert.deepEqual(catchup.jobs["catch-up"].permissions, { contents: "read", issues: "read", actions: "write" });
  assert.equal(Object.keys(catchup.jobs).length, 1);
  assert.match(catchup.jobs["catch-up"].if, /refs\/heads\/master/);
  assert.equal(JSON.stringify(catchup).includes("CLOUDFLARE"), false);
  assert.equal(JSON.stringify(catchup).includes("secrets."), false);
});

function fakeDispatch(issues) {
  const dispatched = [];
  const f = fakeGithub(issues);
  f.github.rest.actions = { createWorkflowDispatch: async (a) => { dispatched.push(a); } };
  return { ...f, dispatched };
}

test("catch-up: with the notice open it starts deploy-cloudflare.yml on master; with none open (a closed notice does not count) it dispatches nothing and succeeds", async () => {
  const open = fakeDispatch([{ number: 7, state: "open", body: `${MARKER}
x` }]);
  const c1 = mkCore(); await run(catchupScript, open.github, c1, ctx("schedule"));
  assert.deepEqual(open.dispatched, [{ owner: "o", repo: "r", workflow_id: "deploy-cloudflare.yml", ref: "master" }]);
  assert.match(c1.notices.join(" "), /issue #7/);
  const none = fakeDispatch([{ number: 8, state: "open", body: "an unrelated issue" }, { number: 9, state: "closed", body: MARKER }, { number: 10, state: "open", body: MARKER, pull_request: {} }]);
  const c2 = mkCore(); await run(catchupScript, none.github, c2, ctx("schedule"));
  assert.equal(none.dispatched.length, 0);
  assert.match(c2.notices.join(" "), /nothing to catch up/);
});

test("the dispatched deploy proceeds: a workflow_dispatch run reaches the budget count and the deploy (no scope step to stop it), and the budget gate still counts that event", () => {
  const names = wf.jobs["budget-gate"].steps.map((s) => s.name);
  assert.equal(names.some((n) => /catch up/i.test(n)), false, "the scope step is gone");
  const count = wf.jobs["budget-gate"].steps.find((s) => /Count today's deploys/.test(s.name));
  assert.equal(count.if, undefined);
  assert.match(readFileSync(path.join(ROOT, "tools", "cf-budget-check.mjs"), "utf8"), /"workflow_dispatch"/);
});

test("a refusal opens one sticky issue that names the sha, the run, what delivers it and what the override is; a second refusal updates it instead of opening another", async () => {
  const script = scriptOf("budget-gate", /Say that production is behind master/);
  const g = fakeGithub([]);
  await run(script, g.github, mkCore(), ctx("push"));
  assert.equal(g.log.created.length, 1);
  const issue = g.log.created[0];
  assert.match(issue.title, /Production is behind master/);
  assert.ok(issue.body.includes(MARKER));
  assert.ok(issue.body.includes("abcdef1") && issue.body.includes("/actions/runs/42"));
  assert.match(issue.body, /00:25 UTC/);
  assert.match(issue.body, /deploy-catchup\.yml/);
  assert.match(issue.body, /budget_override/);
  await run(script, g.github, mkCore(), ctx("push", { sha: "1111111999999", runId: 43 }));
  assert.equal(g.log.created.length, 1, "no second issue");
  assert.equal(g.log.updated.length, 1);
  assert.equal(g.log.comments.length, 1);
  assert.ok(g.issues[0].body.includes("1111111"), "the notice now names the newer commit");
});

test("the next successful deploy closes the notice; with none open it does nothing", async () => {
  const script = scriptOf("clear-behind-notice", /Close the notice/);
  const g = fakeGithub([{ number: 5, state: "open", body: `${MARKER}\nbehind` }, { number: 6, state: "open", body: "unrelated" }]);
  await run(script, g.github, mkCore(), ctx("push"));
  assert.deepEqual(g.log.updated.map((u) => [u.issue_number, u.state]), [[5, "closed"]]);
  assert.match(g.log.comments[0].body, /in step with master/);
  const none = fakeGithub([{ number: 6, state: "open", body: "unrelated" }]);
  await run(script, none.github, mkCore(), ctx("push"));
  assert.equal(none.log.updated.length, 0);
  assert.equal(wf.jobs["clear-behind-notice"].needs, "deploy-production");
  assert.match(wf.jobs["clear-behind-notice"].if, /needs\.deploy-production\.result == 'success'/);
});

test("the notice step runs only when the gate failed", () => {
  const step = wf.jobs["budget-gate"].steps.find((s) => /Say that production is behind master/.test(s.name));
  assert.equal(step.if, "failure()");
  assert.match(step.with.script, /deploy-catchup\.yml/);
});
