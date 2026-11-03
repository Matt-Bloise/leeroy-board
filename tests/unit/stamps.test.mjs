// Unit tests for tools/stamps.mjs. Fixtures live in a temp directory. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tools/stamps.mjs");
const h10 = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stamps-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const cli = (root, mode) => spawnSync(process.execPath, [TOOL, mode, "--root", root], { encoding: "utf8" });
const read = (root, rel) => fs.readFileSync(path.join(root, rel));

test("a stale stamp is detected, then --write fixes it", () => {
  const root = fixture({ "js/a.js": "export const a = 1;\n", "index.html": '<script src="js/a.js?v=0123456789"></script>\n' });
  const bad = cli(root, "--check");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /index\.html:1 js\/a\.js has \?v=0123456789, expected \?v=/);
  assert.equal(cli(root, "--write").status, 0);
  assert.equal(cli(root, "--check").status, 0);
  assert.ok(read(root, "index.html").toString().includes("js/a.js?v=" + h10(read(root, "js/a.js"))));
});

test("dependency order: a change in B restamps A and then A's stamp in index", () => {
  const root = fixture({
    "js/b.js": "export const b = 1;\n",
    "js/a.js": 'import { b } from "./b.js?v=0000000000";\nexport default b;\n',
    "index.html": '<script type="module" src="js/a.js?v=0000000000"></script>\n',
  });
  cli(root, "--write");
  assert.equal(cli(root, "--check").status, 0);
  const before = read(root, "index.html").toString();
  fs.writeFileSync(path.join(root, "js/b.js"), "export const b = 2;\n");
  assert.equal(cli(root, "--check").status, 1);
  cli(root, "--write");
  const after = read(root, "index.html").toString();
  assert.notEqual(before, after);
  const a = read(root, "js/a.js");
  assert.ok(a.toString().includes("./b.js?v=" + h10(read(root, "js/b.js"))));
  assert.ok(after.includes("js/a.js?v=" + h10(a)));
  assert.equal(cli(root, "--check").status, 0);
});

test("CRLF and LF bytes are preserved", () => {
  const crlf = 'import "./b.js?v=0000000000";\r\nexport const a = 1;\r\n';
  const root = fixture({ "js/b.js": "x\r\ny\n", "js/a.js": crlf, "index.html": '<script src="js/a.js?v=0000000000"></script>\r\n<p>\n</p>\n' });
  cli(root, "--write");
  assert.equal(read(root, "js/b.js").toString("latin1"), "x\r\ny\n");
  const a = read(root, "js/a.js").toString("latin1");
  assert.equal(a.replace(/\?v=[0-9a-f]{10}/, "?v=0000000000"), crlf);
  const idx = read(root, "index.html").toString("latin1");
  assert.ok(idx.includes("\"></script>\r\n<p>\n</p>\n"));
});

test("an unresolved reference is reported, not rewritten", () => {
  const body = '<script src="js/missing.js?v=abcdef0123"></script>\n<link href="https://example.test/x.css?v=abcdef0123">\n';
  const root = fixture({ "index.html": body });
  const r = cli(root, "--write");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /unresolved \(not touched\): index\.html:1 js\/missing\.js\?v=abcdef0123/);
  assert.equal(read(root, "index.html").toString(), body);
  assert.equal(cli(root, "--check").status, 0);
});

test("a reference cycle stops the run", () => {
  const root = fixture({ "js/a.js": 'import "./b.js?v=0000000000";\n', "js/b.js": 'import "./a.js?v=0000000000";\n' });
  const r = cli(root, "--check");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cycle/);
});

test("the real repo is stamped (same check CI runs)", () => {
  const r = spawnSync(process.execPath, [TOOL, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

test("atlas style: a template-literal css href with a base prefix is stamped from the site root, and the importer's stamp follows", () => {
  const root = fixture({
    "atlas/panels.css": ".a{color:red}\n",
    "atlas/atlas.js": 'const link = `${base}atlas/panels.css?v=0000000000`;\nexport default link;\n',
    "js/hook.js": 'import("../atlas/atlas.js?v=0000000000");\n',
  });
  assert.equal(cli(root, "--check").status, 1);
  assert.equal(cli(root, "--write").status, 0);
  assert.equal(cli(root, "--check").status, 0);
  const atlas = read(root, "atlas/atlas.js").toString();
  assert.ok(atlas.includes("${base}atlas/panels.css?v=" + h10(read(root, "atlas/panels.css"))));
  assert.ok(read(root, "js/hook.js").toString().includes("atlas/atlas.js?v=" + h10(read(root, "atlas/atlas.js"))));
  fs.writeFileSync(path.join(root, "atlas/panels.css"), ".a{color:blue}\n");
  const stale = cli(root, "--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /atlas\/atlas\.js:1 atlas\/panels\.css has \?v=/);
  assert.match(stale.stdout, /js\/hook\.js:1 atlas\/atlas\.js has \?v=/);
});

test("an all-zero placeholder stamp (any length) is stale, not ignored; --write replaces it with the real stamp", () => {
  for (const zero of ["00000000", "0000000000", "0"]) {
    const root = fixture({ "css/t.css": "a{}\n", "index.html": `<link rel="stylesheet" href="css/t.css?v=${zero}">\n` });
    const bad = cli(root, "--check");
    assert.equal(bad.status, 1, `?v=${zero} must fail --check`);
    assert.match(bad.stdout, /all-zero placeholder/);
    assert.equal(cli(root, "--write").status, 0);
    assert.equal(cli(root, "--check").status, 0);
    assert.ok(read(root, "index.html").toString().includes("css/t.css?v=" + h10(read(root, "css/t.css"))));
  }
});
