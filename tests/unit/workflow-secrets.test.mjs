// Guard for docs/runbooks/ci-secrets.md: a workflow that a pull request can trigger must never reference a production secret,
// and the production deploy must run in the GitHub environment `production`. Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { stripComments as code } from "../helpers/yaml-comments.mjs";

const DIR = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const load = (f) => { const text = readFileSync(DIR + f, "utf8"); return { f, text, doc: parse(text) }; };
const workflows = files.map(load);

// Triggers that run code from a pull request (or its fork). `workflow_run` is included: it can be started by a PR workflow and read secrets with the PR's artifacts.
const PR_TRIGGERS = ["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment", "workflow_run"];
// The only secrets a PR-triggered workflow may name. GITHUB_TOKEN is per run; CLOUDFLARE_ACCOUNT_ID is an identifier, not a credential.
// CLOUDFLARE_API_TOKEN (the production Cloudflare token) is allowed ONLY in the jobs listed in TOKEN_JOBS, one occurrence each, by decision of the Cloudflare
// account owner (previews share the production Cloudflare token; there is no CLOUDFLARE_PREVIEW_API_TOKEN). BOARD_ADMIN_TOKEN and every other production secret stay forbidden.
const PR_ALLOWED = new Set(["GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN", "BOARD_PREVIEW_ADMIN_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
const TOKEN_JOBS = {
  "pr-preview-cloudflare.yml": { "preview-guard": 1, "deploy-pr-preview": 1, "teardown-pr-preview": 1 },
  "preview-tests.yml": { "preview-secrets": 1 },
};
const TOKEN_RE = /(?<![\w.\/-])secrets\.CLOUDFLARE_API_TOKEN\b/g;
// Production secrets: deploy-cloudflare.yml reads these from the environment `production` only.
const PRODUCTION = ["BOARD_ADMIN_TOKEN", "USER_SALT", "KEY_SALT", "AI_GATEWAY_TOKEN", "CLOUDFLARE_AIG_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  "GROQ_API_KEY", "CEREBRAS_API_KEY", "GITHUB_MODELS_TOKEN", "OPENROUTER_API_KEY", "DISCORD_WEBHOOK_URL", "DISCORD_PUBLIC_KEY", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"];

const triggers = (doc) => { const on = doc.on ?? doc[true]; return typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on || {}); };
// Comments are not code: `code` (tests/helpers/yaml-comments.mjs) strips `# ...` comments, but not a # inside quotes or ${{ }}, so a runbook pointer in a comment is not read as a reference.
const secretNames = (text) => [...code(text).matchAll(/(?<![\w.\/-])secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);

test("the workflow directory is found and parsed", () => {
  assert.ok(workflows.length >= 5);
  assert.ok(workflows.some((w) => w.f === "preview-tests.yml") && workflows.some((w) => w.f === "pr-preview-cloudflare.yml"));
});

for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) {
  test(`${w.f} (PR-triggered) names no production secret`, () => {
    const bad = secretNames(w.text).filter((n) => !PR_ALLOWED.has(n));
    assert.deepEqual([...new Set(bad)], [], `${w.f} references secrets a pull request must not read`);
    const c = code(w.text);
    for (const n of PRODUCTION) assert.equal(new RegExp(`(?<![\\w./-])secrets\\.${n}\\b`).test(c), false, `${w.f} reads production secret ${n}`);
    assert.equal(/CLOUDFLARE_PREVIEW_API_TOKEN/.test(c), false, `${w.f}: CLOUDFLARE_PREVIEW_API_TOKEN is not part of the design (previews use CLOUDFLARE_API_TOKEN)`);
    assert.equal(/(?<![\w.\/-])secrets\s*\[/.test(c), false, "indexed secrets access hides the name");
    assert.equal(/toJSON\(\s*secrets\s*\)/.test(c), false, "toJSON(secrets) exposes every secret");
    assert.equal(/secrets:\s*inherit/.test(c), false, "secrets: inherit passes every secret to a called workflow");
    assert.equal(/\benvironment\s*:\s*production\b/.test(c), false, "a PR-triggered workflow must not use the production environment");
  });
}

test("no workflow uses pull_request_target", () => {
  for (const w of workflows) assert.equal(triggers(w.doc).includes("pull_request_target"), false, `${w.f} uses pull_request_target`);
});

test("the production deploy runs in the environment production and is not PR-triggered", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.ok(w);
  assert.equal(triggers(w.doc).some((t) => PR_TRIGGERS.includes(t)), false);
  const job = w.doc.jobs["deploy-production"];
  assert.equal(job.environment, "production");
  assert.equal(job.if, "github.ref == 'refs/heads/master'");
});

test("only the production deploy reads production secrets", () => {
  for (const w of workflows.filter((x) => x.f !== "deploy-cloudflare.yml")) {
    const bad = secretNames(w.text).filter((n) => PRODUCTION.includes(n));
    assert.deepEqual([...new Set(bad)], [], `${w.f} reads production secrets outside the production environment`);
  }
});

test("the deploy installs wrangler from the lockfile, with an exact version", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.match(code(w.text), /npm ci --no-audit --no-fund/);
  assert.equal(/npm install\b/.test(code(w.text)), false);
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package.json", import.meta.url)), "utf8"));
  assert.match(pkg.devDependencies.wrangler, /^\d+\.\d+\.\d+$/, "wrangler must be an exact version, no ^ or ~");
  const lock = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package-lock.json", import.meta.url)), "utf8"));
  assert.equal(lock.packages["node_modules/wrangler"].version, pkg.devDependencies.wrangler);
});

test("preview jobs skip, not fail, when the preview secrets are absent", () => {
  const prev = workflows.find((x) => x.f === "pr-preview-cloudflare.yml").doc;
  assert.match(prev.jobs["deploy-pr-preview"].if, /preview-guard\.outputs\.enabled == 'true'/);
  assert.ok([].concat(prev.jobs["deploy-pr-preview"].needs).includes("preview-guard"));
  const tests = workflows.find((x) => x.f === "preview-tests.yml").doc;
  assert.match(tests.jobs.preview.if, /preview-secrets\.outputs\.enabled == 'true'/);
});

test("CLOUDFLARE_API_TOKEN is read only in the preview, teardown and preview-secrets jobs of the two preview workflows, once each", () => {
  const prFiles = workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)));
  for (const w of prFiles) {
    const allowed = TOKEN_JOBS[w.f] || {};
    for (const [name, job] of Object.entries(w.doc.jobs)) {
      const n = (JSON.stringify(job).match(TOKEN_RE) || []).length;
      assert.equal(n, allowed[name] || 0, `${w.f} job ${name}: expected ${allowed[name] || 0} reference(s) to secrets.CLOUDFLARE_API_TOKEN, found ${n}`);
    }
    assert.equal((code(w.text).match(TOKEN_RE) || []).length, Object.values(allowed).reduce((a, b) => a + b, 0), `${w.f}: total references`);
  }
  for (const f of Object.keys(TOKEN_JOBS)) assert.ok(prFiles.some((w) => w.f === f), `${f} must be PR-triggered and checked`);
});

test("BOARD_ADMIN_TOKEN and the other production secrets are never available to a PR workflow", () => {
  for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) {
    for (const n of PRODUCTION) assert.equal(new RegExp(`(?<![\\w./-])secrets\\.${n}\\b`).test(code(w.text)), false, `${w.f}: ${n}`);
  }
});

// Flagship: production binds to the production Flagship app through [[flagship]] in wrangler.toml. A PR preview Worker is built from the same
// file and must NOT: the preview deploy strips the block (tools/strip-flagship-binding.mjs), so previews read the legacy [vars].
const STRIP = "strip-flagship-binding.mjs";
test("every non-production job that runs `wrangler deploy` strips the Flagship binding first, in the same job", () => {
  let seen = 0;
  for (const w of workflows.filter((x) => x.f !== "deploy-cloudflare.yml")) {
    for (const [name, job] of Object.entries(w.doc.jobs)) {
      const steps = job.steps || [];
      steps.forEach((s, i) => {
        if (!/\bwrangler deploy\b/.test(code(s.run || ""))) return;
        seen++;
        const strip = steps.findIndex((t) => (t.run || "").includes(STRIP));
        assert.ok(strip >= 0 && strip <= i, `${w.f} job ${name}: step ${i} runs wrangler deploy without stripping the [[flagship]] binding first`);
      });
    }
  }
  assert.ok(seen >= 1, "the preview deploy step must be found");
});

test("the preview strips the binding AFTER it patches wrangler.toml, and no PR-triggered workflow can add a Flagship binding", () => {
  const prev = workflows.find((x) => x.f === "pr-preview-cloudflare.yml");
  const step = Object.values(prev.doc.jobs).flatMap((j) => j.steps || []).find((t) => (t.run || "").includes(STRIP));
  assert.ok(step, "the preview patch step runs the strip tool");
  assert.ok(step.run.indexOf(STRIP) > step.run.indexOf('writeFileSync("wrangler.toml"'), "strip runs after the patched file is written");
  for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) {
    assert.equal(/flagship/i.test(code(w.text).split(STRIP).join("")), false, `${w.f} mentions Flagship in code other than the strip tool`);
  }
});

test("the production deploy keeps the binding: it does not strip it, and touches Flagship only through the one create-missing-flags step (B51)", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.equal(/strip-flagship-binding/.test(code(w.text)), false, "production never strips the binding");
  const mentions = code(w.text).split("\n").filter((l) => /flagship/i.test(l));
  for (const l of mentions) assert.match(l, /flagship-ensure-flags|Flagship flag|Flagship problem|Flagship app|flagship flags create|never changes an existing flag/i, `unexpected Flagship reference in the production deploy: ${l.trim()}`);
  assert.ok(mentions.length > 0, "the create-missing-flags step is there");
});

// wrangler 4 needs Node >= 22: every workflow that runs wrangler must set up Node 22 or newer.
test("every workflow that runs wrangler sets up Node 22 or newer", () => {
  for (const w of workflows.filter((x) => /\bwrangler\b/.test(code(x.text)))) {
    const versions = Object.values(w.doc.jobs).flatMap((j) => (j.steps || []).filter((s) => /actions\/setup-node/.test(s.uses || "")).map((s) => Number(String(s.with && s.with["node-version"]).split(".")[0])));
    assert.ok(versions.length > 0, `${w.f} runs wrangler without setup-node`);
    for (const v of versions) assert.ok(v >= 22, `${w.f}: setup-node ${v} is below wrangler 4's node >=22`);
  }
});

test("wrangler is pinned to the exact version 4.148.0 in package.json and the lockfile", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package.json", import.meta.url)), "utf8"));
  const lock = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package-lock.json", import.meta.url)), "utf8"));
  assert.equal(pkg.devDependencies.wrangler, "4.148.0");
  assert.equal(lock.packages["node_modules/wrangler"].version, "4.148.0");
  assert.equal(lock.packages[""].devDependencies.wrangler, "4.148.0");
});

// D1 seed decision: fail closed. An unparsed/unexpected wrangler output must never read as 0 rows (the seed does INSERT OR REPLACE over kv_state).
test("the production and preview seed steps read the row count with tools/d1-row-count.mjs, fail the step on error, and never default to 0", () => {
  for (const f of ["deploy-cloudflare.yml", "pr-preview-cloudflare.yml"]) {
    const w = workflows.find((x) => x.f === f);
    const c = code(w.text);
    assert.match(c, /ROW_COUNT=\$\(node \.\.\/tools\/d1-row-count\.mjs "\$COUNT_JSON"\) \|\| \{[^}]*exit 1;?\s*\}/, `${f}: row count must come from the fail-closed tool and exit 1 on error`);
    assert.equal(/\?\?\s*0\b/.test(c), false, `${f}: no "?? 0" default for the row count`);
  }
});

test("the preview workflow does not use `wrangler subdomain get` (gone in wrangler 4) and does not guess a workers.dev account subdomain", () => {
  const c = code(workflows.find((x) => x.f === "pr-preview-cloudflare.yml").text);
  assert.equal(/subdomain get/.test(c), false);
  assert.equal(/jmattbloise\.workers\.dev/.test(c), false);
  assert.match(c, /Could not read the preview Worker URL/);
});

// B51: the production deploy creates missing Flagship flags with wrangler (tools/flagship-ensure-flags.mjs). It needs the production Cloudflare token, so it runs there only.
test("the Flagship flag creation is referenced by the production deploy only, once, after `wrangler deploy`, continue-on-error, and by no PR-triggered workflow", () => {
  const REF = /flagship-ensure-flags|flagship\s+flags\s+(create|enable|disable|update|delete|split|rules)\b/;
  for (const w of workflows.filter((x) => x.f !== "deploy-cloudflare.yml")) assert.equal(REF.test(code(w.text)), false, `${w.f} must not run or reference Flagship flag writes`);
  for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) assert.equal(/flagship/i.test(code(w.text).replace(/strip-flagship-binding/g, "")), false, `${w.f} (PR-triggered) mentions flagship beyond the preview strip`);
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  const steps = w.doc.jobs["deploy-production"].steps;
  const at = steps.findIndex((s) => /flagship-ensure-flags/.test(s.run || ""));
  assert.ok(at > 0, "the step exists in the production job");
  assert.equal(steps.filter((s) => /flagship-ensure-flags/.test(s.run || "")).length, 1);
  assert.ok(steps.findIndex((s) => /npx wrangler deploy\b/.test(s.run || "")) < at, "it runs after wrangler deploy");
  assert.equal(steps[at]["continue-on-error"], true, "a Flagship problem must never block a code deploy");
  assert.ok(steps[at]["timeout-minutes"] > 0 && steps[at]["timeout-minutes"] <= 5, "a hung wrangler must not hold up the secrets sync that follows (timeout-minutes 3)");
  assert.equal(workflows.find((x) => x.f === "deploy-cloudflare.yml").doc.jobs["deploy-production"].steps[at + 1].name.startsWith("Sync Worker Secrets"), true, "the secrets sync is the next step");
  assert.equal(/secrets\./.test(steps[at].run + JSON.stringify(steps[at].env || {})), false, "the step names no secret itself (the job env already holds the token)");
  assert.equal(/\b(enable|disable|update|delete|split)\b/.test(steps[at].run || ""), false, "it never changes an existing flag");
  for (const d of Object.values(w.doc.jobs)) assert.equal(d.environment === undefined || d.environment === "production", true);
});

// B51: the production workflow may contain NO `flagship flags <subcommand>` other than `create` (the script itself only runs list and create; see flagship-ensure.test.mjs).
const flagshipSubcommands = (text) => [...code(text).matchAll(/flagship\s*(?:\\\s*)?flags\s*(?:\\\s*)?([A-Za-z-]+)/g)].map((m) => m[1].toLowerCase());
const forbiddenFlagshipSubcommands = (text) => flagshipSubcommands(text).filter((c) => c !== "create");

test("the production deploy contains no `flagship flags` subcommand other than create", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.deepEqual(forbiddenFlagshipSubcommands(w.text), []);
});

test("the subcommand check itself rejects enable, disable, update, delete, split, rules (and list/evaluate/pull), however spelled, and accepts create", () => {
  for (const sub of ["enable", "disable", "update", "delete", "split", "rules", "list", "evaluate", "pull", "ENABLE"]) {
    assert.deepEqual(forbiddenFlagshipSubcommands(`run: npx wrangler flagship flags ${sub} APP KEY`), [sub.toLowerCase()], sub);
    assert.deepEqual(forbiddenFlagshipSubcommands(`run: |\n  wrangler flagship   flags   ${sub} APP`), [sub.toLowerCase()], `${sub} with extra spaces`);
  }
  assert.deepEqual(forbiddenFlagshipSubcommands("run: wrangler flagship flags \\\n  enable APP KEY"), ["enable"], "line continuation");
  assert.deepEqual(forbiddenFlagshipSubcommands("run: wrangler flagship flags create APP KEY --disabled"), []);
  assert.deepEqual(forbiddenFlagshipSubcommands("# wrangler flagship flags enable is done by the owner\nrun: wrangler flagship flags create A K"), [], "comments are not code");
});

// B46: the comment stripper must not treat a # inside quotes or ${{ }} as a comment start (that would hide a secret that follows it).
test("the comment stripper keeps a secret that follows a quoted # (cases the guard must catch)", () => {
  assert.deepEqual(secretNames('run: echo "#" "${{ secrets.X }}"'), ["X"], "double-quoted #");
  assert.deepEqual(secretNames("run: echo '#' \"${{ secrets.X }}\""), ["X"], "single-quoted #");
  assert.deepEqual(secretNames("run: echo '# ${{ secrets.X }}'"), ["X"], "secret inside single quotes after #");
  assert.deepEqual(secretNames('run: echo "a \\" # \" ${{ secrets.X }}"'), ["X"], "escaped quote inside double quotes");
  assert.deepEqual(secretNames("run: echo ${{ format('#{0}', secrets.X) }}"), ["X"], "# inside a ${{ }} expression");
  assert.deepEqual(secretNames('env: { A: "x #y", B: ${{ secrets.X }} }'), ["X"], "secret after a quoted # on the same line");
  assert.deepEqual(secretNames('run: echo "#" # real comment\nrun: ${{ secrets.Y }}'), ["Y"], "a real comment after a quoted # still ends that line");
});

test("the comment stripper still ignores real comments (cases that must pass)", () => {
  assert.deepEqual(secretNames("# uses secrets.X for the deploy"), [], "plain comment line");
  assert.deepEqual(secretNames("    # secrets.X is read in the production job"), [], "indented comment line");
  assert.deepEqual(secretNames("run: make build # never uses secrets.X"), [], "trailing comment naming secrets");
  assert.deepEqual(secretNames('run: echo "done" # see secrets.X'), [], "trailing comment after a quoted string");
  assert.deepEqual(secretNames("run: echo ${{ github.sha }} # secrets.X"), [], "trailing comment after an expression");
  assert.equal(code("a: b # c").trimEnd(), "a: b", "the code before the comment is kept");
  assert.equal(code('a: "b # c"'), 'a: "b # c"', "a quoted # is kept");
  assert.equal(code("url: http://x/y#frag"), "url: http://x/y#frag", "# not preceded by whitespace is not a comment");
});
