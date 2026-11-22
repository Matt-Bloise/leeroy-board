// BROWSER SHARDS: the browser suites run in 4 CI shards (tests/browser/run.mjs --shard i/4) and the production probe's self-test in 3 (prod-probe-selftest.mjs --shard i/3).
// A suite or a case silently dropped by the split would be a hole in the gate, so this pins: the shards hold every suite exactly once, live-smoke is the first suite of shard 0, the self-test is not
// also run inside the browser shards, the workflow's legs and the shard counts agree, and the self-test's shard 0 owns the sections that follow its cases.
// Run: node --test tests/unit/browser-shards.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { orderedSuites, parseShard, shardOf, withoutShard } from "../helpers/shard.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const { parse } = createRequire(import.meta.url)("yaml");
const wf = parse(read(".github/workflows/preview-tests.yml"));
const nightly = parse(read(".github/workflows/nightly-production.yml"));

const BROWSER_DIR = path.join(ROOT, "tests", "browser");
const listShard = (shard) => {
  const r = spawnSync(process.execPath, [path.join(BROWSER_DIR, "run.mjs"), ...(shard ? ["--shard", shard] : []), "--list"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
};

test("the shard helpers: order, parse, split", () => {
  assert.deepEqual(orderedSuites(["b.mjs", "live-smoke.mjs", "a.mjs"]), ["live-smoke.mjs", "a.mjs", "b.mjs"]);
  assert.equal(parseShard(["--url", "x"]), null);
  assert.deepEqual(parseShard(["--shard", "2/4"]), { index: 2, count: 4 });
  for (const bad of ["4/4", "0/0", "a/b", "1", "-1/4", "0/17", ""]) assert.throws(() => parseShard(["--shard", bad]), /--shard/, bad);
  assert.throws(() => parseShard(["--shard"]), /--shard/);
  assert.deepEqual(shardOf([1, 2, 3, 4, 5, 6, 7], 1, 3), [2, 5]);
  assert.deepEqual(withoutShard(["--url", "u", "--shard", "1/4", "--engines", "x"]), ["--url", "u", "--engines", "x"]);
  const list = Array.from({ length: 23 }, (_, i) => i);
  for (const n of [1, 2, 3, 4, 7]) assert.deepEqual([...Array(n).keys()].flatMap((i) => shardOf(list, i, n)).sort((a, b) => a - b), list, `n=${n}`);
});

test("the union of the browser shards is the full suite list, each suite exactly once, and live-smoke is first in shard 0", () => {
  const full = listShard(null);
  assert.ok(full.length >= 40, `suites found: ${full.length}`);
  assert.equal(full[0], "live-smoke.mjs");
  const count = Number(wf.jobs.browser.strategy.matrix.include.filter((l) => l.suite === "browser")[0].shard.split("/")[1]);
  const shards = Array.from({ length: count }, (_, i) => listShard(`${i}/${count}`));
  assert.deepEqual(shards[0][0], "live-smoke.mjs", "live-smoke stays first, in shard 0");
  assert.ok(shards.slice(1).every((s) => !s.includes("live-smoke.mjs")), "live-smoke runs once");
  const union = shards.flat();
  assert.equal(union.length, full.length, "no suite twice, none dropped");
  assert.deepEqual([...union].sort(), [...full].sort());
  for (const s of shards) assert.ok(s.length >= Math.floor(full.length / count) && s.length <= Math.ceil(full.length / count), "shards are balanced by count");
});

test("every .mjs in tests/browser is either a browser suite, a known helper or the self-test: nothing is outside the shards by accident", () => {
  const all = readdirSync(BROWSER_DIR).filter((f) => f.endsWith(".mjs"));
  const full = new Set(listShard(null));
  const helpers = new Set(["run.mjs", "smoke-retry.mjs", "prod-probe.mjs", "prod-probe-selftest.mjs"]);
  for (const f of all) assert.ok(full.has(f) || helpers.has(f), `${f} is neither in the browser shards nor a known helper`);
  for (const f of helpers) assert.ok(!full.has(f), `${f} must not run as a browser suite`);
  assert.ok(all.includes("prod-probe-selftest.mjs"));
});

test("preview-tests.yml: one job named browser whose legs are the browser shards and the self-test shards, each passing --shard i/n to its own runner", () => {
  const job = wf.jobs.browser;
  assert.equal(job.name, "browser");
  assert.equal(job.strategy["fail-fast"], false);
  const legs = job.strategy.matrix.include;
  const browserLegs = legs.filter((l) => l.suite === "browser"), selfLegs = legs.filter((l) => l.suite === "selftest");
  assert.ok(browserLegs.length >= 2 && selfLegs.length >= 2);
  for (const group of [browserLegs, selfLegs]) {
    const counts = new Set(group.map((l) => l.shard.split("/")[1]));
    assert.equal(counts.size, 1, "one shard count per kind");
    const n = Number([...counts][0]);
    assert.deepEqual(group.map((l) => Number(l.shard.split("/")[0])).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i), "every shard index 0..n-1 exactly once");
  }
  const legNames = legs.map((l) => l.leg), logs = legs.map((l) => l.log);
  assert.equal(new Set(legNames).size, legs.length, "leg names are unique (artifact names)");
  assert.equal(new Set(logs).size, legs.length, "log files are unique");
  assert.equal(browserLegs.find((l) => l.shard.startsWith("0/")).log, "browser.log", "shard 0 holds live-smoke and writes browser.log, which tools/ci-report.mjs reads");
  const run = job.steps.find((s) => s.name === "Browser smoke").run;
  assert.match(run, /prod-probe-selftest\.mjs --shard "\$SHARD"/);
  assert.match(run, /test:browser -- --url "\$PAGES_URL\/" --shard "\$SHARD"/);
  assert.match(JSON.stringify(job.steps.find((s) => s.name === "Upload logs")), /preview-test-logs-browser-\$\{\{ matrix\.leg \}\}/);
  assert.ok(job["timeout-minutes"] <= 30, "a leg is short");
  assert.ok(wf.jobs.report.needs.includes("browser"), "the report job still reads the browser result (the AND of all legs)");
});

test("the self-test shards cover every case once: shard 0 owns the sections after the cases, the others do not run them", () => {
  const src = read("tests/browser/prod-probe-selftest.mjs");
  assert.match(src, /MY_CASES = SHARD \? CASES\.filter\(\(_, p\) => p % SHARD\.count === SHARD\.index\) : CASES/);
  assert.match(src, /const shard0 = !SHARD \|\| SHARD\.index === 0/);
  assert.match(src, /\|\| !shard0\) break;/, "the redirect modes run in shard 0 only");
  assert.match(src, /if \(shard0 && \(!only \|\| only\.includes\("budget"\)\)\)/, "the request budget section runs in shard 0 only");
  assert.match(src, /INFO progress \$\{done\}\/\$\{MY_CASES\.length\}/, "a progress line per finished case");
  // the same arithmetic the file uses, over a stand-in list: the shards hold every case once
  const cases = Array.from({ length: 44 }, (_, i) => i);
  for (const n of [1, 3]) assert.deepEqual([...Array(n).keys()].flatMap((i) => cases.filter((_, p) => p % n === i)).sort((a, b) => a - b), cases);
});

test("the self-test also runs nightly, whole, and a nightly failure counts", () => {
  const job = nightly.jobs["probe-selftest"];
  assert.ok(job, "nightly-production.yml has the probe-selftest job");
  assert.match(JSON.stringify(job.steps), /node browser\/prod-probe-selftest\.mjs 2>&1/);
  assert.ok(nightly.jobs.notify.needs.includes("probe-selftest"));
  assert.match(read(".github/workflows/nightly-production.yml"), /needs\['probe-selftest'\]\.result != 'success'/);
});

test("a change to the production probe, its self-test, tests/helpers or tests/package*.json is a site change, so the legs run for it", async () => {
  const { isSitePath } = await import("../../tools/ci-scope.mjs");
  for (const p of ["tests/browser/prod-probe.mjs", "tests/browser/prod-probe-selftest.mjs", "tests/helpers/probe-checks.mjs", "tests/helpers/shard.mjs", "tests/package.json", "tests/package-lock.json", ".github/workflows/preview-tests.yml"]) assert.equal(isSitePath(p), true, p);
});

test("the install step of the browser legs: bounded attempts, one automatic retry, a Playwright browser cache keyed on the lockfile, and no retry for any test step", () => {
  const steps = wf.jobs.browser.steps;
  const step = steps.find((s) => /^Install test dependencies$/.test(s.name));
  assert.ok(step["timeout-minutes"] <= 20 && step["timeout-minutes"] < wf.jobs.browser["timeout-minutes"], "a stalled install is cut well before the job limit");
  assert.match(step.run, /for attempt in 1 2; do/);
  assert.ok(!/timeout\s+\d+\s+bash/.test(step.run), "nothing is killed mid-install: a kill left apt holding the dpkg lock and the retry failed on it");
  assert.match(step.run, /DPkg::Lock::Timeout "300"/);
  assert.match(step.run, /Acquire::Retries "3"/);
  assert.match(step.run, /playwright install --with-deps chromium webkit/);
  const cache = steps.find((s) => s.uses && /actions\/cache@[0-9a-f]{40}/.test(s.uses));
  assert.ok(cache, "the cache action is pinned to a full sha");
  assert.equal(cache.with.path, "~/.cache/ms-playwright");
  assert.match(cache.with.key, /hashFiles\('tests\/package-lock\.json'\)/);
  assert.ok(steps.indexOf(cache) < steps.indexOf(step), "restored before the install");
  const test = steps.find((s) => s.name === "Browser smoke");
  assert.ok(!/attempt|retry|for i in/.test(test.run), "a test step never gets a retry");
});
