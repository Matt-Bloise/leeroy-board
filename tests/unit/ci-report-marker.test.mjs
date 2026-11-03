import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, matchesGate, verifyComment, parseMarker, markerLine } from "../../tools/ci-report.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA7 = SHA.slice(0, 7);
const base = (over) => ({
  sha7: SHA7, sha: SHA, runId: "4242", docsOnly: false, siteChanged: true, full: true, previewSkipped: false, pagesUrl: "https://pr-1.leeroy-board.pages.dev", runUrl: "https://example.test/run/1", failing: [], visual: false,
  counts: { uPass: 1, uFail: 0, aPass: 1, aFail: 0, bPass: 1, bFail: 0, lFail: 0 },
  results: { unit: "success", stamps: "success", api: "success", browser: "success", layout: "success" },
  ...over,
});

test("the full head sha and run id are embedded in a hidden marker, the visible header is unchanged", () => {
  const r = buildReport(base({}));
  assert.equal(r.body.split("\n")[0], "<!-- preview-tests -->");
  // queue/gate.js reads ONLY line index 1 as the header (same index as on master); the marker must come after it.
  assert.equal(r.body.split("\n")[1], `### Preview tests: passed (\`${SHA7}\`)`);
  assert.equal(r.body.split("\n")[2], `<!-- preview-tests-meta sha=${SHA} run=4242 -->`);
  assert.equal(matchesGate(r.body, SHA7), true);
  assert.deepEqual(parseMarker(r.body), { sha: SHA, runId: "4242" });
});

test("verifyComment accepts the same sha and run, rejects everything else", () => {
  const body = buildReport(base({})).body;
  assert.equal(verifyComment(body, { sha: SHA, runId: "4242" }).ok, true);
  assert.equal(verifyComment(body, { sha: SHA, runId: 4242 }).ok, true);
  assert.equal(verifyComment(body, { sha: SHA, runId: "4243" }).ok, false, "different run id");
  assert.equal(verifyComment(body, { sha: SHA.replace(/7$/, "8"), runId: "4242" }).ok, false, "different sha with the same first 7 characters");
  assert.equal(verifyComment(body, { sha: SHA7, runId: "4242" }).ok, false, "short sha is not enough");
  assert.equal(verifyComment("### Preview tests: passed (`" + SHA7 + "`)", { sha: SHA, runId: "4242" }).ok, false, "no marker");
  assert.equal(verifyComment(body, { sha: SHA, runId: "" }).ok, false);
  assert.equal(verifyComment(body, undefined).ok, false);
  assert.equal(verifyComment("x " + markerLine(SHA, "4242"), { sha: SHA, runId: "4242" }).ok, false, "marker must be on its own line");
});

test("preview secrets absent: SKIPPED header, never the gate, still a passing job", () => {
  const r = buildReport(base({ previewSkipped: true, results: { unit: "success", stamps: "success", api: "skipped", browser: "skipped", layout: "skipped" } }));
  assert.equal(r.pass, true);
  assert.equal(r.gate, false);
  assert.match(r.body, new RegExp(`^### Preview tests: SKIPPED \\(\`${SHA7}\`\\)$`, "m"));
  assert.equal(matchesGate(r.body, SHA7), false);
  assert.match(r.body, /not the merge gate/);
  assert.equal(verifyComment(r.body, { sha: SHA, runId: "4242" }).ok, true);
});

test("preview secrets absent but unit failed, or an executed suite is not skipped: FAILED", () => {
  const skip = { api: "skipped", browser: "skipped", layout: "skipped" };
  const a = buildReport(base({ previewSkipped: true, results: { unit: "failure", stamps: "success", ...skip } }));
  assert.equal(a.pass, false);
  assert.match(a.body, /^### Preview tests: FAILED/m);
  const b = buildReport(base({ previewSkipped: true, results: { unit: "success", stamps: "success", ...skip, api: "success" } }));
  assert.equal(b.pass, false);
  assert.equal(b.gate, false);
});
