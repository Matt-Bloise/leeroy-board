// The game-facts loader: POST /api/facts/load. docs/runbooks/game-facts.md; tools/facts-load.mjs signs and sends it.
// A signed, PC-side loader fills the D1 tables game_fact_loads and game_facts (migration 0016) with facts derived from the Forever client's own data tables, so a later PR can ground /ask answers in them.
// NOTHING reads these rows in this PR (the lookup, game-facts-lookup.js, is not wired into any answer path) and nothing is posted anywhere.
// Gate, in order: flag GAME_FACTS_LOAD "on" (anything else, a PR preview or no usable bot token: 404, nothing read), body up to 256 KB (413), HMAC with the facts-load key (listener-config.js factsLoadKey: its own label, derived from the bot token;
// the listener, self-test, shadow and heartbeat keys never verify here; X-Listen-Timestamp / X-Listen-Signature, 120 s window, 401), the body shape (400: purpose "facts-load", an op, every field strictly validated, the WHOLE batch refused on
// one bad row), then the replay and rate state (kv_state 'facts_load_state': the signed timestamp must be strictly newer than the last accepted one, 409; at most 120 accepted calls an hour, 429), then the op.
// Ops: begin {build, manifest_sha256, files, kind, expected} opens a load; rows {load_id, rows} upserts up to 200 facts; finish {load_id} closes the load, computes the diff and supersedes what the load did not re-see. Rows are never deleted.
// Responses carry fixed fields only: ok, load_id, accepted, counts (numbers), reason (a fixed class). No row text and no D1 error text ever leaves.
import { isPrPreviewEnv } from "./ai-models.js";
import { factsLoadKeyFor, verifyListen } from "./listener-config.js";
import { updateKvJson } from "./kv-cas.js";
import { readBounded } from "./listener.js";

export const FACTS_FLAG = "GAME_FACTS_LOAD";
export const FACTS_PURPOSE = "facts-load";
export const FACTS_MAX_BODY = 256 * 1024;
export const FACTS_MAX_ROWS = 200;
export const FACTS_PER_HOUR = 120;
export const FACTS_STATE_KEY = "facts_load_state";
export const FACTS_OPEN_MIN_AGE_MS = 30 * 60 * 1000; // an open load of the same kind younger than this blocks a new begin
export const FACTS_MAX_EXPECTED = 200000;
const HOUR_MS = 3600 * 1000;
const MAX_FILES = 24;

export const FACT_KINDS = Object.freeze(["spell_level", "item_level_req", "spell_cooldown", "spell_cast_time", "spell_mana_cost", "trait_max_ranks", "trait_points_required", "trait_prereq", "curated"]);
export const FACT_VERDICTS = Object.freeze(["holds", "wrong", "unverifiable"]);
export const FACT_SOURCE_CLASSES = Object.freeze(["client-db2", "client-addon-data", "client-data-site", "blizzard", "tavern-or-forever-guide", "wiki", "third-party-named", "none"]);
export const FACT_UNITS = Object.freeze(["", "level", "seconds", "mana", "ranks", "points"]);
export const LOAD_KINDS = Object.freeze(["client", "curated"]);
export const MAX = Object.freeze({ subject: 120, claim: 400, value: 80, note: 300, sourceTable: 40, rowId: 40 });
const ID_RE = /^[a-z_]+:[A-Za-z0-9_.-]{1,40}$/;
const BUILD_RE = /^[0-9.]{3,32}$/;
const TABLE_RE = /^[a-z0-9_]{0,40}$/;
const ROWID_RE = /^[A-Za-z0-9_.:-]{0,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LOAD_ID_RE = /^[0-9a-f-]{36}$/;
const FILE_NAME_RE = /^[A-Za-z0-9_.-]{1,60}$/;
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u; // control, format (zero-width, bidi), line and paragraph separators
const ROW_KEYS = new Set(["id", "kind", "subject", "claim", "value", "unit", "source_table", "row_id", "build", "verdict", "source_class", "note"]);

export const factsLoadOn = (env) => String((env && env[FACTS_FLAG]) || "").trim().toLowerCase() === "on";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (status, reason, extra = {}) => json({ ok: false, reason, ...extra }, status);
const isStr = (v, max, min = 0) => typeof v === "string" && Array.from(v).length >= min && Array.from(v).length <= max && !BAD_CHARS.test(v);
const isCount = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const num = (v) => (Number.isFinite(v) ? v : 0);

// Lowercase, punctuation folded to single spaces, diacritics stripped.
export function normSubject(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// One fact row, strictly. -> { row } or { error: "<class>" }. No other key, no non-string text field, no control character, every vocabulary fixed.
// loadKind 'client' | 'curated': the row's kind must agree with it. undefined: that one check is left to the caller (the batch is validated before the load is read).
export function validateRow(r, loadKind) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return { error: "row_shape" };
  for (const k of Object.keys(r)) if (!ROW_KEYS.has(k)) return { error: "row_key" };
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return { error: "row_id" };
  if (!FACT_KINDS.includes(r.kind)) return { error: "row_kind" };
  const curated = r.kind === "curated";
  if (loadKind !== undefined && (loadKind === "curated") !== curated) return { error: "row_kind" };
  if (curated !== r.id.startsWith("curated:")) return { error: "row_id" };
  if (!isStr(r.subject, MAX.subject, curated ? 0 : 1)) return { error: "row_subject" };
  if (!isStr(r.claim, MAX.claim, 1)) return { error: "row_claim" };
  if (!isStr(r.value, MAX.value)) return { error: "row_value" };
  if (typeof r.unit !== "string" || !FACT_UNITS.includes(r.unit)) return { error: "row_unit" };
  if (typeof r.source_table !== "string" || !TABLE_RE.test(r.source_table)) return { error: "row_source_table" };
  if (typeof r.row_id !== "string" || !ROWID_RE.test(r.row_id)) return { error: "row_row_id" };
  if (typeof r.build !== "string" || !BUILD_RE.test(r.build)) return { error: "row_build" };
  if (!FACT_VERDICTS.includes(r.verdict)) return { error: "row_verdict" };
  if (!FACT_SOURCE_CLASSES.includes(r.source_class)) return { error: "row_source_class" };
  if (!isStr(r.note, MAX.note)) return { error: "row_note" };
  return { row: { id: r.id, kind: r.kind, subject: r.subject, subject_norm: normSubject(r.subject), claim: r.claim, value: r.value, unit: r.unit, source_table: r.source_table, row_id: r.row_id, build: r.build, verdict: r.verdict, source_class: r.source_class, note: r.note } };
}

// The ONLY bodies the route accepts. -> { op, ... } or { error: "<class>" }. Unknown keys are refused: a signed body of another purpose (listener event, self-test, heartbeat) can never reach a write.
export function parseFactsBody(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "bad_body" };
  if (v.purpose !== FACTS_PURPOSE) return { error: "bad_body" };
  const only = (allowed) => Object.keys(v).every((k) => allowed.includes(k));
  if (v.op === "begin") {
    if (!only(["purpose", "op", "build", "manifest_sha256", "files", "kind", "expected"])) return { error: "bad_body" };
    if (typeof v.build !== "string" || !BUILD_RE.test(v.build)) return { error: "bad_build" };
    if (typeof v.manifest_sha256 !== "string" || !SHA_RE.test(v.manifest_sha256)) return { error: "bad_manifest" };
    if (!LOAD_KINDS.includes(v.kind)) return { error: "bad_kind" };
    if (!Number.isSafeInteger(v.expected) || v.expected < 1 || v.expected > FACTS_MAX_EXPECTED) return { error: "bad_expected" };
    const f = v.files;
    if (!f || typeof f !== "object" || Array.isArray(f)) return { error: "bad_files" };
    const names = Object.keys(f);
    if (names.length < 1 || names.length > MAX_FILES) return { error: "bad_files" };
    const files = {};
    for (const n of names.sort()) {
      const m = f[n];
      if (!FILE_NAME_RE.test(n) || !m || typeof m !== "object" || Array.isArray(m) || !Object.keys(m).every((k) => ["sha256", "bytes", "rows"].includes(k))) return { error: "bad_files" };
      if (typeof m.sha256 !== "string" || !SHA_RE.test(m.sha256) || !isCount(m.bytes, 2 ** 40) || !isCount(m.rows, 2 ** 31)) return { error: "bad_files" };
      files[n] = { sha256: m.sha256, bytes: m.bytes, rows: m.rows };
    }
    return { op: "begin", build: v.build, manifest_sha256: v.manifest_sha256, kind: v.kind, expected: v.expected, files };
  }
  if (v.op === "rows") {
    if (!only(["purpose", "op", "load_id", "rows"])) return { error: "bad_body" };
    if (typeof v.load_id !== "string" || !LOAD_ID_RE.test(v.load_id)) return { error: "bad_load" };
    if (!Array.isArray(v.rows) || v.rows.length < 1 || v.rows.length > FACTS_MAX_ROWS) return { error: "bad_rows" };
    return { op: "rows", load_id: v.load_id, rows: v.rows };
  }
  if (v.op === "finish") {
    if (!only(["purpose", "op", "load_id"])) return { error: "bad_body" };
    if (typeof v.load_id !== "string" || !LOAD_ID_RE.test(v.load_id)) return { error: "bad_load" };
    return { op: "finish", load_id: v.load_id };
  }
  return { error: "bad_body" };
}

const UPSERT = "INSERT INTO game_facts (id, kind, subject, subject_norm, claim, value, unit, source_table, row_id, build, load_id, verdict, source_class, note, superseded, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) "
  + "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, subject = excluded.subject, subject_norm = excluded.subject_norm, claim = excluded.claim, value = excluded.value, unit = excluded.unit, source_table = excluded.source_table, "
  + "row_id = excluded.row_id, build = excluded.build, load_id = excluded.load_id, verdict = excluded.verdict, source_class = excluded.source_class, note = excluded.note, superseded = 0, updated_at = excluded.updated_at";
const parseCounts = (t) => { try { const o = JSON.parse(t); return o && typeof o === "object" ? o : {}; } catch { return {}; } };

// deps.now: a clock returning a Date (tests).
export async function handleFactsLoad(req, env, deps = {}) {
  if (!factsLoadOn(env) || isPrPreviewEnv(env) || !(await factsLoadKeyFor(env))) return json({ error: "not found" }, 404);
  const raw = await readBounded(req, FACTS_MAX_BODY);
  if (raw === null) return fail(413, "too_large");
  const tsHeader = req.headers.get("X-Listen-Timestamp");
  if (!(await verifyListen(await factsLoadKeyFor(env), tsHeader, raw, req.headers.get("X-Listen-Signature"), Math.floor(Date.now() / 1000)))) return fail(401, "unauthorized");
  let parsedJson;
  try { parsedJson = JSON.parse(raw); } catch { return fail(400, "bad_json"); }
  const body = parseFactsBody(parsedJson);
  if (body.error) return fail(400, body.error);
  // Every row is checked before anything is recorded or written: one bad row refuses the whole batch and consumes neither the timestamp nor the rate budget.
  if (body.op === "rows") {
    const seen = new Set();
    for (const r of body.rows) {
      if (validateRow(r, undefined).error) return fail(400, "invalid_row");
      if (seen.has(r.id)) return fail(400, "invalid_row"); // a repeated id inside one batch
      seen.add(r.id);
    }
  }

  const nowFn = deps.now || (() => new Date());
  const nowMs = nowFn().getTime();
  const ts = Number(tsHeader);
  let replay = false;
  let limited = 0;
  try {
    await updateKvJson(env, FACTS_STATE_KEY, (cur) => {
      const lastTs = cur && Number.isFinite(cur.last_ts) ? cur.last_ts : 0;
      const hits = (cur && Array.isArray(cur.hits) ? cur.hits : []).filter((t) => Number.isFinite(t) && nowMs - t < HOUR_MS);
      if (ts <= lastTs) { replay = true; return { skip: true }; }
      if (hits.length >= FACTS_PER_HOUR) { limited = Math.max(1, Math.ceil(([...hits].sort((a, b) => a - b)[hits.length - FACTS_PER_HOUR] + HOUR_MS - nowMs) / 1000)); return { skip: true }; }
      return { doc: { last_ts: ts, hits: [...hits, nowMs] } };
    }, { now: () => new Date(nowMs).toISOString() });
  } catch {
    return fail(503, "unavailable"); // the state row could not be written: nothing runs (fail closed)
  }
  if (replay) return fail(409, "replay");
  if (limited > 0) return new Response(JSON.stringify({ ok: false, reason: "rate_limited", retry_after: limited }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(limited) } });

  const nowIso = new Date(nowMs).toISOString();
  try {
    if (body.op === "begin") return await opBegin(env, body, nowMs, nowIso);
    if (body.op === "rows") return await opRows(env, body.load_id, body.rows, nowIso);
    return await opFinish(env, body.load_id, nowIso);
  } catch {
    console.log(JSON.stringify({ evt: "facts_load", op: body.op, ok: false })); // no text, no id
    return fail(503, "unavailable");
  }
}

async function opBegin(env, b, nowMs, nowIso) {
  const cutoff = new Date(nowMs - FACTS_OPEN_MIN_AGE_MS).toISOString();
  // An open load of the same kind that has been silent for 30 minutes is a dead run: mark it failed. (Its rows never counted and stay inert.)
  await env.DB.prepare("UPDATE game_fact_loads SET status = 'failed', finished_at = ? WHERE kind = ? AND status = 'open' AND started_at <= ?").bind(nowIso, b.kind, cutoff).run();
  const id = crypto.randomUUID();
  const res = await env.DB.prepare(
    "INSERT INTO game_fact_loads (id, build, manifest_sha256, files_json, kind, status, counts_json, started_at) SELECT ?, ?, ?, ?, ?, 'open', ?, ? WHERE NOT EXISTS (SELECT 1 FROM game_fact_loads WHERE kind = ? AND status = 'open') RETURNING id",
  ).bind(id, b.build, b.manifest_sha256, JSON.stringify(b.files), b.kind, JSON.stringify({ expected: b.expected, added: 0, changed: 0 }), nowIso, b.kind).all();
  if (!res.results || res.results.length !== 1) return fail(409, "conflict");
  console.log(JSON.stringify({ evt: "facts_load", op: "begin", kind: b.kind, ok: true }));
  return json({ ok: true, load_id: id, accepted: 0 });
}

const readLoad = (env, id) => env.DB.prepare("SELECT id, build, kind, status, counts_json FROM game_fact_loads WHERE id = ?").bind(id).first();

async function opRows(env, loadId, rawRows, nowIso) {
  const load = await readLoad(env, loadId);
  if (!load) return fail(404, "no_load");
  if (load.status !== "open") return fail(409, "load_closed");
  const rows = [];
  for (const r of rawRows) {
    const v = validateRow(r, load.kind);
    if (v.error) return fail(400, "invalid_row");
    if (load.kind === "client" && v.row.build !== load.build) return fail(400, "invalid_row"); // a client load carries one build
    rows.push(v.row);
  }
  // What each id was before this batch, to count added / changed. An id already owned by THIS load is a repeat of a batch (a resume) and is not counted again.
  const prior = new Map();
  for (let i = 0; i < rows.length; i += 80) { // D1 allows 100 bound values per statement
    const part = rows.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT id, load_id, value, claim, verdict, subject FROM game_facts WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part.map((r) => r.id)).all();
    for (const p of results || []) prior.set(p.id, p);
  }
  let added = 0, changed = 0;
  for (const r of rows) {
    const p = prior.get(r.id);
    if (!p) added++;
    else if (p.load_id !== loadId && (p.value !== r.value || p.claim !== r.claim || p.verdict !== r.verdict || p.subject !== r.subject)) changed++;
  }
  const counts = parseCounts(load.counts_json);
  counts.added = num(counts.added) + added;
  counts.changed = num(counts.changed) + changed;
  const stmts = rows.map((r) => env.DB.prepare(UPSERT).bind(r.id, r.kind, r.subject, r.subject_norm, r.claim, r.value, r.unit, r.source_table, r.row_id, r.build, loadId, r.verdict, r.source_class, r.note, nowIso));
  stmts.push(env.DB.prepare("UPDATE game_fact_loads SET counts_json = ? WHERE id = ? AND status = 'open'").bind(JSON.stringify(counts), loadId));
  await env.DB.batch(stmts); // one transaction: the whole batch or none of it
  const own = await env.DB.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE load_id = ?").bind(loadId).first();
  return json({ ok: true, load_id: loadId, accepted: rows.length, total: num(own && own.c) });
}

async function opFinish(env, loadId, nowIso) {
  const load = await readLoad(env, loadId);
  if (!load) return fail(404, "no_load");
  if (load.status !== "open") return fail(409, "load_closed");
  const counts = parseCounts(load.counts_json);
  const own = await env.DB.prepare("SELECT COUNT(*) AS c FROM game_facts WHERE load_id = ?").bind(loadId).first();
  const total = num(own && own.c);
  if (total !== counts.expected) return fail(409, "incomplete", { accepted: total }); // a half load must never supersede the other half; the load stays open for a resume
  const scope = load.kind === "curated" ? "kind = 'curated'" : "kind <> 'curated'";
  const rm = await env.DB.prepare(`SELECT COUNT(*) AS c FROM game_facts WHERE ${scope} AND load_id <> ? AND superseded = 0`).bind(loadId).first();
  const removed = num(rm && rm.c);
  const prev = await env.DB.prepare("SELECT id, build FROM game_fact_loads WHERE kind = ? AND status = 'done' ORDER BY finished_at DESC, started_at DESC LIMIT 1").bind(load.kind).first();
  const final = { expected: counts.expected, total, added: num(counts.added), changed: num(counts.changed), unchanged: Math.max(0, total - num(counts.added) - num(counts.changed)), removed, prev_load_id: prev ? prev.id : null, prev_build: prev ? prev.build : null };
  await env.DB.batch([
    env.DB.prepare(`UPDATE game_facts SET superseded = 1, updated_at = ? WHERE ${scope} AND load_id <> ? AND superseded = 0`).bind(nowIso, loadId),
    env.DB.prepare("UPDATE game_fact_loads SET status = 'done', finished_at = ?, counts_json = ? WHERE id = ? AND status = 'open'").bind(nowIso, JSON.stringify(final), loadId),
  ]);
  console.log(JSON.stringify({ evt: "facts_load", op: "finish", kind: load.kind, ok: true, total, removed }));
  return json({ ok: true, load_id: loadId, accepted: total, counts: { total: final.total, added: final.added, changed: final.changed, unchanged: final.unchanged, removed: final.removed } });
}
