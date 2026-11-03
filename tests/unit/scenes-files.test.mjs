// Every scene in js/scenes.js names files that exist and are not empty (scenes/tablet.js used to be a 0-byte file that was still fetched).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = fs.readFileSync(path.join(ROOT, "js/scenes.js"), "utf8");
const block = src.slice(src.indexOf("const SCENES"), src.indexOf("const NEEDS"));

test("every file a scene loads exists and has content", () => {
  const files = [...block.matchAll(/"\.\.\/([A-Za-z0-9_./-]+\.(?:js|css))\?v=/g)].map((m) => m[1]);
  assert.ok(files.length > 20, "found the scene map");
  for (const f of files) {
    const p = path.join(ROOT, f);
    assert.ok(fs.existsSync(p), `${f} exists`);
    assert.ok(fs.statSync(p).size > 0, `${f} is not empty`);
  }
});

test("the tablet scene is css only and the loader accepts a null script", () => {
  assert.match(block, /tablet: \(\) => \[new URL\("\.\.\/scenes\/tablet\.css\?v=[0-9a-f]{10}", HERE\), null\]/);
  assert.ok(!fs.existsSync(path.join(ROOT, "scenes/tablet.js")));
  assert.match(src, /\(urls\[1\] \? tag\(urls\[1\], false\) : Promise\.resolve\(\)\)/);
});
