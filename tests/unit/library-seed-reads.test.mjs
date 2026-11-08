import test from "node:test";
import assert from "node:assert/strict";
import { wranglerD1Args, runLibrarySeed } from "../../infrastructure/scripts/library-seed.mjs";

delete process.env.LIBRARY_SEED_ALLOW_EMPTY; // the guard tests below need it unset, whatever the caller's environment

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
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /no Library pages or no index\.json/);
});
test("rows that lack an id are a broken read, not an empty table", async () => {
  const db = { query: (sql) => (/FROM lib_pages/.test(sql) ? [{ "Total queries executed": 1 }] : []), exec: noWrites };
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /without an id/);
});
test("blob rows that lack a name are a broken read", async () => {
  const db = { query: (sql) => (/FROM lib_blobs/.test(sql) && /name, json/.test(sql) ? [{ "Total queries executed": 1 }] : []), exec: noWrites };
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /without a name/);
});

import { rowsFromWrangler } from "../../infrastructure/scripts/library-seed.mjs";
const ok = (results) => JSON.stringify([{ results, success: true, meta: {} }]);

test("rowsFromWrangler returns the rows, including a genuinely empty table", () => {
  assert.deepEqual(rowsFromWrangler("├ Checking\n" + ok([{ a: 1 }])), [{ a: 1 }]);
  assert.deepEqual(rowsFromWrangler(ok([])), []);
});
test("rowsFromWrangler never turns a missing results array into an empty table", () => {
  assert.throws(() => rowsFromWrangler(JSON.stringify([{ "Total queries executed": 1, "Rows read": 0 }])), /no d1 JSON payload|no results array/);
  assert.throws(() => rowsFromWrangler("├ Checking if file needs uploading\n"), /no d1 JSON payload/);
});
test("pages present but index.json missing is refused (either one missing means a failed read)", async () => {
  const db = { query: (sql) => (/FROM lib_pages/.test(sql) ? [{ id: "classes/mage", category: "classes", as_of: "2026-10-19" }] : []), exec: noWrites };
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /no Library pages or no index\.json/);
});
test("index.json present but no pages is refused", async () => {
  const db = { query: (sql) => (/name, json, updated_at/.test(sql) ? [{ name: "index.json", json: "{}", updated_at: "2026-11-08T00:00:00Z" }] : []), exec: noWrites };
  await assert.rejects(runLibrarySeed({ db, libDir: "data/library" }), /no Library pages or no index\.json/);
});
test("wranglerD1Args rejects an empty read and a multi-line or percent read", () => {
  assert.throws(() => wranglerD1Args({ dbName: "db", isRemote: true }), /needs a file or a non-empty sql/);
  assert.throws(() => wranglerD1Args({ dbName: "db", isRemote: true, sql: "SELECT 1\nSELECT 2" }), /one line/);
  assert.throws(() => wranglerD1Args({ dbName: "db", isRemote: true, sql: "SELECT '%PATH%'" }), /percent/);
  assert.throws(() => wranglerD1Args({ dbName: "db", isRemote: true, sql: 'SELECT "x" FROM t' }), /double quote/);
});

import { joinStatements } from "../../infrastructure/scripts/library-seed.mjs";
import { DatabaseSync } from "node:sqlite";

// Production run 3 (Nov 8 2026): the Worker's INSERT has no trailing ';', so statements joined with "\n" became a syntax error at the next UPDATE.
test("joinStatements ends every statement with a semicolon so the joined script runs as one file", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE lib_blobs (name TEXT PRIMARY KEY, stamp TEXT, json TEXT, updated_at TEXT)");
  const insert = "INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('classes.json', 's', 'abc', 't') ON CONFLICT(name) DO UPDATE SET json = excluded.json"; // no ';', as the Worker writes it
  const append = "UPDATE lib_blobs SET json = json || 'def' WHERE name = 'classes.json';";
  assert.throws(() => db.exec([insert, append].join("\n")), /syntax error/i, "the old join is the bug");
  db.exec(joinStatements([insert, append, "UPDATE lib_blobs SET json = json || 'ghi' WHERE name = 'classes.json'"]));
  assert.equal(db.prepare("SELECT json FROM lib_blobs WHERE name = 'classes.json'").get().json, "abcdefghi");
});
test("joinStatements keeps statements that already end with a semicolon, and trailing whitespace", () => {
  assert.equal(joinStatements(["SELECT 1;", "SELECT 2  \n"]), "SELECT 1;\nSELECT 2;");
});
