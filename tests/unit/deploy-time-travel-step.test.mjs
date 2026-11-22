// Pins the production deploy's D1 Time Travel bookmark step: present, before migrations apply, never blocking, read-only, writes the job summary.
// Needs the `yaml` package (tests/package.json). Run: node --test tests/unit/deploy-time-travel-step.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const doc = parse(readFileSync(new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url), "utf8"));
const jobs = Object.values(doc.jobs).filter((j) => (j.steps || []).some((s) => /d1 migrations apply/.test(s.run || "")));

test("exactly one job applies migrations, and it records the Time Travel bookmark first, non-blocking", () => {
  assert.equal(jobs.length, 1);
  const steps = jobs[0].steps;
  const tt = steps.findIndex((s) => /d1 time-travel info\s+"\$D1_DATABASE_NAME"/.test(s.run || ""));
  const mig = steps.findIndex((s) => /d1 migrations apply/.test(s.run || ""));
  assert.ok(tt >= 0, "time-travel info step missing");
  assert.ok(tt < mig, "bookmark step must come before migrations apply");
  assert.equal(steps[tt]["continue-on-error"], true);
  assert.equal(steps[tt]["working-directory"], "infrastructure");
  assert.match(steps[tt].run, /GITHUB_STEP_SUMMARY/);
  assert.match(steps[tt].run, /D1 Time Travel bookmark before migrations/);
  assert.doesNotMatch(steps[tt].run, /time-travel restore|secrets\./, "read-only, no secrets");
});
