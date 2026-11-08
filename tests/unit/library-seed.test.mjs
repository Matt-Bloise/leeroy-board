// Library-only seed: per-page merge, stamp skip, dry-run, kv_state untouched.
// D1 is faked with in-memory SQLite loaded from the real infrastructure/schema.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runLibrarySeed, comparePage, STAMP_NAME } from "../../infrastructure/scripts/library-seed.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../infrastructure/schema.sql"), "utf8");

function page(id, asOf, checked, extra = {}) {
  return { id, category: "classes", title: id, confidence: "confirmed", status: "current", as_of: asOf, checked, recheck_days: 7, blurb: "b", aliases: [], facts: [{ key: "k.f", value: "f-" + asOf }], open: [], related: [], history: [], snapshots: [], ...extra };
}

function makeLibDir(pages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libseed-"));
  fs.writeFileSync(path.join(dir, "classes.json"), JSON.stringify({ key: "classes", title: "Classes", pages }));
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ generated: "2026-11-08T00:00:00Z", totals: {}, categories: [], pages: [], changes: [] }));
  fs.writeFileSync(path.join(dir, "news.json"), JSON.stringify({ generated: "2026-11-08T00:00:00Z", items: [{ t: "new" }] }));
  return dir;
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const log = [];
  return {
    sqlite,
    log,
    query: (sql) => sqlite.prepare(sql).all(),
    exec: (stmts) => {
      for (const s of stmts) {
        log.push(s);
        sqlite.exec(s);
      }
    },
  };
}

function putD1Page(db, p) {
  db.sqlite.exec(
    `INSERT INTO lib_pages (id, category, title, as_of, checked, facts_json, updated_at) VALUES ('${p.id}', 'classes', 'D1', '${p.as_of}', '${p.checked}', '[{"key":"k.d","value":"d1-fact"}]', 'x')`
  );
}

const factsOf = (db, id) => db.query(`SELECT facts_json FROM lib_pages WHERE id = '${id}'`)[0]?.facts_json;
const NOW = "2026-11-08T12:00:00.000Z";

test("comparePage: as_of first, then checked", () => {
  assert.equal(comparePage({ as_of: "2026-11-02" }, { as_of: "2026-11-01" }), 1);
  assert.equal(comparePage({ as_of: "2026-11-01" }, { as_of: "2026-11-02" }), -1);
  assert.equal(comparePage({ as_of: "2026-11-01", checked: "2026-11-05" }, { as_of: "2026-11-01", checked: "2026-11-04" }), 1);
  assert.equal(comparePage({ as_of: "2026-11-01", checked: "a" }, { as_of: "2026-11-01", checked: "a" }), 0);
});

test("repo newer wins, D1 newer is kept, same is kept, absent is inserted", async () => {
  const db = makeDb();
  putD1Page(db, { id: "p-old", as_of: "2026-11-01", checked: "2026-11-01" });
  putD1Page(db, { id: "p-live", as_of: "2026-11-09", checked: "2026-11-09" });
  putD1Page(db, { id: "p-same", as_of: "2026-11-05", checked: "2026-11-05" });
  const dir = makeLibDir([
    page("p-old", "2026-11-07", "2026-11-07"),
    page("p-live", "2026-11-07", "2026-11-07"),
    page("p-same", "2026-11-05", "2026-11-05"),
    page("p-new", "2026-11-07", "2026-11-07"),
  ]);
  const r = await runLibrarySeed({ db, libDir: dir, now: NOW });
  assert.equal(r.status, "seeded");
  assert.match(factsOf(db, "p-old"), /f-2026-11-07/, "repo newer replaces");
  assert.match(factsOf(db, "p-live"), /d1-fact/, "D1 newer kept");
  assert.match(factsOf(db, "p-same"), /d1-fact/, "same kept");
  assert.match(factsOf(db, "p-new"), /f-2026-11-07/, "absent inserted");
  assert.deepEqual([r.counts["repo newer"], r.counts["D1 newer"], r.counts.same, r.counts.inserted], [2, 1, 1, 1]);
  // derived blobs rebuilt from D1 pages: category blob carries the merged result, including the kept D1 page
  const cat = JSON.parse(db.query("SELECT json FROM lib_blobs WHERE name = 'classes.json'")[0].json);
  assert.equal(cat.pages.length, 4);
  assert.match(JSON.stringify(cat.pages.find((x) => x.id === "p-live")), /d1-fact/);
  assert.ok(db.query("SELECT 1 FROM lib_blobs WHERE name IN ('search.json','open.json')").length >= 1);
  // stale news.json from D1 is replaced only if the repo is newer
  assert.match(db.query("SELECT json FROM lib_blobs WHERE name = 'news.json'")[0].json, /"t":"new"/);
});

test("kv_state and lib_sources are never written", async () => {
  const db = makeDb();
  db.sqlite.exec("INSERT INTO kv_state (key, json, updated_at) VALUES ('party', '{\"live\":1}', 'x')");
  const dir = makeLibDir([page("p1", "2026-11-07", "2026-11-07")]);
  await runLibrarySeed({ db, libDir: dir, now: NOW });
  assert.equal(db.query("SELECT json FROM kv_state WHERE key = 'party'")[0].json, '{"live":1}');
  assert.equal(db.query("SELECT COUNT(*) AS n FROM kv_state")[0].n, 1);
  assert.equal(db.query("SELECT COUNT(*) AS n FROM lib_sources")[0].n, 0);
  const touched = db.log.filter((s) => /kv_state|lib_sources/i.test(s));
  assert.deepEqual(touched, [], "no statement mentions kv_state or lib_sources");
});

test("unchanged stamp skips; changed data runs again", async () => {
  const db = makeDb();
  const dir = makeLibDir([page("p1", "2026-11-07", "2026-11-07")]);
  assert.equal((await runLibrarySeed({ db, libDir: dir, now: NOW })).status, "seeded");
  assert.ok(db.query(`SELECT 1 FROM lib_blobs WHERE name = '${STAMP_NAME}'`).length === 1);
  const before = db.log.length;
  const r2 = await runLibrarySeed({ db, libDir: dir, now: NOW });
  assert.equal(r2.status, "skipped");
  assert.equal(db.log.length, before, "skipped run wrote nothing");
  fs.writeFileSync(path.join(dir, "classes.json"), JSON.stringify({ key: "classes", title: "Classes", pages: [page("p1", "2026-11-08", "2026-11-08")] }));
  assert.equal((await runLibrarySeed({ db, libDir: dir, now: NOW })).status, "seeded");
});

test("dry-run prints verdicts and writes nothing, including no stamp", async () => {
  const db = makeDb();
  putD1Page(db, { id: "p-old", as_of: "2026-11-01", checked: "2026-11-01" });
  const dir = makeLibDir([page("p-old", "2026-11-07", "2026-11-07"), page("p-new", "2026-11-07", "2026-11-07")]);
  const lines = [];
  const r = await runLibrarySeed({ db, libDir: dir, dryRun: true, log: (l) => lines.push(l), now: NOW });
  assert.equal(r.status, "dry-run");
  assert.deepEqual(db.log, []);
  assert.equal(db.query("SELECT COUNT(*) AS n FROM lib_blobs").length, 1);
  assert.equal(db.query("SELECT COUNT(*) AS n FROM lib_blobs")[0].n, 0);
  assert.match(lines.join("\n"), /p-old: repo newer/);
  assert.match(lines.join("\n"), /Pages: 2 repo newer \(1 new\), 0 D1 newer, 0 same/);
  assert.match(factsOf(db, "p-old"), /d1-fact/);
});

test("index.json totals follow lib_pages after a merge", async () => {
  const db = makeDb();
  const dir = makeLibDir([page("p1", "2026-11-07", "2026-11-07"), page("p2", "2026-11-07", "2026-11-07")]);
  await runLibrarySeed({ db, libDir: dir, now: NOW });
  const ix = JSON.parse(db.query("SELECT json FROM lib_blobs WHERE name = 'index.json'")[0].json);
  assert.equal(ix.totals.pages, 2);
  assert.equal(ix.totals.facts, 2);
});
