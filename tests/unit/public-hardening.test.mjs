// Public-repo hardening (the repository is public since 2026-11-19): workflow-parse and source checks for
//   M1 no Cloudflare account name or id in any log line, M2 previews use only the preview-scoped token,
//   M4 the production probe and live smoke print counts, never member names, L1 no github.event / step-output expression inside a run: script,
//   L2 the preview URL comment is accepted only from github-actions[bot], stale "private repo" statements.
// Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = ROOT + ".github/workflows/";
const read = (rel) => readFileSync(ROOT + rel, "utf8");
const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => { const text = readFileSync(DIR + f, "utf8"); return { f, text, doc: parse(text) }; });
const wf = (f) => workflows.find((w) => w.f === f);
const stepsOf = (w) => Object.entries(w.doc.jobs || {}).flatMap(([job, j]) => (j.steps || []).map((s) => ({ job, ...s })));

// ---- M1 ----------------------------------------------------------------------------------------------------------------------------
test("M1: no workflow prints the Cloudflare account name or lists accounts", () => {
  for (const w of workflows) {
    for (const s of stepsOf(w)) {
      const run = typeof s.run === "string" ? s.run : "";
      assert.equal(/ACC_NAME/.test(run), false, `${w.f}: ${s.name}: the account name must not be read into a variable`);
      assert.equal(/\.name\b[^\n]*\bacc|accs?\.[a-z]*\.name|match\.name|accs\[0\]\.name|a\.name/.test(run), false, `${w.f}: ${s.name}: the account name is not printed`);
      assert.equal(/Available accounts for this token/.test(run), false, `${w.f}: ${s.name}: no account listing`);
      assert.equal(/Auto-resolved Cloudflare Account ID: '/.test(run), false, `${w.f}: ${s.name}: the old notice with the account name`);
    }
  }
});

test("M1: the two pre-flight steps mask a resolved account id before any echo and never echo the id", () => {
  for (const f of ["deploy-cloudflare.yml", "pr-preview-cloudflare.yml"]) {
    const step = stepsOf(wf(f)).find((s) => /Verify Cloudflare Credentials/.test(s.name || ""));
    assert.ok(step, `${f}: pre-flight step exists`);
    const run = step.run;
    const idVars = ["ACC_ID"];
    for (const v of idVars) {
      assert.ok(run.includes("::add-mask::$" + v), `${f}: ${v} is masked`);
      const unmasked = run.split("\n").filter((l) => !l.includes("::add-mask::") && !l.includes("GITHUB_ENV")).join("\n");
      assert.equal(new RegExp("echo[^\\n]*\\$" + v + "\\b").test(unmasked), false, `${f}: ${v} is never echoed`);
    }
    assert.equal(/Raw response from Cloudflare|Cloudflare response: \$/.test(run), false, `${f}: no raw Cloudflare response (it can carry account data)`);
  }
});

// ---- L1 ----------------------------------------------------------------------------------------------------------------------------
test("L1: no run: script interpolates github.event, head_ref, inputs or a step output (they go through env: instead)", () => {
  const bad = [];
  for (const w of workflows) for (const s of stepsOf(w)) {
    if (typeof s.run !== "string") continue;
    for (const m of s.run.matchAll(/\$\{\{([^}]*)\}\}/g)) if (/github\.(event|head_ref|ref_name|actor)|\binputs\.|\bsteps\./.test(m[1])) bad.push(`${w.f}: ${s.job}: ${s.name || ""}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test("L1: the fork-policy step takes base.ref and head.repo.full_name from env", () => {
  const step = stepsOf(wf("pr-preview-cloudflare.yml")).find((s) => /fork PR policy/.test(s.name || ""));
  assert.equal(step.env.BASE_BRANCH, "${{ github.event.pull_request.base.ref }}");
  assert.equal(step.env.HEAD_REPO, "${{ github.event.pull_request.head.repo.full_name }}");
  assert.match(step.run, /\$BASE_BRANCH/);
  assert.match(step.run, /\$HEAD_REPO/);
});

// ---- L2 ---------------------------------------------------------------------------------------------------------------------------
test("L2: the preview URL comment is accepted only from user.type Bot with login github-actions[bot], read through the issues comments API", () => {
  for (const [f, name] of [["security.yml", "Find the preview URL"], ["preview-tests.yml", "Find the preview URL"]]) {
    const step = stepsOf(wf(f)).find((s) => s.name && s.name.includes(name));
    assert.ok(step, f);
    assert.ok(step.run.includes('gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments"'), f);
    assert.ok(step.run.includes('select(.user.type == "Bot" and .user.login == "github-actions[bot]" and (.body | contains("<!-- cloudflare-pr-preview -->")))'), f);
    assert.equal(step.run.includes(".author.login"), false, f + ": no looser author match");
  }
});

// ---- Cloudflare error codes (review finding 4) ----------------------------------------------------------------------------------------
test("the error-code extraction prints the numeric code and nothing else, and every workflow call feeds the real variable", () => {
  const body = JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error for account Fictional Holdings Ltd" }, { code: 9109, message: "Zone mirelle-voss.example" }], messages: [], result: null });
  const r = spawnSync(process.execPath, [ROOT + "tools/cf-error-codes.mjs"], { input: body, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "10000,9109");
  assert.equal(/Fictional|Authentication|mirelle/i.test(r.stdout + r.stderr), false, "no message text");
  assert.equal(spawnSync(process.execPath, [ROOT + "tools/cf-error-codes.mjs"], { input: "<html>nope</html>", encoding: "utf8" }).stdout.trim(), "unparseable");
  assert.equal(spawnSync(process.execPath, [ROOT + "tools/cf-error-codes.mjs"], { input: '{"success":true,"errors":[]}', encoding: "utf8" }).stdout.trim(), "none");
  assert.equal(spawnSync(process.execPath, [ROOT + "tools/cf-error-codes.mjs"], { input: '{"errors":[{"code":"x; rm","message":"m"}]}', encoding: "utf8" }).stdout.trim(), "none", "a non-numeric code is dropped");
  let calls = 0;
  for (const f of ["deploy-cloudflare.yml", "pr-preview-cloudflare.yml"]) for (const st of stepsOf(wf(f))) {
    if (typeof st.run !== "string") continue;
    assert.equal(st.run.includes("console.log((j.errors"), false, f + ": no inline extraction");
    for (const line of st.run.split("\n")) {
      if (!line.includes("cf-error-codes.mjs")) continue;
      calls++;
      const m = line.match(/printf '%s' "\$([A-Z0-9_]+)" \| node \.\.\/tools\/cf-error-codes\.mjs/);
      assert.ok(m, f + ": the variable's contents are piped in, not its name: " + line.trim().slice(0, 60));
      assert.ok(["VERIFY_RES", "D1_CHECK", "ZONE_CHECK", "USER_VERIFY_RES", "ACCOUNT_VERIFY_RES", "ACCOUNTS_RES"].includes(m[1]), f + ": a real response variable");
    }
  }
  assert.equal(calls, 5, "lines: verify, D1, zone (deploy); user+account verify, account list (preview)");
});

// ---- L3/L-extra: untrusted output and the stamped Worker URL (review finding 6) ---------------------------------------------------------
test("file names are never printed raw, and the Worker URL is validated before it is stamped into JavaScript", () => {
  const prev = stepsOf(wf("pr-preview-cloudflare.yml"));
  assert.equal(prev.some((st) => typeof st.run === "string" && st.run.split("\n").some((l) => l.trim().startsWith('cat "$RUNNER_TEMP/paths.txt"'))), false, "no raw cat of the changed file names");
  assert.ok(prev.some((st) => typeof st.run === "string" && st.run.includes("sed 's/^/| /' \"$RUNNER_TEMP/paths.txt\"")), "the names are prefixed so none can start a workflow command");
  for (const [f, name] of [["pr-preview-cloudflare.yml", "Stage Static Site"], ["deploy-cloudflare.yml", "Stage Static Site"]]) {
    const st = stepsOf(wf(f)).find((x) => x.name && x.name.startsWith(name));
    assert.ok(st, f);
    const gate = st.run.indexOf("refusing to stamp");
    if (f === "pr-preview-cloudflare.yml") {
      // the preview stamps through tools/preview-stamp.mjs (it validates the URL itself and uses replacer functions: tests/unit/preview-stamp.test.mjs)
      const stamp = st.run.indexOf("node tools/preview-stamp.mjs");
      assert.ok(gate > 0 && gate < stamp, f + ": validated before it is stamped");
      continue;
    }
    const stamp = st.run.indexOf("const WORKER");
    assert.ok(gate > 0 && gate < stamp, f + ": validated before it is stamped");
    assert.ok(st.run.includes("() => `const WORKER = \"${url}\";`"), f + ": a replacer function, so $-patterns in the URL are literal");
  }
  const shape = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)?\.workers\.dev$/;
  assert.equal(shape.test("https://leeroy-brain-pr-7.fictional.workers.dev"), true);
  for (const bad of ['https://x.workers.dev/";alert(1);//', "http://x.workers.dev", "https://x.workers.dev.evil.example", "https://x.workers.dev\n::error::x", "https://x.workers.dev$&"]) assert.equal(shape.test(bad), false, bad);
  // the shape used by the workflows is this one (grep -E), so prove the workflow text carries it
  assert.ok(stepsOf(wf("pr-preview-cloudflare.yml")).some((st) => typeof st.run === "string" && st.run.includes("'^https://[a-z0-9-]+(\\.[a-z0-9-]+)?\\.workers\\.dev$'")));
});

test("the secrets runbook states the three design limits and lists the repository-level secrets", () => {
  const t = read("docs/runbooks/ci-secrets.md");
  assert.match(t, /Any user with write access can read repository-level secrets/);
  assert.match(t, /environment secrets of `production`/);
  assert.match(t, /Cloudflare permission groups for Workers, D1 and Pages are account-wide/);
  assert.ok(t.includes("separate Cloudflare account (or zone) for previews"));
  assert.ok(t.includes("Previews still use the production `CLOUDFLARE_API_TOKEN` for now"), "says the split is pending");
  for (const n of ["BOARD_ADMIN_TOKEN", "USER_SALT", "KEY_SALT", "AI_GATEWAY_TOKEN", "DISCORD_BOT_TOKEN", "GEMINI_API_KEY"]) assert.ok(t.includes(n), n);
});

// ---- M4 ----------------------------------------------------------------------------------------------------------------------------
test("M4: the production probe prints counts, never the chip texts or slugs, and scrubs member names from its failure lines", () => {
  const src = read("tests/browser/prod-probe.mjs");
  assert.equal(/names: \$\{/.test(src), false, "no names list in the DOM facts");
  assert.equal(/\.textContent\.trim\(\)\)\.filter\(Boolean\)\.slice\(0, 12\)/.test(src), false);
  assert.equal(/slugs: \$\{have\.slugs/.test(src), false, "no slug list");
  assert.match(src, /counts only, no member names/);
  assert.match(src, /const fail = \(where, what\) => \{ const w = scrub\(what\)/);
  assert.match(src, /DIAG \$\{tag\}: \$\{scrub\(line\)\}/);
});

test("M4: the probe redacts every roster token (name, slug, words, slug components) from all output, and the selftest asserts it", () => {
  const src = read("tests/browser/prod-probe.mjs");
  assert.ok(src.includes('...n.split(/[^A-Za-z0-9]+/), ...sl.split("-")'));
  assert.ok(src.includes('for (const m of ["log", "error", "warn"])'));
  assert.ok(src.includes("fs.appendFileSync = "));
  const st = read("tests/browser/prod-probe-selftest.mjs");
  assert.match(st, /no fixture roster name, slug or word appears anywhere in the output/);
});

test("M4: live-smoke prints a count of unreadable chip labels, not their names", () => {
  const src = read("tests/browser/live-smoke.mjs");
  assert.equal(/\$\{c\.name\} \(lum/.test(src), false);
  assert.match(src, /chip labels not readable \(counts only, no member names\)/);
});

// ---- stale private statements ------------------------------------------------------------------------------------------------------
test("docs and comments no longer say the repository is private", () => {
  for (const rel of ["docs/runbooks/ci-minutes.md", "tools/ci-scope.mjs", ".github/workflows/pr-preview-cloudflare.yml", ".github/workflows/preview-tests.yml"]) {
    const t = read(rel);
    assert.equal(/repo(sitory)? is private|private repo\b|GitHub (Actions|minutes)[^\n]*metered/i.test(t), false, `${rel} still describes a private, metered repo`);
  }
  const roster = read("docs/runbooks/roster-upsert.md");
  assert.equal(/The repository must be private\./.test(roster), false);
  assert.match(roster, /cannot run while the repository is public/);
  // The planning files moved to the private ops repo; the public tree must not carry them and the README must say where they went.
  for (const rel of ["docs/roadmap/PRODUCT-REVIEW.md", "docs/roadmap/SYNTHESIS.md", "docs/roadmap/CRITIQUE-B-security-ops.md", "docs/roadmap/OWNER-VISION.md", "docs/roadmap/research/notes-R5-ip-commercial.md"]) {
    assert.equal(existsSync(ROOT + rel), false, `${rel} must live in the private ops repo, not here`);
  }
  assert.match(read("docs/roadmap/README.md"), /moved to the private ops repo on 2026-11-19/);
});

test("the roster workflow still refuses to run in a public repository", () => {
  const step = stepsOf(wf("roster-upsert.yml"))[0];
  assert.match(step.run, /\[ "\$REPO_PRIVATE" != "true" \]/);
  assert.match(step.run, /runs of a public repository publish their logs/);
});
