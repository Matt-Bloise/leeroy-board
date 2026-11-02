// Backup you own: GET /api/admin/export (admin token only), NDJSON, one table page per request.
//   GET /api/admin/export                              manifest: one line per table with its exported columns, plus the exclusions
//   GET /api/admin/export?table=<name>&after=<n>&limit=<n>   up to `limit` rows of one table with rowid > after, oldest first
// Every line is a JSON object on its own line:
//   {"t":"manifest","version":1,...}             first line of the manifest answer
//   {"t":"table","table":"kv_state","columns":[...],"excluded_columns":[...],"filter":"..."|null}   one per exported table
//   {"t":"excluded_table","table":"sessions","why":"..."}                                          one per table never exported
//   {"t":"page","table":"kv_state","after":0,"columns":[...]}                                      first line of a page answer
//   {"t":"row","table":"kv_state","r":{"key":"party",...}}                                          one per row
//   {"t":"end","table":"kv_state","rows":200,"next":412|null}                                      last line; next is the cursor for the following page
// Free-plan fit: a page is one indexed D1 read of at most `limit` rows (default 200, never more than 1000); a manifest is two small
// reads per table and no row scans. The caller loops until next is null (tools/pull-export.mjs does).
// What is NEVER exported (the single source for this list; tests/unit/export.test.mjs checks it against schema.sql):
//   tables  sessions, sessions_v2 (session token hashes), provider_tokens (encrypted OAuth tokens), account_keys (key hashes),
//           guest_rate_limits (hashed visitor addresses, short lived), plus anything SQLite, Cloudflare or the migration bookkeeping owns
//   columns members.key_hash (the member's salted key hash: keys are re-issued after a restore)
//   rows    kv_state keys starting with `secret` (the Worker never serves them) and `feed_cache:` (a derived cache)
// Everything else is exported, including pseudonymous hashes that a restore needs as keys (user_state.user_key, answer_feedback.user_hash,
// answer_details.asker_hash). A new table is exported by default; if it holds a secret, add it here: the schema test fails until it is classified.
// No secret values are read, logged or returned. The response is private and never cached.
import { timingSafeEqualStr } from "./crypto.js";
import { extractKey } from "./request-key.js";

export const EXCLUDED_TABLES = Object.freeze({
  sessions: "session token hashes",
  sessions_v2: "web session token hashes",
  provider_tokens: "encrypted OAuth access and refresh tokens",
  account_keys: "account key hashes",
  guest_rate_limits: "hashed visitor addresses, short-lived counters",
});
export const EXCLUDED_COLUMNS = Object.freeze({
  members: Object.freeze({ key_hash: "salted hash of the member key" }),
});
// Row filters as SQL fragments appended with AND. Constants only, never built from input.
export const ROW_FILTERS = Object.freeze({
  kv_state: "key NOT LIKE 'secret%' AND key NOT LIKE 'feed_cache:%'",
});
export const PAGE = Object.freeze({ default: 200, max: 1000 });
const SYSTEM_TABLE = /^(sqlite_|_cf_|d1_)/;
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const lines = (objs) => new Response(objs.map((o) => JSON.stringify(o)).join("\n") + "\n", { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });

export const isExcludedTable = (name) => SYSTEM_TABLE.test(name) || Object.prototype.hasOwnProperty.call(EXCLUDED_TABLES, name);
export const exportedColumns = (table, all) => all.filter((c) => !(EXCLUDED_COLUMNS[table] && Object.prototype.hasOwnProperty.call(EXCLUDED_COLUMNS[table], c)));

// -> [{ name }] in creation order, every user table in the database (excluded ones included, so the manifest can name them).
export async function listTables(env) {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid").all();
  return (results || []).map((r) => r.name).filter((n) => IDENT.test(n) || SYSTEM_TABLE.test(n));
}
async function columnsOf(env, table) { // table was matched against listTables(), so the quoted name is safe
  const { results } = await env.DB.prepare(`PRAGMA table_info("${table}")`).all();
  return (results || []).map((r) => r.name).filter((c) => IDENT.test(c));
}

async function manifest(env) {
  const out = [{ t: "manifest", version: 1, page: { default: PAGE.default, max: PAGE.max }, note: "Secrets are not exported. Members are restored without keys." }];
  for (const table of await listTables(env)) {
    if (SYSTEM_TABLE.test(table)) continue;
    if (Object.prototype.hasOwnProperty.call(EXCLUDED_TABLES, table)) { out.push({ t: "excluded_table", table, why: EXCLUDED_TABLES[table] }); continue; }
    const all = await columnsOf(env, table), cols = exportedColumns(table, all);
    out.push({ t: "table", table, columns: cols, excluded_columns: all.filter((c) => !cols.includes(c)), filter: ROW_FILTERS[table] || null });
  }
  return lines(out);
}

async function page(env, table, afterRaw, limitRaw) {
  const known = await listTables(env);
  if (!IDENT.test(table) || !known.includes(table) || isExcludedTable(table)) return json(404, { error: "unknown table" });
  const after = afterRaw === null || afterRaw === "" ? 0 : Number(afterRaw);
  if (!Number.isSafeInteger(after) || after < 0) return json(400, { error: "after must be a whole number, 0 or more" });
  let limit = limitRaw === null || limitRaw === "" ? PAGE.default : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1) return json(400, { error: "limit must be a whole number, 1 or more" });
  limit = Math.min(limit, PAGE.max);
  const cols = exportedColumns(table, await columnsOf(env, table));
  if (!cols.length) return json(404, { error: "unknown table" });
  const filter = ROW_FILTERS[table] ? ` AND ${ROW_FILTERS[table]}` : "";
  const sql = `SELECT rowid AS _rowid, ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" WHERE rowid > ?${filter} ORDER BY rowid LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(after, limit + 1).all();
  const rows = results || [], more = rows.length > limit, take = more ? rows.slice(0, limit) : rows;
  const next = more ? take[take.length - 1]._rowid : null;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const put = (o) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      put({ t: "page", table, after, columns: cols });
      for (const row of take) { const { _rowid, ...r } = row; put({ t: "row", table, r }); }
      put({ t: "end", table, rows: take.length, next });
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

// -> a Response. The caller has already matched GET /admin/export; the admin token is checked here so the gate cannot be forgotten.
export async function handleExport(req, env, url) {
  if (!env.BOARD_ADMIN_TOKEN) return json(503, { error: "Admin token not configured" });
  const k = extractKey(req);
  if (!k || !timingSafeEqualStr(k, env.BOARD_ADMIN_TOKEN)) return json(401, { error: "Unauthorized" });
  try {
    const table = url.searchParams.get("table");
    if (table === null) return await manifest(env);
    return await page(env, table, url.searchParams.get("after"), url.searchParams.get("limit"));
  } catch (e) {
    console.error("export: failed");
    return json(500, { error: "export failed" });
  }
}
