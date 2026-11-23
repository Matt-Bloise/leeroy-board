// B62: the post-deploy smoke job in deploy-cloudflare.yml (it replaced the 165-request production probe, which now runs only once a day in prod-probe-daily.yml) is non-blocking
// (continue-on-error) until it has 3 consecutive clean runs (B53b follow-up); no deploy job may carry continue-on-error. Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const text = readFileSync(fileURLToPath(new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url)), "utf8");
const jobs = parse(text).jobs;

test("the post-deploy smoke job has continue-on-error: true", () => {
  assert.equal(jobs["post-deploy-smoke"]["continue-on-error"], true);
});

test("no deploy job has job-level continue-on-error", () => {
  const deploy = Object.keys(jobs).filter((k) => /deploy/.test(k) && k !== "post-deploy-smoke");
  assert.ok(deploy.length >= 1);
  for (const k of deploy) assert.equal(jobs[k]["continue-on-error"], undefined, `${k} must not set continue-on-error`);
});

test("the smoke step reports a failure as an annotation and a step summary", () => {
  const step = jobs["post-deploy-smoke"].steps.find((s) => /Deploy smoke/.test(s.name));
  assert.match(step.run, /::error title=Post-deploy smoke failed \(non-blocking\)::/);
  assert.match(step.run, /GITHUB_STEP_SUMMARY/);
  assert.match(step.run, /exit "\$RC"/);
});

test("the deploy no longer runs the full production probe: it stays on its daily schedule", () => {
  assert.equal(jobs["production-probe"], undefined);
  assert.equal(/prod-probe\.mjs/.test(text.replace(/#.*$/gm, "")), false, "deploy-cloudflare.yml runs no prod-probe.mjs");
  assert.match(text, /node browser\/deploy-smoke\.mjs --url https:\/\/leeroy\.party\//);
  const daily = readFileSync(fileURLToPath(new URL("../../.github/workflows/prod-probe-daily.yml", import.meta.url)), "utf8");
  assert.match(daily, /schedule:/);
  assert.match(daily, /prod-probe\.mjs/);
});
