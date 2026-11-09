import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, matchesGate } from "../../tools/ci-report.mjs";

const base = { sha7: "abc1234", full: true, docsOnly: false, previewSkipped: false, runUrl: "u", pagesUrl: "p", counts: {} };
const res = (o) => ({ unit: "success", stamps: "success", api: "success", browser: "success", layout: "success", ...o });

test("a skipped API suite passes only when the scope rule said apiNeeded=false", () => {
  const a = buildReport({ ...base, siteChanged: true, apiNeeded: false, results: res({ api: "skipped" }) });
  assert.equal(a.pass, true);
  assert.equal(matchesGate(a.body, "abc1234"), true);
  assert.match(a.body, /not run \(scope rule\)/);
});
test("a skipped API suite is a FAIL when apiNeeded is true or unknown (fails closed)", () => {
  for (const apiNeeded of [true, undefined]) {
    const r = buildReport({ ...base, siteChanged: true, apiNeeded, results: res({ api: "skipped" }) });
    assert.equal(r.pass, false);
    assert.equal(r.gate, false);
    assert.equal(matchesGate(r.body, "abc1234"), false);
  }
});
test("a failed or cancelled API suite never passes, even with apiNeeded=false", () => {
  for (const api of ["failure", "cancelled"]) assert.equal(buildReport({ ...base, siteChanged: true, apiNeeded: false, results: res({ api }) }).pass, false);
});
test("apiNeeded=false does not excuse the other suites", () => {
  assert.equal(buildReport({ ...base, siteChanged: true, apiNeeded: false, results: res({ api: "skipped", browser: "failure" }) }).pass, false);
  assert.equal(buildReport({ ...base, siteChanged: false, apiNeeded: false, results: res({ api: "skipped", browser: "skipped", layout: "skipped", unit: "failure" }) }).pass, false);
});
test("no site and no API change: a failed or missing preview never earns the gate phrase (advisor follow-up)", () => {
  const mk = (previewResult) => buildReport({ ...base, siteChanged: false, apiNeeded: false, previewResult, results: res({ api: "skipped", browser: "skipped", layout: "skipped" }) });
  assert.equal(mk("failure").pass, false);
  assert.equal(mk("cancelled").pass, false);
  assert.equal(mk(undefined).pass, false);
  assert.equal(mk("success").pass, true);
});
test("no site and no API change: unit and stamps alone give the gate phrase", () => {
  const r = buildReport({ ...base, siteChanged: false, apiNeeded: false, previewResult: "success", results: res({ api: "skipped", browser: "skipped", layout: "skipped" }) });
  assert.equal(r.pass, true);
  assert.equal(r.gate, true);
});
test("an API-needed PR is unchanged: api must succeed", () => {
  assert.equal(buildReport({ ...base, siteChanged: false, apiNeeded: true, results: res({ browser: "skipped", layout: "skipped" }) }).pass, true);
  assert.equal(buildReport({ ...base, siteChanged: false, apiNeeded: true, results: res({ api: "skipped", browser: "skipped", layout: "skipped" }) }).pass, false);
});
