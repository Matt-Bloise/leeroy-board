// A deploy refused by the budget pre-flight must never leave a fix undelivered silently: a sticky issue says "Production is behind master", a scheduled catch-up delivers it, the next successful
// deploy closes the notice. The github-script bodies of deploy-cloudflare.yml are compiled and run here against a fake GitHub client.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wf = parse(readFileSync(path.join(ROOT, ".github", "workflows", "deploy-cloudflare.yml"), "utf8"));
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

test("the gate has a scope step and a notice step, and the deploy job runs only when the gate says proceed", () => {
  assert.equal(wf.jobs["budget-gate"].permissions.issues, "write");
  assert.equal(wf.jobs["deploy-production"].permissions, undefined, "the production deploy job's token gains nothing");
  assert.ok(wf.jobs["deploy-production"].if.includes("needs.budget-gate.outputs.proceed == 'true'"));
  assert.ok(wf.jobs["budget-gate"].outputs.proceed);
  assert.deepEqual(wf.on.schedule, [{ cron: "25 0 * * *" }]);
  for (const j of ["budget-gate", "clear-behind-notice"]) assert.equal(JSON.stringify(wf.jobs[j]).includes("CLOUDFLARE"), false, `${j} holds no Cloudflare secret`);
});

test("scheduled run: proceeds only when a notice is open; a push or manual run always proceeds", async () => {
  const script = scriptOf("budget-gate", /refused deploy to catch up/);
  const withNotice = fakeGithub([{ number: 7, state: "open", body: `${MARKER}\nx` }]);
  const c1 = mkCore(); await run(script, withNotice.github, c1, ctx("schedule"));
  assert.equal(c1.out.proceed, "true");
  const none = fakeGithub([{ number: 8, state: "open", body: "an unrelated issue" }, { number: 9, state: "closed", body: MARKER }]);
  const c2 = mkCore(); await run(script, none.github, c2, ctx("schedule"));
  assert.equal(c2.out.proceed, "false", "nothing to catch up (a closed notice does not count)");
  assert.match(c2.notices.join(" "), /nothing to deliver/);
  for (const ev of ["push", "workflow_dispatch"]) { const c = mkCore(); await run(script, none.github, c, ctx(ev)); assert.equal(c.out.proceed, "true", ev); }
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

test("the notice step runs only when the gate failed on a run that was meant to deploy, and a scheduled run with nothing to catch up stays silent", () => {
  const step = wf.jobs["budget-gate"].steps.find((s) => /Say that production is behind master/.test(s.name));
  assert.match(step.if, /failure\(\)/);
  assert.match(step.if, /steps\.scope\.outputs\.proceed == 'true'/);
  const count = wf.jobs["budget-gate"].steps.find((s) => /Count today's deploys/.test(s.name));
  assert.match(count.if, /steps\.scope\.outputs\.proceed == 'true'/);
});
