// B61: no eval-class code in anything the site serves. An enforcing CSP without 'unsafe-eval' would break such code.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree, scanText, walk } from "../helpers/no-eval-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Allowlist: third-party vendor files only. One line of reason per entry. `count` is exact.
export const ALLOWLIST = [
  { file: "vendor/embedded-app-sdk.mjs", kind: "Function(", count: 1, reason: 'Discord SDK (third party, lodash): `jt||Nr||Function("return this")()` is the globalThis fallback and never runs where self.Object===Object, which is every browser and worker.' },
];

test("every allowlist entry is a vendor file and states a reason", () => {
  for (const a of ALLOWLIST) {
    assert.ok(a.file.startsWith("vendor/"), `${a.file}: only vendor/ files may be allowlisted, fix first-party code instead`);
    assert.ok(typeof a.reason === "string" && a.reason.length > 20 && !a.reason.includes("\n"), `${a.file}: one-line reason required`);
    assert.ok(Number.isInteger(a.count) && a.count > 0);
  }
});

test("the scan covers the shipped code (guards against an empty walk)", () => {
  const files = walk(root);
  for (const f of ["index.html", "js/board.js", "js/brain.js", "scenes/hades.js", "atlas/atlas.js", "room/room.js", "vendor/three.module.min.js", "vendor/embedded-app-sdk.mjs"]) assert.ok(files.includes(f), `${f} is scanned`);
  assert.ok(files.length > 50, `scanned ${files.length} files`);
  assert.ok(!files.some((f) => /^(tests|tools|infrastructure|docs|\.github)\//.test(f)), "non-served dirs are not scanned");
});

test("no eval, new Function, Function( constructor, constructor.constructor( or string-form timer in shipped JS/HTML", () => {
  const r = scanTree(root, ALLOWLIST);
  assert.deepEqual(r.problems, [], "eval-class code found (an enforcing CSP would block it):\n" + r.problems.join("\n"));
});

test("revert-failing: the rules catch every planted case on the right line", () => {
  const text = fs.readFileSync(path.join(root, "tests/fixtures/no-eval/planted.js.txt"), "utf8");
  const got = scanText("planted.js", text).map((h) => `${h.line}:${h.kind}`).sort();
  // line 3 eval, 4 new Function, 5 Function(, 6 constructor.constructor(, 7 and 8 string timers. Lines 9 and 10 are clean.
  assert.deepEqual(got, ["3:eval", "4:new Function", "5:Function(", "6:constructor.constructor", "7:string timer", "8:string timer"].sort());
});

test("revert-failing: a planted eval in a real shipped file makes the tree scan fail", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-eval-"));
  try {
    fs.mkdirSync(path.join(tmp, "js"));
    fs.mkdirSync(path.join(tmp, "vendor"));
    fs.writeFileSync(path.join(tmp, "js/board.js"), fs.readFileSync(path.join(root, "js/board.js"), "utf8") + '\nconst planted = eval("1");\n');
    const clean = scanTree(tmp, []);
    assert.equal(clean.problems.length, 1);
    assert.match(clean.problems[0], /^js\/board\.js:\d+ eval:/);
    // an allowlist entry must not cover first-party files, and a stale entry fails too
    const stale = scanTree(tmp, [{ file: "vendor/embedded-app-sdk.mjs", kind: "Function(", count: 1, reason: "x" }]);
    assert.ok(stale.problems.some((p) => p.startsWith("stale allowlist entry")));
    // a second hit in an allowlisted vendor file still fails (count is exact)
    fs.writeFileSync(path.join(tmp, "vendor/embedded-app-sdk.mjs"), 'a=Function("return this")();b=new Function("x");');
    const more = scanTree(tmp, [{ file: "vendor/embedded-app-sdk.mjs", kind: "Function(", count: 1, reason: "x" }]);
    assert.ok(more.problems.some((p) => p.includes("vendor/embedded-app-sdk.mjs") && p.includes("new Function")));
    // and the allowlisted single hit alone passes
    fs.writeFileSync(path.join(tmp, "vendor/embedded-app-sdk.mjs"), 'a=Function("return this")();');
    fs.unlinkSync(path.join(tmp, "js/board.js"));
    assert.deepEqual(scanTree(tmp, [{ file: "vendor/embedded-app-sdk.mjs", kind: "Function(", count: 1, reason: "x" }]).problems, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
