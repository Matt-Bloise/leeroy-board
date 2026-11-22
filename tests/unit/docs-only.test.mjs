// Unit tests for tools/docs-only.mjs, the docs-only classifier shared by the preview workflows.
// Run: node --test tests/unit/docs-only.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { isDocsOnly, isDocsPath } from "../../tools/docs-only.mjs";

test("docs, root markdown and issue templates are docs", () => {
  for (const p of ["docs/runbooks/rollback.md", "docs/img/a.png", "README.md", "CONTRIBUTING.md", ".github/ISSUE_TEMPLATE/bug.yml"]) {
    assert.equal(isDocsPath(p), true, p);
  }
});

test("code, workflows and nested markdown are not docs", () => {
  for (const p of ["js/brain.js", "infrastructure/worker/index.js", "infrastructure/README.md", "tests/README.md", ".github/workflows/preview-tests.yml", ".github/pull_request_template.md", "docsx/a.md", "docs/../js/a.js", "notes.mdx", ""]) {
    assert.equal(isDocsPath(p), false, p);
  }
});

test("a PR is docs-only only when every path is docs", () => {
  assert.equal(isDocsOnly(["README.md", "docs/a.md"]), true);
  assert.equal(isDocsOnly(["README.md", "js/a.js"]), false);
  assert.equal(isDocsOnly([]), false);
  assert.equal(isDocsOnly(["", "  "]), false);
});

// Light path (what the CLI prints): docs, unit tests and the tools no CI job and no deploy runs.
import { isLightPath, isLightOnly, LIGHT_TOOL_FILES, LIGHT_TOOL_DIRS } from "../../tools/docs-only.mjs";

test("light path: unit tests and non-deploy tools count, with docs", () => {
  for (const p of ["tests/unit/x.test.mjs", "tools/replay/run.mjs", "tools/replay/a/b.json", "tools/voice-eval/README.md", "tools/gateway-spike/x.js", "tools/shadow-ask.mjs", "tools/cost-model.mjs", "docs/a.md", "README.md"]) assert.equal(isLightPath(p), true, p);
  assert.equal(isLightOnly(["tools/replay/run.mjs", "tests/unit/replay.test.mjs", "docs/runbooks/replay.md"]), true);
});

test("light path: anything CI, the deploy, the bundle or the browser tests run stays full", () => {
  for (const p of ["tools/pages-bundle.mjs", "tools/static-server.mjs", "tools/d1-row-count.mjs", "tools/flagship-ensure-flags.mjs", "tools/sync-discord-commands.mjs", "tools/strip-flagship-binding.mjs", "tools/ci-scope.mjs", "tools/api-scope.mjs", "tools/docs-only.mjs", "tools/ci-report.mjs", "tools/stamps.mjs", "tools/render-legal.mjs", "tools/local-browser.sh", "tools/local-requests.mjs", "tools/win-kill-tree.ps1", "tools/pages-prune.mjs", "tools/roster-upsert.mjs", "tools/terms-watch.mjs", "tools/flake-signatures.mjs", "tools/lighthouse-summary.mjs", "tools/brand-new-tool.mjs"]) assert.equal(isLightPath(p), false, p);
  for (const p of ["tests/api/api.test.mjs", "tests/browser/run.mjs", "tests/helpers/x.mjs", "tests/package.json", "tests/package-lock.json", "tests/fixtures/a.json", "tests/README.md", "tests/unit/../browser/x.mjs", "tools/replay/../stamps.mjs", "tools/replaysx/a.mjs", "Tools/stamps.mjs", ".github/workflows/x.yml", "infrastructure/worker/a.js", "js/a.js", "package.json"]) assert.equal(isLightPath(p), false, p);
});

test("light path: one non-light file makes the whole PR full; empty and odd lists are full", () => {
  assert.equal(isLightOnly(["tools/replay/run.mjs", "tools/stamps.mjs"]), false);
  assert.equal(isLightOnly(["tests/unit/a.test.mjs", "js/a.js"]), false);
  assert.equal(isLightOnly([]), false);
  assert.equal(isLightOnly(["", "  "]), false);
  assert.equal(isLightOnly(["tools/replay/run.mjs", '"quoted/path"']), false);
  assert.equal(isLightOnly(["tools/replay/run.mjs", "/etc/x"]), false);
});

test("light path: every listed tool exists, and none is a file a workflow runs", async () => {
  const fs = await import("node:fs");
  const wfDir = new URL("../../.github/workflows/", import.meta.url);
  const wf = fs.readdirSync(wfDir).map((f) => fs.readFileSync(new URL(f, wfDir), "utf8")).join("\n").split("\n").filter((l) => !/^\s*- "tools\//.test(l)).join("\n"); // minus the deploy paths-ignore entries themselves
  for (const f of LIGHT_TOOL_FILES) {
    assert.ok(fs.existsSync(new URL("../../tools/" + f, import.meta.url)), f);
    assert.equal(wf.includes("tools/" + f), false, f + " is referenced by a workflow");
  }
  for (const d of LIGHT_TOOL_DIRS) assert.ok(fs.existsSync(new URL("../../tools/" + d, import.meta.url)), d);
});
