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
