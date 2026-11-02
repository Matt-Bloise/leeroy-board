import test from "node:test";
import assert from "node:assert/strict";
import { isSitePath, siteChanged } from "../../tools/ci-scope.mjs";

test("Worker, unit-test and docs paths do not need the browser jobs", () => {
  assert.equal(siteChanged(["infrastructure/worker/discord.js", "tests/unit/x.test.mjs", "tests/api/a.test.mjs", "docs/runbooks/a.md", "infrastructure/migrations/0004_x.sql", "README.md", "CONTRIBUTING.md"]), false);
});
test("site files and assets do", () => {
  for (const p of ["index.html", "css/shell.css", "js/board.js", "scenes/sheet.js", "landing/index.html", "privacy/index.html", "404.html", "data/client.json", "img/a.png", "og-1200x630.jpg", "_headers", "tests/browser/run.mjs"]) assert.equal(isSitePath(p), true, p);
});
test("anything under .github/ forces a full run", () => {
  for (const p of [".github/workflows/preview-tests.yml", ".github/workflows/nightly-production.yml", ".github/CODEOWNERS", ".github/ISSUE_TEMPLATE/bug.md", ".github/actions/x/action.yml", ".github/dependabot.yml"]) assert.equal(isSitePath(p), true, p);
});
test("anything under tools/ forces a full run", () => {
  for (const p of ["tools/stamps.mjs", "tools/ci-scope.mjs", "tools/docs-only.mjs", "tools/ci-report.mjs", "tools/add-member.mjs", "tools/new/deep/x.mjs"]) assert.equal(isSitePath(p), true, p);
});
test("infrastructure/wrangler* forces a full run, other infrastructure files do not", () => {
  for (const p of ["infrastructure/wrangler.toml", "infrastructure/wrangler.jsonc", "infrastructure/wrangler-staging.toml"]) assert.equal(isSitePath(p), true, p);
  for (const p of ["infrastructure/worker/index.js", "infrastructure/schema.sql", "infrastructure/scripts/seed-d1.mjs"]) assert.equal(isSitePath(p), false, p);
});
test("package*.json at any depth forces a full run", () => {
  for (const p of ["package.json", "package-lock.json", "tests/package.json", "tests/package-lock.json", "infrastructure/package.json", "infrastructure/package-lock.json", "a/b/c/package.json", "infrastructure/package.dev.json"]) assert.equal(isSitePath(p), true, p);
  for (const p of ["infrastructure/mypackage.json", "docs/package.md", "infrastructure/packages/readme.txt"]) assert.equal(isSitePath(p), false, p);
});
test("matching is case-insensitive in the safe direction", () => {
  for (const p of ["Tools/x.mjs", ".GitHub/workflows/a.yml", "Infrastructure/Wrangler.toml", "PACKAGE.JSON", "CSS/a.css"]) assert.equal(isSitePath(p), true, p);
});
test("a rename counts on both sides", () => {
  // the workflow lists filename and previous_filename; either side being a site path forces the full run
  assert.equal(siteChanged(["docs/moved.css", "css/old.css"]), true);
  assert.equal(siteChanged(["js/new.js", "docs/old.md"]), true);
  assert.equal(siteChanged(["docs/new.md", "docs/old.md"]), false);
  assert.equal(siteChanged(["infrastructure/worker/b.js", "infrastructure/worker/a.js"]), false);
});
test("an empty or odd list runs everything", () => {
  assert.equal(siteChanged([]), true);
  assert.equal(siteChanged(["", "  ", "\r"]), true);
  assert.equal(siteChanged(["../x"]), true);
});
test("unknown shapes run everything", () => {
  for (const p of ["/etc/passwd", "C:\\a\\b.md", "docs\\a.md", '"docs/a b.md"', "docs/../css/a.css", "docs/a\u0000.md", "./", "./.github/x.yml", "docs/"]) assert.equal(siteChanged(["docs/ok.md", p]), true, JSON.stringify(p));
});
test("CRLF input and a leading ./ are normalised", () => {
  assert.equal(siteChanged(["docs/a.md\r", "README.md\r"]), false);
  assert.equal(isSitePath("./css/a.css"), true);
  assert.equal(isSitePath("./docs/a.md"), false);
});
test("a mixed PR with one site file runs the browser jobs", () => {
  assert.equal(siteChanged(["infrastructure/worker/a.js", "css/x.css"]), true);
});
