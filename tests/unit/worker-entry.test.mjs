// The Worker entry module (infrastructure/worker/entry.js, wrangler.toml main) exports only what the Workers runtime may see: the default handler and the Durable Object class.
// The local runtime (wrangler dev --local) refuses an entry module with any other export, which is why the Worker could not start locally while main was worker/index.js.
// index.js keeps its helper exports: the unit tests and other modules import them from there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as entry from "../../infrastructure/worker/entry.js";
import * as index from "../../infrastructure/worker/index.js";

test("entry.js exports exactly the default handler and BoardRoom, the same objects index.js has", () => {
  assert.deepEqual(Object.keys(entry).sort(), ["BoardRoom", "default"]);
  assert.equal(entry.default, index.default);
  assert.equal(entry.BoardRoom, index.BoardRoom);
  assert.equal(typeof entry.default.fetch, "function");
  assert.equal(typeof entry.default.scheduled, "function");
});

test("wrangler.toml starts from entry.js and still binds the same Durable Object class", () => {
  const toml = readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /^main = "worker\/entry\.js"$/m);
  assert.match(toml, /class_name = "BoardRoom"/);
  assert.match(toml, /new_sqlite_classes = \["BoardRoom"\]/);
});

test("index.js still exports its helpers, so the tests and the other modules that import them keep working", () => {
  for (const name of ["ROUTES", "SHEET_FIELDS", "KEPT_CACHE_CONTROL", "MEMBER_NO_STORE", "buildPartySheetsFromD1", "recordSheetEventInD1"]) assert.ok(name in index, name);
});
