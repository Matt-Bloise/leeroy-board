import test from "node:test";
import assert from "node:assert/strict";
import { isSitePath, siteChanged } from "../../tools/ci-scope.mjs";

test("Worker, unit-test and docs paths do not need the browser jobs", () => {
  assert.equal(siteChanged(["infrastructure/worker/discord.js", "tests/unit/x.test.mjs", "docs/runbooks/a.md", "infrastructure/migrations/0004_x.sql"]), false);
});
test("site files and assets do", () => {
  for (const p of ["index.html", "css/shell.css", "js/board.js", "scenes/sheet.js", "landing/index.html", "privacy/index.html", "404.html", "data/client.json", "img/a.png", "og-1200x630.jpg", "_headers", "tests/browser/run.mjs"]) assert.equal(isSitePath(p), true, p);
});
test("a workflow or the stamp tool runs everything", () => {
  assert.equal(siteChanged([".github/workflows/preview-tests.yml"]), true);
  assert.equal(siteChanged(["tools/stamps.mjs"]), true);
});
test("an empty or odd list runs everything", () => {
  assert.equal(siteChanged([]), true);
  assert.equal(siteChanged(["../x"]), true);
});
test("a mixed PR with one site file runs the browser jobs", () => {
  assert.equal(siteChanged(["infrastructure/worker/a.js", "css/x.css"]), true);
});
