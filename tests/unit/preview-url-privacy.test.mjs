// The account's workers.dev subdomain carries a personal name. It must not reach the public PR comment or a workflow log through the preview and deploy workflows.
// The preview Worker URL is handed from pr-preview-cloudflare.yml to preview-tests.yml as the `preview-urls` workflow artifact, never through the comment.
// (The subdomain is also in served files and git history: docs/runbooks/ci-secrets.md. Renaming the subdomain or a custom domain is the account admin's.)
// Run: node --test tests/unit/preview-url-privacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const { parse } = createRequire(import.meta.url)("yaml");
const preview = read(".github/workflows/pr-preview-cloudflare.yml");
const tests = read(".github/workflows/preview-tests.yml");
const deploy = read(".github/workflows/deploy-cloudflare.yml");
const stepsOf = (text, job) => Object.values(parse(text).jobs).flatMap((j) => j.steps || []);

test("the sticky preview comment never prints the Worker URL or a workers.dev host", () => {
  const step = stepsOf(preview).find((s) => /Post \/ Update Sticky PR Preview Comment/.test(s.name || ""));
  const script = step.with.script;
  assert.ok(!/workerUrl|worker_url/.test(script), "the comment script does not read the Worker URL");
  assert.ok(!/workers\.dev\/|\$\{[^}]*workers\.dev/.test(script), "no workers.dev URL is built in the comment");
  for (const m of script.matchAll(/[a-z0-9-]*\.?workers\.dev/gi)) assert.match(script.slice(Math.max(0, m.index - 12), m.index + m[0].length + 1), /workers\.dev host|account's workers\.dev/, "workers.dev appears only in the words 'the account's workers.dev host'");
  assert.match(script, /host not printed here/);
});

test("every wrangler deploy output is redacted before it reaches the log (preview and production)", () => {
  for (const [name, text] of [["pr-preview-cloudflare.yml", preview], ["deploy-cloudflare.yml", deploy]]) {
    const step = stepsOf(text).find((s) => /^Deploy (Ephemeral PR Worker|Cloudflare Worker)/.test(s.name || ""));
    assert.ok(step, `${name} deploy step`);
    assert.ok(!/^\s*echo "\$DEPLOY_OUT"\s*$/m.test(step.run), `${name}: a bare echo of the deploy output would print the account subdomain`);
    assert.ok(step.run.includes("echo \"$DEPLOY_OUT\" | sed -E 's#\\.[a-z0-9-]+\\.workers\\.dev#.<account-subdomain>.workers.dev#g'"), `${name}: the redacting sed`);
  }
});

test("the redaction really turns a deploy line into a placeholder host", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("sed", ["-E", "s#\\.[a-z0-9-]+\\.workers\\.dev#.<account-subdomain>.workers.dev#g"], { input: "Deployed leeroy-brain-pr-9 triggers\n  https://leeroy-brain-pr-9.somebody-name.workers.dev\n", encoding: "utf8" });
  if (r.error) return; // no sed here (Windows without Git Bash): the pattern is pinned by the previous test
  assert.equal(r.stdout.trim().split("\n")[1].trim(), "https://leeroy-brain-pr-9.<account-subdomain>.workers.dev");
});

test("the Worker URL travels as the preview-urls artifact, and the Preview Tests workflow reads it from there", () => {
  const up = stepsOf(preview).find((s) => s.uses && /upload-artifact/.test(s.uses) && s.with && s.with.name === "preview-urls");
  assert.ok(up, "pr-preview uploads preview-urls");
  assert.equal(up.with["if-no-files-found"], "error");
  const w = stepsOf(preview).find((s) => /Deploy Ephemeral PR Worker/.test(s.name || ""));
  assert.match(w.run, /printf '%s\\n' "\$WORKER_URL" > "\$RUNNER_TEMP\/preview-urls\/worker\.txt"/);
  const find = stepsOf(tests).find((s) => /Find the preview URLs/.test(s.name || ""));
  assert.ok(!/WORKER=\$\(echo "\$BODY"/.test(find.run), "the worker URL is not read from the comment body");
  assert.match(find.run, /gh run download "\$RID" -R "\$GITHUB_REPOSITORY" -n preview-urls/);
  assert.match(find.run, /pr-preview-cloudflare\.yml/);
  assert.ok(!/echo "Preview found: \$PAGES and \$WORKER/.test(find.run), "the Worker URL is not echoed");
  assert.equal(parse(tests).permissions.actions, "read", "downloading an artifact of another workflow run needs actions: read");
});
