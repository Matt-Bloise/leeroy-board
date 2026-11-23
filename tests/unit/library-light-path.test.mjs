// A PR that changes only docs and data/library gets no preview Worker and no api/browser/layout run, even with the ci-full label (the visual gate reads the pinned
// tests/fixtures/library). The merge still deploys: the library is merged into D1 by the deploy workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isLibraryPath, isLightPath, isLightOnly, isDocsOnly } from "../../tools/docs-only.mjs";
import { siteChanged } from "../../tools/ci-scope.mjs";

test("isLibraryPath: only data/library/<name>.json, one level, no traversal", () => {
  for (const p of ["data/library/classes.json", "./data/library/index.json", "data/library/open.json"]) assert.equal(isLibraryPath(p), true, p);
  for (const p of ["data/library/", "data/library/sub/x.json", "data/library/x.js", "data/library/../party.json", "data/party.json", "data/atlas/marks.json", "tests/fixtures/library/index.json", "xdata/library/x.json"]) assert.equal(isLibraryPath(p), false, p);
});

test("a PR of library files and docs is light; adding any other data or site file makes it not light", () => {
  assert.equal(isLightOnly(["data/library/classes.json", "data/library/index.json", "data/library/search.json", "docs/adr/0002-x.md"]), true);
  assert.equal(isLightOnly(["data/library/classes.json", "data/party.json"]), false);
  assert.equal(isLightOnly(["data/library/classes.json", "js/board.js"]), false);
  assert.equal(isLightOnly(["data/library/classes.json", "tests/fixtures/library/index.json"]), false, "changing the pinned fixture changes what the visual gate renders");
  assert.equal(isLightOnly([]), false);
  assert.equal(isLightPath("data/library/x.json"), true);
  assert.equal(isDocsOnly(["data/library/classes.json"]), false, "isDocsOnly itself is unchanged: docs paths only");
});

test("library data stays a site path for the scope rule, so the visual gate still runs on such a PR", () => {
  assert.equal(siteChanged(["data/library/classes.json"]), true);
});

test("the deploy workflow does not ignore data/library: a merge of library data still deploys and merges it into D1", () => {
  const wf = readFileSync(new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url), "utf8");
  const ignore = wf.slice(wf.indexOf("paths-ignore:"), wf.indexOf("workflow_dispatch:"));
  assert.equal(/data\/library/.test(ignore), false);
});

test("the preview workflow skips the spin-up for a light PR and says so", () => {
  const wf = readFileSync(new URL("../../.github/workflows/pr-preview-cloudflare.yml", import.meta.url), "utf8");
  assert.ok(wf.includes("needs.prep.outputs.docs_only != 'true'"), "the spin-up condition is the light-path answer");
  assert.ok(wf.includes("library data"), "the skip notice names library data");
});
