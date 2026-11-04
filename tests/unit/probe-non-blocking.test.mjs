// B62: the production probe job in deploy-cloudflare.yml is non-blocking (continue-on-error) until it has 3 consecutive clean runs (B53b follow-up);
// no deploy job may carry continue-on-error. Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const text = readFileSync(fileURLToPath(new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url)), "utf8");
const jobs = parse(text).jobs;

test("the production probe job has continue-on-error: true", () => {
  assert.equal(jobs["production-probe"]["continue-on-error"], true);
});

test("no deploy job has job-level continue-on-error", () => {
  const deploy = Object.keys(jobs).filter((k) => /deploy/.test(k));
  assert.ok(deploy.length >= 1);
  for (const k of deploy) assert.equal(jobs[k]["continue-on-error"], undefined, `${k} must not set continue-on-error`);
});

test("the probe step reports a failure as an annotation and a step summary", () => {
  const step = jobs["production-probe"].steps.find((s) => /Production probe \(at most 200/.test(s.name));
  assert.match(step.run, /::error title=Production probe failed \(non-blocking\)::/);
  assert.match(step.run, /GITHUB_STEP_SUMMARY/);
  assert.match(step.run, /exit "\$RC"/);
});
