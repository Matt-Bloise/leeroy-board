// =============================================================================
// `library-seed.mjs` - the LIBRARY-ONLY seed. Used by `seed-d1.mjs --library-only`.
//
// Touches ONLY `lib_blobs` and `lib_pages`. Never `kv_state`, never `lib_sources`.
// Merges the repo's data/library/*.json into D1 per page, so a data-only Library PR
// reaches the live site without clobbering what the 6-hour cron, wiki edits and
// approvals wrote into D1:
//   - page absent in D1                       -> insert the repo page ("repo newer")
//   - repo (as_of, checked) newer than D1 row -> replace the row      ("repo newer")
//   - D1 (as_of, checked) newer               -> keep D1              ("D1 newer")
//   - equal                                   -> keep D1              ("same")
// Afterwards the category blobs, search.json, open.json and index.json are rebuilt by
// the Worker's own `recomputeCategoryAndIndex` (imported, not forked).
//
// Stamp: lib_blobs row `seed.stamp` holds the sha256 of the concatenated
// data/library/*.json (sorted by file name). Equal stamp -> the step is skipped.
// The stamp is written last, only after a fully successful run.
//
// The D1 access is injected (`db`), so tests run it against an in-memory SQLite.
// `db` = { query(sql) -> rows[], exec(statements[]) -> void }.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { recomputeCategoryAndIndex } from "../worker/scraper.js";

export const STAMP_NAME = "seed.stamp";
// Rebuilt from lib_pages (or written by the cron): seeded only when absent, never overwritten from the repo.
const DERIVED = new Set(["index.json", "search.json", "open.json", "refresh.json"]);
const CHUNK = 30000; // characters per literal, well under D1's 100 KB statement limit

export function sqlStr(val) {
  if (val === null || val === undefined) return "NULL";
  return `'${String(val).replace(/'/g, "''")}'`;
}

function sha8(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 8);
}

/** Read data/library/*.json: sorted [{ file, raw, parsed }]. */
export function readLibraryFiles(libDir) {
  if (!fs.existsSync(libDir)) return [];
  return fs
    .readdirSync(libDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(libDir, file), "utf8");
      return { file, text, parsed: JSON.parse(text) };
    });
}

/** sha256 of the concatenated file contents, in sorted file-name order. */
export function libraryHash(files) {
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(f.text);
  return h.digest("hex");
}

/** Compare (as_of, checked) of two page-like rows as strings. >0 repo newer, <0 D1 newer, 0 same. */
export function comparePage(repo, d1) {
  const a = String(repo.as_of || "");
  const b = String(d1.as_of || "");
  if (a !== b) return a > b ? 1 : -1;
  const c = String(repo.checked || "");
  const d = String(d1.checked || "");
  if (c !== d) return c > d ? 1 : -1;
  return 0;
}

function blobStatements(name, json, now) {
  const stamp = sha8(json);
  const out = [
    `INSERT OR REPLACE INTO lib_blobs (name, stamp, json, updated_at) VALUES (${sqlStr(name)}, ${sqlStr(stamp)}, ${sqlStr(json.slice(0, CHUNK))}, ${sqlStr(now)});`,
  ];
  for (let i = CHUNK; i < json.length; i += CHUNK) {
    out.push(`UPDATE lib_blobs SET json = json || ${sqlStr(json.slice(i, i + CHUNK))} WHERE name = ${sqlStr(name)};`);
  }
  return out;
}

const jsonOrEmpty = (j) => {
  try {
    return JSON.parse(j || "[]");
  } catch {
    return [];
  }
};

/** Canonical page object (same defaults the INSERT applies), from a repo page. */
function canonRepo(p) {
  return [p.id, p.category, p.title, p.confidence || "confirmed", p.status || "current", p.as_of || null, p.checked || null, Number(p.recheck_days) || 7, p.blurb || "", p.aliases || [], p.facts || [], p.open || [], p.related || [], p.history || [], p.snapshots || []];
}

/** Same canonical object, from a lib_pages row. */
function canonRow(r) {
  return [r.id, r.category, r.title, r.confidence, r.status, r.as_of || null, r.checked || null, Number(r.recheck_days) || 7, r.blurb || "", jsonOrEmpty(r.aliases_json), jsonOrEmpty(r.facts_json), jsonOrEmpty(r.open_json), jsonOrEmpty(r.related_json), jsonOrEmpty(r.history_json), jsonOrEmpty(r.snapshots_json)];
}

export const contentHash = (canon) => sha8(JSON.stringify(canon));

/**
 * Conditional upsert: the comparison is part of the write, so a cron or approval write that lands between
 * the snapshot read and this statement is not overwritten with older data. A repo page with equal dates but
 * different content may only replace the exact row version it was compared against (updated_at).
 */
function pageStatement(p, now, snapUpdatedAt) {
  const cols = "id, category, title, confidence, status, as_of, checked, recheck_days, blurb, aliases_json, facts_json, open_json, related_json, history_json, snapshots_json, updated_at";
  const sets = cols
    .split(", ")
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const guard = `COALESCE(excluded.as_of, '') > COALESCE(lib_pages.as_of, '') OR (COALESCE(excluded.as_of, '') = COALESCE(lib_pages.as_of, '') AND COALESCE(excluded.checked, '') > COALESCE(lib_pages.checked, ''))${
    snapUpdatedAt === undefined
      ? ""
      : ` OR (COALESCE(excluded.as_of, '') = COALESCE(lib_pages.as_of, '') AND COALESCE(excluded.checked, '') = COALESCE(lib_pages.checked, '') AND lib_pages.updated_at = ${sqlStr(snapUpdatedAt)})`
  }`;
  return `${insertPart(p, now, cols)} ON CONFLICT(id) DO UPDATE SET ${sets} WHERE ${guard};`;
}

function insertPart(p, now, cols) {
  return `INSERT INTO lib_pages (${cols}) VALUES (${sqlStr(p.id)}, ${sqlStr(p.category)}, ${sqlStr(p.title)}, ${sqlStr(p.confidence || "confirmed")}, ${sqlStr(p.status || "current")}, ${sqlStr(p.as_of || null)}, ${sqlStr(p.checked || null)}, ${Number(p.recheck_days) || 7}, ${sqlStr(p.blurb || "")}, ${sqlStr(JSON.stringify(p.aliases || []))}, ${sqlStr(JSON.stringify(p.facts || []))}, ${sqlStr(JSON.stringify(p.open || []))}, ${sqlStr(JSON.stringify(p.related || []))}, ${sqlStr(JSON.stringify(p.history || []))}, ${sqlStr(JSON.stringify(p.snapshots || []))}, ${sqlStr(now)})`;
}

/**
 * An `env` the Worker's recomputeCategoryAndIndex can run against: prepare/bind/all/first/run,
 * with `?` placeholders inlined as SQL literals. A bound string longer than CHUNK is split into
 * a short INSERT/UPDATE plus `json = json || ...` appends (D1 caps a statement at 100 KB).
 */
export function makeEnv(db) {
  const inline = (sql, params) => {
    let i = 0;
    return sql.replace(/\?/g, () => {
      const v = params[i++];
      return typeof v === "number" ? String(v) : sqlStr(v);
    });
  };
  return {
    DB: {
      prepare(sql) {
        let params = [];
        const stmt = {
          bind(...p) {
            params = p;
            return stmt;
          },
          async all() {
            return { results: db.query(inline(sql, params)) };
          },
          async first() {
            return db.query(inline(sql, params))[0] || null;
          },
          async run() {
            const big = params.findIndex((v) => typeof v === "string" && v.length > CHUNK);
            if (big < 0) {
              db.exec([inline(sql, params)]);
              return {};
            }
            const full = params[big];
            const nameM = /name = '([^']+)'/.exec(sql);
            const name = nameM ? nameM[1] : params.find((v) => typeof v === "string" && /\.json$/.test(v));
            const head = params.slice();
            head[big] = full.slice(0, CHUNK);
            const stmts = [inline(sql, head)];
            for (let i = CHUNK; i < full.length; i += CHUNK) {
              stmts.push(`UPDATE lib_blobs SET json = json || ${sqlStr(full.slice(i, i + CHUNK))} WHERE name = ${sqlStr(name)};`);
            }
            db.exec(stmts);
            return {};
          },
        };
        return stmt;
      },
    },
  };
}

/** Keep index.json totals/category counts in line with lib_pages (recomputeCategoryAndIndex only touches stamps). */
function refreshIndexTotals(db, repoIndex) {
  const row = db.query("SELECT json FROM lib_blobs WHERE name = 'index.json'")[0];
  if (!row) return;
  let ix;
  try {
    ix = JSON.parse(row.json);
  } catch {
    return;
  }
  // Category list: add keys the repo index has and D1's lacks (counts are corrected just below); keep D1's own entries.
  if (repoIndex && Array.isArray(repoIndex.categories)) {
    ix.categories = Array.isArray(ix.categories) ? ix.categories : [];
    const have = new Set(ix.categories.map((c) => c.key));
    for (const c of repoIndex.categories) if (c && c.key && !have.has(c.key)) ix.categories.push({ ...c });
  }
  const pages = db.query("SELECT category, facts_json, open_json FROM lib_pages");
  const len = (j) => {
    try {
      return JSON.parse(j || "[]").length;
    } catch {
      return 0;
    }
  };
  const per = new Map();
  let facts = 0;
  let open = 0;
  for (const p of pages) {
    const f = len(p.facts_json);
    facts += f;
    open += len(p.open_json);
    const c = per.get(p.category) || { pages: 0, facts: 0 };
    c.pages++;
    c.facts += f;
    per.set(p.category, c);
  }
  ix.totals = { ...(ix.totals || {}), pages: pages.length, facts, open };
  if (Array.isArray(ix.categories)) {
    for (const c of ix.categories) {
      const m = per.get(c.key);
      if (m) {
        c.pages = m.pages;
        c.facts = m.facts;
      }
    }
  }
  const json = JSON.stringify(ix);
  db.exec([`UPDATE lib_blobs SET stamp = ${sqlStr(sha8(json))}, json = ${sqlStr(json.slice(0, CHUNK))} WHERE name = 'index.json';`, ...Array.from({ length: Math.ceil(json.length / CHUNK) - 1 }, (_, i) => `UPDATE lib_blobs SET json = json || ${sqlStr(json.slice((i + 1) * CHUNK, (i + 2) * CHUNK))} WHERE name = 'index.json';`)]);
}

/**
 * Run the library-only seed.
 * @returns {Promise<{status:string, counts:object, lines:string[]}>}
 */
export async function runLibrarySeed({ db, libDir, dryRun = false, force = false, log = () => {}, now = new Date().toISOString() }) {
  const files = readLibraryFiles(libDir);
  const hash = libraryHash(files);
  const lines = [];
  const say = (s) => {
    lines.push(s);
    log(s);
  };

  const stampRow = db.query(`SELECT json FROM lib_blobs WHERE name = ${sqlStr(STAMP_NAME)}`)[0];
  if (!force && stampRow && stampRow.json === hash) {
    say(`Library stamp unchanged (${hash.slice(0, 12)}). Skipping library seed.`);
    return { status: "skipped", counts: {}, lines };
  }

  const d1Pages = new Map();
  for (const r of db.query("SELECT * FROM lib_pages")) d1Pages.set(r.id, r);

  const counts = { "repo newer": 0, "D1 newer": 0, same: 0, inserted: 0, blobs: 0 };
  const writes = [];
  // Every category present in the repo files is rebuilt on every run that does not skip on the stamp, plus the
  // old category of any page that moved. A failed run therefore cannot leave a stale category blob behind:
  // the retry rebuilds them all, and the stamp is written only after that.
  const rebuildCats = new Set();

  for (const { file, parsed } of files) {
    if (file === "index.json" || !Array.isArray(parsed.pages)) continue;
    if (parsed.key) rebuildCats.add(parsed.key);
    for (const p of parsed.pages) {
      rebuildCats.add(p.category);
      const d1 = d1Pages.get(p.id);
      let verdict;
      if (!d1) {
        verdict = "repo newer";
        counts.inserted++;
        say(`${p.id}: repo newer (absent in D1)`);
      } else {
        const c = comparePage(p, d1);
        let snap; // set only for an equal-dates, different-content write
        verdict = c > 0 ? "repo newer" : c < 0 ? "D1 newer" : "same";
        if (c === 0 && contentHash(canonRepo(p)) !== contentHash(canonRow(d1))) {
          verdict = "repo newer";
          snap = d1.updated_at;
          say(`${p.id}: repo newer (same dates, content differs)`);
        } else {
          say(`${p.id}: ${verdict}`);
        }
        if (verdict === "repo newer") {
          if (d1.category !== p.category) rebuildCats.add(d1.category);
          writes.push(pageStatement(p, now, snap));
        }
        counts[verdict]++;
        continue;
      }
      counts[verdict]++;
      writes.push(pageStatement(p, now));
    }
  }

  // Blobs that are not page-bearing (news, glossary, tooltips, ...): write the repo copy when D1 has none
  // or the repo's `generated` is newer. Category blobs, search, open and index are rebuilt below, except
  // that a missing one is seeded first so the rebuild has a base. index.json: repo wins only when newer.
  const blobRows = new Map(db.query("SELECT name, json FROM lib_blobs").map((r) => [r.name, r.json]));
  const genOf = (txt) => {
    try {
      return String(JSON.parse(txt).generated || "");
    } catch {
      return "";
    }
  };
  for (const { file, parsed } of files) {
    const hasPages = Array.isArray(parsed.pages) && file !== "index.json";
    const d1Json = blobRows.get(file);
    const repoJson = JSON.stringify(parsed);
    let write = false;
    if (d1Json === undefined) write = true;
    else if (!hasPages && !DERIVED.has(file)) write = String(parsed.generated || "") > genOf(d1Json);
    if (write) {
      say(`${file}: blob ${d1Json === undefined ? "absent in D1, seeding" : "repo newer"}`);
      writes.push(...blobStatements(file, repoJson, now));
      counts.blobs++;
    } else if (!hasPages) {
      say(`${file}: blob kept (D1 same or newer)`);
    }
  }

  say(
    `Pages: ${counts["repo newer"]} repo newer (${counts.inserted} new), ${counts["D1 newer"]} D1 newer, ${counts.same} same. Blobs written: ${counts.blobs}.`
  );

  say(`Categories to rebuild: ${[...rebuildCats].sort().join(", ") || "none"}.`);

  if (dryRun) {
    say("Dry run: nothing written.");
    return { status: "dry-run", counts, lines };
  }

  const BATCH = 20;
  for (let i = 0; i < writes.length; i += BATCH) db.exec(writes.slice(i, i + BATCH));

  // Rebuild derived blobs with the Worker's own function. Category blobs for touched categories,
  // then one final pass (null) that refreshes index.json stamps.
  const env = makeEnv(db);
  const repoIndex = files.find((f) => f.file === "index.json");
  refreshIndexTotals(db, repoIndex && repoIndex.parsed);
  for (const cat of [...rebuildCats].sort()) await recomputeCategoryAndIndex(env, cat);
  await recomputeCategoryAndIndex(env, null);

  db.exec(blobStatements(STAMP_NAME, hash, now));
  say(`Stamp ${STAMP_NAME} written (${hash.slice(0, 12)}).`);
  return { status: "seeded", counts, lines };
}

/** Real D1 access through wrangler (remote or local). Reads and writes go through --file. */
export async function makeWranglerDb({ dbName, isRemote, infraDir }) {
  const { execFileSync } = await import("node:child_process");
  const run = (sql) => {
    const f = path.join(infraDir, `.seed-lib-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sql`);
    fs.writeFileSync(f, sql, "utf8");
    try {
      const args = ["wrangler", "d1", "execute", dbName, isRemote ? "--remote" : "--local", `--file=${f}`, "--json"];
      if (process.env.D1_PERSIST_TO && !isRemote) args.push("--persist-to", process.env.D1_PERSIST_TO);
      return execFileSync("npx", args, { cwd: infraDir, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    } finally {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  };
  return {
    query(sql) {
      const out = JSON.parse(run(sql));
      const last = Array.isArray(out) ? out[out.length - 1] : out;
      return (last && last.results) || [];
    },
    exec(statements) {
      if (statements.length) run(statements.join("\n"));
    },
  };
}
