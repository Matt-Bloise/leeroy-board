// Production smoke: pins the shape that stops the post-deploy smoke from hanging in apt again (run 45297981246, both attempts cancelled at the 15 minute limit) and the two ways it can never pass without a browser.
// Needs the `yaml` package (tests/package.json). Run: node --test tests/unit/production-smoke-job.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { stampsOf, compareStamps } from "../../tools/served-stamps.mjs";

const root = (p) => fileURLToPath(new URL("../../" + p, import.meta.url));
const read = (p) => readFileSync(root(p), "utf8");
const deploy = parse(read(".github/workflows/deploy-cloudflare.yml"));
const manual = parse(read(".github/workflows/production-smoke.yml"));
const jobs = { "deploy-cloudflare.yml post-deploy-smoke": deploy.jobs["post-deploy-smoke"], "production-smoke.yml smoke": manual.jobs.smoke };
const playwrightPin = JSON.parse(read("tests/package.json")).devDependencies.playwright;
const IMAGE = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}$/;

for (const [name, job] of Object.entries(jobs)) {
  test(`${name}: runs in the Playwright image pinned to tests/package.json, by tag and digest`, () => {
    assert.match(job.container.image, IMAGE);
    assert.equal(job.container.image.match(IMAGE)[1], playwrightPin, "the image tag and the playwright version in tests/package.json must be equal, or the browsers are not found");
    assert.equal(job.env.SMOKE_REQUIRE_ENGINES, "1", "a missing engine must fail, not warn");
    assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
  });
  test(`${name}: no apt, no browser download, every step is bounded`, () => {
    const body = JSON.stringify(job.steps);
    assert.ok(!/apt-get|apt install|--with-deps|playwright install|sudo /.test(body), "the dependency on apt speed is the bug");
    assert.ok(job["timeout-minutes"] <= 15);
    for (const s of job.steps.filter((x) => x.run && !/sleep 45/.test(x.run))) assert.ok(s["timeout-minutes"] > 0 && s["timeout-minutes"] <= 8, `step "${s.name}" needs its own timeout-minutes`);
  });
  test(`${name}: runs the proving script and holds no secret`, () => {
    assert.ok(job.steps.some((s) => /bash tools\/production-smoke\.sh https:\/\/leeroy\.party\/$/.test(s.run || "")));
    assert.ok(!/secrets\./.test(JSON.stringify(job)) && !job.environment);
    assert.ok(!job.permissions || JSON.stringify(job.permissions) === '{"contents":"read"}');
  });
}

test("production-smoke.yml: manual only, read-only, no deploy, and it checks which commit is served before the smoke", () => {
  const on = manual.on ?? manual[true];
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"]);
  assert.deepEqual(manual.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(manual.jobs), ["smoke"]);
  assert.ok(!/wrangler|CLOUDFLARE|pages deploy|workflow_run|schedule/.test(read(".github/workflows/production-smoke.yml").replace(/^\s*#.*$/gm, "")), "it deploys nothing");
  const i = manual.jobs.smoke.steps.findIndex((s) => /served-stamps\.mjs/.test(s.run || "")), j = manual.jobs.smoke.steps.findIndex((s) => /production-smoke\.sh/.test(s.run || ""));
  assert.ok(i >= 0 && j > i, "stamp check first");
  assert.equal(manual.jobs.smoke.steps[i].shell, "bash", "pipefail, so tee cannot hide a failing check");
});

test("deploy-cloudflare.yml: the manual smoke file is ignored by the push trigger, nothing the smoke job reads is", () => {
  const ignore = (deploy.on ?? deploy[true]).push["paths-ignore"];
  assert.ok(ignore.includes(".github/workflows/production-smoke.yml"));
  for (const g of ["tools/production-smoke.sh", "tools/served-stamps.mjs", ".github/workflows/deploy-cloudflare.yml"]) assert.ok(!ignore.includes(g), g);
});

test("production-smoke.sh: names the lines that prove both browsers ran, and fails with 3 when they are missing", () => {
  const sh = read("tools/production-smoke.sh");
  for (const want of ["PASS chromium: the first screen renders with the live API", "PASS webkit: the first screen renders with the live API", "0 failed"]) assert.ok(sh.includes(want), want);
  assert.match(sh, /RC=3/);
  // those lines are what deploy-smoke.mjs prints
  const smoke = read("tests/browser/deploy-smoke.mjs");
  assert.ok(smoke.includes("${eng}: the first screen renders with the live API") && smoke.includes("deploy-smoke: ${pass} passed, ${fail} failed"));
});

test("production-smoke.sh: exit 0 from a smoke that printed no browser lines is still a failure (fake smoke on PATH-free temp tree)", { skip: spawnSync("bash", ["-c", "true"]).status !== 0 && "bash not available" }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, cpSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const run = (smokeBody) => {
    const d = mkdtempSync(join(tmpdir(), "psmoke-"));
    mkdirSync(join(d, "tools")); mkdirSync(join(d, "tests/browser"), { recursive: true });
    cpSync(root("tools/production-smoke.sh"), join(d, "tools/production-smoke.sh"));
    writeFileSync(join(d, "tests/browser/deploy-smoke.mjs"), smokeBody);
    const r = spawnSync("bash", ["tools/production-smoke.sh", "https://example.invalid/"], { cwd: d, encoding: "utf8", env: { ...process.env, RUNNER_TEMP: d, GITHUB_STEP_SUMMARY: join(d, "summary.md") } });
    return r.status;
  };
  assert.equal(run(`console.log("PASS GET /api/health"); console.log("deploy-smoke: 1 passed, 0 failed");`), 3, "exit 0 without the engine lines");
  assert.equal(run(`console.log("PASS chromium: the first screen renders with the live API\\nPASS webkit: the first screen renders with the live API\\ndeploy-smoke: 11 passed, 0 failed");`), 0);
  assert.equal(run(`console.log("FAIL webkit launches"); process.exit(1);`), 1);
});

test("served-stamps: equal stamps match, edge injections are ignored, no stamp or a different stamp is never ok", () => {
  const page = (s, extra = "") => `<link href="css/board.css?v=${s}"><script src="js/a.js?v=0123456789"></script>${extra}`;
  assert.deepEqual(stampsOf(page("18d6ca147a")), ["css/board.css?v=18d6ca147a", "js/a.js?v=0123456789"]);
  assert.equal(compareStamps(page("18d6ca147a"), page("18d6ca147a", '<script src="/cdn-cgi/scripts/x/email-decode.min.js"></script>')).ok, true);
  assert.equal(compareStamps(page("18d6ca147a"), page("18d6ca147a").replace(/\n/g, "\r\n")).ok, true, "CRLF does not matter");
  const diff = compareStamps(page("18d6ca147a"), page("ffffffffff"));
  assert.equal(diff.ok, false); assert.ok(!diff.unknown); assert.equal(diff.missing.length, 1);
  assert.equal(compareStamps("<html></html>", page("18d6ca147a")).unknown, true, "no local stamp: cannot tell");
  assert.equal(compareStamps(page("18d6ca147a"), "<html>error</html>").unknown, true, "no served stamp: cannot tell");
});
