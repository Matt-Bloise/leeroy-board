// A PR that changes the production probe, its self-test or what they read must run the self-test, so a light run cannot pass for it (the report check is required by the ruleset).
// Why: #410 changed the probe's output and broke the self-test unseen; nothing ran the self-test afterwards. Run: node --test tests/unit/ci-probe-scope.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { isProbePath, probeChanged, siteChanged } from "../../tools/ci-scope.mjs";
import { buildReport } from "../../tools/ci-report.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { parse } = createRequire(import.meta.url)("yaml");

test("the probe paths: the probe, its self-test, the runner, its helpers, the roster fixture and the test dependencies", () => {
  for (const p of ["tests/browser/prod-probe.mjs", "tests/browser/prod-probe-selftest.mjs", "tests/browser/run.mjs", "tests/helpers/probe-checks.mjs", "tests/helpers/probe-budget.mjs", "tests/helpers/probe-scrub.mjs", "tests/helpers/probe-fixture-server.mjs",
    "tests/helpers/page-url.mjs", "tests/helpers/clock-arg.mjs", "tests/helpers/private-path-probe.mjs", "tests/helpers/shard.mjs", "tests/package.json", "tests/package-lock.json", "tests/fixtures/six-members/party.json", "./tests/browser/prod-probe.mjs"]) {
    assert.equal(isProbePath(p), true, p);
    assert.equal(siteChanged([p]), true, `${p} is also a site change, so the browser job (and its self-test legs) exists for it`);
  }
  for (const p of ["js/brain.js", "tests/unit/probe-scrub.test.mjs", "tests/browser/layout-sweep.mjs", "tests/helpers/browser-stub.mjs", "docs/runbooks/ci-minutes.md", "tests/browser/prod-probe-selftest.mjs.bak/x"]) assert.equal(isProbePath(p), false, p);
  assert.equal(probeChanged([]), true, "an empty list cannot be classified");
  assert.equal(probeChanged(["js/brain.js", "tests/helpers/shard.mjs"]), true);
  assert.equal(probeChanged(["js/brain.js"]), false);
});

const base = { sha7: "abc1234", sha: "a".repeat(40), runId: "1", docsOnly: false, siteChanged: true, apiNeeded: true, full: false, previewResult: "skipped", recoverResult: "skipped", results: { unit: "success", stamps: "success", api: "skipped", crawl: "skipped", browser: "skipped", layout: "skipped" }, counts: {}, failing: [], runUrl: "u", pagesUrl: "" };

test("a light run passes for an ordinary PR and FAILS for one that changes the probe", () => {
  const ordinary = buildReport({ ...base, probeChanged: false });
  assert.equal(ordinary.pass, true);
  const probe = buildReport({ ...base, probeChanged: true });
  assert.equal(probe.pass, false);
  assert.match(probe.body, /changes the production probe, its self-test or what they read, so the self-test must run/);
  assert.match(probe.body, /Add the `ci-full` label/);
  assert.equal(probe.gate, false);
});

test("a full run is unchanged: it passes only when the browser job (self-test legs included) passed", () => {
  const full = { ...base, full: true, probeChanged: true, previewResult: "success", recoverResult: "success", results: { unit: "success", stamps: "success", api: "success", crawl: "success", browser: "success", layout: "success" } };
  assert.equal(buildReport(full).pass, true);
  assert.equal(buildReport({ ...full, results: { ...full.results, browser: "failure" } }).pass, false, "a failed self-test leg fails the browser job");
  assert.equal(buildReport({ ...full, results: { ...full.results, browser: "skipped" } }).pass, false, "a skipped browser job cannot pass a site change");
});

test("the scope job exports probe_changed and the report reads it", () => {
  const wf = parse(readFileSync(path.join(ROOT, ".github/workflows/preview-tests.yml"), "utf8"));
  assert.equal(wf.jobs.scope.outputs.probe_changed, "${{ steps.classify.outputs.probe_changed }}");
  const classify = wf.jobs.scope.steps.find((s) => s.id === "classify").run;
  assert.match(classify, /node tools\/ci-scope\.mjs --probe < /);
  const rep = wf.jobs.report.steps.find((s) => s.id === "build");
  assert.equal(rep.env.PROBE_CHANGED, "${{ needs.scope.outputs.probe_changed }}");
});
