// `node infrastructure/scripts/export-d1.mjs --rebuild` must leave data/library/index.json in the shape the other tests and the public read contract accept:
// stamps are the first 10 hex of the sha256 of each file's bytes, refresh.json has no stamp, categories carry pages and facts only, totals match the shelf files.
// It runs on a copy (LIBRARY_DIR), never on the checked-in data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const repo = path.resolve(new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const script = path.join(repo, "infrastructure", "scripts", "export-d1.mjs");

test("--rebuild writes 10-hex stamps of the file bytes, no refresh.json stamp, no per-category open count, and matching totals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-rebuild-"));
  try {
    fs.cpSync(path.join(repo, "data", "library"), dir, { recursive: true });
    execFileSync(process.execPath, [script, "--rebuild"], { env: { ...process.env, LIBRARY_DIR: dir }, stdio: "pipe" });
    const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    const names = Object.keys(index.stamps);
    assert.ok(names.length >= 15 && names.includes("classes.json") && names.includes("open.json") && names.includes("search.json"));
    assert.ok(!names.includes("refresh.json"), "refresh.json is not stamped");
    for (const f of names) {
      const want = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex").slice(0, 10);
      assert.equal(index.stamps[f], want, `${f} stamp`);
    }
    for (const c of index.categories) assert.deepEqual(Object.keys(c).sort(), ["facts", "key", "pages", "title"], `category ${c.key} keys`);
    let facts = 0;
    for (const c of index.categories) facts += JSON.parse(fs.readFileSync(path.join(dir, `${c.key}.json`), "utf8")).pages.reduce((n, p) => n + p.facts.length, 0);
    assert.equal(index.totals.facts, facts);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the rebuild leaves the checked-in library untouched when LIBRARY_DIR points elsewhere", () => {
  const before = fs.readFileSync(path.join(repo, "data", "library", "index.json"), "utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-rebuild-"));
  try {
    fs.cpSync(path.join(repo, "data", "library"), dir, { recursive: true });
    execFileSync(process.execPath, [script, "--rebuild"], { env: { ...process.env, LIBRARY_DIR: dir }, stdio: "pipe" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(path.join(repo, "data", "library", "index.json"), "utf8"), before);
});
