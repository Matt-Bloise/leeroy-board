// Library-only seed: per-page merge, stamp skip, dry-run, kv_state untouched.
// D1 is faked with in-memory SQLite loaded from the real infrastructure/schema.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runLibrarySeed, comparePage, chunkEscaped, MAX_STMT_BYTES, STAMP_NAME } from "../../infrastructure/scripts/library-seed.mjs";
process.env.LIBRARY_SEED_ALLOW_EMPTY = "1"; // these tests seed a brand-new in-memory database; the empty-database guard is tested in library-seed-reads.test.mjs

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

function makeDb({ failOnExec = 0, afterSnapshot = null, afterQuery = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const log = [];
  const batches = [];
  let execCalls = 0;
  return {
    sqlite,
    log,
    batches,
    query: (sql) => {
      const rows = sqlite.prepare(sql).all();
      if (afterSnapshot && /FROM lib_pages$/.test(sql)) afterSnapshot(sqlite); // a concurrent writer lands right after the snapshot read
      if (afterQuery) afterQuery(sqlite, sql);
      return rows;
    },
    exec: (stmts) => {
      if (failOnExec && ++execCalls === failOnExec) throw new Error("simulated D1 failure");
      batches.push(stmts);
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
  db.sqlite.exec(
    `INSERT INTO lib_pages (id, category, title, as_of, checked, blurb, facts_json, updated_at) VALUES ('p-same', 'classes', 'p-same', '2026-11-05', '2026-11-05', 'b', '[{"key":"k.f","value":"f-2026-11-05"}]', 'x')`
  );
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
  assert.equal(db.query("SELECT updated_at FROM lib_pages WHERE id = 'p-same'")[0].updated_at, "x", "same kept, not rewritten");
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

const manyPages = (n, asOf) => Array.from({ length: n }, (_, i) => page("bulk-" + String(i).padStart(3, "0"), asOf, asOf));
const catPagesInBlob = (db, key) => JSON.parse(db.query(`SELECT json FROM lib_blobs WHERE name = '${key}.json'`)[0].json).pages.length;

test("failed run then retry: category blobs consistent, stamp written once", async () => {
  const dir = makeLibDir(manyPages(45, "2026-11-07"));
  const db = makeDb({ failOnExec: 2 }); // second write batch fails after the first one landed
  await assert.rejects(runLibrarySeed({ db, libDir: dir, now: NOW }), /simulated D1 failure/);
  assert.equal(db.query(`SELECT 1 FROM lib_blobs WHERE name = '${STAMP_NAME}'`).length, 0, "no stamp after a failed run");
  const r = await runLibrarySeed({ db, libDir: dir, now: NOW });
  assert.equal(r.status, "seeded");
  assert.equal(db.query("SELECT COUNT(*) AS n FROM lib_pages")[0].n, 45);
  assert.equal(catPagesInBlob(db, "classes"), 45, "category blob rebuilt even for pages the failed run already wrote");
  assert.equal(db.log.filter((s) => s.includes(`'${STAMP_NAME}'`)).length, 1);
});

test("race: a D1 page that became newer after the snapshot is not overwritten", async () => {
  const db = makeDb({
    afterSnapshot: (sq) =>
      sq.exec(`UPDATE lib_pages SET as_of = '2026-11-20', checked = '2026-11-20', facts_json = '[{"key":"k.live","value":"cron-write"}]' WHERE id = 'p-race'`),
  });
  putD1Page(db, { id: "p-race", as_of: "2026-11-01", checked: "2026-11-01" });
  await runLibrarySeed({ db, libDir: makeLibDir([page("p-race", "2026-11-07", "2026-11-07")]), now: NOW });
  assert.match(factsOf(db, "p-race"), /cron-write/);
});

test("equal dates keep D1 even when repo content differs, and the dry-run and the run print a warning list", async () => {
  const dir = makeLibDir([page("p-edit", "2026-11-05", "2026-11-05", { facts: [{ key: "k.f", value: "edited in repo" }] }), page("p-ok", "2026-11-05", "2026-11-05")]);
  for (const dryRun of [true, false]) {
    const db = makeDb();
    db.sqlite.exec(
      `INSERT INTO lib_pages (id, category, title, as_of, checked, blurb, facts_json, updated_at) VALUES ('p-edit', 'classes', 'p-edit', '2026-11-05', '2026-11-05', 'b', '[{"key":"k.f","value":"live"}]', 'u1'), ('p-ok', 'classes', 'p-ok', '2026-11-05', '2026-11-05', 'b', '[{"key":"k.f","value":"f-2026-11-05"}]', 'u1')`
    );
    const lines = [];
    const r = await runLibrarySeed({ db, libDir: dir, dryRun, log: (l) => lines.push(l), now: NOW });
    assert.deepEqual(r.unbumped, ["p-edit"]);
    assert.ok(lines.includes("WARNING: repo content differs but as_of/checked not bumped (NOT applied): p-edit"));
    assert.match(factsOf(db, "p-edit"), /live/, "D1 kept");
  }
});

test("a page that moves category rebuilds both category blobs; an emptied category ends empty", async () => {
  const db = makeDb();
  db.sqlite.exec(`INSERT INTO lib_pages (id, category, title, as_of, checked, updated_at) VALUES ('mv', 'old', 'mv', '2026-11-01', '2026-11-01', 'x')`);
  const oldBlob = JSON.stringify({ key: "old", title: "Old", pages: [{ id: "mv" }] });
  db.sqlite.exec(`INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('old.json', 's', '${oldBlob}', 'x')`);
  await runLibrarySeed({ db, libDir: makeLibDir([page("mv", "2026-11-07", "2026-11-07")]), now: NOW });
  assert.equal(db.query("SELECT category FROM lib_pages WHERE id = 'mv'")[0].category, "classes");
  assert.equal(catPagesInBlob(db, "old"), 0);
  assert.equal(catPagesInBlob(db, "classes"), 1);
});

test("index.json: categories new in the repo are added to D1's list, D1 entries kept", async () => {
  const db = makeDb();
  db.sqlite.exec(
    `INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('index.json', 's', '{"generated":"2026-11-09","totals":{},"categories":[{"key":"d1only","title":"D1 only","pages":3,"facts":9}],"changes":[]}', 'x')`
  );
  const dir = makeLibDir([page("p1", "2026-11-07", "2026-11-07")]);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ generated: "2026-11-08", categories: [{ key: "classes", title: "Classes", pages: 0, facts: 0 }], totals: {}, pages: [] }));
  await runLibrarySeed({ db, libDir: dir, now: NOW });
  const ix = JSON.parse(db.query("SELECT json FROM lib_blobs WHERE name = 'index.json'")[0].json);
  assert.deepEqual(ix.categories.map((c) => c.key).sort(), ["classes", "d1only"]);
  assert.equal(ix.categories.find((c) => c.key === "classes").pages, 1, "count corrected from lib_pages");
});

test("interrupted category move: retry still rebuilds the old category from the blobs already in D1", async () => {
  const db = makeDb({ failOnExec: 2 }); // the page batch (exec 1) lands, the next exec fails before any rebuild
  db.sqlite.exec(`INSERT INTO lib_pages (id, category, title, as_of, checked, updated_at) VALUES ('mv', 'old', 'mv', '2026-11-01', '2026-11-01', 'x')`);
  db.sqlite.exec(`INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('old.json', 's', '{"key":"old","title":"Old","pages":[{"id":"mv"}]}', 'x')`);
  const dir = makeLibDir([page("mv", "2026-11-07", "2026-11-07")]);
  await assert.rejects(runLibrarySeed({ db, libDir: dir, now: NOW }), /simulated D1 failure/);
  assert.equal(db.query("SELECT category FROM lib_pages WHERE id = 'mv'")[0].category, "classes", "move landed");
  assert.equal(catPagesInBlob(db, "old"), 1, "old blob still stale after the interruption");
  const r = await runLibrarySeed({ db, libDir: dir, now: NOW });
  assert.equal(r.status, "seeded");
  assert.equal(catPagesInBlob(db, "old"), 0);
  assert.equal(catPagesInBlob(db, "classes"), 1);
});

test("emptied category: index.json count goes to zero", async () => {
  const db = makeDb();
  db.sqlite.exec(
    `INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('index.json', 's', '{"generated":"2026-11-09","totals":{},"categories":[{"key":"old","title":"Old","pages":1,"facts":4}]}', 'x')`
  );
  db.sqlite.exec(`INSERT INTO lib_pages (id, category, title, as_of, checked, updated_at) VALUES ('mv', 'old', 'mv', '2026-11-01', '2026-11-01', 'x')`);
  await runLibrarySeed({ db, libDir: makeLibDir([page("mv", "2026-11-07", "2026-11-07")]), now: NOW });
  const ix = JSON.parse(db.query("SELECT json FROM lib_blobs WHERE name = 'index.json'")[0].json);
  const old = ix.categories.find((c) => c.key === "old");
  assert.deepEqual([old.pages, old.facts], [0, 0]);
});

test("a chunked blob write is never split across batches; an unparseable D1 blob is replaced", async () => {
  const dir = makeLibDir(manyPages(25, "2026-11-07"));
  fs.writeFileSync(path.join(dir, "news.json"), JSON.stringify({ generated: "2026-11-08", items: ["x".repeat(90000)] }));
  const db = makeDb();
  db.sqlite.exec(`INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('news.json', 's', '{"truncat', 'x')`);
  await runLibrarySeed({ db, libDir: dir, now: NOW });
  const withHead = db.batches.filter((b) => b.some((st) => st.startsWith("INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('news.json'")));
  assert.equal(withHead.length, 1);
  assert.ok(withHead[0].filter((st) => st.startsWith("UPDATE lib_blobs SET json = json ||") && st.includes("WHERE name = 'news.json' AND updated_at")).length >= 2, "all chunk appends in the same batch as the head");
  assert.equal(JSON.parse(db.query("SELECT json FROM lib_blobs WHERE name = 'news.json'")[0].json).items[0].length, 90000);
});

test("equal dates: repo-only facts (by key) are appended to D1, D1 facts and dates are untouched", async () => {
  const dir = makeLibDir([
    page("p-merge", "2026-11-05", "2026-11-05", { facts: [{ key: "k.shared", value: "repo-copy" }, { key: "k.new", value: "repo-only" }] }),
  ]);
  const db = makeDb();
  db.sqlite.exec(
    `INSERT INTO lib_pages (id, category, title, as_of, checked, blurb, facts_json, updated_at) VALUES ('p-merge', 'classes', 'p-merge', '2026-11-05', '2026-11-05', 'b', '[{"key":"k.shared","value":"live"},{"key":"k.liveonly","value":"d1-only"}]', 'u1')`
  );
  const r = await runLibrarySeed({ db, libDir: dir, now: NOW });
  const facts = JSON.parse(factsOf(db, "p-merge"));
  assert.deepEqual(facts.map((f) => f.key), ["k.shared", "k.liveonly", "k.new"]);
  assert.equal(facts[0].value, "live", "shared fact keeps D1's value");
  assert.equal(r.counts.merged, 1);
  const row = db.query("SELECT as_of, checked FROM lib_pages WHERE id = 'p-merge'")[0];
  assert.deepEqual([row.as_of, row.checked], ["2026-11-05", "2026-11-05"]);
  const blob = JSON.parse(db.query("SELECT json FROM lib_blobs WHERE name = 'classes.json'")[0].json);
  assert.ok(blob.pages.find((p) => p.id === "p-merge").facts.some((f) => f.key === "k.new"), "category blob rebuilt with the merged fact");
});

test("fact merge race: a row that changed after the snapshot is not touched by the merge", async () => {
  const dir = makeLibDir([page("p-mr", "2026-11-05", "2026-11-05", { facts: [{ key: "k.new", value: "repo-only" }] })]);
  const db = makeDb({ afterSnapshot: (sq) => sq.exec(`UPDATE lib_pages SET facts_json = '[{"key":"k.cron","value":"cron"}]', updated_at = 'u2' WHERE id = 'p-mr'`) });
  db.sqlite.exec(
    `INSERT INTO lib_pages (id, category, title, as_of, checked, blurb, facts_json, updated_at) VALUES ('p-mr', 'classes', 'p-mr', '2026-11-05', '2026-11-05', 'b', '[{"key":"k.old","value":"x"}]', 'u1')`
  );
  await runLibrarySeed({ db, libDir: dir, now: NOW });
  assert.match(factsOf(db, "p-mr"), /k\.cron/);
  assert.doesNotMatch(factsOf(db, "p-mr"), /k\.new/);
});
