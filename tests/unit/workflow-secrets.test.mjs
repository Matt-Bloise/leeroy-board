// Guard for docs/runbooks/ci-secrets.md: a workflow that a pull request can trigger must never reference a production secret,
// and the production deploy must run in the GitHub environment `production`. Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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
// Comments are not code: strip `# ...` so a runbook pointer in a comment is not read as a reference.
const code = (text) => text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "$1")).join("\n");
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

test("the production deploy keeps the binding: it does not strip it and does not touch Flagship", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.equal(/flagship/i.test(code(w.text)), false);
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
