import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { failureLines, classify, classifyJobs, loadSignatures } from "../../tools/flake-signatures.mjs";

const raw = readFileSync(new URL("../../tools/flake-signatures.json", import.meta.url), "utf8");
const sigs = loadSignatures(raw);
const ts = "2026-11-10T12:00:00.1234567Z ";
const verdict = (...logLines) => classify(failureLines(logLines.map((l) => ts + l).join("\n")), sigs);

const KNOWN = {
  "webkit-rum-beacon-cors": "FAIL [webkit] no console errors: Access to fetch at 'https://x' from origin 'https://leeroy.party' blocked. Origin https://leeroy.party is not allowed by Access-Control-Allow-Origin. Status code: 404",
  "roads-buffs-pin-hover": "FAIL [laptop] pin 3 hover opens a tip that is inside the view and covers nothing: {\"top\":4} DIAG(evidence for a CI-only flake, nothing asserted) {\"shownByWait\":false}",
  "open-return-b-scroll": "FAIL [phone] B open then close at 40 percent: ends correct 9 of 10 (slowest 410 ms, bound 600): run 1: scroll 192 -> 0",
  "preview-worker-not-found": "##[error]A request to the Cloudflare API failed. This Worker does not exist on your account. [code: 10007]",
  "layout-sweep-time-budget": "FAIL time budget of 9 min ran out after 588 cells; the sweep is incomplete",
};

for (const [id, line] of Object.entries(KNOWN)) {
  test(`signature ${id} matches its fixture and only its own`, () => {
    const r = verdict(line);
    assert.equal(r.rerun, true);
    assert.deepEqual(r.matched.map((m) => m.id), [id]);
  });
}

test("every signature in the JSON has a fixture and a reason", () => {
  const doc = JSON.parse(raw);
  assert.deepEqual(doc.signatures.map((s) => s.id).sort(), Object.keys(KNOWN).sort());
  for (const s of doc.signatures) assert.ok(s.why && s.why.length > 20, s.id);
});

test("a real assertion failure does not match", () => {
  for (const line of [
    "FAIL [phone] the sheet heading takes focus when a tile opens it: sheet-close",
    "FAIL [laptop] pin 3 hover opens a tip that is outside the view: {\"top\":-40}",
    "FAIL [phone] B three rapid toggles: ends correct 7 of 10 (slowest 900 ms, bound 600): run 2: waitForFunction Timeout 2010ms",
    "FAIL [chromium] no console errors: Uncaught TypeError: x is not a function",
    "##[error]Preview did not answer 200 in time.",
  ]) assert.equal(verdict(line).rerun, false, line);
});

test("one unknown failure among known ones blocks the rerun", () => {
  const r = verdict(KNOWN["layout-sweep-time-budget"], "FAIL [phone] the footer is visible: false");
  assert.equal(r.rerun, false);
  assert.equal(r.matched.length, 1);
  assert.equal(r.unknown.length, 1);
});

test("no failure line at all is unknown, never a rerun", () => {
  assert.equal(verdict("PASS a check", "##[error]Process completed with exit code 1.").rerun, false);
  assert.equal(classify([], sigs).rerun, false);
});

test("the exit-code annotation is a consequence and is ignored, other annotations count", () => {
  assert.deepEqual(failureLines(ts + "##[error]Process completed with exit code 1."), []);
  assert.deepEqual(failureLines(ts + "##[error]Something else"), ["##[error]Something else"]);
  assert.equal(verdict(KNOWN["layout-sweep-time-budget"], "##[error]Process completed with exit code 1.").rerun, true);
});

test("timestamps, a BOM and CRLF are tolerated; PASS and DIAG lines are not failures", () => {
  const log = "\uFEFF" + ts + "PASS fine\r\n" + ts + "DIAG shownByWait false\r\n" + ts + KNOWN["layout-sweep-time-budget"] + "\r\n";
  assert.equal(failureLines(log).length, 1);
});

const jobLog = (...logLines) => logLines.map((l) => ts + l).join("\n");

test("classifyJobs: every failed job a known flake reruns", () => {
  const r = classifyJobs([jobLog(KNOWN["layout-sweep-time-budget"]), jobLog(KNOWN["roads-buffs-pin-hover"])], sigs);
  assert.equal(r.rerun, true);
  assert.deepEqual(r.jobs.map((j) => j.rerun), [true, true]);
});

test("classifyJobs: a known flake beside a crashed job with an empty log does NOT rerun", () => {
  for (const crashed of ["", "\n", null, undefined, jobLog("PASS a check", "##[error]Process completed with exit code 1.")]) {
    const r = classifyJobs([jobLog(KNOWN["layout-sweep-time-budget"]), crashed], sigs);
    assert.equal(r.rerun, false, String(crashed));
    assert.deepEqual(r.jobs.map((j) => j.rerun), [true, false]);
  }
});

test("classifyJobs: a known flake beside a job with an unknown failure does not rerun", () => {
  const r = classifyJobs([jobLog(KNOWN["layout-sweep-time-budget"]), jobLog("FAIL [phone] the footer is visible: false")], sigs);
  assert.equal(r.rerun, false);
});

test("classifyJobs: no logs at all, or only silent logs, never rerun", () => {
  assert.equal(classifyJobs([], sigs).rerun, false);
  assert.equal(classifyJobs([""], sigs).rerun, false);
});

test("the CLI judges each file on its own and treats a missing file as silent", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "flake-"));
  const flake = join(dir, "a.log"), empty = join(dir, "b.log"), missing = join(dir, "nope.log");
  writeFileSync(flake, jobLog(KNOWN["layout-sweep-time-budget"]));
  writeFileSync(empty, "");
  const run = (...files) => spawnSync(process.execPath, [fileURLToPath(new URL("../../tools/flake-signatures.mjs", import.meta.url)), ...files], { encoding: "utf8" });
  assert.equal(run(flake).status, 0);
  assert.equal(run(flake, empty).status, 10);
  assert.equal(run(flake, missing).status, 10);
  assert.equal(run().status, 10);
});

test("the 10007 signature needs the bracketed code or the sentence, never the bare number", () => {
  assert.equal(verdict("FAIL [phone] step took 10007 ms, limit 9000: the sheet never opened").rerun, false);
  assert.equal(verdict("FAIL [phone] sheet at x=10007 px is off screen").rerun, false);
  assert.equal(verdict("##[error]request failed [code: 10007]").rerun, true);
  assert.equal(verdict("##[error]This Worker does not exist on your account").rerun, true);
});

test("the scroll signature states the cost of a real failure matching it", () => {
  const doc = JSON.parse(raw);
  assert.match(doc.signatures.find((s) => s.id === "open-return-b-scroll").why, /never rerun/);
});

test("the byte order mark is written as an escape in source, not as an invisible character", () => {
  for (const f of ["../../tools/flake-signatures.mjs", "./flake-signatures.test.mjs"]) {
    assert.ok(!readFileSync(new URL(f, import.meta.url), "utf8").includes("\uFEFF"), f);
  }
});
