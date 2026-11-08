// Library seed: statement size limits, surrogate-safe chunking, and blob/index concurrency guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runLibrarySeed, chunkEscaped, MAX_STMT_BYTES } from "../../infrastructure/scripts/library-seed.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../infrastructure/schema.sql"), "utf8");
const NOW = "2026-11-08T12:00:00.000Z";
const EURO = "€";
const EMOJI = "\u{1F600}";
const bytes = (st) => Buffer.byteLength(st);

function page(id, extra = {}) {
  return { id, category: "classes", title: id, confidence: "confirmed", status: "current", as_of: "2026-11-07", checked: "2026-11-07", recheck_days: 7, blurb: "b", aliases: [], facts: [{ key: "k.f", value: "v" }], open: [], related: [], history: [], snapshots: [], ...extra };
}

function makeLibDir(pages, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libseed-lim-"));
  fs.writeFileSync(path.join(dir, "classes.json"), JSON.stringify({ key: "classes", title: "Classes", pages }));
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ generated: "2026-11-08T00:00:00Z", totals: {}, categories: [], pages: [], changes: [] }));
  for (const [f, v] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
  return dir;
}

function makeDb(afterQuery = null) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const log = [];
  return {
    sqlite,
    log,
    query: (sql) => {
      const rows = sqlite.prepare(sql).all();
      if (afterQuery) afterQuery(sqlite, sql);
      return rows;
    },
    exec: (stmts) => {
      for (const s of stmts) {
        log.push(s);
        sqlite.exec(s);
      }
    },
  };
}

test("chunkEscaped is byte-aware for apostrophes and multibyte text, and lossless", () => {
  const limit = 100;
  for (const unit of ["a", "'", "é", EURO, EMOJI]) {
    const str = unit.repeat(400);
    const chunks = chunkEscaped(str, limit);
    assert.equal(chunks.join(""), str);
    for (const c of chunks) assert.ok(bytes(c.replace(/'/g, "''")) <= limit, `chunk within ${limit} bytes for ${JSON.stringify(unit)}`);
  }
});

test("chunkEscaped never splits a surrogate pair: an emoji at the boundary moves to the next chunk", () => {
  const chunks = chunkEscaped("x".repeat(99) + EMOJI + "y", 100);
  assert.deepEqual(chunks.map((c) => c.length), [99, 3]);
  for (const c of chunks) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(c), "no trailing high surrogate");
    assert.ok(!/^[\uDC00-\uDFFF]/.test(c), "no leading low surrogate");
  }
});

test("a page statement over the limit aborts the whole seed: no write at all (apostrophes, multibyte)", async () => {
  for (const value of ["'".repeat(50000), EURO.repeat(30000)]) {
    const db = makeDb();
    const dir = makeLibDir([page("small"), page("huge", { facts: [{ key: "k.f", value }] })]);
    await assert.rejects(runLibrarySeed({ db, libDir: dir, now: NOW }), /aborted before any write: a statement is \d+ bytes/);
    assert.deepEqual(db.log, []);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM lib_pages").get().n, 0);
  }
});

test("a large page just under the limit is accepted", async () => {
  const db = makeDb();
  await runLibrarySeed({ db, libDir: makeLibDir([page("big", { facts: [{ key: "k.f", value: "a".repeat(60000) }] })]), now: NOW });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM lib_pages").get().n, 1);
});

test("a big blob of apostrophes, euro signs and emoji is chunked within the limit and round-trips", async () => {
  const value = `it's ${EURO}${EMOJI} `.repeat(20000);
  const db = makeDb();
  await runLibrarySeed({ db, libDir: makeLibDir([page("p1")], { "news.json": { generated: "2026-11-08", items: [value] } }), now: NOW });
  for (const st of db.log) assert.ok(bytes(st) <= MAX_STMT_BYTES, "statement within limit");
  assert.equal(JSON.parse(db.sqlite.prepare("SELECT json FROM lib_blobs WHERE name = 'news.json'").get().json).items[0], value);
});

test("blob concurrency: a blob changed in D1 after the snapshot is kept, with no stray chunk appends", async () => {
  const db = makeDb((sq, sql) => {
    if (sql === "SELECT name, json, updated_at FROM lib_blobs") {
      sq.exec(`UPDATE lib_blobs SET json = '{"live":1}', updated_at = '2026-11-20T00:00:00Z' WHERE name = 'news.json'`);
    }
  });
  db.sqlite.exec(`INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('news.json', 's', '{"generated":"2026-11-01"}', '2026-11-01T00:00:00Z')`);
  const dir = makeLibDir([page("p1")], { "news.json": { generated: "2026-11-08", items: ["x".repeat(100000)] } });
  await runLibrarySeed({ db, libDir: dir, now: NOW });
  assert.equal(db.sqlite.prepare("SELECT json FROM lib_blobs WHERE name = 'news.json'").get().json, '{"live":1}');
});

test("index.json changed after it was read: the totals write is skipped, the concurrent write survives", async () => {
  const db = makeDb((sq, sql) => {
    if (sql === "SELECT json, updated_at FROM lib_blobs WHERE name = 'index.json'") {
      sq.exec(
        `UPDATE lib_blobs SET json = '{"generated":"2026-11-09","totals":{"pages":999},"categories":[],"concurrent":1}', updated_at = '2026-11-20T00:00:00Z' WHERE name = 'index.json'`
      );
    }
  });
  db.sqlite.exec(`INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('index.json', 's', '{"generated":"2026-11-09","totals":{},"categories":[]}', '2026-11-01T00:00:00Z')`);
  await runLibrarySeed({ db, libDir: makeLibDir([page("p1")]), now: NOW });
  const ix = JSON.parse(db.sqlite.prepare("SELECT json FROM lib_blobs WHERE name = 'index.json'").get().json);
  assert.equal(ix.concurrent, 1);
  assert.equal(ix.totals.pages, 999, "our totals were not applied over the concurrent write");
});

const stampRows = (db) => db.sqlite.prepare("SELECT 1 FROM lib_blobs WHERE name = 'seed.stamp'").all().length;

test("a live page write that interleaves with the rebuild: no stamp, warning, next run stamps", async () => {
  let fired = false;
  const db = makeDb((sq, sql) => {
    if (!fired && sql.startsWith("SELECT * FROM lib_pages WHERE category = 'classes'")) {
      fired = true;
      sq.exec(`UPDATE lib_pages SET facts_json = '[{"key":"k","value":"cron"}]', updated_at = '2026-11-20T00:00:00Z' WHERE id = 'p1'`);
    }
  });
  const dir = makeLibDir([page("p1")]);
  const lines = [];
  const r = await runLibrarySeed({ db, libDir: dir, now: NOW, log: (l) => lines.push(l) });
  assert.equal(r.status, "not-stamped");
  assert.equal(stampRows(db), 0);
  assert.ok(lines.includes("::warning::library seed: a concurrent edit was detected, not stamping; the next deploy retries"));
  assert.deepEqual(r.interleaved, ["page p1"]);
  const r2 = await runLibrarySeed({ db, libDir: dir, now: "2026-11-21T00:00:00.000Z" });
  assert.equal(r2.status, "seeded");
  assert.equal(stampRows(db), 1);
});

test("a foreign blob write during the run blocks the stamp; the seed's own writes do not", async () => {
  const db = makeDb((sq, sql) => {
    if (sql.startsWith("SELECT * FROM lib_pages WHERE category = 'classes'")) {
      sq.exec(`INSERT OR REPLACE INTO lib_blobs (name, stamp, json, updated_at) VALUES ('refresh.json', 's', '{"cron":1}', '2026-11-20T00:00:00Z')`);
    }
  });
  const r = await runLibrarySeed({ db, libDir: makeLibDir([page("p1")]), now: NOW });
  assert.equal(r.status, "not-stamped");
  assert.deepEqual(r.interleaved, ["blob refresh.json"]);
  assert.equal(stampRows(db), 0);
});

test("a skipped guarded index.json totals write blocks the stamp", async () => {
  const db = makeDb((sq, sql) => {
    if (sql === "SELECT json, updated_at FROM lib_blobs WHERE name = 'index.json'") sq.exec(`UPDATE lib_blobs SET updated_at = '2026-11-20T00:00:00Z' WHERE name = 'index.json'`);
  });
  db.sqlite.exec(`INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('index.json', 's', '{"generated":"2026-11-09","totals":{},"categories":[]}', '2026-11-01T00:00:00Z')`);
  const r = await runLibrarySeed({ db, libDir: makeLibDir([page("p1")]), now: NOW });
  assert.equal(r.status, "not-stamped");
  assert.equal(stampRows(db), 0);
});

import { makeEnv } from "../../infrastructure/scripts/library-seed.mjs";
process.env.LIBRARY_SEED_ALLOW_EMPTY = "1"; // these tests seed a brand-new in-memory database; the empty-database guard is tested in library-seed-reads.test.mjs

const wordFor = (n) => {
  let w = "";
  do {
    w = String.fromCharCode(97 + (n % 26)) + w;
    n = Math.floor(n / 26);
  } while (n > 0);
  return "w" + w.padStart(4, "a");
};

test("makeEnv chunked write resolves the name from VALUES ('search.json', ?, ?, ?) and round-trips", async () => {
  const db = makeDb();
  const env = makeEnv(db);
  const json = JSON.stringify({ generated: "x", idf: Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [wordFor(i), 1.2345])) });
  assert.ok(bytes(json) > 100000);
  await env.DB.prepare(
    "INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('search.json', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET stamp = excluded.stamp, json = excluded.json, updated_at = excluded.updated_at"
  )
    .bind("s", json, NOW)
    .run();
  const stored = db.sqlite.prepare("SELECT json FROM lib_blobs WHERE name = 'search.json'").get().json;
  assert.equal(bytes(stored), bytes(json));
  assert.equal(JSON.parse(stored).idf[wordFor(11999)], 1.2345);
});

test("makeEnv chunked write without a resolvable name throws and executes nothing", async () => {
  const db = makeDb();
  const env = makeEnv(db);
  await assert.rejects(env.DB.prepare("INSERT INTO lib_blobs (stamp, json, updated_at) VALUES (?, ?, ?)").bind("s", "x".repeat(90000), NOW).run(), /without a resolvable name/);
  assert.deepEqual(db.log, []);
});

test("a real seed whose search.json and open.json exceed one chunk stores both intact and stamps", async () => {
  const pages = Array.from({ length: 120 }, (_, i) =>
    page("big-" + String(i).padStart(3, "0"), {
      facts: Array.from({ length: 40 }, (_, j) => ({ key: "k." + j, value: wordFor(i * 40 + j) + " " + wordFor(i * 40 + j + 7000) })),
      open: Array.from({ length: 12 }, (_, j) => "open question number " + j + " about " + wordFor(i * 12 + j)),
    })
  );
  const db = makeDb();
  const r = await runLibrarySeed({ db, libDir: makeLibDir(pages), now: NOW });
  assert.equal(r.status, "seeded");
  for (const name of ["search.json", "open.json"]) {
    const row = db.sqlite.prepare("SELECT json FROM lib_blobs WHERE name = ?").get(name);
    assert.ok(bytes(row.json) > 40000, `${name} is larger than one chunk (${bytes(row.json)} bytes)`);
    const parsed = JSON.parse(row.json);
    assert.ok(name === "search.json" ? Object.keys(parsed.idf).length > 3000 : parsed.open.length === 120 * 12);
  }
  assert.equal(stampRows(db), 1);
});
