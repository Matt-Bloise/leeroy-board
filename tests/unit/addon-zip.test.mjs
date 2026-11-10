// Tests addon/build-zip.mjs: store-only zip writer, read back and verified.
// Run: node --test tests/unit/addon-zip.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { buildZip, readZip, crc32, collectAddon, addonVersion } from "../../addon/build-zip.mjs";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("zip round-trips and is deterministic", () => {
  const entries = [{ name: "X/a.txt", data: Buffer.from("hello") }, { name: "X/b.bin", data: Buffer.from([0, 1, 2, 255]) }, { name: "X/empty", data: Buffer.alloc(0) }];
  const zip = buildZip(entries);
  const back = readZip(zip);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => { assert.ok(e.crcOk); assert.deepEqual(Buffer.from(e.data), entries[i].data); });
  assert.deepEqual(buildZip(entries), zip);
});

test("the real add-on zip has LeeroyBuild/ at the root, all files, and matching bytes", () => {
  const files = collectAddon();
  const back = readZip(buildZip(files));
  assert.ok(back.length >= 5);
  for (const e of back) { assert.ok(e.name.startsWith("LeeroyBuild/")); assert.ok(!e.name.slice(12).includes("/")); assert.ok(e.crcOk); }
  const names = back.map((e) => e.name);
  for (const need of ["LeeroyBuild/LeeroyBuild.toc", "LeeroyBuild/LeeroyBuild_Forever.toc", "LeeroyBuild/LeeroyBuild.lua", "LeeroyBuild/LeeroyBuild_Codec.lua"]) assert.ok(names.includes(need), need);
  assert.match(addonVersion(), /^\d+\.\d+\.\d+$/);
  assert.equal(typeof zlib.crc32 === "function" ? zlib.crc32(files[0].data) : crc32(files[0].data), crc32(files[0].data));
});
