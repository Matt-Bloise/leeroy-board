// Public-repo hardening (the repository is public since 2026-11-19): workflow-parse and source checks for
//   M1 no Cloudflare account name or id in any log line, M2 previews use only the preview-scoped token,
//   M4 the production probe and live smoke print counts, never member names, L1 no github.event / step-output expression inside a run: script,
//   L2 the preview URL comment is accepted only from github-actions[bot], stale "private repo" statements.
// Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = ROOT + ".github/workflows/";
const read = (rel) => readFileSync(ROOT + rel, "utf8");
const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => { const text = readFileSync(DIR + f, "utf8"); return { f, text, doc: parse(text) }; });
const wf = (f) => workflows.find((w) => w.f === f);
const stepsOf = (w) => Object.entries(w.doc.jobs || {}).flatMap(([job, j]) => (j.steps || []).map((s) => ({ job, ...s })));
const PREVIEW_FILES = ["pr-preview-cloudflare.yml", "preview-tests.yml"];
const PROD_TOKEN = /secrets\.CLOUDFLARE_API_TOKEN\b/;
const PREVIEW_TOKEN = /secrets\.CLOUDFLARE_PREVIEW_API_TOKEN\b/;

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
    const masks = [...run.matchAll(/::add-mask::\$ACC_ID/g)].length;
    assert.equal(masks, 2, `${f}: ACC_ID is masked in the MATCH and the RESOLVED_SINGLE branch`);
    assert.equal(/echo[^\n]*\$ACC_ID/.test(run.replace(/echo "::add-mask::\$ACC_ID"/g, "")), false, `${f}: ACC_ID is never echoed`);
    assert.equal(/Raw response from Cloudflare|Cloudflare response: \$/.test(run), false, `${f}: no raw Cloudflare response (it can carry account data)`);
  }
});

// ---- M2 ----------------------------------------------------------------------------------------------------------------------------
test("M2: no preview workflow references secrets.CLOUDFLARE_API_TOKEN; each uses the preview token", () => {
  for (const f of PREVIEW_FILES) {
    const w = wf(f);
    assert.equal(PROD_TOKEN.test(w.text), false, `${f} must not read the production Cloudflare token`);
    assert.equal(PREVIEW_TOKEN.test(w.text), true, `${f} reads the preview token`);
  }
  const prev = wf("pr-preview-cloudflare.yml").doc.jobs;
  for (const job of ["deploy-pr-preview", "teardown-pr-preview"]) assert.match(prev[job].env.CLOUDFLARE_API_TOKEN, /secrets\.CLOUDFLARE_PREVIEW_API_TOKEN/, `${job}: wrangler gets the preview token under its conventional env name`);
});

test("M2: production deploy, roster and prune workflows never reference the preview token", () => {
  for (const f of ["deploy-cloudflare.yml", "roster-upsert.yml", "pages-prune.yml"]) {
    assert.equal(/CLOUDFLARE_PREVIEW_API_TOKEN/.test(wf(f).text), false, `${f} must not mention the preview token`);
    assert.equal(PROD_TOKEN.test(wf(f).text), true, `${f} keeps the production token`);
  }
});

test("M2: the preview guards test for the preview token by NAME only", () => {
  for (const [f, job] of [["pr-preview-cloudflare.yml", "preview-guard"], ["preview-tests.yml", "preview-secrets"]]) {
    const j = wf(f).doc.jobs[job];
    assert.match(j.env.PREVIEW_API_TOKEN, /secrets\.CLOUDFLARE_PREVIEW_API_TOKEN/);
    const run = j.steps.find((s) => s.id === "check").run;
    assert.match(run, /\[ -n "\$PREVIEW_API_TOKEN" \] \|\| MISSING="\$MISSING CLOUDFLARE_PREVIEW_API_TOKEN"/);
    assert.equal(/echo[^\n]*\$PREVIEW_API_TOKEN/.test(run), false, "the token value is never echoed");
  }
});

test("M2: the diagnostics step runs with the preview token and names each missing permission without printing the token, account name or response body", () => {
  const step = stepsOf(wf("pr-preview-cloudflare.yml")).find((s) => /Verify Cloudflare Credentials/.test(s.name || ""));
  const job = wf("pr-preview-cloudflare.yml").doc.jobs[step.job];
  assert.match(job.env.CLOUDFLARE_API_TOKEN, /CLOUDFLARE_PREVIEW_API_TOKEN/);
  for (const label of ["Account > D1 > Edit", "Account > Workers Scripts > Edit", "Account > Cloudflare Pages > Edit"]) assert.ok(step.run.includes(label), `reports ${label}`);
  assert.match(step.run, /CLOUDFLARE_PREVIEW_API_TOKEN is missing permissions:\$MISSING_PERMS/);
  assert.equal(/echo[^\n]*\$(PERM_RES|D1_CHECK|CLEAN_TOKEN|ACCOUNTS_RES)/.test(step.run.replace(/^.*GITHUB_ENV.*$/gm, "")), false, "no response body or token is echoed");
  assert.equal(/Authorization: Bearer \$CLEAN_TOKEN/.test(step.run), true);
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

// ---- L2 ----------------------------------------------------------------------------------------------------------------------------
test("L2: security.yml accepts the preview URL only from a github-actions comment", () => {
  const step = stepsOf(wf("security.yml")).find((s) => /Find the preview URL/.test(s.name || ""));
  assert.match(step.run, /select\(\(\.author\.login == "github-actions" or \.author\.login == "github-actions\[bot\]"\) and \(\.body \| contains\("<!-- cloudflare-pr-preview -->"\)\)\)/);
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
  const review = read("docs/roadmap/PRODUCT-REVIEW.md");
  assert.match(review.split("\n").slice(0, 6).join("\n"), /made public on 2026-11-19/);
});

test("the roster workflow still refuses to run in a public repository", () => {
  const step = stepsOf(wf("roster-upsert.yml"))[0];
  assert.match(step.run, /\[ "\$REPO_PRIVATE" != "true" \]/);
  assert.match(step.run, /runs of a public repository publish their logs/);
});
