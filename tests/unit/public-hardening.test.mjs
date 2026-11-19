// Public-repo hardening (the repository is public since 2026-11-19): workflow-parse and source checks for
//   M1 no Cloudflare account name or id in any log line, M2 previews use only the preview-scoped token,
//   M4 the production probe and live smoke print counts, never member names, L1 no github.event / step-output expression inside a run: script,
//   L2 the preview URL comment is accepted only from github-actions[bot], stale "private repo" statements.
// Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
    const idVars = f.startsWith("deploy") ? ["ACC_ID"] : ["CLEAN_ACC", "TARGET_ACCOUNT_ID"];
    for (const v of idVars) {
      assert.ok(run.includes("::add-mask::$" + v), `${f}: ${v} is masked`);
      const unmasked = run.split("\n").filter((l) => !l.includes("::add-mask::") && !l.includes("GITHUB_ENV")).join("\n");
      assert.equal(new RegExp("echo[^\\n]*\\$" + v + "\\b").test(unmasked), false, `${f}: ${v} is never echoed`);
    }
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
  assert.equal(/echo[^\n]*\$(PERM_RES|D1_CHECK|CLEAN_TOKEN|ACCOUNTS_RES)/.test(step.run.replace(/^.*GITHUB_ENV.*$/gm, "").replace(/printf '%s' "\$[A-Z0-9_]+" \| node \.\.\/tools\/cf-error-codes\.mjs/g, "")), false, "no response body or token is echoed");
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
    const gate = st.run.indexOf("refusing to stamp"), stamp = st.run.indexOf("const WORKER");
    assert.ok(gate > 0 && gate < stamp, f + ": validated before it is stamped");
    assert.ok(st.run.includes("() => `const WORKER = \"${url}\";`"), f + ": a replacer function, so $-patterns in the URL are literal");
  }
  const shape = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)?\.workers\.dev$/;
  assert.equal(shape.test("https://leeroy-brain-pr-7.fictional.workers.dev"), true);
  for (const bad of ['https://x.workers.dev/";alert(1);//', "http://x.workers.dev", "https://x.workers.dev.evil.example", "https://x.workers.dev\n::error::x", "https://x.workers.dev$&"]) assert.equal(shape.test(bad), false, bad);
  // the shape used by the workflows is this one (grep -E), so prove the workflow text carries it
  assert.ok(stepsOf(wf("pr-preview-cloudflare.yml")).some((st) => typeof st.run === "string" && st.run.includes("'^https://[a-z0-9-]+(\\.[a-z0-9-]+)?\\.workers\\.dev$'")));
});

test("the guard and teardown messages warn that deleting the preview token disables previews and teardown", () => {
  for (const f of PREVIEW_FILES) assert.match(wf(f).text, /Do not delete CLOUDFLARE_PREVIEW_API_TOKEN while any PR carries ci-full/);
  assert.match(wf("pr-preview-cloudflare.yml").text, /any preview that already exists is NOT torn down/);
});

test("the secrets runbook states the three design limits and lists the repository-level secrets", () => {
  const t = read("docs/runbooks/ci-secrets.md");
  assert.match(t, /Any user with write access can read repository-level secrets/);
  assert.match(t, /environment secrets of `production`/);
  assert.match(t, /Cloudflare permission groups for Workers, D1 and Pages are account-wide/);
  assert.ok(t.includes("separate Cloudflare account (or zone) for previews"));
  assert.match(t, /Deleting the preview token disables full previews and makes teardown skip/);
  for (const n of ["BOARD_ADMIN_TOKEN", "USER_SALT", "KEY_SALT", "AI_GATEWAY_TOKEN", "DISCORD_BOT_TOKEN", "GEMINI_API_KEY"]) assert.ok(t.includes(n), n);
  assert.equal(t.includes("**not used.**"), false, "the stale 'not used' row is gone");
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
  const review = read("docs/roadmap/PRODUCT-REVIEW.md");
  assert.match(review.split("\n").slice(0, 6).join("\n"), /made public on 2026-11-19/);
});

test("the roster workflow still refuses to run in a public repository", () => {
  const step = stepsOf(wf("roster-upsert.yml"))[0];
  assert.match(step.run, /\[ "\$REPO_PRIVATE" != "true" \]/);
  assert.match(step.run, /runs of a public repository publish their logs/);
});

// ---- preview pre-flight with an account-owned token ---------------------------------------------------------------------------------------
// Runs the real step script under bash with a fake `curl` on PATH. Fictional account id and token; nothing leaves the machine.
import { mkdtempSync, writeFileSync, chmodSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runPreflight = ({ userOk, accountOk }) => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const fake = [
    "#!/usr/bin/env bash",
    'url=""; for a in "$@"; do case "$a" in https://*) url="$a";; esac; done',
    'case "$url" in',
    "  */user/tokens/verify) " + (userOk ? "echo '{\"success\":true,\"result\":{\"status\":\"active\"}}'" : "echo '{\"success\":false,\"errors\":[{\"code\":1000,\"message\":\"Invalid API Token for Fictional Holdings\"}]}'") + ";;",
    "  */tokens/verify) " + (accountOk ? "echo '{\"success\":true,\"result\":{\"status\":\"active\"}}'" : "echo '{\"success\":false,\"errors\":[{\"code\":7003,\"message\":\"Could not route to /accounts/ACC1234, perhaps your object identifier is invalid?\"}]}'") + ";;",
    "  *) echo '{\"success\":true,\"result\":[]}';;",
    "esac",
  ].join("\n");
  writeFileSync(join(dir, "curl"), fake); chmodSync(join(dir, "curl"), 0o755);
  const step = stepsOf(wf("pr-preview-cloudflare.yml")).find((s) => /Verify Cloudflare Credentials/.test(s.name || ""));
  const envFile = join(dir, "env.txt"); writeFileSync(envFile, "");
  const r = spawnSync("bash", ["-c", step.run], {
    cwd: ROOT + "infrastructure", encoding: "utf8",
    env: { ...process.env, PATH: dir + ":" + process.env.PATH, CLOUDFLARE_API_TOKEN: "tok-fictional-0000", CLOUDFLARE_ACCOUNT_ID: "ACC1234", GITHUB_ENV: envFile },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), env: rf(envFile, "utf8") };
};

test("preview pre-flight: a user token verifies at /user, an account-owned token at /accounts/{id}, and a failure names both endpoints with codes only", () => {
  const user = runPreflight({ userOk: true, accountOk: false });
  assert.equal(user.code, 0, user.out);
  assert.match(user.out, /verified via GET \/user\/tokens\/verify/);
  const acct = runPreflight({ userOk: false, accountOk: true });
  assert.equal(acct.code, 0, acct.out);
  assert.match(acct.out, /verified via GET \/accounts\/\{account_id\}\/tokens\/verify \(account-owned token\)/);
  assert.match(acct.env, /CLOUDFLARE_API_TOKEN=tok-fictional-0000/);
  const none = runPreflight({ userOk: false, accountOk: false });
  assert.equal(none.code, 1);
  assert.ok(none.out.includes("GET /user/tokens/verify (Cloudflare error codes: 1000)"), none.out);
  assert.ok(none.out.includes("GET /accounts/{account_id}/tokens/verify (Cloudflare error codes: 7003)"), none.out);
  assert.equal(/Fictional|Invalid API Token|Could not route|ACC1234|tok-fictional/.test(none.out), false, "no message text, account id or token in the log");
});

test("preview pre-flight: the account list is not needed when the account id is configured", () => {
  const step = stepsOf(wf("pr-preview-cloudflare.yml")).find((s) => /Verify Cloudflare Credentials/.test(s.name || ""));
  const listIdx = step.run.indexOf('client/v4/accounts"'), guard = step.run.indexOf('if [ -n "$CLEAN_ACC" ]; then');
  assert.ok(guard > 0 && listIdx > guard, "listing only in the else branch");
});
