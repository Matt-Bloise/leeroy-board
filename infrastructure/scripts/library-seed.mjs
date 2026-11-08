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
const CHUNK_BYTES = 40000; // UTF-8 bytes of one ESCAPED literal (quotes doubled); a statement then stays far under D1's 100 KB limit
export const MAX_STMT_BYTES = 80000; // any fully built statement above this aborts the whole seed before a single write

/**
 * Split on code-point boundaries (never inside a surrogate pair) so that each piece, after SQL quote doubling,
 * is at most CHUNK_BYTES of UTF-8. A single code point is at most 4 bytes, so progress is guaranteed.
 */
export function chunkEscaped(str, maxBytes = CHUNK_BYTES) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of str) {
    const b = ch === "'" ? 2 : Buffer.byteLength(ch);
    if (bytes + b > maxBytes) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

function assertStatementSizes(units) {
  for (const unit of units) {
    for (const st of unit) {
      const n = Buffer.byteLength(st);
      if (n > MAX_STMT_BYTES) {
        throw new Error(`Library seed aborted before any write: a statement is ${n} bytes (limit ${MAX_STMT_BYTES}): ${st.slice(0, 120).replace(/\s+/g, " ")}...`);
      }
    }
  }
}

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

/**
 * One blob as a unit of statements. Guarded: the head only lands when the row is absent at the snapshot and still absent,
 * or its updated_at is not newer than the snapshot (`snapUpdatedAt`). Chunk appends only apply while the row carries
 * this write's `now` as updated_at, so a skipped head can never be followed by stray appends.
 */
function blobStatements(name, json, now, snapUpdatedAt) {
  const stamp = sha8(json);
  const chunks = chunkEscaped(json);
  const head = `INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES (${sqlStr(name)}, ${sqlStr(stamp)}, ${sqlStr(chunks[0])}, ${sqlStr(now)}) ON CONFLICT(name) DO UPDATE SET stamp = excluded.stamp, json = excluded.json, updated_at = excluded.updated_at WHERE ${
    snapUpdatedAt === undefined ? "0" : `lib_blobs.updated_at <= ${sqlStr(snapUpdatedAt)}`
  };`;
  const out = [head];
  for (let i = 1; i < chunks.length; i++) {
    out.push(`UPDATE lib_blobs SET json = json || ${sqlStr(chunks[i])} WHERE name = ${sqlStr(name)} AND updated_at = ${sqlStr(now)};`);
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
 * the snapshot read and this statement is not overwritten with older data. Equal dates never overwrite.
 */
function pageStatement(p, now) {
  const cols = "id, category, title, confidence, status, as_of, checked, recheck_days, blurb, aliases_json, facts_json, open_json, related_json, history_json, snapshots_json, updated_at";
  const sets = cols
    .split(", ")
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const guard = `COALESCE(excluded.as_of, '') > COALESCE(lib_pages.as_of, '') OR (COALESCE(excluded.as_of, '') = COALESCE(lib_pages.as_of, '') AND COALESCE(excluded.checked, '') > COALESCE(lib_pages.checked, ''))`;
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
export function makeEnv(db, ownBlobs = new Set()) {
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
            // Record which lib_blobs rows the Worker function writes, so the interleaving check can tell them from foreign writes.
            const m = /INTO lib_blobs \(name[^)]*\) VALUES \('([^']+)'/.exec(inline(sql, params).slice(0, 300)) || /UPDATE lib_blobs .*? WHERE name = '([^']+)'/s.exec(inline(sql, params).slice(0, 400));
            if (m) ownBlobs.add(m[1]);
            const big = params.findIndex((v) => typeof v === "string" && Buffer.byteLength(v) > CHUNK_BYTES);
            if (big < 0) {
              db.exec([inline(sql, params)]);
              return {};
            }
            const chunks = chunkEscaped(params[big]);
            // The Worker writes either `WHERE name = 'x'`, `VALUES ('x.json', ?, ?, ?)` (search.json, open.json) or binds the name.
            const nameM = /name = '([^']+)'/.exec(sql) || /VALUES \('([^']+\.json)'/.exec(sql);
            const name = nameM ? nameM[1] : params.find((v) => typeof v === "string" && /\.json$/.test(v));
            if (!name) throw new Error("chunked lib_blobs write without a resolvable name");
            const head = params.slice();
            head[big] = chunks[0];
            const stmts = [inline(sql, head)];
            for (let i = 1; i < chunks.length; i++) {
              stmts.push(`UPDATE lib_blobs SET json = json || ${sqlStr(chunks[i])} WHERE name = ${sqlStr(name)};`);
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
function refreshIndexTotals(db, repoIndex, now) {
  const row = db.query("SELECT json, updated_at FROM lib_blobs WHERE name = 'index.json'")[0];
  if (!row) return true;
  let ix;
  try {
    ix = JSON.parse(row.json);
  } catch {
    return true;
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
      c.pages = m ? m.pages : 0;
      c.facts = m ? m.facts : 0;
    }
  }
  // Same guard as every blob write: only if index.json still has the updated_at that was read (else skip; the final
  // recompute pass refreshes stamps, and the next seed run corrects the counts).
  const json = JSON.stringify(ix);
  const chunks = chunkEscaped(json);
  const stmts = [`UPDATE lib_blobs SET stamp = ${sqlStr(sha8(json))}, json = ${sqlStr(chunks[0])}, updated_at = ${sqlStr(now)} WHERE name = 'index.json' AND updated_at = ${sqlStr(row.updated_at)};`];
  for (let i = 1; i < chunks.length; i++) stmts.push(`UPDATE lib_blobs SET json = json || ${sqlStr(chunks[i])} WHERE name = 'index.json' AND updated_at = ${sqlStr(now)};`);
  db.exec(stmts);
  const after = db.query("SELECT updated_at FROM lib_blobs WHERE name = 'index.json'")[0];
  return !!after && after.updated_at === now; // false: the guard skipped the write because index.json changed under us
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
  const writes = []; // units: a unit (one page, or one blob with its chunk appends) is never split across batches
  const unbumped = [];
  const intendedPages = new Set();
  const intendedBlobs = new Set();
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
        verdict = c > 0 ? "repo newer" : c < 0 ? "D1 newer" : "same";
        // Equal dates always keep D1 (live cron/wiki edits are never clobbered). A repo edit that did not bump
        // as_of or checked is therefore NOT applied; list it so it cannot go unnoticed.
        if (c === 0 && contentHash(canonRepo(p)) !== contentHash(canonRow(d1))) unbumped.push(p.id);
        say(`${p.id}: ${verdict}`);
        if (verdict === "repo newer") {
          intendedPages.add(p.id);
          if (d1.category !== p.category) rebuildCats.add(d1.category);
          writes.push([pageStatement(p, now)]);
        }
        counts[verdict]++;
        continue;
      }
      counts[verdict]++;
      intendedPages.add(p.id);
      writes.push([pageStatement(p, now)]);
    }
  }

  // Blobs that are not page-bearing (news, glossary, tooltips, ...): write the repo copy when D1 has none
  // or the repo's `generated` is newer. Category blobs, search, open and index are rebuilt below, except
  // that a missing one is seeded first so the rebuild has a base. index.json: repo wins only when newer.
  const blobRows = new Map();
  const blobStamps = new Map(); // name -> updated_at at snapshot time
  for (const r of db.query("SELECT name, json, updated_at FROM lib_blobs")) {
    blobRows.set(r.name, r.json);
    blobStamps.set(r.name, r.updated_at);
  }
  const parses = (txt) => {
    try {
      JSON.parse(txt);
      return true;
    } catch {
      return false;
    }
  };
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
    if (d1Json === undefined || !parses(d1Json)) write = true;
    else if (!hasPages && !DERIVED.has(file)) write = String(parsed.generated || "") > genOf(d1Json);
    if (write) {
      say(`${file}: blob ${d1Json === undefined ? "absent in D1, seeding" : parses(d1Json) ? "repo newer" : "unparseable in D1, replacing"}`);
      intendedBlobs.add(file);
      writes.push(blobStatements(file, repoJson, now, blobStamps.get(file)));
      counts.blobs++;
    } else if (!hasPages) {
      say(`${file}: blob kept (D1 same or newer)`);
    }
  }

  if (unbumped.length) {
    say(`WARNING: repo content differs but as_of/checked not bumped (NOT applied): ${unbumped.join(", ")}`);
  }
  say(
    `Pages: ${counts["repo newer"]} repo newer (${counts.inserted} new), ${counts["D1 newer"]} D1 newer, ${counts.same} same. Blobs written: ${counts.blobs}.`
  );

  // Also every category blob already in D1 and every category D1 pages sit in, so an interrupted category move
  // can never lose the old category on retry.
  for (const [name, json] of blobRows) {
    if (name === "index.json" || !name.endsWith(".json")) continue;
    try {
      if (Array.isArray(JSON.parse(json).pages)) rebuildCats.add(name.slice(0, -5));
    } catch {}
  }
  for (const r of d1Pages.values()) rebuildCats.add(r.category);
  say(`Categories to rebuild: ${[...rebuildCats].sort().join(", ") || "none"}.`);

  // Size check on every fully escaped statement BEFORE any write: one oversized statement aborts the whole seed.
  assertStatementSizes(writes);

  if (dryRun) {
    say("Dry run: nothing written.");
    return { status: "dry-run", counts, lines, unbumped };
  }

  const BATCH = 20;
  let batch = [];
  for (const unit of writes) {
    if (batch.length && batch.length + unit.length > BATCH) {
      db.exec(batch);
      batch = [];
    }
    batch.push(...unit);
  }
  if (batch.length) db.exec(batch);

  // Rebuild derived blobs with the Worker's own function. Category blobs for touched categories,
  // then one final pass (null) that refreshes index.json stamps.
  const ownBlobs = new Set(["index.json"]); // recompute always rewrites index.json
  const env = makeEnv(db, ownBlobs);
  const repoIndex = files.find((f) => f.file === "index.json");
  let interleaved = [];
  if (!refreshIndexTotals(db, repoIndex && repoIndex.parsed, now)) interleaved.push("index.json (totals write skipped)");
  for (const cat of [...rebuildCats].sort()) await recomputeCategoryAndIndex(env, cat);
  await recomputeCategoryAndIndex(env, null);

  // Stamp only if nothing changed under the seed: every lib_pages row must be at its snapshot version (or ours),
  // every lib_blobs row too (rows the seed or the Worker rebuild function wrote are exempt). Anything else is a concurrent
  // edit, including one that interleaved with the rebuild (the rebuild has no version guard of its own).
  for (const r of db.query("SELECT id, updated_at FROM lib_pages")) {
    const snap = d1Pages.get(r.id);
    const ok = intendedPages.has(r.id) ? r.updated_at === now : snap ? r.updated_at === snap.updated_at : r.updated_at === now;
    if (!ok) interleaved.push(`page ${r.id}`);
  }
  for (const r of db.query("SELECT name, updated_at FROM lib_blobs")) {
    if (r.name === STAMP_NAME || ownBlobs.has(r.name)) continue;
    const ok = intendedBlobs.has(r.name) ? r.updated_at === now : blobStamps.has(r.name) && r.updated_at === blobStamps.get(r.name);
    if (!ok) interleaved.push(`blob ${r.name}`);
  }
  if (interleaved.length) {
    say("::warning::library seed: a concurrent edit was detected, not stamping; the next deploy retries");
    say(`Changed under the seed: ${interleaved.slice(0, 20).join(", ")}`);
    return { status: "not-stamped", counts, lines, unbumped, interleaved };
  }

  db.exec(blobStatements(STAMP_NAME, hash, now, blobStamps.get(STAMP_NAME)));
  say(`Stamp ${STAMP_NAME} written (${hash.slice(0, 12)}).`);
  return { status: "seeded", counts, lines, unbumped };
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
      // A shell is needed only on Windows (npx is npx.cmd); there the arguments are quoted. Elsewhere no shell, so nothing is re-parsed.
      const win = process.platform === "win32";
      const argv = win ? args.map((a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
      return execFileSync("npx", argv, { cwd: infraDir, shell: win, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
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
