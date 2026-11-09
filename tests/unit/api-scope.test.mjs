import test from "node:test";
import assert from "node:assert/strict";
import { isApiPath, apiNeeded } from "../../tools/api-scope.mjs";

test("site, docs and unit-test paths do not need the API suite", () => {
  assert.equal(apiNeeded(["css/shell.css", "js/board.js", "scenes/sheet.js", "landing/index.html", "index.html", "docs/runbooks/a.md", "README.md", "tests/unit/x.test.mjs", "tests/browser/run.mjs", "tests/README.md", "infrastructure/README.md", "infrastructure/docs/notes.md", "img/a.png"]), false);
});
test("Worker, API test, schema, migration and wrangler paths do", () => {
  for (const p of ["infrastructure/worker/index.js", "infrastructure/worker/discord.js", "infrastructure/schema.sql", "infrastructure/migrations/0004_x.sql", "infrastructure/wrangler.toml", "wrangler.toml", "tests/api/api.test.mjs", "tests/api/contract.test.mjs", "tests/helpers/x.mjs", "tests/fixtures/api-snapshot/snapshot.json", "db/schema.sql", "db/migrations/1.sql", "docs/openapi.yaml", "data/client.json"]) assert.equal(isApiPath(p), true, p);
});
test("dependency files at any depth do", () => {
  for (const p of ["package.json", "package-lock.json", "tests/package.json", "tests/package-lock.json", "a/b/package.json"]) assert.equal(isApiPath(p), true, p);
});
test("workflow and tooling changes do (they decide how the suite runs)", () => {
  for (const p of [".github/workflows/preview-tests.yml", ".github/CODEOWNERS", "tools/ci-report.mjs", "tools/api-scope.mjs"]) assert.equal(isApiPath(p), true, p);
});
test("a markdown file inside infrastructure/ is docs, other files there are not", () => {
  assert.equal(isApiPath("infrastructure/README.md"), false);
  assert.equal(isApiPath("infrastructure/worker/README.md"), false);
  assert.equal(isApiPath("infrastructure/worker/index.js"), true);
  assert.equal(isApiPath("infrastructure/worker/index.md.js"), true);
});
test("a mixed PR with one API file needs the suite", () => {
  assert.equal(apiNeeded(["css/x.css", "infrastructure/worker/a.js"]), true);
});
test("a rename counts on both sides", () => {
  assert.equal(apiNeeded(["docs/moved.md", "infrastructure/worker/old.js"]), true);
  assert.equal(apiNeeded(["js/new.js", "js/old.js"]), false);
});
test("an empty or odd list runs everything", () => {
  assert.equal(apiNeeded([]), true);
  assert.equal(apiNeeded(["", "  ", "\r"]), true);
  for (const p of ["/etc/passwd", "C:\\a\\b.md", "docs\\a.md", '"docs/a b.md"', "docs/../x", "docs/a\u0000.md", "./", "docs/"]) assert.equal(apiNeeded(["docs/ok.md", p]), true, JSON.stringify(p));
});
test("CRLF input, a leading ./ and case are normalised in the safe direction", () => {
  assert.equal(apiNeeded(["docs/a.md\r", "css/a.css\r"]), false);
  assert.equal(isApiPath("./infrastructure/worker/a.js"), true);
  assert.equal(isApiPath("Infrastructure/Worker/A.js"), true);
});
