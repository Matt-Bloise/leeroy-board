// A D1-shaped wrapper over node:sqlite (in memory), so Worker code can be tested against real SQL: constraints, cascades, ordering.
// Supports the calls the Worker makes: prepare(sql).bind(...).all() / first() / run(), and batch([...]) (one transaction, all or nothing).
// Not D1: no replicas, no size limits, no Time Travel. No network, no AI, no secrets.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_PATH = new URL("../../infrastructure/schema.sql", import.meta.url);

export function makeD1(db = new DatabaseSync(":memory:")) {
  db.exec("PRAGMA foreign_keys = ON");
  const stmt = (sql) => {
    let args = [];
    const o = {
      sql,
      bind: (...a) => { args = a; return o; },
      all: async () => ({ results: db.prepare(sql).all(...args), success: true }),
      first: async () => db.prepare(sql).get(...args) || null,
      run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      _run: () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return o;
  };
  return {
    raw: db,
    prepare: stmt,
    exec: async (sql) => { db.exec(sql); return { count: 1 }; },
    batch: async (list) => {
      db.exec("BEGIN");
      try { const out = list.map((s) => s._run()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

// A database built from schema.sql, the way a fresh preview database is.
export function schemaDb() {
  const d = makeD1();
  d.raw.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return d;
}
