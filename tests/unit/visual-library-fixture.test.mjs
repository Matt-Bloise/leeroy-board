// The visual gate must not read the live data/library: a library data PR (new facts, new counts in the library header) would move the library screens (PR 441 did, by 25 px over the limit).
// Browser suites cannot run here, so this pins the wiring and the stub's behaviour: the suite passes tests/fixtures/library to the stub and routes the static copy to it too,
// the stub serves /library/<file> from that folder when given one (and from data/library only when not), and the fixture is a complete library.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoDoc } from "../helpers/api-stub.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(root, "tests", "fixtures", "library");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

test("the visual suite answers the library from tests/fixtures/library, over /api/ and over the static path", () => {
  const src = read("tests/browser/visual-baseline.mjs");
  assert.ok(src.includes("const LIBRARY_FIXTURE = path.join(here, \"..\", \"fixtures\", \"library\")"));
  assert.ok(src.includes("{ libraryDir: LIBRARY_FIXTURE }"), "the stub gets the fixture folder");
  assert.ok(src.includes(String.raw`/\/data\/library\/[A-Za-z0-9._-]+$/.test(u.pathname)`), "the static data/library path is routed");
  assert.ok(src.includes("path.join(LIBRARY_FIXTURE, path.basename("), "and answered from the fixture folder");
});

test("the stub serves /library/<file> from the given folder, and only falls back to data/library without one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-fixture-"));
  try {
    fs.writeFileSync(path.join(dir, "index.json"), '{"pinned":true}');
    assert.equal(repoDoc("/library/index.json", dir).body, '{"pinned":true}');
    assert.equal(repoDoc("/library/classes.json", dir), null, "a file missing from the fixture is a miss, never the live file");
    assert.equal(repoDoc("/library/index.json").body, read("data/library/index.json"), "without a folder: the checked-in library, as the other suites read it");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the fixture is a complete library: every shelf the index lists, every derived file, parseable", () => {
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURE, "index.json"), "utf8"));
  for (const c of index.categories) assert.ok(fs.existsSync(path.join(FIXTURE, `${c.key}.json`)), `shelf ${c.key}`);
  for (const f of ["open.json", "search.json", "tooltips.json", "glossary.json", "news.json", "diff.json", "schema.json"]) assert.ok(fs.existsSync(path.join(FIXTURE, f)), f);
  for (const f of fs.readdirSync(FIXTURE)) JSON.parse(fs.readFileSync(path.join(FIXTURE, f), "utf8"));
  let facts = 0;
  for (const c of index.categories) facts += JSON.parse(fs.readFileSync(path.join(FIXTURE, `${c.key}.json`), "utf8")).pages.reduce((n, p) => n + p.facts.length, 0);
  assert.equal(index.totals.facts, facts, "the pinned index counts what the pinned shelves hold");
});
