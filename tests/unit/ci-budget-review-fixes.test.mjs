// Pins for the findings of the attack review of the CI budget branch (A1 to A8, B1, B2): each test fails on the code before the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { teardown, listAll } from "../../tools/preview-cleanup.mjs";
import { smokeNeeded } from "../../tools/smoke-scope.mjs";
import { SMALL, estimateRowsWritten, SMALL_ROW_BUDGET } from "../../tools/d1-facts-smoke.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wfText = readFileSync(path.join(ROOT, ".github", "workflows", "pr-preview-cloudflare.yml"), "utf8");
const wf = parse(wfText);
const json = (status, body) => ({ status, ok: status < 300, json: async () => body });

// Evaluates the cancel-in-progress expression of the workflow for one pull_request event (the expression only uses ==, !=, &&, || and !).
function cancelFor(action, label) {
  const expr = wf.concurrency["cancel-in-progress"].replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const js = expr.replace(/github\.event\.action/g, JSON.stringify(action)).replace(/github\.event\.label\.name/g, JSON.stringify(label || ""));
  return Function(`"use strict"; return (${js});`)();
}
function groupFor(action, label) {
  const expr = wf.concurrency.group.replace(/^\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{\s*|\s*\}\}$/g, "");
  const js = expr.replace(/github\.event\.action/g, JSON.stringify(action)).replace(/github\.event\.label\.name/g, JSON.stringify(label || ""));
  return Function(`"use strict"; return (${js});`)();
}

test("A1/A2: every teardown event is in the teardown group and is never cancelled; spin-up events keep their rule", () => {
  for (const [action, label, group, cancel] of [
    ["closed", undefined, "teardown", false],
    ["unlabeled", "ci-full", "teardown", false],
    ["opened", undefined, "spinup", true],
    ["synchronize", undefined, "spinup", true],
    ["reopened", undefined, "spinup", true],
    ["labeled", "ci-full", "spinup", true],
    ["labeled", "security", "spinup", false],
    ["unlabeled", "visual", "spinup", false],
  ]) {
    assert.equal(groupFor(action, label), group, `${action} ${label || ""}: group`);
    assert.equal(cancelFor(action, label), cancel, `${action} ${label || ""}: cancel-in-progress`);
  }
});

test("A1: the teardown stops this PR's running spin-up first, and a closed PR cannot start a spin-up", () => {
  const steps = wf.jobs["teardown-pr-preview"].steps;
  assert.match(steps[0].name, /Stop this PR's spin-up runs that are still running/);
  assert.ok(steps[0].run.includes("/cancel") && steps[0].run.includes("pr-preview-cloudflare.yml"));
  assert.ok(steps[0].run.includes("GITHUB_RUN_ID"), "it never cancels itself");
  assert.equal(wf.jobs["teardown-pr-preview"].permissions.actions, "write");
  assert.ok(wf.jobs.prep.if.includes("github.event.pull_request.state == 'open'"), "no spin-up for a PR that is not open");
});

test("A3: a PR that ever had a preview always gets the full teardown, even when D1 and the Worker are gone", () => {
  const probe = wf.jobs["teardown-pr-preview"].steps.find((s) => s.id === "probe");
  assert.ok(probe.run.includes("<!-- cloudflare-pr-preview -->") && probe.run.includes("ANSWER=yes"));
  assert.ok(probe.env.GH_TOKEN, "it can read the PR's comments");
});

test("A6: the retry of a waiting PR does not depend on the tool's verdict", () => {
  const step = wf.jobs["teardown-pr-preview"].steps.find((s) => /Re-run failed preview and test jobs/.test(s.name));
  assert.match(step.if, /!cancelled\(\)/);
});

test("A7: a delete call that errored but left nothing behind is a pass with a warning, not a red job", async () => {
  const state = { worker: true };
  const fetchImpl = async (url, { method = "GET" } = {}) => {
    const p = new URL(url).pathname;
    if (method === "DELETE" && /workers\/scripts/.test(p)) { state.worker = false; return json(500, { success: false, errors: [{ code: 1, message: "late error" }] }); } // it deleted, then answered an error
    if (/workers\/scripts$/.test(p)) return json(200, { success: true, result: state.worker ? [{ id: "leeroy-brain-pr-5" }] : [] });
    if (/d1\/database$/.test(p) || /deployments$/.test(p)) return json(200, { success: true, result: [], result_info: { total_count: 0, total_pages: 1 } });
    return json(404, { success: false, errors: [] });
  };
  const r = await teardown({ fetchImpl, token: "t", accountId: "a", pr: 5, sleep: async () => {}, waitMs: 0 });
  assert.equal(r.ok, true);
  assert.ok(r.lines.some((l) => /^warning: 1 delete call/.test(l)));
});

test("A5: a short last page ends the listing even when total_count counts more than the filter returns; a page that does not advance still fails", async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}` }));
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return json(200, { success: true, result: items.slice((page - 1) * 25, page * 25), result_info: { total_count: 500 } }); // a total for ALL deployments, the list is filtered
  };
  const all = await listAll(fetchImpl, "t", "/x");
  assert.equal(all.length, 30);
  const stuck = async () => json(200, { success: true, result: items.slice(0, 25), result_info: { total_count: 500 } });
  await assert.rejects(listAll(stuck, "t", "/x"), /incomplete/);
});

test("A8: every API call carries a timeout", () => {
  assert.ok(readFileSync(path.join(ROOT, "tools", "preview-cleanup.mjs"), "utf8").includes("AbortSignal.timeout("));
});

test("B1: changes to the wrangler version, config, export and restore code, and the seed run the smoke", () => {
  for (const p of ["infrastructure/package.json", "infrastructure/package-lock.json", "infrastructure/wrangler.toml", "infrastructure/worker/export.js", "infrastructure/scripts/seed-d1.mjs", "tools/restore-drill.mjs", "infrastructure/worker/kv-cas.js"]) assert.equal(smokeNeeded([p]), true, p);
  assert.equal(smokeNeeded(["js/board.js"]), false);
});

test("B2: the small profile loads in several batches and stays under its row budget", () => {
  assert.ok(SMALL.batch < SMALL.facts, "10 facts do not fit one call, so the batching loop runs");
  assert.ok(estimateRowsWritten(SMALL) <= SMALL_ROW_BUDGET);
});
