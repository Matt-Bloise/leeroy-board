import test from "node:test";
import assert from "node:assert/strict";
import { wranglerD1Args, runLibrarySeed } from "../../infrastructure/scripts/library-seed.mjs";

// First production run, Nov 8 2026: reads went through `wrangler d1 execute --remote --file`, the bulk import path, which returns a summary and no rows.
// Every SELECT looked empty, so every page read as "absent in D1". Reads must use --command; only writes use --file.

test("a read uses --command and never --file", () => {
  const a = wranglerD1Args({ dbName: "db", isRemote: true, sql: "SELECT 1" });
  assert.ok(a.includes("--command=SELECT 1"));
  assert.ok(!a.some((x) => x.startsWith("--file")));
  assert.ok(a.includes("--remote") && a.includes("--json"));
});
test("a write uses --file and never --command", () => {
  const a = wranglerD1Args({ dbName: "db", isRemote: true, file: "/tmp/x.sql" });
  assert.ok(a.includes("--file=/tmp/x.sql"));
  assert.ok(!a.some((x) => x.startsWith("--command")));
});
test("--persist-to is added for a local database only", () => {
  assert.ok(wranglerD1Args({ dbName: "db", isRemote: false, sql: "SELECT 1", persistTo: "/p" }).includes("--persist-to"));
  assert.ok(!wranglerD1Args({ dbName: "db", isRemote: true, sql: "SELECT 1", persistTo: "/p" }).includes("--persist-to"));
});

const noWrites = () => { throw new Error("a write was attempted"); };

test("an empty-looking D1 is refused before any write (a failed read must never look like a new database)", async () => {
  const db = { query: () => [], exec: noWrites };
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /no Library pages and no index\.json/);
});
test("rows that lack an id are a broken read, not an empty table", async () => {
  const db = { query: (sql) => (/FROM lib_pages/.test(sql) ? [{ "Total queries executed": 1 }] : []), exec: noWrites };
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /without an id/);
});
test("blob rows that lack a name are a broken read", async () => {
  const db = { query: (sql) => (/FROM lib_blobs/.test(sql) && /name, json/.test(sql) ? [{ "Total queries executed": 1 }] : []), exec: noWrites };
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /without a name/);
});
