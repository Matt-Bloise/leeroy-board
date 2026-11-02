import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, matchesGate, gateRegex, GATE_RE_SOURCE } from "../../tools/ci-report.mjs";

const SHA = "abc1234";
const base = (over) => ({
  sha7: SHA, docsOnly: false, siteChanged: true, full: true, pagesUrl: "https://pr-1.leeroy-board.pages.dev", runUrl: "https://example.test/run/1", failing: [], visual: false,
  counts: { uPass: 10, uFail: 0, aPass: 5, aFail: 0, bPass: 3, bFail: 0, lFail: 0 },
  results: { unit: "success", stamps: "success", api: "success", browser: "success", layout: "success" },
  ...over,
});
const res = (o) => ({ unit: "success", stamps: "success", api: "success", browser: "success", layout: "success", ...o });
const light = () => buildReport(base({ full: false, siteChanged: true, results: res({ api: "skipped", browser: "skipped", layout: "skipped" }) }));

test("the documented regex source is the one in use", () => {
  assert.equal(GATE_RE_SOURCE, "^### Preview tests: passed \\(`?<sha7>`?\\)[ \\t]*\\r?$");
  assert.equal(gateRegex(SHA).source, GATE_RE_SOURCE.replace("<sha7>", SHA));
});

test("the light header never matches the gate regex", () => {
  const r = light();
  assert.equal(r.pass, true);
  assert.equal(r.gate, false);
  assert.match(r.body, /^### Light checks: passed \(`abc1234`\)$/m);
  assert.equal(matchesGate(r.body, SHA), false);
  assert.equal(/preview tests/i.test(r.body), false, "the light comment must not contain the words Preview tests");
  assert.match(r.body, /Full suite not requested/);
});

test("a failed light run does not match and does not contain the gate words", () => {
  const r = buildReport(base({ full: false, results: res({ unit: "failure", api: "skipped", browser: "skipped", layout: "skipped" }) }));
  assert.equal(r.pass, false);
  assert.equal(matchesGate(r.body, SHA), false);
  assert.equal(/preview tests/i.test(r.body), false);
});

test("the full-pass comment matches, on the right sha only", () => {
  const r = buildReport(base({}));
  assert.equal(r.pass, true);
  assert.equal(r.gate, true);
  assert.equal(matchesGate(r.body, SHA), true);
  assert.equal(matchesGate(r.body, "abc1235"), false);
  assert.equal(matchesGate(r.body, "abc123"), false);
  assert.equal(matchesGate(r.body, "ABC1234"), false);
  assert.match(r.body, /Suites run: unit, stamps, api, browser, layout\. Not run: none\./);
});

test("the sha may appear with or without backticks, nothing else may follow", () => {
  assert.equal(matchesGate("### Preview tests: passed (abc1234)", SHA), true);
  assert.equal(matchesGate("### Preview tests: passed (`abc1234`)", SHA), true);
  assert.equal(matchesGate("<!-- preview-tests -->\r\n### Preview tests: passed (`abc1234`)\r\n\r\ntext", SHA), true);
  assert.equal(matchesGate("### Preview tests: passed (`abc1234`) extra", SHA), false);
  assert.equal(matchesGate("text ### Preview tests: passed (`abc1234`)", SHA), false);
  assert.equal(matchesGate("### Preview tests: FAILED (`abc1234`)", SHA), false);
  assert.equal(matchesGate("### Preview tests: passed (docs only)", SHA), false);
  assert.equal(matchesGate("### Preview tests: passed (`abc1234`)", "not-a-sha"), false);
});

test("a full run with a skipped browser or layout suite does not match when site files changed", () => {
  for (const o of [{ browser: "skipped" }, { layout: "skipped" }, { browser: "skipped", layout: "skipped" }, { api: "skipped" }]) {
    const r = buildReport(base({ siteChanged: true, results: res(o) }));
    assert.equal(r.pass, false, JSON.stringify(o));
    assert.equal(matchesGate(r.body, SHA), false, JSON.stringify(o));
  }
});

test("a failed or cancelled suite never matches", () => {
  for (const k of ["unit", "stamps", "api", "browser", "layout"]) {
    for (const v of ["failure", "cancelled", "skipped", undefined]) {
      const r = buildReport(base({ results: res({ [k]: v }) }));
      assert.equal(matchesGate(r.body, SHA), false, `${k}=${v}`);
    }
  }
});

test("skipped browser and layout match only under the documented skip condition", () => {
  const skippedBoth = res({ browser: "skipped", layout: "skipped" });
  // documented condition: full requested, scope rule says no site-affecting file changed, api succeeded, browser and layout both skipped
  const okCase = buildReport(base({ siteChanged: false, results: skippedBoth }));
  assert.equal(matchesGate(okCase.body, SHA), true);
  assert.match(okCase.body, /Not run: browser, layout \(scope rule/);
  // the same skips with site files changed: no
  assert.equal(matchesGate(buildReport(base({ siteChanged: true, results: skippedBoth })).body, SHA), false);
  // scope rule holds but api did not succeed: no
  for (const api of ["failure", "skipped", "cancelled"]) assert.equal(matchesGate(buildReport(base({ siteChanged: false, results: res({ api, browser: "skipped", layout: "skipped" }) })).body, SHA), false, api);
  // scope rule holds but only one of the two was skipped and the other failed or was cancelled: no
  assert.equal(matchesGate(buildReport(base({ siteChanged: false, results: res({ browser: "skipped", layout: "failure" }) })).body, SHA), false);
  assert.equal(matchesGate(buildReport(base({ siteChanged: false, results: res({ browser: "cancelled", layout: "skipped" }) })).body, SHA), false);
  // scope rule holds, everything ran and passed: also fine
  assert.equal(matchesGate(buildReport(base({ siteChanged: false })).body, SHA), true);
  // scope rule holds but the full suite was not requested: light header, no match
  assert.equal(matchesGate(buildReport(base({ siteChanged: false, full: false, results: res({ api: "skipped", browser: "skipped", layout: "skipped" }) })).body, SHA), false);
});

test("docs-only PRs keep the old gate phrase and say docs only", () => {
  const r = buildReport(base({ docsOnly: true, full: false, siteChanged: false, results: res({ api: "skipped", browser: "skipped", layout: "skipped" }) }));
  assert.equal(r.pass, true);
  assert.equal(matchesGate(r.body, SHA), true);
  assert.match(r.body, /\*\*passed \(docs only\)\*\*/);
  // a docs-only PR with a failing unit suite does not match
  assert.equal(matchesGate(buildReport(base({ docsOnly: true, full: false, results: res({ unit: "failure", api: "skipped", browser: "skipped", layout: "skipped" }) })).body, SHA), false);
});

test("a failed full run says FAILED and never matches", () => {
  const r = buildReport(base({ results: res({ browser: "failure" }), failing: ["FAIL x"] }));
  assert.match(r.body, /^### Preview tests: FAILED \(`abc1234`\)$/m);
  assert.equal(r.gate, false);
  assert.match(r.body, /FAIL x/);
});
