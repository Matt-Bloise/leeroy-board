// Pre-flight for the jobs that spend Cloudflare: refuses to start when today's budget is used up. Node 22, no dependencies, fetch injected for the tests.
//   node tools/cf-budget-check.mjs spinup     in pr-preview-cloudflare.yml, before the spin-up job
//   node tools/cf-budget-check.mjs deploy     in deploy-cloudflare.yml, before the production deploy
// env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA; DEPLOY_BUDGET_OVERRIDE=true (the workflow_dispatch input of the deploy workflow).
//
// The budget is the repo-tracked file .github/cf-budget.json (spinUpsPerDay, deployingMergesPerDay, the names of the two jobs and workflows it counts, the override label). Counts are for the UTC day:
// the runs of the named workflow created today (GitHub API, read-only, no Cloudflare call), minus this run, that have a started job of the named kind. A job that was skipped does not count; a job that
// started and failed or was cancelled does (it spent the Worker deploy, the secrets and the D1 rows). Re-runs count: each is a run attempt of its own run, and the run counts once per attempt's job.
//
// FAIL CLOSED: if the file cannot be read or is malformed, or the API cannot be read completely, or the count cannot be made, the job does not start. The one way past is the override label
// (default `cf-budget-override`) on the pull request (for a deploy: on a pull request merged into the commit being deployed, or the `budget_override` input of a manual run). The label is for the
// session that merges (VAREN) and the account owner; adding it is a recorded decision, and it is the only override: no env var, no commit message.
import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GH = "https://api.github.com";

export function validateBudget(b) {
  const bad = (m) => { throw new Error(`.github/cf-budget.json: ${m}`); };
  if (!b || typeof b !== "object" || b.version !== 1) bad("version must be 1");
  for (const k of ["spinUpsPerDay", "deployingMergesPerDay"]) if (!Number.isInteger(b[k]) || b[k] < 0 || b[k] > 1000) bad(`${k} must be a whole number from 0 to 1000`);
  if (typeof b.overrideLabel !== "string" || !/^[A-Za-z0-9 _.:-]{1,50}$/.test(b.overrideLabel)) bad("overrideLabel must be a short label name");
  for (const [g, keys] of [["jobs", ["spinUp", "deploy"]], ["workflows", ["spinUp", "deploy"]]]) for (const k of keys) if (!b[g] || typeof b[g][k] !== "string" || !b[g][k]) bad(`${g}.${k} must be a non-empty string`);
  return b;
}

export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

async function gh(fetchImpl, token, pathAndQuery) {
  let res;
  try { res = await fetchImpl(`${GH}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }); }
  catch (e) { throw new Error(`GitHub API ${pathAndQuery.split("?")[0]}: network error: ${e.message}`); }
  if (!res.ok) throw new Error(`GitHub API ${pathAndQuery.split("?")[0]} answered ${res.status}`);
  try { return await res.json(); } catch { throw new Error(`GitHub API ${pathAndQuery.split("?")[0]}: the answer was not JSON`); }
}

// -> number of today's runs (other than runId) of `workflowFile` that have a started job named `jobName`. Reads every page of runs and every run's jobs; throws if any read fails or is cut short.
export async function countToday({ fetchImpl = fetch, token, repo, workflowFile, jobName, events, runId, day }) {
  const runs = [];
  let total = 0;
  for (let page = 1; page <= 30; page++) {
    const body = await gh(fetchImpl, token, `/repos/${repo}/actions/workflows/${workflowFile}/runs?created=${encodeURIComponent(">=" + day)}&per_page=100&page=${page}`);
    if (!Array.isArray(body.workflow_runs) || typeof body.total_count !== "number") throw new Error("GitHub API: the runs answer has an unexpected shape");
    total = body.total_count;
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length === 0 || runs.length >= body.total_count) break;
    if (page === 30) throw new Error("GitHub API: more than 3000 runs today, the count would be cut short");
  }
  if (runs.length < total) throw new Error(`GitHub API: only ${runs.length} of ${total} runs could be read (the list is capped), so the count would be cut short`);
  const fromToday = runs.filter((r) => String(r.created_at || "").slice(0, 10) >= day && String(r.id) !== String(runId) && (!events || events.includes(r.event)));
  let n = 0;
  for (const r of fromToday) {
    const jobs = await gh(fetchImpl, token, `/repos/${repo}/actions/runs/${r.id}/jobs?filter=all&per_page=100`);
    if (!Array.isArray(jobs.jobs) || typeof jobs.total_count !== "number" || jobs.jobs.length < jobs.total_count) throw new Error(`GitHub API: the jobs of run ${r.id} could not be read completely`);
    if (jobs.jobs.some((j) => j.name === jobName && j.conclusion !== "skipped" && j.started_at)) n++;
  }
  return n;
}

// The labels that can authorise an override for this event. -> string[]
export async function overrideLabels({ fetchImpl = fetch, token, repo, eventName, eventPath, sha, readEvent = (p) => JSON.parse(readFileSync(p, "utf8")) }) {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const ev = readEvent(eventPath);
    return ((ev.pull_request && ev.pull_request.labels) || []).map((l) => l.name);
  }
  if (eventName === "push" && sha) {
    const prs = await gh(fetchImpl, token, `/repos/${repo}/commits/${sha}/pulls?per_page=30`);
    if (!Array.isArray(prs)) throw new Error("GitHub API: the pulls of the commit have an unexpected shape");
    return prs.flatMap((p) => (p.labels || []).map((l) => l.name));
  }
  return [];
}

// -> { ok, lines, used, limit, overridden }. Never throws: any failure is a refusal (unless the override label is present).
export async function preflight({ kind, budget, fetchImpl = fetch, token, repo, runId, eventName, eventPath, sha, manualOverride = false, now = new Date(), readEvent }) {
  const lines = [];
  let used = null, overridden = false;
  const limit = kind === "spinup" ? budget.spinUpsPerDay : budget.deployingMergesPerDay;
  const what = kind === "spinup" ? "preview spin-ups" : "production deploys";
  let labels = [];
  try { labels = await overrideLabels({ fetchImpl, token, repo, eventName, eventPath, sha, readEvent }); } catch (e) { lines.push(`could not read the labels (${e.message}); the override is not available`); }
  const hasOverride = manualOverride || labels.includes(budget.overrideLabel);
  try {
    used = await countToday({
      fetchImpl, token, repo, runId, day: utcDay(now),
      workflowFile: kind === "spinup" ? budget.workflows.spinUp : budget.workflows.deploy,
      jobName: kind === "spinup" ? budget.jobs.spinUp : budget.jobs.deploy,
      events: kind === "spinup" ? ["pull_request"] : ["push", "workflow_dispatch"],
    });
  } catch (e) {
    lines.push(`COULD NOT COUNT today's ${what}: ${e.message}`);
    if (hasOverride) { lines.push(`override: ${manualOverride ? "the budget_override input" : `the label ${budget.overrideLabel}`} is present, so this run goes ahead without a count`); return { ok: true, lines, used, limit, overridden: true }; }
    lines.push(`Refusing to start (fail closed): without a count the budget cannot be checked.`);
    return { ok: false, lines, used, limit, overridden: false };
  }
  lines.push(`${what} today (UTC ${utcDay(now)}), other than this run: ${used} of ${limit}`);
  if (used < limit) return { ok: true, lines, used, limit, overridden: false };
  if (hasOverride) { lines.push(`Budget used up, but ${manualOverride ? "the budget_override input is set" : `the label ${budget.overrideLabel} is on this change`}: going ahead (a recorded decision of the session that merges).`); return { ok: true, lines, used, limit, overridden: true }; }
  lines.push(`REFUSING TO START: today's budget of ${limit} ${what} is used up (.github/cf-budget.json). The Cloudflare account is a friend's and the free plan blocks at its limit instead of billing. Try again after 00:00 UTC. Only the session that merges adds the label \`${budget.overrideLabel}\` to override this.`);
  return { ok: false, lines, used, limit, overridden: false };
}

async function main() {
  const kind = process.argv[2];
  if (kind !== "spinup" && kind !== "deploy") { console.error("usage: node tools/cf-budget-check.mjs spinup|deploy"); return 2; }
  const out = [];
  let budget;
  try { budget = validateBudget(JSON.parse(readFileSync(new URL("../.github/cf-budget.json", import.meta.url), "utf8"))); }
  catch (e) { console.log(`::error title=Budget file unreadable::${String(e.message).replace(/[\r\n]+/g, " ")}. Refusing to start (fail closed).`); return 1; }
  const r = await preflight({
    kind, budget, token: process.env.GH_TOKEN, repo: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, eventName: process.env.GITHUB_EVENT_NAME,
    eventPath: process.env.GITHUB_EVENT_PATH, sha: process.env.GITHUB_SHA, manualOverride: process.env.DEPLOY_BUDGET_OVERRIDE === "true",
  });
  out.push(`### Cloudflare budget pre-flight (${kind})`, "", ...r.lines.map((l) => `- ${l}`), "", r.ok ? (r.overridden ? "**Result: allowed by the override.**" : "**Result: inside the budget.**") : "**Result: refused.**");
  console.log(out.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n"); } catch { /* best effort */ } }
  if (!r.ok) console.log(`::error title=Cloudflare daily budget::${r.lines[r.lines.length - 1].replace(/[\r\n]+/g, " ")}`);
  return r.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c), (e) => { console.log(`::error::${String(e.message).replace(/[\r\n]+/g, " ")}`); process.exit(1); });
