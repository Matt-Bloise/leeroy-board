// =============================================================================
// Cloudflare Worker Entry Point (`leeroy-brain`)
// Full parity with the PC bot (`leeroy-ops` repo, `bot-legacy/`):
//   - Edge-cached D1 state (`kv_state`), library blobs (`lib_blobs`), & source snapshots
//   - Event-sourced Party Character Sheets (`GET/POST /api/sheet`, `PUT /api/vocab`)
//   - Chamber Letter Dispatches (`POST /api/dispatch`)
//   - Flat & nested Intents (`signup`, `journey`, `launch`, `ask`, `fix`, `refresh`)
//   - Multi-Provider AI Q&A (`ai-models.js`) & Discord HTTP Interactions (`discord.js`)
// =============================================================================

import { BoardRoom, LIVE_AUTH_HEADER } from "./room.js";
import {
  answerWithAi,
  callAnthropicClaude,
  resolveAiProvider,
  isProviderConfigured,
  isPrPreviewEnv,
  invalidatePagesCache,
  AI_PROVIDER_LABELS,
  webBoardLinks,
  webBoardLinksDeep,
} from "./ai-models.js";
import { runScheduledSourceSweep, recomputeCategoryAndIndex, acquireRefreshCooldown } from "./scraper.js";
import { feedbackReport, cleanupAnswerUx, insertAskTurn, newGuestSecret, privateTurnAccess, RELOAD_ANSWER_LINE } from "./answer-ux.js";
import { clampContent, ALLOWED_MENTIONS_NONE } from "./discord-safety.js";
import { handleDiscordInteraction, recomputeSignupTallies, DISCORD_SLASH_COMMANDS_MANIFEST } from "./discord.js";
import { manifestFor } from "./setup-command.js";
import { buildAnnounceBody, lookupRosterId } from "./announce.js";
import { handleAccount } from "./account.js";
import { handleWebAuth, webSessionFrom } from "./web-auth.js";
import { handleDataRights } from "./data-rights.js";
import { charsOn, handleCharacters, listFor } from "./characters-api.js";
import { handleExport } from "./export.js";
import { gauge, handleGauge } from "./gauge.js";
import { authenticate } from "./auth.js";
import { invalidatePersonaCache } from "./persona.js";
import { evalEnabled, validateEvalRequest, runEval } from "./eval.js";
import { loadBudget, dailyCap, utcDayKey, hashId } from "./budget.js";
import { askWallPlan } from "./research/no-wall.js";
import { groupWikiCronOn, maybeRefreshGroupWiki } from "./research/group-wiki.js";
import { upsertMember } from "./members.js";
import { updateKvJson, commitSheetWrite, KvConflictError } from "./kv-cas.js";
import { readJsonCapped, questionTooLong, pickSignupPatch, upsertSignupEntry, MAX_QUESTION_CHARS } from "./limits.js";
import { approveProposal, rejectProposal, describeProposal } from "./wiki-proposals.js";
import { defaultDocRow } from "./default-docs.js";
import { libraryGlossaryBody, LIBRARY_GLOSSARY_BLOB, LIBRARY_GLOSSARY_CACHE_PATH } from "./party-glossary.js";
import { isPublicAtlasDoc, isPublicDataDoc, publicDataDoc, dataCachePath } from "./public-docs.js";
import { feedOn, serveFeedDoc } from "./feed.js";
import { CONFIG_KEYS, CONFIG_MAX_BYTES, invalidateConfigCache, isDeniedKvKey, isPrivateKvKey, loadConfigKey, validateConfigValue } from "./config.js";
import { timingSafeEqualStr, sha256Hex } from "./crypto.js";
import { extractKey } from "./request-key.js";
import { guestIpKey } from "./guest-key.js";
import { applyManualAnswer } from "./ask-answer.js";
import { publicParty, partyForMember, sheetIntentBody, redactIntentBody } from "./sheet-privacy.js";
import { sheetValueProblem, ADMIN_SHEET_FIELDS, nextLevelField } from "./sheet-values.js";
import { VOCAB_LIST } from "./sheet-vocab.js";
import { saltProblems, saltErrorBody, SaltMissingError } from "./salts.js";
import { loadPublicVotes } from "./votes.js";
import { cardsEnabled, cardsShadow, postCard, requestCardEdit, CARD_NAMES } from "./cards.js";
import { flushBoardLines } from "./board-lines.js";
import { eventsEnabled, runSync } from "./scheduled-events.js";
import { collectInterest } from "./interest.js";
import { withSecurityHeaders } from "./security-headers.js";
import { runMoments, momentsStatus, momentsEnabled, momentsDryRun, momentsShadow, d1Store, MOMENTS_CRON, MOMENTS_SHADOW_STATE_KEY, MOMENTS_LEDGER_KEY } from "./moments.js";
import { originVerdict, corsHeaders as buildCorsHeaders } from "./cors.js";
import { projectDataDoc, projectBroadcast, loadPublicInputs, writeSheetValueToDoc, SHEET_FIELD_NAMES, MEMBER_DOCS as MEMBER_DOC_KEYS } from "./public-party.js";
import { PARTY_MEMBERS, loadPartyMembers, normName, reconcileSheetsWithDoc, sheetForDocMember, sheetForWrite } from "./party-source.js";

export { BoardRoom };

export const SHEET_FIELDS = ["race", "class", "spec_path", "spec_at_40", "professions", "level", "launch_state", "plan_zone", "goals"];

async function resolveMemberAuth(req, url, env) {
  // 1. Try cryptographic salted hash lookup in `members` table
  const authWho = await authenticate(req, env);
  if (authWho && authWho.slug) {
    const found = PARTY_MEMBERS.find((m) => m.slug === authWho.slug);
    if (found) return { ok: true, member: found };
    // Not one of the built-in five: the party document in D1 may know them (read only on this miss, so the five cost no extra query).
    const fromDoc = (await loadPartyMembers(env)).find((m) => m.slug === authWho.slug);
    if (fromDoc) return { ok: true, member: fromDoc };
    return { ok: true, member: { slug: authWho.slug, name: authWho.name || authWho.slug } };
  }

  // 2. Verified BOARD_ADMIN_TOKEN via constant-time comparison
  const k = extractKey(req);
  if (env.BOARD_ADMIN_TOKEN && k && timingSafeEqualStr(k, env.BOARD_ADMIN_TOKEN)) {
    return { ok: true, member: PARTY_MEMBERS[3] }; // Default admin to Bloise
  }

  return { ok: false, member: null };
}

// Admin-token-only gate (same pattern as PUT /persona): 503 if unset, 401 if missing or wrong. Returns a Response to send, or null to continue.
function adminGate(req, url, env, cors) {
  if (!env.BOARD_ADMIN_TOKEN) {
    return jsonResp({ error: "Admin token not configured" }, 503, cors);
  }
  const adminKey = extractKey(req);
  if (!adminKey || !timingSafeEqualStr(adminKey, env.BOARD_ADMIN_TOKEN)) {
    return jsonResp({ error: "Unauthorized" }, 401, cors);
  }
  return null;
}

function corsHeaders(req, env) {
  const verdict = originVerdict(req, env);
  if (verdict.ok && verdict.origin) {
    return buildCorsHeaders(verdict.origin);
  }
  return {};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResp(body, status = 200, extraHeaders = {}) {
  const txt = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(txt, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

// In-memory isolate L1 cache for sub-millisecond edge responses on *.workers.dev and custom domains
const ISOLATE_CACHE = new Map();
const ISOLATE_CACHE_MAX = 150;
const ISOLATE_CACHE_TTL_MS = 60 * 1000; // 60 seconds default TTL

function getIsolateCache(path) {
  const hit = ISOLATE_CACHE.get(path);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    ISOLATE_CACHE.delete(path);
    return null;
  }
  return new Response(hit.body, {
    status: hit.status,
    headers: { ...hit.headers, "X-Isolate-Cache": "HIT" },
  });
}

function putIsolateCache(path, resp, ttlMs = ISOLATE_CACHE_TTL_MS) {
  if (ISOLATE_CACHE.size >= ISOLATE_CACHE_MAX) {
    const firstKey = ISOLATE_CACHE.keys().next().value;
    if (firstKey) ISOLATE_CACHE.delete(firstKey);
  }
  const cloned = resp.clone();
  cloned.text().then((body) => {
    const headers = {};
    for (const [k, v] of cloned.headers.entries()) {
      headers[k] = v;
    }
    ISOLATE_CACHE.set(path, {
      body,
      status: cloned.status,
      headers,
      expiresAt: Date.now() + ttlMs,
    });
  }).catch(() => {});
}

function clearIsolateCache(paths = []) {
  if (!paths || paths.length === 0) {
    ISOLATE_CACHE.clear();
    return;
  }
  for (const path of paths) {
    for (const key of ISOLATE_CACHE.keys()) {
      if (key.includes(path)) {
        ISOLATE_CACHE.delete(key);
      }
    }
  }
}

// A response read back from caches.default comes with the zone's Browser Cache TTL in place of its own max-age (seen 2026-11-14: max-age=15 became
// max-age=14400, 4 hours, on every CF-Cache-Status: HIT). The route's own Cache-Control travels with the stored copy in KEPT_CACHE_CONTROL and is put
// back on the way out, so what the Worker means is what the browser gets, whatever the zone setting.
export const KEPT_CACHE_CONTROL = "x-board-cache-control";
export function restoreCacheControl(resp) {
  if (!resp) return resp;
  const kept = resp.headers.get(KEPT_CACHE_CONTROL);
  if (kept === null) return resp;
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", kept);
  headers.delete(KEPT_CACHE_CONTROL);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

// Member documents, /state and /bootstrap (PARTY_CACHE_PATHS) are never held in the isolate memory or in caches.default, and are sent no-store. A purge clears only the isolate and the data
// centre that handled the write, so a copy held anywhere else kept serving a value the member had just hidden for up to the TTL (seen on the real preview, 2026-11-15: plain GET /data/party.json
// returned the hidden values 3 s after the hide). Every read of these paths is a fresh projection of the stored rows (about 3 to 5 D1 reads), so a hide is in force on the next request, everywhere.
const memberPath = (path) => PARTY_CACHE_PATHS.includes(path);
export const MEMBER_NO_STORE = "no-store";

async function getCachedResponse(origin, path) {
  if (memberPath(path)) return null;
  const local = getIsolateCache(path);
  if (local) return local;
  try {
    const cacheKey = new Request(`${origin}${path}`, { method: "GET" });
    return restoreCacheControl(await caches.default.match(cacheKey));
  } catch {
    return null;
  }
}

function setCachedResponse(ctx, origin, path, resp, ttlMs = ISOLATE_CACHE_TTL_MS) {
  if (memberPath(path)) return;
  putIsolateCache(path, resp, ttlMs);
  try {
    const cacheKey = new Request(`${origin}${path}`, { method: "GET" });
    const copy = resp.clone();
    const own = copy.headers.get("Cache-Control");
    const stored = own === null ? copy : new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers: (() => { const h = new Headers(copy.headers); h.set(KEPT_CACHE_CONTROL, own); return h; })() });
    ctx.waitUntil(caches.default.put(cacheKey, stored));
  } catch {}
}

// Cached library paths that are not a category blob: the glossary has its own cache key. Spread into every library purge list.
export const LIBRARY_PURGE_PATHS = Object.freeze(["/api/library/glossary.json", LIBRARY_GLOSSARY_CACHE_PATH]);

export async function purgeWorkerCache(origin, paths = []) {
  // /api/state and /api/bootstrap carry every document, so any purge clears their isolate copies too (not only the edge cache below)
  clearIsolateCache([...new Set([...paths, "/api/state", "/api/bootstrap"])]);
  invalidatePagesCache();
  try {
    const cache = caches.default;
    const allPaths = new Set(paths);
    allPaths.add("/api/state");
    allPaths.add("/api/bootstrap");
    await Promise.all(
      [...allPaths].map((p) => cache.delete(new Request(`${origin}${p}`, { method: "GET" })).catch(() => false))
    );
  } catch {}
}

// Every cached URL the party document is served from, purged after any party write (sheet edit, Discord /build). js/board.js apiFetch
// requests /api/data/party (no ".json"); the public API also answers /api/data/party.json; /api/state and /api/bootstrap embed the party.
// GET /data/* caches under the path as requested, so the two spellings are two cache entries (review catalogue F-12).
// A hide changes every document that carries member data (public-party.js MEMBER_DOCS), so every one of them is purged, both spellings. The cache itself is keyed by the
// decoded document name (docCachePath in the /data route), so /data/part%79 and //party are the same entry as /data/party.
export const PARTY_CACHE_PATHS = Object.freeze(["/api/bootstrap", "/api/state", ...MEMBER_DOC_KEYS.flatMap((n) => [dataCachePath(n), `${dataCachePath(n)}.json`])]);

// Every message to the room passes here, so this is where a message that carries member data is projected for anonymous readers (public-party.js):
// the sheet list, and the party, decide and tonight documents. A message that carries none costs nothing extra.
export async function broadcastToRoom(env, payload) {
  try {
    const id = env.BOARD_ROOM.idFromName("global");
    const stub = env.BOARD_ROOM.get(id);
    let out = payload;
    if (payload && payload.type === "data" && MEMBER_DOC_KEYS.includes(payload.key) && payload.data !== undefined) out = projectBroadcast(payload, await loadPublicInputs(env));
    else if (payload && payload.type === "state" && "party" in payload) out = projectBroadcast(payload);
    const res = await stub.fetch("https://room.internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webBoardLinksDeep(out)),
    });
    if (res && res.ok === false) console.error("BoardRoom refused a broadcast:", res.status); // e.g. 413 payload_too_large
  } catch (err) {
    console.error("Failed to broadcast to BoardRoom:", err);
  }
}

// The sheet list as GET /state and the public reads see it. Two things here exist for privacy (public-party.js reads this list to decide what is hidden):
//  - a party-document member with NO stored sheet row (a junk row, a rename by an admin PUT, a person added after the row was written) gets a reconciled
//    sheet that says "everything visible". That is only true if they never hid anything, so the sheet_events log is replayed for them, and a stored sheet that
//    belongs to nobody in the document (the old name of a rename) hides its hidden fields on every such row (the link is unknowable: fail closed).
//  - strict: a failed read throws instead of falling back to a visible-everything list, so the caller (loadPublicInputs) can fail closed.
// A write could not read the log of who hid what (a failed sheet_events read) and must not guess: nothing was stored, the caller answers 503. A write that guessed "all hidden" would persist a
// member with no stored sheet as all-hidden, which blanks every composite for everyone (a read may fall back to that; a write may not).
export class SheetLogUnreadableError extends Error {
  constructor(cause) { super("The sheet log could not be read"); this.name = "SheetLogUnreadableError"; this.cause = cause; }
}

// The log of hide/show events, read once per isolate and database while nothing changed. Every uncached read that has a party-document member without a stored sheet needs it, and an
// unmemoised read scans the whole table each time. The key is MAX(id) plus COUNT(*) (one cheap statement), read BEFORE the log so a later event can only make the key older than the content, never newer:
// the next read then rescans. An erasure that deletes a row other than the newest leaves MAX(id) alone but lowers COUNT(*), so it changes the key too, in every isolate (a memo that kept a deleted
// row would say "shown" for a name another slug had hidden, while a fresh read says "hidden"). `last` memoises the result per row (slug + name): the last visibility of each field.
const EVENT_LOGS = new WeakMap();
async function sheetEventLog(env) {
  const m = await env.DB.prepare("SELECT MAX(id) AS m, COUNT(*) AS c FROM sheet_events").first();
  const max = `${m && m.m !== undefined && m.m !== null ? m.m : ""}:${m && m.c !== undefined && m.c !== null ? m.c : ""}`;
  const hit = EVENT_LOGS.get(env.DB);
  if (hit && hit.max === max) return hit;
  const events = (await env.DB.prepare("SELECT slug, name, field, visible FROM sheet_events ORDER BY id ASC").all()).results || [];
  const log = { max, events, last: new Map() };
  EVENT_LOGS.set(env.DB, log);
  return log;
}
// For tests: forget what this isolate memoised.
export function forgetSheetEventLogs(db) { if (db) EVENT_LOGS.delete(db); }

async function hideFromEvents(env, rows, known, partyDoc, strict, memo = null) {
  const added = rows.filter((r) => !known.has(r));
  if (!added.length) return rows;
  const ALLNAMES = SHEET_FIELD_NAMES;
  const hideAll = (r) => ({ ...r, fields: { ...Object.fromEntries(ALLNAMES.map((k) => [k, { value: null, visible: false, source: "board" }])), ...Object.fromEntries(Object.entries(r.fields || {}).map(([k, v]) => [k, { ...v, visible: false }])) } });
  let log;
  try {
    // memo: a sheet write retries its compute on a lost race, and the log is read once per write (the subrequest budget). It is scoped to ONE write (a hide recorded by an earlier write must be seen
    // by the next one: tests/unit/sheet-events-memo.test.mjs). A hide recorded in between lands in the stored sheets the retry reads, not here.
    log = (memo && memo.log) || (await sheetEventLog(env));
    if (memo) memo.log = log;
  } catch (err) {
    if (strict) throw err;
    return rows.map((r) => (known.has(r) ? r : hideAll(r)));
  }
  const docMembers = partyDoc && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  const docNames = new Set(docMembers.map((m) => String(m && m.name || "").toLowerCase()));
  const docNorm = new Set(docMembers.map((m) => normName(m && m.name)));
  const orphanHidden = new Set(); // fields hidden on a stored sheet that no document member claims
  for (const r of rows) {
    if (!known.has(r) || !r.fields || typeof r.fields !== "object") continue;
    if (docNames.has(String(r.name || "").toLowerCase()) || docNorm.has(normName(r.name))) continue;
    for (const [k, v] of Object.entries(r.fields)) if (v && v.visible === false) orphanHidden.add(k);
  }
  return rows.map((r) => {
    if (known.has(r)) return r;
    const memoKey = `${r.slug} ${normName(r.name)}`;
    let seen = log.last.get(memoKey);
    if (!seen) {
      seen = new Map();
      for (const e of log.events) if (e.slug === r.slug || (e.name && normName(e.name) === normName(r.name))) seen.set(e.field, Boolean(e.visible));
      if (log.last.size >= 500) log.last.clear();
      log.last.set(memoKey, seen);
    }
    const last = new Map(seen);
    for (const k of orphanHidden) last.set(k, false);
    let out = r;
    for (const [field, visible] of last) {
      if (visible) continue;
      if (out === r) out = { ...r, fields: { ...(r.fields || {}) } };
      out.fields[field] = { ...(out.fields[field] || { value: null, source: "board" }), visible: false };
    }
    return out;
  });
}

export async function buildPartySheetsFromD1(env, { persist = true, partyDoc, strict = false } = {}) {
  const now = new Date().toISOString();

  // 1. Fast path: Read pre-materialized party sheets from kv_state (single point lookup)
  let cachedRow = null;
  try { cachedRow = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").first(); } catch (err) { if (strict) throw err; }
  let parsed = null;
  if (cachedRow && cachedRow.json) { try { parsed = JSON.parse(cachedRow.json); } catch { parsed = null; } }
  if (Array.isArray(parsed) && parsed.length > 0) {
    // A person added to the party document after this row was stored has no sheet here: add theirs (reads one more row; nothing is written).
    // A caller that already read the party row passes it as partyDoc (null means "read, none"); otherwise it is read here.
    let reconciled = parsed, doc = partyDoc;
    try {
      if (doc === undefined) {
        const partyRow = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first();
        doc = partyRow && partyRow.json ? JSON.parse(partyRow.json) : null;
      }
      if (doc) reconciled = reconcileSheetsWithDoc(parsed, doc);
    } catch (err) { if (strict) throw err; }
    if (reconciled !== parsed) reconciled = await hideFromEvents(env, reconciled, new Set(parsed), doc, strict);
    return { party: reconciled, seq: Date.now() };
  }

  // 2. Slow path / bootstrap fallback: Reconstruct from base + sheet_events
  const bySlug = new Map();

  for (const m of await loadPartyMembers(env)) {
    const fields = {};
    for (const f of SHEET_FIELDS) {
      if (m[f] !== undefined) {
        fields[f] = { value: m[f], visible: true, source: "board", at: "2026-10-30T00:00:00.000Z" };
      }
    }
    bySlug.set(m.slug, { slug: m.slug, name: m.name, fields, updated: "2026-10-30T00:00:00.000Z" });
  }

  try {
    const { results } = await env.DB.prepare(
      "SELECT slug, name, field, value_json, visible, source, created_at FROM sheet_events ORDER BY id ASC"
    ).all();
    for (const r of results || []) {
      let row = bySlug.get(r.slug);
      if (!row) {
        row = { slug: r.slug, name: r.name || r.slug, fields: {}, updated: r.created_at || now };
        bySlug.set(r.slug, row);
      }
      let val = null;
      try {
        val = r.value_json !== null && r.value_json !== undefined ? JSON.parse(r.value_json) : null;
      } catch {
        val = r.value_json;
      }
      // A level event carries the resolved field, so the same rule the live commit used (a same-value event keeps its at and source; an
      // older new value cannot win) gives the same end state. Other fields replay as before: last event by id wins.
      row.fields[r.field] = r.field === "level"
        ? nextLevelField(row.fields[r.field], { value: val, visible: Boolean(r.visible), source: r.source || "board", at: r.created_at || now }).field
        : { value: val, visible: Boolean(r.visible), source: r.source || "board", at: r.created_at || now };
      if (row.fields[r.field] === null) delete row.fields[r.field];
      row.updated = r.created_at || now;
    }
  } catch (err) {
    // The log of who hid what could not be read: the seeds below say "everything visible", which would be a lie. Strict callers get the error; the others get every field hidden, and nothing is persisted.
    if (strict) throw err;
    persist = false;
    for (const r of bySlug.values()) r.fields = { ...Object.fromEntries(SHEET_FIELD_NAMES.map((k) => [k, { value: null, visible: false, source: "board" }])), ...Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, { ...v, visible: false }])) };
  }

  const party = [...bySlug.values()];
  if (!persist) return { party, seq: Date.now() };
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, ?)"
    )
      .bind(JSON.stringify(party), now)
      .run();
  } catch {}

  return { party, seq: Date.now() };
}

// Visibility: `visible` counts only when visibleGiven is true and it is a boolean (the owner's explicit choice). Otherwise the field keeps the
// visibility it has now, read inside the atomic commit below on every attempt, so a value-only write can never un-hide a hidden field, not even
// one hidden between this request's read and its write. A field with no earlier visibility starts visible, as before.
// valueGiven false (a visibility-only write, any field): the stored value stays.
// keepHidden (the admin path): a field its owner has hidden stays hidden. The check runs inside the commit, against the sheet state that is
// written, so a hide that lands between the admin's request and the write is never undone.
// levelRules (level, sheet-values.js nextLevelField): a visibility-only write (valueGiven false) keeps the value; a write of the same value
// keeps its at and source; an older write of a new value is stale and changes nothing (a hide still hides). A write that changes nothing
// records no event and broadcasts nothing; the reply carries stale and the stored field. The level event row carries the resolved field
// (value and visible), so the slow-path replay below ends where this commit ended.
export async function recordSheetEventInD1(env, origin, { slug, name, field, value, valueGiven = true, visible, visibleGiven = false, source = "board", at, keepHidden = false, levelRules = false }) {
  const now = at || new Date().toISOString();
  const valJson = value === undefined || value === null ? null : JSON.stringify(value);
  // event.visible and event.valJson are set in compute() from the fresh read on every attempt, before the event row is bound.
  const event = { slug, name: name || slug, field, valJson, visible: true, source: source || "board", at: now };
  let stale = false, changed = true, stored = null;
  const eventsMemo = {};

  // One atomic commit (kv-cas.js): the event, the materialised sheets and the public party projection succeed or fail together. A lost race
  // recomputes everything from the fresh documents; running out of retries throws KvConflictError and nothing was written.
  const saved = await commitSheetWrite(env, {
    event,
    compute: async (cur, partyDoc) => {
      // Reconcile first: a person who is in the party document but has no stored sheet gets theirs (race, class, zone) before this write adds its
      // field, so the write cannot turn a synthesized member into a one-field sheet that reconcile would then skip.
      // The rows reconcile adds (a person added or renamed through the document) are all-visible by construction. That is only true if they never hid anything, so they get the same
      // events / orphaned-sheet rule the read path applies (hideFromEvents) BEFORE anything is persisted: otherwise this write would store an all-visible sheet for a renamed member who had hidden fields.
      // strict: a read of the sheet log that fails stops the write (SheetLogUnreadableError, 503, nothing stored). The lenient fallback "all hidden" is for reads; a write would persist it.
      const unreadable = async (read) => { try { return await read(); } catch (err) { throw new SheetLogUnreadableError(err); } };
      const base = Array.isArray(cur) && cur.length > 0 ? cur : (await unreadable(() => buildPartySheetsFromD1(env, { persist: false, partyDoc, strict: true }))).party;
      const reconciled = reconcileSheetsWithDoc(base, partyDoc);
      const currentParty = reconciled === base ? reconciled : await unreadable(() => hideFromEvents(env, reconciled, new Set(base), partyDoc, true, eventsMemo));
      // Same identity as the reconcile above: a write that arrives under a renamed document member's new slug lands on the person's existing
      // sheet (which takes the new slug and name) instead of starting a second one-field sheet. Events keyed by the old slug stay as history.
      let memberSheet = sheetForWrite(currentParty, partyDoc, slug, name);
      if (memberSheet) {
        if (memberSheet.slug !== slug) {
          memberSheet.slug = slug;
          if (name) memberSheet.name = name;
        }
      } else {
        memberSheet = { slug, name: name || slug, fields: {}, updated: now };
        currentParty.push(memberSheet);
      }
      memberSheet.fields = memberSheet.fields || {};
      const prior = memberSheet.fields[field];
      // The document is stored whole: a written value is copied into it whether or not it is hidden; every read projects (public-party.js).
      // sheet-privacy.js treats exactly visible === false as hidden, so that is what is kept hidden. Read from `prior` of THIS attempt.
      const priorHidden = !!(prior && typeof prior === "object" && prior.visible === false);
      const explicit = visibleGiven && typeof visible === "boolean";
      const project = () => ({ sheets: currentParty, party: partyDoc ? writeSheetValueToDoc(partyDoc, currentParty, memberSheet, field, value, prior) : undefined });
      if (levelRules) { // recomputed on every retry, against the state this attempt writes
        const next = nextLevelField(prior, { value, valueGiven, visible, visibleGiven: explicit, source: source || "board", at: now }, { keepHidden });
        stale = next.stale; changed = next.changed; stored = next.field;
        event.valJson = !stored || stored.value === undefined || stored.value === null ? null : JSON.stringify(stored.value);
        event.visible = !stored || stored.visible !== false;
        if (!changed) return { ...project(), skipEvent: true };
        if (stored) memberSheet.fields[field] = stored;
        else delete memberSheet.fields[field]; // no value and not hidden: no level line at all
        memberSheet.updated = now;
        return project();
      }
      event.visible = keepHidden && priorHidden ? false : explicit ? visible : !priorHidden;
      const nextValue = valueGiven ? value : prior && typeof prior === "object" && prior.value !== undefined ? prior.value : null;
      event.valJson = nextValue === undefined || nextValue === null ? null : JSON.stringify(nextValue); // the event row carries the resolved value too
      memberSheet.fields[field] = stored = { value: nextValue, visible: event.visible, source: source || "board", at: now };
      memberSheet.updated = now;
      return project();
    },
  });
  const currentParty = saved.sheets;

  if (changed) {
    await purgeWorkerCache(origin, PARTY_CACHE_PATHS);
    await broadcastToRoom(env, { type: "state", party: currentParty }); // projected for anonymous sockets inside broadcastToRoom
  }
  return { party: currentParty, at: now, visible: stored ? stored.visible !== false : event.visible, stale, changed, stored };
}

export async function insertIntent(env, { slug, kind, body, ver = 1, at }) {
  const now = at || new Date().toISOString();
  const bodyJson = typeof body === "string" ? body : JSON.stringify(body || {});
  const res = await env.DB.prepare(
    "INSERT INTO intents (at, slug, kind, body, ver) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(now, slug || "unknown", kind || "unknown", bodyJson, ver)
    .run();
  const seq = res.meta && res.meta.last_row_id ? res.meta.last_row_id : Date.now();
  return { seq, at: now };
}

// Every route this Worker answers, as "METHOD pattern" (":name" is one path segment, a trailing "*" is a prefix, ANY is every
// method). A description only: dispatch below does not read it. tests/unit/authz.test.mjs checks it against the handlers in
// this file and account.js and against a hand-written table of who may call each route, so a new route must be added here.
// FNV-1a of a string, base 36: a short tag for a projected body (ETag marker). Not a secret and not a security boundary.
export function projectionTag(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }

export const ROUTES = [
  "POST /discord", "GET /discord/commands", "GET /votes", "GET /me", "POST /probe", "ANY /sheet",
  "POST /announce", "PUT /vocab", "PUT /config/:key", "POST /admin/members", "POST /admin/sheet", "POST /admin/cards/post", "GET /admin/feedback", "GET /admin/export", "GET /admin/requests", "PUT /persona", "POST /dispatch", "POST /admin/events/sync", "GET /admin/moments", "POST /admin/eval",
  "GET /intents", "POST /ack", "POST /answer", "GET /signups", "POST /signups", "ANY /live", "GET /state",
  "POST /token", "POST /auth/discord", "GET /auth/discord/start", "GET /auth/discord/callback", "POST /auth/logout", "ANY /me", "GET /me/export", "POST /me/erase", "POST /me/characters", "ANY /state/:doc", "GET /ask", "GET /wiki/snapshots",
  "GET /wiki/proposals", "GET /wiki/proposals/:id", "POST /wiki/proposals/:id/approve", "POST /wiki/proposals/:id/reject", "PUT /wiki/page", "GET /bootstrap", "GET /library/*", "GET /data/*", "PUT /data/*",
  "GET /atlas/*", "PUT /atlas/*", "POST /intent", "POST /refresh", "GET /", "GET /health",
];

const worker = {
  async fetch(req, env, ctx) {
    try { gauge.hit(env, ctx); } catch (e) { /* the gauge can never fail a request */ } // REQUEST_GAUGE (default off): one in-memory add, a batched D1 write every 25 requests; see worker/gauge.js
    const url = new URL(req.url);
    const verdict = originVerdict(req, env);
    if (!verdict.ok) {
      return new Response("Forbidden Origin", { status: 403 });
    }
    const cors = buildCorsHeaders(verdict.origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Normalize optional /api prefix so both direct Worker calls and proxied /api/* calls match
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";

    try {
      // 0. Discord Serverless HTTP Interactions Endpoint (`POST /api/discord`) & Command Manifest (`GET /api/discord/commands`)
      if (req.method === "POST" && path === "/discord") {
        return await handleDiscordInteraction(req, env, ctx, url.origin);
      }
      if (req.method === "GET" && path === "/discord/commands") {
        return jsonResp({ commands: manifestFor(env, DISCORD_SLASH_COMMANDS_MANIFEST) }, 200, cors);
      }

      // 0a. GET /votes -> public, read-only: id, title, choice counts, closes_at, open. Never voter ids or hashes.
      if (req.method === "GET" && path === "/votes") {
        // loadPublicVotes is the index row plus up to 50 vote rows (51 D1 reads): cached for 10 seconds, shared by every caller.
        let resp = await getCachedResponse(url.origin, "/api/votes");
        if (!resp) {
          const votes = await loadPublicVotes(env.DB, Date.now());
          resp = jsonResp({ votes }, 200, { ...cors, "Cache-Control": "public, max-age=10, s-maxage=10" });
          setCachedResponse(ctx, url.origin, "/api/votes", resp, 10000);
        } else {
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          resp = new Response(resp.body, { status: resp.status, headers });
        }
        return resp;
      }

      // 0b. GET /me -> Resolves board key to party member identity for `js/brain.js`
      if (req.method === "GET" && path === "/me") {
        const auth = await resolveMemberAuth(req, url, env);
        if (!auth.ok) {
          // Q18: a web session cookie is accepted too, only when WEB_LOGIN is on. The legacy board key path is unchanged.
          const ws = await webSessionFrom(req, env, Date.now());
          if (ws) {
            const credCors = cors["Access-Control-Allow-Origin"] ? { ...cors, "Access-Control-Allow-Credentials": "true" } : cors;
            const me = { name: ws.name, discord_user_id: ws.discord_user_id, expires_at: ws.expires_at, via: "web-session", pending: [] };
            if (charsOn(env)) Object.assign(me, await listFor(env, ws.discord_user_id)); // CHARS_V1: { characters, selected }
            return jsonResp(me, 200, { ...credCors, "Cache-Control": "no-store" });
          }
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = auth.member;
        return jsonResp({ slug: m.slug, name: m.name, pending: [] }, 200, cors);
      }

      // Admin only: NDJSON backup, one table page per request (see export.js for the exact exclusions).
      if (req.method === "GET" && path === "/admin/export") {
        const res = await handleExport(req, env, url);
        for (const [k, v] of Object.entries(cors)) if (!res.headers.has(k)) res.headers.set(k, v);
        return res;
      }

      // Admin only: Worker requests counted today (approximation; the Cloudflare dashboard is the source of truth). 404 while REQUEST_GAUGE is off.
      if (req.method === "GET" && path === "/admin/requests") return await handleGauge(req, env, cors);

      // 0c. POST /probe -> Capability probe from `js/brain.js`
      if (req.method === "POST" && path === "/probe") {
        return jsonResp({ ok: true, at: new Date().toISOString() }, 200, cors);
      }

      // 0d. GET /sheet & POST /sheet & PUT /vocab & POST /dispatch -> Party Sheet & Chamber Dispatches (PC bot Phase 0 parity; the bot lives in the `leeroy-ops` repo)
      if (path === "/sheet") {
        const auth = await resolveMemberAuth(req, url, env);
        if (!auth.ok) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = auth.member;
        if (req.method === "GET") {
          const { party, seq } = await buildPartySheetsFromD1(env);
          const mine = party.find((p) => p.slug === m.slug) || { slug: m.slug, name: m.name, fields: {}, updated: null };
          return jsonResp(
            {
              slug: m.slug,
              name: m.name,
              sheet: { fields: mine.fields, updated: mine.updated },
              party: partyForMember(party, m.slug), // other members' hidden fields stay hidden
              seq,
            },
            200,
            cors
          );
        }
        if (req.method === "POST") {
          const read = await readJsonCapped(req);
          if (read.tooLarge) return jsonResp({ error: "Body too large" }, 413, cors);
          const body = read.body;
          const field = String(body.field || "").trim();
          if (!SHEET_FIELDS.includes(field)) {
            return jsonResp({ error: `Unknown sheet field: ${field}` }, 400, cors);
          }
          let problem = sheetValueProblem(field, body.value, body, { allowClear: true }); // the owner may clear a level (value null)
          // A value the line already stores is never refused: a stored production value can pre-date the vocabulary, and re-sending it (or hiding the line) must work.
          // Only a vocabulary line is looked up, and only after the vocabulary refused, so the normal write costs no extra read.
          if (problem && VOCAB_LIST[field] && body.value !== undefined && body.value !== null) {
            try {
              const cur = (await buildPartySheetsFromD1(env, { persist: false })).party.find((p) => p.slug === m.slug);
              const stored = cur && cur.fields && cur.fields[field];
              if (stored && stored.value !== undefined && JSON.stringify(stored.value) === JSON.stringify(body.value)) problem = null;
            } catch { /* unreadable: the refusal stands */ }
          }
          if (problem) return jsonResp({ error: problem }, 400, cors);
          // Only a boolean `visible` changes the field's visibility; without one the field keeps what it has (a write of a value never un-hides).
          // { field, visible } with no value key is a visibility change for every field: the stored value stays. { value: null } still clears.
          const visibleGiven = typeof body.visible === "boolean";
          const valueGiven = !(body.value === undefined && visibleGiven);
          const value = body.value === undefined ? null : body.value;
          const now = new Date().toISOString();
          let saved;
          try {
            saved = await recordSheetEventInD1(env, url.origin, {
              slug: m.slug,
              name: m.name,
              field,
              value,
              valueGiven,
              visible: body.visible,
              visibleGiven,
              source: "board",
              at: now,
              levelRules: field === "level",
            });
          } catch (e) {
            if (e instanceof KvConflictError) return jsonResp({ error: "The sheet is busy. Try again." }, 409, cors);
            throw e;
          }
          // The reply is the stored field (for level: the kept value on a visibility change, the stored one on a stale write). A write that
          // changed nothing (same field, or stale) sends no intent: the PC bot never sees a value that lost.
          const st = saved.stored || { value, visible: saved.visible, at: now };
          const out = { ok: true, at: st.at || now, field, value: st.value === undefined ? null : st.value, visible: st.visible !== false, ...(saved.stale ? { stale: true } : {}) };
          if (!saved.changed) return jsonResp({ ...out, unchanged: true }, 200, cors);
          const { seq } = await insertIntent(env, {
            slug: m.slug,
            kind: "sheet",
            body: sheetIntentBody(field, out.value, out.visible, "board"),
            ver: 1,
            at: now,
          });
          return jsonResp({ ...out, id: seq, seq }, 200, cors);
        }
      }

      // Admin only: post one message to a channel named in discord_roster.channels. Ids come from config, never the request.
      if (req.method === "POST" && path === "/announce") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        if (!env.DISCORD_BOT_TOKEN) return jsonResp({ error: "Discord bot token not configured" }, 503, cors);
        let input;
        try {
          input = await req.json();
        } catch {
          return jsonResp({ error: "Body must be JSON" }, 400, cors);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) return jsonResp({ error: "Body must be a JSON object" }, 400, cors);
        const roster = await loadConfigKey(env, "discord_roster");
        const channelId = lookupRosterId(roster, "channels", input.channel_key);
        if (!channelId) return jsonResp({ error: "Unknown channel_key" }, 400, cors);
        let roleId = null;
        if (input.mention_role !== undefined && input.mention_role !== null) {
          roleId = lookupRosterId(roster, "roles", input.mention_role);
          if (!roleId) return jsonResp({ error: "Unknown mention_role" }, 400, cors);
        }
        const built = buildAnnounceBody({ text: input.text, roleId, buttonLabel: input.button_label, buttonUrl: input.button_url });
        if (!built.ok) return jsonResp({ error: built.error }, 400, cors);
        let res;
        try {
          res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(built.body),
          });
        } catch {
          return jsonResp({ error: "Discord request failed" }, 502, cors);
        }
        if (!res.ok) {
          await res.arrayBuffer().catch(() => {});
          return jsonResp({ ok: false, status: res.status, error: "Discord refused the post" }, 502, cors);
        }
        await res.arrayBuffer().catch(() => {});
        return jsonResp({ ok: true, status: res.status }, 200, cors);
      }

      // Admin only (CARDS_ENABLED): post a pinned card for the first time, or recreate one a person deleted, and record its message id in
      // the cards row. The channel comes from discord_roster.channels, never from the request. Posting the first card is a deliberate act.
      if (req.method === "POST" && path === "/admin/cards/post") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        if (!cardsEnabled(env)) return jsonResp({ error: "Cards are off" }, 404, cors);
        if (!env.DISCORD_BOT_TOKEN && !cardsShadow(env)) return jsonResp({ error: "Discord bot token not configured" }, 503, cors);
        let input;
        try {
          input = await req.json();
        } catch {
          return jsonResp({ error: "Body must be JSON" }, 400, cors);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) return jsonResp({ error: "Body must be a JSON object" }, 400, cors);
        if (!CARD_NAMES.includes(input.card) || input.card === "party") return jsonResp({ error: "card must be signups or board" }, 400, cors);
        const roster = await loadConfigKey(env, "discord_roster");
        const channelId = lookupRosterId(roster, "channels", input.channel_key);
        if (!channelId) return jsonResp({ error: "Unknown channel_key" }, 400, cors);
        const out = await postCard(env, { card: input.card, channelId, replace: input.replace === true });
        if (!out.ok) return jsonResp({ ok: false, error: out.error }, out.status || 400, cors);
        invalidateConfigCache("cards");
        return jsonResp(out.shadow ? { ok: true, card: out.card, shadow: true } : { ok: true, card: out.card, pinned: out.pinned }, 200, cors);
      }

      // Admin token only: a friend's member key must not rewrite the shared vocabulary.
      if (req.method === "PUT" && path === "/vocab") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const body = await req.json();
        const vocab = (body && body.vocab) || {};
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('vocab', ?, ?)")
          .bind(JSON.stringify(vocab), now)
          .run();
        return jsonResp({ ok: true, fields: Object.keys(vocab).length }, 200, cors);
      }

      // Admin-only config rows (name_map, discord_members) that live only in D1. Write-only: there is no GET route.
      const configMatch = path.match(/^\/config\/([^/]+)$/);
      if (req.method === "PUT" && configMatch) {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const key = configMatch[1];
        if (!CONFIG_KEYS.includes(key)) {
          return jsonResp({ error: "Unknown config key" }, 400, cors);
        }
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > CONFIG_MAX_BYTES) {
          return jsonResp({ error: "Config too large" }, 413, cors);
        }
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          return jsonResp({ error: "Body must be valid JSON" }, 400, cors);
        }
        const problem = validateConfigValue(key, value);
        if (problem) return jsonResp({ error: problem }, 400, cors);
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
          .bind(key, JSON.stringify(value), now)
          .run();
        invalidateConfigCache(key);
        return jsonResp({ ok: true, key, entries: Array.isArray(value) ? value.length : Object.keys(value).length }, 200, cors);
      }

      // Admin only, flag EVENTS_ENABLED=on: plan (default, no Discord call) or with ?dry=0 apply Discord scheduled events from the events_schedule row.
      if (req.method === "POST" && path === "/admin/events/sync") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        if (!eventsEnabled(env)) return jsonResp({ error: "Not found" }, 404, cors);
        const dry = url.searchParams.get("dry") !== "0";
        const roster = dry ? null : await loadConfigKey(env, "discord_roster");
        const { status, body } = await runSync({ env, dry, guildId: roster && /^[0-9]{5,25}$/.test(roster.guildId || "") ? roster.guildId : null });
        return jsonResp(body, status, cors);
      }

      // Admin only: timed-post schedule status for mission control. No channel ids, user ids, message ids or content.
      if (req.method === "GET" && path === "/admin/moments") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const schedule = await loadConfigKey(env, "moments");
        const shadow = momentsShadow(env);
        const { state } = await d1Store(env, shadow ? MOMENTS_SHADOW_STATE_KEY : undefined).read();
        const { state: led } = await d1Store(env, MOMENTS_LEDGER_KEY, "entries").read();
        return jsonResp(momentsStatus({ schedule, state, now: Date.now(), enabled: momentsEnabled(env), shadow, dryRun: momentsDryRun(env), ledger: led.entries }), 200, cors);
      }

      // Admin only: fill one field on a party member's sheet (q-20261114-22: level, which the owner can fill for a friend). Only fields with a
      // server-side rule (ADMIN_SHEET_FIELDS). The member must be in the party. A field the friend has hidden stays hidden (keepHidden); the admin
      // may hide a field but never shows one. Same commit, broadcast and intent as a friend's own POST /sheet, with source "admin".
      // Follow-up (review LOW-4): there is no expected-value precondition; the admin's fill wins over any older stored value.
      if (req.method === "POST" && path === "/admin/sheet") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const read = await readJsonCapped(req);
        if (read.tooLarge) return jsonResp({ error: "Body too large" }, 413, cors);
        const body = read.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResp({ error: "Body must be a JSON object" }, 400, cors);
        if (!Object.keys(body).every((k) => k === "slug" || k === "field" || k === "value" || k === "visible")) return jsonResp({ error: "Body carries slug, field, value and an optional visible:false" }, 400, cors);
        const field = typeof body.field === "string" ? body.field : "";
        if (!ADMIN_SHEET_FIELDS.includes(field)) return jsonResp({ error: `The admin may fill only: ${ADMIN_SHEET_FIELDS.join(", ")}` }, 400, cors);
        const problem = sheetValueProblem(field, body.value);
        if (problem) return jsonResp({ error: problem }, 400, cors);
        if (body.visible !== undefined && body.visible !== false) return jsonResp({ error: "visible may only be false: the admin never shows a hidden field" }, 400, cors);
        const slug = typeof body.slug === "string" ? body.slug : "";
        const member = /^[a-z0-9-]{1,32}$/.test(slug) ? (await loadPartyMembers(env)).find((m) => m.slug === slug) : null;
        if (!member) return jsonResp({ error: "Unknown party member" }, 404, cors);
        const now = new Date().toISOString();
        let saved;
        try {
          saved = await recordSheetEventInD1(env, url.origin, { slug: member.slug, name: member.name, field, value: body.value, visible: body.visible !== false, visibleGiven: body.visible === false, source: "admin", at: now, keepHidden: true, levelRules: true });
        } catch (e) {
          if (e instanceof KvConflictError) return jsonResp({ error: "The sheet is busy. Try again." }, 409, cors);
          throw e;
        }
        // The reply is the stored field. A write that changed nothing (same field, or stale) sends no intent.
        const st = saved.stored || { value: null, visible: true, at: now };
        const out = { ok: true, at: st.at, slug: member.slug, field, value: st.value, visible: st.visible !== false, ...(saved.stale ? { stale: true } : {}) };
        if (!saved.changed) return jsonResp({ ...out, unchanged: true }, 200, cors);
        const { seq } = await insertIntent(env, { slug: member.slug, kind: "sheet", body: sheetIntentBody(field, st.value, out.visible, "admin"), ver: 1, at: now });
        return jsonResp({ ...out, id: seq, seq }, 200, cors);
      }

      // Admin only: add or update one roster entry in discord_members. The reply never echoes other members.
      if (req.method === "POST" && path === "/admin/members") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > 2000) return jsonResp({ error: "Body too large" }, 413, cors);
        let entry;
        try {
          entry = JSON.parse(raw);
        } catch {
          return jsonResp({ error: "Body must be valid JSON" }, 400, cors);
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return jsonResp({ error: "member must be an object" }, 400, cors);
        let current = [];
        try {
          const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'discord_members'").first();
          if (row && row.json) current = JSON.parse(row.json);
        } catch {
          return jsonResp({ error: "Could not read the roster" }, 500, cors);
        }
        const result = upsertMember(Array.isArray(current) ? current : [], entry);
        if (result.error) return jsonResp({ error: result.error }, 400, cors);
        const problem = validateConfigValue("discord_members", result.members);
        if (problem) return jsonResp({ error: problem }, 400, cors);
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
          .bind("discord_members", JSON.stringify(result.members), now)
          .run();
        invalidateConfigCache("discord_members");
        return jsonResp({ ok: true, slug: entry.slug, entries: result.members.length }, 200, cors);
      }

      // Admin only, and only when EVAL_ENABLED is on (default off; 404 otherwise). Model bake-off: runs a few cells of questions x
      // candidates through the production retrieval and prompt path and returns answers plus deterministic lint. Stores nothing,
      // posts nothing. At most 6 model calls and 25 seconds per request; the caller loops on nextCursor (see eval.js).
      if (req.method === "POST" && path === "/admin/eval") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        if (!evalEnabled(env)) return jsonResp({ error: "Not found" }, 404, cors);
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > 100000) return jsonResp({ error: "Body too large" }, 413, cors);
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        const parsed = validateEvalRequest(body);
        if (parsed.error) return jsonResp({ error: parsed.error }, 400, cors);
        const out = await runEval(env, parsed);
        return jsonResp(out, 200, { ...cors, "Cache-Control": "no-store" });
      }

      // The persona pack is curated content that lives only in D1. Write-only: there is no GET route for it.
      // Admin token only: a member key must not be able to rewrite the system prompt for every ask.
      if (req.method === "PUT" && path === "/persona") {
        if (!env.BOARD_ADMIN_TOKEN) {
          return jsonResp({ error: "Admin token not configured" }, 503, cors);
        }
        const adminKey = extractKey(req);
        if (!adminKey || !timingSafeEqualStr(adminKey, env.BOARD_ADMIN_TOKEN)) {
          return jsonResp({ error: "Unauthorized" }, 401, cors);
        }
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > 200000) {
          return jsonResp({ error: "Persona pack too large" }, 413, cors);
        }
        let pack = null;
        try {
          pack = JSON.parse(raw);
        } catch {}
        if (!pack || typeof pack !== "object" || Array.isArray(pack) || typeof pack.version !== "number" || typeof pack.system !== "string") {
          return jsonResp({ error: "Body must be a JSON object with a numeric version and a string system" }, 400, cors);
        }
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('persona', ?, ?)")
          .bind(JSON.stringify(pack), now)
          .run();
        invalidatePersonaCache();
        return jsonResp({ ok: true, version: pack.version, bytes: raw.length }, 200, cors);
      }

      if (req.method === "POST" && path === "/dispatch") {
        const auth = await resolveMemberAuth(req, url, env);
        if (!auth.ok) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = auth.member;
        const read = await readJsonCapped(req);
        if (read.tooLarge) return jsonResp({ error: "Body too large" }, 413, cors);
        const body = read.body;
        const ids = Array.isArray(body && body.ids) ? body.ids.slice(0, 3) : [];
        if (!ids.length || !body || body.yes !== true) {
          return jsonResp({ error: "Invalid dispatch payload" }, 400, cors);
        }
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT INTO dispatches (slug, name, ask_ids_json, created_at) VALUES (?, ?, ?, ?)")
          .bind(m.slug, m.name, JSON.stringify(ids), now)
          .run();
        const seq = Date.now();
        if (env.DISCORD_WEBHOOK_URL) {
          await fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: "Leeroy Jenkins",
              content: clampContent(`📜 **${m.name}** shared ${ids.length} library note${ids.length === 1 ? "" : "s"} from the Leeroy Chamber with the party.`),
              allowed_mentions: ALLOWED_MENTIONS_NONE,
            }),
          }).catch(() => {});
        }
        return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
      }

      // 0e. GET /intents -> Shared brain intents mailbox polling for bot or consumer
      if (path === "/intents" && req.method === "GET") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const after = parseInt(url.searchParams.get("after") || "0", 10) || 0;
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);

        const [rows, countRow] = await Promise.all([
          env.DB.prepare(
            "SELECT seq, at, slug, kind, body, ver FROM intents WHERE seq > ? ORDER BY seq ASC LIMIT ?"
          )
            .bind(after, limit)
            .all(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM intents").first(),
        ]);

        const intents = (rows.results || []).map((r) => {
          let parsed = {};
          try {
            parsed = JSON.parse(r.body);
          } catch {
            parsed = { unreadable: true }; // never echo the stored text: a row that is not JSON may still hold a hidden value
          }
          return {
            seq: r.seq,
            at: r.at,
            slug: r.slug,
            kind: r.kind,
            body: redactIntentBody(parsed), // rows from before hide intents dropped the value may still hold one
            ver: r.ver,
          };
        });

        return jsonResp(
          {
            ok: true,
            intents,
            expired: 0,
            pending: countRow ? countRow.count : 0,
          },
          200,
          cors
        );
      }

      // Admin only: Helpful/Off counts and the latest 50 votes (question, first 160 chars of the answer, no user ids).
      if (req.method === "GET" && path === "/admin/feedback") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const sinceRaw = url.searchParams.get("since");
        const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Date.now() - 30 * 86400000;
        if (!Number.isFinite(sinceMs)) return jsonResp({ error: "since must be an ISO 8601 date" }, 400, cors);
        try {
          return jsonResp(await feedbackReport(env, new Date(sinceMs).toISOString()), 200, cors);
        } catch {
          return jsonResp({ error: "feedback_unavailable" }, 503, cors);
        }
      }

      // 0f. POST /ack -> Acknowledge and clear intents up to `upTo` sequence number
      if (path === "/ack" && req.method === "POST") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        let body = {};
        try {
          body = (await req.json()) || {};
        } catch {}
        const upTo = parseInt(body.upTo || body.up_to || "0", 10);
        if (!upTo || upTo <= 0) {
          return jsonResp({ error: "Missing or invalid upTo sequence number" }, 400, cors);
        }
        const res = await env.DB.prepare("DELETE FROM intents WHERE seq <= ?").bind(upTo).run();
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM intents").first();
        const deleted = (res.meta && res.meta.changes) || 0;
        return jsonResp(
          {
            ok: true,
            deleted,
            pending: countRow ? countRow.count : 0,
          },
          200,
          cors
        );
      }

      // 0g. POST /answer -> Push answer to ask question into ask_turns & broadcast
      if (path === "/answer" && req.method === "POST") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        let body = {};
        try {
          body = (await req.json()) || {};
        } catch {}
        const id = String(body.id || "").trim();
        if (!id) {
          return jsonResp({ error: "Missing ask turn id" }, 400, cors);
        }
        const applied = await applyManualAnswer(env, {
          id,
          answer: body.answer ? String(body.answer) : null,
          sources: body.sources,
          failed: body.failed || null,
          byName: "",
          isAdmin: true, // adminGate above
        });
        if (!applied.ok) return jsonResp({ error: "Ask turn not found" }, 404, cors);
        const status = applied.status;
        await broadcastToRoom(env, applied.broadcast);
        await purgeWorkerCache(url.origin, ["/api/bootstrap", `/api/ask?id=${id}`]);

        return jsonResp({ ok: true, id, status }, 200, cors);
      }

      // 0h. GET/POST /signups -> Direct signups endpoint
      if (path === "/signups") {
        if (req.method === "GET") {
          let resp = await getCachedResponse(url.origin, "/api/signups");
          if (!resp) {
            const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
            const doc = row ? JSON.parse(row.json) : { entries: [], tallies: {} };
            resp = jsonResp(doc, 200, {
              ...cors,
              "Cache-Control": "public, max-age=15, stale-while-revalidate=60",
            });
            setCachedResponse(ctx, url.origin, "/api/signups", resp, 15000);
          } else {
            const headers = new Headers(resp.headers);
            for (const [k, v] of Object.entries(cors)) headers.set(k, v);
            resp = new Response(resp.body, { status: resp.status, headers });
          }
          return resp;
        }
        if (req.method === "POST") {
          const auth = await resolveMemberAuth(req, url, env);
          if (!auth.ok) {
            return jsonResp({ error: "Unauthorized board key" }, 401, cors);
          }
          const member = auth.member;
          const read = await readJsonCapped(req);
          if (read.tooLarge) return jsonResp({ error: "Body too large" }, 413, cors);
          const body = read.body;
          const now = new Date().toISOString();

          const picked = pickSignupPatch(body.patch && typeof body.patch === "object" ? body.patch : body);
          if (picked.error || !Object.keys(picked.patch).length) return jsonResp({ error: picked.error || "No known sign-up field" }, 400, cors);
          const patch = picked.patch;

          let saved;
          try {
            saved = await updateKvJson(env, "signups", async (cur) => {
              const doc = cur || { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [] };
              doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
              const entry = upsertSignupEntry(doc, member);
              for (const [k, v] of Object.entries(patch)) {
                entry[k] = v === "vos" ? "Valley of Strength" : v === "xroads" ? "The Crossroads" : v;
              }
              entry.updated = now;
              await recomputeSignupTallies(doc);
              return { doc, result: entry };
            });
          } catch (e) {
            if (e instanceof KvConflictError) return jsonResp({ error: "The sign-ups card is busy. Try again." }, 409, cors);
            throw e;
          }
          const doc = saved.doc, entry = saved.result;

          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "signup",
            body: { patch, entry },
            ver: 1,
            at: now,
          });

          await purgeWorkerCache(url.origin, ["/api/bootstrap", dataCachePath("signups"), "/api/signups"]);
          await broadcastToRoom(env, { type: "data", key: "signups", data: doc });

          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }
      }

      // 1. WebSocket / Live State -> Durable Object (`BoardRoom`) + D1 state
      if (path === "/live" || path === "/state") {
        if (path === "/state" && req.method === "GET") {
          let resp = await getCachedResponse(url.origin, "/api/state");
          if (!resp) {
            const { results } = await env.DB.prepare(
              "SELECT key, json, updated_at FROM kv_state WHERE key IN ('party','timeline','stats','signups','tonight','launch','decide')"
            ).all();
            const map = {};
            const stored = {}; // the stored documents, for reconciling sheets; map holds their public form (public-docs.js publicDataDoc)
            for (const row of results || []) {
              try {
                stored[row.key] = JSON.parse(row.json);
                map[row.key] = publicDataDoc(row.key, stored[row.key], row.updated_at);
              } catch {}
            }
            // The party row is already in hand: pass it on so the sheets are reconciled without a second read.
            const inputs = await loadPublicInputs(env, { partyDoc: stored.party || null });
            const now = new Date().toISOString();
            resp = jsonResp(
              webBoardLinksDeep({
                type: "state",
                ver: 1,
                at: now,
                party: inputs.sheets ? publicParty(inputs.sheets) : [], // the cached body is public: hidden sheet fields never enter it
                signups: map.signups || null,
                partyDoc: map.party ? projectDataDoc("party", map.party, inputs) : null,
                tonight: map.tonight ? projectDataDoc("tonight", map.tonight, inputs) : null,
                timeline: map.timeline || null,
                stats: map.stats || null,
                decide: map.decide ? projectDataDoc("decide", map.decide, inputs) : null,
                launch: (() => { const L = map.launch ? projectDataDoc("launch", map.launch, inputs) : null; return Array.isArray(L) ? L : L && Array.isArray(L.rows) ? L.rows : []; })(), // a hidden launch_state is not in the public list
              }),
              200,
              {
                ...cors,
                "Cache-Control": MEMBER_NO_STORE,
              }
            );
            setCachedResponse(ctx, url.origin, "/api/state", resp, 30000);
          } else {
            const headers = new Headers(resp.headers);
            for (const [k, v] of Object.entries(cors)) headers.set(k, v);
            resp = new Response(resp.body, { status: resp.status, headers });
          }
          return resp;
        }
        const id = env.BOARD_ROOM.idFromName("global");
        const stub = env.BOARD_ROOM.get(id);
        let roomReq = req;
        if (path === "/live") {
          // The room reads this header to know the socket belongs to a signed-in web session. A client's own copy never gets through.
          const h = new Headers(req.headers);
          h.delete(LIVE_AUTH_HEADER);
          if (req.headers.get("Upgrade") === "websocket" && (await webSessionFrom(req, env, Date.now()))) h.set(LIVE_AUTH_HEADER, "web");
          roomReq = new Request(req, { headers: h });
        }
        const doResp = await stub.fetch(roomReq);
        if (doResp.status === 101) return doResp; // WebSocket Upgrade
        const headers = new Headers(doResp.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(doResp.body, { status: doResp.status, headers });
      }

      // 1a. POST /token -> Discord Embedded App SDK OAuth2 code-to-token exchange (`vendor/discord-auth.js`)
      // 1b. Per-user settings and accounts (`/auth/discord`, `/me`, `/state/:doc`)
      const webRes = await handleWebAuth(req, env, { path, ip: req.headers.get("CF-Connecting-IP") || "127.0.0.1", now: Date.now() });
      if (webRes) {
        for (const [k, v] of Object.entries(cors)) if (!webRes.headers.has(k)) webRes.headers.set(k, v);
        return webRes;
      }
      const charsRes = await handleCharacters(req, env, { path, now: Date.now() });
      if (charsRes) {
        for (const [k, v] of Object.entries(cors)) if (!charsRes.headers.has(k)) charsRes.headers.set(k, v);
        return charsRes;
      }
      const rightsRes = await handleDataRights(req, env, { path, now: Date.now() });
      if (rightsRes) {
        for (const [k, v] of Object.entries(cors)) if (!rightsRes.headers.has(k)) rightsRes.headers.set(k, v);
        return rightsRes;
      }
      const accountRes = await handleAccount(req, env, {
        path,
        ip: req.headers.get("CF-Connecting-IP") || "127.0.0.1",
        now: Date.now(),
      });
      if (accountRes) {
        const [status, body, extra] = accountRes;
        return jsonResp(body, status, { ...cors, ...extra, "Cache-Control": "no-store" });
      }

      if (req.method === "POST" && path === "/token") {
        let body = {};
        try {
          body = await req.json();
        } catch {}
        const code = typeof body?.code === "string" ? body.code.trim() : "";
        if (!code || code.length > 512) {
          return jsonResp({ error: "Invalid authorization code" }, 400, cors);
        }
        const clientId = env.DISCORD_CLIENT_ID || "1561857940174938114";
        const clientSecret = env.DISCORD_CLIENT_SECRET || "";
        if (!clientSecret) {
          return jsonResp({ error: "Discord client secret not configured" }, 503, cors);
        }
        const params = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
        });
        const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        if (!tokenRes.ok) {
          return jsonResp({ error: "Token exchange failed" }, 502, cors);
        }
        const tokenJson = await tokenRes.json().catch(() => null);
        if (!tokenJson || typeof tokenJson.access_token !== "string") {
          return jsonResp({ error: "Invalid token response" }, 502, cors);
        }
        return jsonResp({ access_token: tokenJson.access_token }, 200, cors);
      }

      // 1c. GET /ask -> Returns latest Q&A turn for `js/brain.js` (`askRead()`)
      if (req.method === "GET" && path === "/ask") {
        const isPrPreview = isPrPreviewEnv(env);
        const auth = await resolveMemberAuth(req, url, env);
        const askId = url.searchParams.get("id");

        let row = null;
        if (askId) {
          // Old ids are millisecond timestamps (guessable): they need a member key, web session or the admin token.
          // New ids are random UUIDs, so holding the id is the credential (a guest polls for their own answer with it).
          const ws = auth.ok ? null : await webSessionFrom(req, env, Date.now());
          if (!auth.ok && !ws && !UUID_RE.test(askId)) return jsonResp({ error: "Unauthorized board key" }, 401, cors);
          row = await env.DB.prepare("SELECT * FROM ask_turns WHERE id = ?").bind(askId).first();
          // A private random-id turn is no longer readable by its id alone: only by its asker's key or session, or a guest's secret (answer-ux.js
          // privateTurnAccess); the admin sees all. A guest turn asked from a page that predates the secret answers one clear line, never the turn.
          if (row && UUID_RE.test(String(row.id)) && row.share !== 1 && adminGate(req, url, env, cors)) {
            const access = await privateTurnAccess(env, row, { member: auth.ok ? auth.member : null, ws, secret: url.searchParams.get("s") || "" });
            if (access === "reload") row = { id: row.id, status: "answered", question: "", answer: RELOAD_ANSWER_LINE, cites_json: "[]", model: "library", created_at: row.created_at, answered_at: row.created_at };
            else if (access !== "ok") row = null;
          }
          // A timestamp id can be guessed: even with a key it shows only shared turns and the caller's own (the admin sees all).
          if (row && !UUID_RE.test(String(row.id)) && row.share !== 1 && adminGate(req, url, env, cors)) {
            const mine = auth.ok ? [auth.member.name, auth.member.slug] : [ws.name];
            if (!mine.includes(row.by_name)) row = null;
          }
        } else if (auth.ok && auth.member) {
          row = await env.DB.prepare(
            "SELECT * FROM ask_turns WHERE ((by_name = ? OR by_name = ?) AND by_name <> 'Visitor') OR share = 1 ORDER BY created_at DESC LIMIT 1" // a member named "Visitor" is not every guest
          ).bind(auth.member.name, auth.member.slug).first();
        } else {
          // No key and no id: the visitor is anonymous. The latest shared turn is a member's question and answer, so it is for signed-in
          // members and web sessions only (audit 2026-11-06 finding 4). A guest polls their own just-created ask by its random id (above).
          const ws = await webSessionFrom(req, env, Date.now());
          if (ws) {
            row = await env.DB.prepare(
              "SELECT * FROM ask_turns WHERE share = 1 ORDER BY created_at DESC LIMIT 1"
            ).first();
          }
        }

        let limitLeft = 6;
        if (!auth.ok) {
          const missingSalt = saltProblems(env, ["USER_SALT"]);
          if (missingSalt.length) return jsonResp(saltErrorBody(missingSalt), 503, cors);
          const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
          const ipHash = await guestIpKey(clientIp, env.USER_SALT);
          const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
          const countRow = await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ?"
          ).bind(ipHash, oneHourAgo).first();
          const used = countRow ? Number(countRow.count) || 0 : 0;
          limitLeft = Math.max(0, 2 - used);
        }

        if (!row) {
          return jsonResp({ ask: null, limit: { left: limitLeft }, isPrPreview, aiProvider: auth.ok ? resolveAiProvider(env) : "workers-ai" }, 200, { ...cors, "Cache-Control": "no-store" });
        }
        const status =
          row.status === "thinking" || row.status === "pending"
            ? "queued"
            : row.status === "answered"
            ? "answered"
            : "failed";
        const [provider, model] = isPrPreview
          ? ["workers-ai", row.model || "workers-ai"]
          : String(row.model || "").includes(":")
            ? String(row.model).split(/:(.+)/)
            : [resolveAiProvider(env), row.model || null];
        let sources = [];
        try {
          sources = JSON.parse(row.cites_json || "[]");
        } catch {}
        const numericId = Number(String(row.id).replace(/\D/g, "").slice(0, 13)) || Date.now();
        return jsonResp(
          {
            ask: {
              id: UUID_RE.test(String(row.id)) ? row.id : numericId, // a random id must come back whole so the page can poll it
              status,
              text: row.question,
              answer: webBoardLinks(row.answer) || null,
              sources,
              provider,
              model,
              at: row.answered_at || row.created_at,
              answeredAt: row.answered_at || null,
            },
            limit: { left: 6 },
            isPrPreview,
            aiProvider: resolveAiProvider(env),
          },
          200,
          { ...cors, "Cache-Control": "no-store" } // a turn is personal, and its URL may carry a guest secret: never cached
        );
      }

      // 1d. GET /wiki/snapshots & GET /wiki/proposals -> D1-backed source snapshots & AI fact proposals
      if (req.method === "GET" && path === "/wiki/snapshots") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          "SELECT id, source_id, url, sha8, substr(body_text, 1, 600) AS preview, fetched_at FROM lib_source_snapshots ORDER BY fetched_at DESC LIMIT 25"
        ).all();
        return jsonResp({ snapshots: results || [] }, 200, cors);
      }

      if (req.method === "GET" && path === "/wiki/proposals") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          "SELECT * FROM wiki_proposals ORDER BY created_at DESC LIMIT 50"
        ).all();
        return jsonResp({ proposals: results || [] }, 200, cors);
      }

      // 1d2. One proposal next to the live value, and the admin decisions on it (approve applies it to lib_pages, reject only closes it)
      const propMatch = path.match(/^\/wiki\/proposals\/([A-Za-z0-9_.-]{1,80})(\/approve|\/reject)?$/);
      if (propMatch && ((req.method === "GET" && !propMatch[2]) || (req.method === "POST" && propMatch[2]))) {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const propId = propMatch[1];
        if (req.method === "GET") {
          const r = await describeProposal(env, propId);
          return jsonResp(r.body, r.status, cors);
        }
        const read = await readJsonCapped(req);
        if (read.tooLarge) return jsonResp({ error: "Body too large" }, 413, cors);
        const body = read.body || {};
        if (propMatch[2] === "/reject") {
          const r = await rejectProposal(env, propId, { reason: body.reason });
          return jsonResp(r.body, r.status, cors);
        }
        const r = await approveProposal(env, propId, { force: body.force === true });
        if (r.refresh) {
          // The row is already committed; a failure while rebuilding blobs must not hide that, so it is reported, not thrown.
          const cats = [r.refresh.category];
          try {
            await recomputeCategoryAndIndex(env, r.refresh.category, { date: r.refresh.date, page: r.refresh.page, text: r.refresh.text });
            invalidatePagesCache();
            await purgeWorkerCache(url.origin, [
              "/api/library/index.json",
              "/api/library/search.json",
              "/api/library/open.json",
              ...LIBRARY_PURGE_PATHS,
              `/api/library/${r.refresh.category}.json`,
            ]);
            await broadcastToRoom(env, { type: "library", categories: cats, page: r.refresh.page });
          } catch (e) {
            invalidatePagesCache();
            return jsonResp({ ...r.body, refresh: "failed" }, r.status, cors);
          }
        }
        return jsonResp(r.body, r.status, cors);
      }

      // 1e. PUT /wiki/page -> Direct D1 wiki page authoring/editing (replaces editing markdown in the `leeroy-ops` wiki)
      if (req.method === "PUT" && path === "/wiki/page") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const body = await req.json();
        const pageId = String(body.id || "").trim();
        const category = String(body.category || pageId.split("/")[0] || "").trim();
        const title = String(body.title || pageId.split("/").pop() || "").trim();
        if (!pageId || !category || !title) {
          return jsonResp({ error: "Missing page id, category, or title" }, 400, cors);
        }
        const now = new Date().toISOString();
        const today = now.slice(0, 10);
        await env.DB.prepare(
          `INSERT INTO lib_pages (id, category, title, confidence, status, as_of, checked, recheck_days, blurb, aliases_json, facts_json, open_json, related_json, history_json, snapshots_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             category = excluded.category,
             title = excluded.title,
             confidence = excluded.confidence,
             status = excluded.status,
             as_of = excluded.as_of,
             checked = excluded.checked,
             recheck_days = excluded.recheck_days,
             blurb = excluded.blurb,
             aliases_json = excluded.aliases_json,
             facts_json = excluded.facts_json,
             open_json = excluded.open_json,
             related_json = excluded.related_json,
             history_json = excluded.history_json,
             snapshots_json = excluded.snapshots_json,
             updated_at = excluded.updated_at`
        )
          .bind(
            pageId,
            category,
            title,
            body.confidence || "confirmed",
            body.status || "current",
            body.as_of || today,
            body.checked || today,
            Number(body.recheck_days) || 3,
            body.blurb || "",
            JSON.stringify(Array.isArray(body.aliases) ? body.aliases : []),
            JSON.stringify(Array.isArray(body.facts) ? body.facts : []),
            JSON.stringify(Array.isArray(body.open) ? body.open : []),
            JSON.stringify(Array.isArray(body.related) ? body.related : []),
            JSON.stringify(Array.isArray(body.history) ? body.history : []),
            JSON.stringify(Array.isArray(body.snapshots) ? body.snapshots : []),
            now
          )
          .run();

        await recomputeCategoryAndIndex(env, category, {
          date: today,
          page: pageId,
          text: `${title} updated in D1`,
        });
        await purgeWorkerCache(url.origin, [
          "/api/library/index.json",
          "/api/library/search.json",
          "/api/library/open.json",
          ...LIBRARY_PURGE_PATHS,
          `/api/library/${category}.json`,
        ]);
        await broadcastToRoom(env, { type: "library", categories: [category], page: pageId });
        return jsonResp({ ok: true, id: pageId, category, updated_at: now }, 200, cors);
      }

      // 2. GET /bootstrap -> Single-roundtrip Edge-cached startup bundle
      if (req.method === "GET" && path === "/bootstrap") {
        let resp = await getCachedResponse(url.origin, "/api/bootstrap");
        if (!resp) {
          const { results } = await env.DB.prepare(
            "SELECT key, json, updated_at FROM kv_state WHERE key IN ('party','timeline','stats','signups','tonight','launch','marks','decide')"
          ).all();
          let partyDocRead = null;
          for (const row of results || []) {
            if (row.key === "party") {
              try { partyDocRead = JSON.parse(row.json); } catch {}
            }
          }
          const inputs = await loadPublicInputs(env, { partyDoc: partyDocRead });
          const isPrPreview = isPrPreviewEnv(env);
          const providers = {};
          for (const k of Object.keys(AI_PROVIDER_LABELS)) {
            providers[k] = isProviderConfigured(env, k);
          }
          const bundle = {
            aiProvider: resolveAiProvider(env),
            isPrPreview,
            providers,
            partySheets: inputs.sheets ? publicParty(inputs.sheets) : [], // the cached body is public: hidden sheet fields never enter it
          };
          for (const row of results || []) {
            try {
              const doc = JSON.parse(row.json);
              bundle[row.key] = isPublicDataDoc(row.key) ? projectDataDoc(row.key, publicDataDoc(row.key, doc, row.updated_at), inputs) : doc;
            } catch {
              bundle[row.key] = null;
            }
          }
          resp = jsonResp(webBoardLinksDeep(bundle), 200, {
            ...cors,
            "Cache-Control": MEMBER_NO_STORE,
          });
          setCachedResponse(ctx, url.origin, "/api/bootstrap", resp, 60000);
        } else {
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          resp = new Response(resp.body, { status: resp.status, headers });
        }
        return resp;
      }

      // 3. GET /library/:name -> Edge-cached library JSON blob from D1 `lib_blobs`
      if (req.method === "GET" && path.startsWith("/library/")) {
        let name;
        try { name = decodeURIComponent(path.slice("/library/".length)); } catch { return jsonResp({ error: "Library blob not found" }, 404, cors); }
        // Blob names never hold whitespace or control characters. Those would be stripped when the cache key is built, so a trailing space or %00 could otherwise land on another blob's cache key.
        if (/[\s\u0000-\u001f\u007f]/.test(name)) return jsonResp({ error: "Library blob not found" }, 404, cors);
        // seed.stamp is the deploy seed's bookkeeping row, not a Library document.
        if (name === "seed.stamp") return jsonResp({ error: `Library blob ${name} not found` }, 404, cors);
        // The glossary is the one blob that is filtered on the way out (party-glossary.js): the stored row may hold text that names the vocabulary. Its cache entry has its own key
        // (a copy cached unfiltered by an earlier deploy is never read) and a short lifetime, and a library write purges it (LIBRARY_PURGE_PATHS).
        const isGlossary = name === LIBRARY_GLOSSARY_BLOB;
        const cachePath = isGlossary ? LIBRARY_GLOSSARY_CACHE_PATH : `/api/library/${name}`;
        let resp = await getCachedResponse(url.origin, cachePath);
        if (!resp) {
          const row = await env.DB.prepare("SELECT json, stamp FROM lib_blobs WHERE name = ?")
            .bind(name)
            .first();
          if (!row) return jsonResp({ error: `Library blob ${name} not found` }, 404, cors);
          const ttl = isGlossary ? 300 : name === "index.json" || name === "refresh.json" || name === "news.json" ? 30 : 3600;
          resp = jsonResp(isGlossary ? libraryGlossaryBody(row.json) : row.json, 200, {
            ...cors,
            ETag: `"${row.stamp}${isGlossary ? "-f1" : ""}"`,
            "Cache-Control": `public, max-age=${ttl}, s-maxage=${isGlossary ? ttl : ttl * 4}, stale-while-revalidate=${isGlossary ? 0 : 600}`,
          });
          setCachedResponse(ctx, url.origin, cachePath, resp, ttl * 1000);
        } else {
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          resp = new Response(resp.body, { status: resp.status, headers });
        }
        return resp;
      }

      // 4. GET or PUT /data/:name or GET /atlas/:name -> Single document in D1 `kv_state`
      if (path.startsWith("/data/") || path.startsWith("/atlas/")) {
        const raw = decodeURIComponent(path.split("/").pop() || "").replace(/\.json$/, "");
        const cachePath = `/api/${path.startsWith("/atlas/") ? "atlas" : "data"}/${raw}`; // keyed by the decoded name: "/data/part%79", "//party" and "/party.json" are one entry
        if (req.method === "GET") {
          // Config and private working rows live in the same table: serve only documents the public site fetches
          // (allow list in public-docs.js), and keep the private-key guard as a second check.
          const allowed = path.startsWith("/atlas/") ? isPublicAtlasDoc(raw) : isPublicDataDoc(raw);
          if (!allowed || isPrivateKvKey(raw)) return jsonResp({ error: `Document ${raw} not found` }, 404, cors);
          // ?stored=1 (admin token only): the stored document, whole. A tool that reads a document in order to write it back (tools/add-member.mjs) must not start from the public
          // projection, or the write would store a document with the hidden fields cut out. Never cached, never shared.
          if (path.startsWith("/data/") && url.searchParams.get("stored") === "1") {
            const denied = adminGate(req, url, env, cors);
            if (denied) return denied;
            const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(raw).first();
            if (!row) return jsonResp({ error: `Document ${raw} not found` }, 404, cors);
            return jsonResp(row.json, 200, { ...cors, "Cache-Control": "no-store" });
          }
          let resp = await getCachedResponse(url.origin, cachePath);
          if (!resp) {
            // D1_FEED (default off): stats is computed from D1 and cached 5 minutes; null means serve the stored row as before.
            const fed = path.startsWith("/data/") && (await feedOn(env)) ? await serveFeedDoc(env, raw) : null;
            // A document with no row falls back to the copy bundled with the Worker (default-docs.js: `client`, which seed-d1 never wrote), and that copy is projected like a stored row. Without it the board
            // would read 404 for a member document and show nothing; with it the page and the privacy rule do not depend on a row existing.
            const row = fed || (await env.DB.prepare("SELECT json, updated_at FROM kv_state WHERE key = ?").bind(raw).first()) || (path.startsWith("/data/") ? defaultDocRow(raw) : null);
            if (!row) return jsonResp({ error: `Document ${raw} not found` }, 404, cors);
            let etag = `"${raw}-${row.updated_at || '1'}"`;
            let docJson = row.json;
            if (typeof docJson === "string" && path.startsWith("/data/")) {
              try {
                let pubDoc = publicDataDoc(raw, JSON.parse(docJson), row.updated_at);
                if (MEMBER_DOC_KEYS.includes(raw)) pubDoc = projectDataDoc(raw, pubDoc, await loadPublicInputs(env, raw === "party" ? { partyDoc: pubDoc } : {}));
                docJson = JSON.stringify(pubDoc);
                // The stored row did not change but what is served did (a member hid or showed a line): the tag of a member document carries a hash of the projected body, so a full and a withheld body never share an ETag.
                if (MEMBER_DOC_KEYS.includes(raw)) etag = `"${raw}-${row.updated_at || '1'}-p${projectionTag(docJson)}"`;
              } catch {
                // an unparsable stats row cannot be filtered, so it is not served (it may hold stats.recent); nor is a member document that cannot be projected
                if (raw === "stats" || MEMBER_DOC_KEYS.includes(raw)) return jsonResp({ error: `Document ${raw} is unreadable` }, 500, cors);
              }
            }
            if (typeof docJson === "string" && docJson.includes("{board:")) {
              try {
                docJson = JSON.stringify(webBoardLinksDeep(JSON.parse(docJson)));
              } catch {}
            }
            resp = jsonResp(docJson, 200, {
              ...cors,
              ETag: etag,
              "Cache-Control": MEMBER_DOC_KEYS.includes(raw) ? MEMBER_NO_STORE : "public, max-age=15, s-maxage=60, stale-while-revalidate=300",
            });
            setCachedResponse(ctx, url.origin, cachePath, resp, 60000);
          } else {
            const headers = new Headers(resp.headers);
            for (const [k, v] of Object.entries(cors)) headers.set(k, v);
            resp = new Response(resp.body, { status: resp.status, headers });
          }
          return resp;
        }
        if (req.method === "PUT") {
          const denied = adminGate(req, url, env, cors);
          if (denied) return denied;
          // kv_state also holds the private config and working rows (persona, discord_members, budgets, votes, ...).
          // They have their own routes (PUT /config/:key, /persona, ...) with validation; this one never writes or broadcasts them.
          // Write allowlist: only the documents the board publishes (public-docs.js). A new internal kv_state key is therefore not writable here by default.
          if (isDeniedKvKey(raw) || !(path.startsWith("/atlas/") ? isPublicAtlasDoc(raw) : isPublicDataDoc(raw))) return jsonResp({ error: `Document ${raw} cannot be written here` }, 403, cors);
          const body = await req.json();
          const now = new Date().toISOString();
          // The document is stored whole, as sent. A hide that commits between a sheet read and this write cannot leak: every read, and the broadcast below, projects.
          await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
            .bind(raw, JSON.stringify(body), now)
            .run();
          const area = path.startsWith("/atlas/") ? "atlas" : "data";
          await purgeWorkerCache(url.origin, ["/api/bootstrap", `/api/${area}/${raw}.json`, `/api/${area}/${raw}`]);
          const isPublicDoc = area === "atlas" ? isPublicAtlasDoc(raw) : isPublicDataDoc(raw);
          // Only a public document's content goes to the sockets; any other key announces the change without its data.
          await broadcastToRoom(env, isPublicDoc ? { type: "data", key: raw, data: area === "data" ? publicDataDoc(raw, body, now) : body } : { type: "data", key: raw });
          return jsonResp({ ok: true, key: raw, updated_at: now }, 200, cors);
        }
      }

      // 5. POST /refresh or POST /intent -> Ask Leeroy, Signups (flat & nested), Journey, Launch, Fact Fix, or Refresh
      if (req.method === "POST" && (path === "/intent" || path === "/refresh")) {
        const auth = await resolveMemberAuth(req, url, env);
        const read = await readJsonCapped(req);
        if (read.tooLarge) return jsonResp({ error: "Body too large" }, 413, cors);
        const body = read.body;
        const kind = path === "/refresh" ? "refresh" : String(body.kind || "");

        // If not authenticated, ONLY allow public guest asking
        if (!auth.ok) {
          if (kind !== "ask") {
            return jsonResp({ error: "Unauthorized board key" }, 401, cors);
          }
        }

        const member = auth.member || null;
        const by = member ? (member.name || member.slug) : "Visitor";
        const memberSlug = member ? member.slug : "guest";
        const now = new Date().toISOString();
        const numericIntentId = Date.now();
        // New ask ids are unguessable (GET /api/ask?id= is open to whoever holds the id); other kinds keep the timestamp id.
        const intentId = kind === "ask" ? crypto.randomUUID() : String(numericIntentId);

        // 5a. `signup` (nested `{ kind: "signup", patch: { rsvp } }` or flat `{ kind: "signup", field, value, place }`)
        if (kind === "signup") {
          const patch =
            body.patch && typeof body.patch === "object"
              ? { ...body.patch }
              : body.field
              ? {
                  [body.field]:
                    body.field === "meet" && body.value === "vos"
                      ? "Valley of Strength"
                      : body.field === "meet" && body.value === "xroads"
                      ? "The Crossroads"
                      : body.value,
                  ...(body.place ? { meet_other: body.place } : {}),
                }
              : {};

          const picked = pickSignupPatch(patch);
          if (picked.error || !Object.keys(picked.patch).length) return jsonResp({ error: picked.error || "No known sign-up field" }, 400, cors);
          let saved;
          try {
            saved = await updateKvJson(env, "signups", async (cur) => {
              const doc = cur || { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [] };
              doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
              const entry = upsertSignupEntry(doc, member);
              for (const [k, v] of Object.entries(picked.patch)) {
                entry[k] = v;
              }
              entry.updated = now;
              await recomputeSignupTallies(doc);
              return { doc, result: entry };
            });
          } catch (e) {
            if (e instanceof KvConflictError) return jsonResp({ error: "The sign-ups card is busy. Try again." }, 409, cors);
            throw e;
          }
          const doc = saved.doc, entry = saved.result;
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "signup",
            body: { patch: picked.patch, entry },
            ver: 1,
            at: now,
          });
          await purgeWorkerCache(url.origin, ["/api/bootstrap", dataCachePath("signups"), "/api/signups"]);
          await broadcastToRoom(env, { type: "data", key: "signups", data: doc });
          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }

        // 5b. `journey` (`{ kind: "journey", patch: { journey } }`)
        if (kind === "journey") {
          const jVal = body.patch && body.patch.journey;
          if (["guided", "curious", "everything"].includes(jVal)) {
            try {
              await updateKvJson(env, "signups", async (cur) => {
                if (!cur) return { skip: true }; // no card yet: nothing to attach the journey to (as before)
                const doc = cur;
                doc.journeys = Array.isArray(doc.journeys) ? doc.journeys : [];
                const jEntry = doc.journeys.find((j) => j.slug === member.slug);
                if (jEntry) jEntry.journey = jVal;
                else doc.journeys.push({ slug: member.slug, name: member.name, journey: jVal });
                return { doc };
              }, { now: () => now });
            } catch (e) {
              if (e instanceof KvConflictError) return jsonResp({ error: "The sign-ups card is busy. Try again." }, 409, cors);
              throw e;
            }
          }
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "journey",
            body: { journey: jVal },
            ver: 1,
            at: now,
          });
          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }

        // 5c. `launch` (`{ kind: "launch", patch: { state: "queue"|"in"|"done" } }`)
        if (kind === "launch") {
          const lState = body.patch && body.patch.state;
          let savedLaunch;
          if (["queue", "in", "done"].includes(lState)) {
            const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'launch'").first();
            let rows = [];
            if (row) {
              try {
                const parsed = JSON.parse(row.json);
                rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
              } catch {}
            }
            const idx = rows.findIndex((r) => r.slug === member.slug);
            const item = { slug: member.slug, name: member.name, state: lState, at: now };
            if (idx >= 0) rows[idx] = item;
            else rows.push(item);
            try {
              savedLaunch = await recordSheetEventInD1(env, url.origin, {
                slug: member.slug,
                name: member.name,
                field: "launch_state",
                value: lState, // value-only: launch_state keeps its visibility
                source: "board",
                at: now,
              });
            } catch (e) {
              if (e instanceof KvConflictError) return jsonResp({ error: "The sheet is busy. Try again." }, 409, cors);
              throw e;
            }
            // the sheet event first: a refused or unreadable events log (503/409/500) must leave NO launch row behind
            await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('launch', ?, ?)")
              .bind(JSON.stringify(rows), now)
              .run();
            await purgeWorkerCache(url.origin, ["/api/bootstrap", dataCachePath("launch")]);
            await broadcastToRoom(env, { type: "data", key: "launch", data: rows });
          }
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "launch",
            body: savedLaunch && savedLaunch.visible === false ? { field: "launch_state", visible: false } : { state: lState }, // hidden launch_state: no value in the mailbox
            ver: 1,
            at: now,
          });
          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }

        // 5d. `ask` (`{ kind: "ask", patch: { text, share, provider } }`)
        if (kind === "ask") {
          const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
          const question = String(patch.text || body.q || body.text || "").trim();
          const isGuest = !auth.ok;
          const isPrPreview = isPrPreviewEnv(env);

          // For public guests, strictly enforce Cloudflare Workers AI and no Discord broadcast
          const requestedProvider = isGuest || isPrPreview ? "workers-ai" : (patch.provider || body.provider || env.AI_PROVIDER);
          const activeProvider = isGuest || isPrPreview ? "workers-ai" : resolveAiProvider(env, requestedProvider);
          const share = isGuest ? false : (patch.share !== undefined ? Boolean(patch.share) : true);
          const askBy = isGuest ? "Visitor" : by;
          const askSlug = isGuest ? "guest" : memberSlug;

          if (!question) return jsonResp({ error: "Missing question" }, 400, cors);
          if (questionTooLong(question)) return jsonResp({ error: `Question is too long (max ${MAX_QUESTION_CHARS} characters)` }, 400, cors);

          // Rate limit check for public guests: 2 questions per hour per IP
          let guestLeft = 6;
          let guestHash = "";
          if (isGuest) {
            const missingSalt = saltProblems(env, ["USER_SALT"]);
            if (missingSalt.length) return jsonResp(saltErrorBody(missingSalt), 503, cors);
            const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
            const ipHash = await guestIpKey(clientIp, env.USER_SALT);
            guestHash = ipHash;
            const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

            // 1. A plain read first: an IP already at 2 gets its 429 with no write at all (refused requests must cost no D1 writes).
            const tooMany = (row) => {
              const oldestTime = row && row.oldest ? Date.parse(row.oldest) : Date.now();
              const retryAfterSec = Math.max(1, Math.ceil((oldestTime + 3600 * 1000 - Date.now()) / 1000));
              return jsonResp(
                { ok: false, why: "limited", error: "Public guest access is limited to 2 questions per hour.", retryAfter: retryAfterSec, left: 0 },
                429,
                cors
              );
            };
            const seen = await env.DB.prepare(
              "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ?"
            )
              .bind(ipHash, oneHourAgo)
              .first();
            if ((seen ? Number(seen.count) || 0 : 0) >= 2) return tooMany(seen);

            // 2. Passed: insert, then count the rows up to and including this one (by rowid). Parallel requests that all passed step 1
            // rank themselves 1, 2, 3, ...: the first 2 are admitted, the rest remove their own row and are refused.
            const ins = await env.DB.prepare("INSERT INTO guest_rate_limits (ip_hash, created_at) VALUES (?, ?)").bind(ipHash, now).run();
            const myRowId = ins && ins.meta ? ins.meta.last_row_id : null;
            const ranked = await env.DB.prepare(
              "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ? AND rowid <= ?"
            )
              .bind(ipHash, oneHourAgo, myRowId || 0)
              .first();
            const guestCount = ranked ? Number(ranked.count) || 0 : 0; // this request's place, 1-based
            if (guestCount > 2) {
              if (myRowId) await env.DB.prepare("DELETE FROM guest_rate_limits WHERE rowid = ?").bind(myRowId).run().catch(() => {});
              return tooMany(ranked);
            }

            // Asynchronously prune expired entries older than 2 hours
            ctx.waitUntil(
              env.DB.prepare("DELETE FROM guest_rate_limits WHERE created_at < ?")
                .bind(new Date(Date.now() - 7200 * 1000).toISOString())
                .run()
                .catch(() => {})
            );

            guestLeft = Math.max(0, 2 - guestCount);
          }

          // A guest's page gets a secret with its ask (only its salted hash is stored): GET /api/ask?id=&s= needs it to read this private turn.
          const guestSecret = isGuest ? newGuestSecret() : "";
          try {
            await insertAskTurn(env, { id: intentId, byName: askBy, question, provider: activeProvider, share, createdAt: now }, isGuest ? { guestSecret } : { slug: memberSlug });
          } catch (e) {
            if (!(e instanceof SaltMissingError)) throw e;
            return jsonResp(saltErrorBody(e.missing), 503, cors);
          }

          const { seq } = await insertIntent(env, {
            slug: askSlug,
            kind: "ask",
            body: { question, by: askBy, provider: activeProvider, share },
            ver: 1,
            at: now,
          });

          const intentItem = {
            id: seq,
            kind: "ask",
            by: askBy,
            slug: askSlug,
            ...(share ? { q: question } : {}), // a private question is never pushed to other sockets
            provider: activeProvider,
            status: "thinking",
            at: now,
          };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          // ASK_RESEARCH on: a signed-in member is never walled (answerWithAi skips the verdict); a guest keeps the rate limit above and gets the guests' own budget keys (research/no-wall.js). Flag off: exactly askBudgetKeys.
          const { budget: askBudget } = await askWallPlan(env, { isMember: !isGuest, userPart: isGuest ? guestHash : await hashId(memberSlug), guest: isGuest, preview: isPrPreview });
          ctx.waitUntil(
            answerWithAi({
              env,
              origin: url.origin,
              intentId,
              by: askBy,
              memberSlug: askSlug,
              question,
              deep: Boolean(body.deep || patch.deep),
              share,
              provider: activeProvider,
              budget: askBudget,
              isMember: !isGuest,
            })
          );

          return jsonResp(
            {
              ok: true,
              id: intentId, // the page polls GET /ask?id= with this, so it must be the ask id, not the intent seq
              seq,
              status: "thinking",
              provider: activeProvider,
              at: now,
              left: isGuest ? guestLeft : 5,
              ...(isGuest ? { secret: guestSecret } : {}),
              ask: { id: intentId, question, by: askBy, status: "thinking", model: activeProvider, at: now },
            },
            200,
            cors
          );
        }

        // 5e. `fix` (flat `{ kind: "fix", page, key, note }` or nested `{ kind: "fix", patch: { page, key, note } }`)
        if (kind === "fix") {
          // Fixes rewrite the pages the AI answers from, so a member key is not enough (lib_pages has no owner to check against).
          if (adminGate(req, url, env, cors)) return jsonResp({ error: "Fact fixes need the admin token" }, 403, cors);
          const src = body.patch && typeof body.patch === "object" ? body.patch : body;
          const pageId = String(src.page || "").trim();
          const factKey = String(src.fact || src.key || "").trim();
          const newVal = String(src.val || src.text || src.note || "").trim();
          const note = String(src.note || "").trim();
          if (!pageId || !factKey || !newVal) {
            return jsonResp({ error: "Missing page, fact, or val" }, 400, cors);
          }

          const pageRow = await env.DB.prepare("SELECT * FROM lib_pages WHERE id = ?").bind(pageId).first();
          if (!pageRow) return jsonResp({ error: `Page ${pageId} not found` }, 404, cors);

          const facts = JSON.parse(pageRow.facts_json || "[]");
          const history = JSON.parse(pageRow.history_json || "[]");
          const existing = facts.find((f) => f.key === factKey);
          const oldVal = existing ? existing.value : null;

          if (existing) {
            existing.value = newVal;
          } else {
            facts.push({ key: factKey, value: newVal, refs: [] });
          }
          history.unshift({
            date: now.slice(0, 10),
            text: `${factKey} updated by ${member.name}${note ? ` (${note})` : ""}`,
          });

          await env.DB.batch([
            env.DB.prepare(
              "UPDATE lib_pages SET facts_json = ?, history_json = ?, checked = ?, updated_at = ? WHERE id = ?"
            ).bind(JSON.stringify(facts), JSON.stringify(history), now.slice(0, 10), now, pageId),
            env.DB.prepare(
              "INSERT INTO fact_fixes (id, page_id, fact_key, old_value, new_value, note, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(intentId, pageId, factKey, oldVal, newVal, note, member.name, now),
          ]);

          await recomputeCategoryAndIndex(env, pageRow.category, {
            date: now.slice(0, 10),
            page: pageId,
            text: `${factKey}: ${newVal}`,
          });
          await purgeWorkerCache(url.origin, [
            "/api/library/index.json",
            "/api/library/search.json",
            "/api/library/open.json",
            ...LIBRARY_PURGE_PATHS,
            `/api/library/${pageRow.category}.json`,
          ]);

          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "fix",
            body: { pageId, factKey, oldVal, newVal, note, by: member.name },
            ver: 1,
            at: now,
          });

          const intentItem = {
            id: seq,
            kind: "fix",
            by: member.name,
            page: pageId,
            fact: factKey,
            status: "applied",
            at: now,
          };
          await broadcastToRoom(env, {
            type: "library",
            categories: [pageRow.category],
            page: pageId,
            intent: intentItem,
          });

          return jsonResp({ ok: true, id: seq, seq, status: "applied" }, 200, cors);
        }

        // 5f. `refresh` (`POST /api/refresh` or `POST /api/intent { kind: "refresh" }`)
        if (kind === "refresh") {
          // One sweep per 15 minutes for the whole board (each changed source costs an AI call).
          const lock = await acquireRefreshCooldown(env);
          if (!lock.ok) {
            return lock.error
              ? jsonResp({ error: "Refresh unavailable, try again later" }, 503, cors)
              : jsonResp({ ok: false, why: "cooldown", error: "A refresh ran recently. Try again later.", retryAfter: lock.retryAfter }, 429, { ...cors, "Retry-After": String(lock.retryAfter) });
          }
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "refresh",
            body: { triggeredBy: member.name },
            ver: 1,
            at: now,
          });

          const intentItem = { id: seq, kind: "refresh", by: member.name, status: "running", at: now };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          ctx.waitUntil(
            runScheduledSourceSweep(env, url.origin, { triggeredBy: member.name, intentId })
          );
          return jsonResp({ ok: true, queued: true, id: seq, seq, status: "running", at: now }, 200, cors);
        }

        return jsonResp({ error: `Unsupported intent kind: ${kind}` }, 400, cors);
      }

      // 6. Health check
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        // One trivial D1 query so a deploy that left the Worker on a missing DB binding or an unreachable D1 is caught (SELECT 1 also succeeds on an empty database, so it does not prove the schema or data). The error is never echoed.
        let dbOk = true;
        try {
          await env.DB.prepare("SELECT 1").first();
        } catch (_) {
          dbOk = false;
        }
        if (!dbOk) {
          return jsonResp({ ok: false, service: "leeroy-brain", db: "error", at: new Date().toISOString() }, 503, cors);
        }
        const body = {
          ok: true,
          service: "leeroy-brain",
          runtime: "cloudflare-workers-d1",
          isPrPreview: isPrPreviewEnv(env),
          db: "ok",
          at: new Date().toISOString(),
        };
        // Provider detail is for the admin token only; a request without it gets the minimal body, not a 401.
        const healthKey = extractKey(req);
        if (env.BOARD_ADMIN_TOKEN && healthKey && timingSafeEqualStr(healthKey, env.BOARD_ADMIN_TOKEN)) {
          const providers = {};
          for (const k of Object.keys(AI_PROVIDER_LABELS)) {
            providers[k] = isProviderConfigured(env, k);
          }
          body.aiProvider = resolveAiProvider(env);
          body.aiGateway = env.AI_GATEWAY_ID || null;
          body.providers = providers;
          body.saltsMissing = saltProblems(env); // names only; a non-empty list means member keys or guest asks are refused
          const budget = await loadBudget(env);
          body.aiBudget = { day: utcDayKey(), neurons: budget.neurons, cap: dailyCap(env), asks: budget.asks, cron: budget.cron };
        }
        return jsonResp(body, 200, cors);
      }

      return jsonResp({ error: "Not found", path }, 404, cors);
    } catch (err) {
      console.error("Worker error:", err, String((err && err.message) || err));
      if (err instanceof SheetLogUnreadableError) return jsonResp({ error: "The sheet could not be saved right now. Try again." }, 503, { ...cors, "Retry-After": "5" });
      return jsonResp({ error: "Internal error" }, 500, cors);
    }
  },

  async scheduled(controller, env, ctx) {
    // The every-minute trigger runs only the timed posts; every other trigger is the source sweep. Timed posts are off until MOMENTS_ENABLED.
    if (controller && controller.cron === MOMENTS_CRON) {
      ctx.waitUntil(
        runMoments(env, { loadSchedule: () => loadConfigKey(env, "moments") }).catch((err) => console.error("moments run failed:", String((err && err.message) || err)))
      );
      // CARDS_ENABLED: the every-minute tick also flushes a due board line and retries an unfinished card edit (no D1 read while the flag is off).
      if (cardsEnabled(env)) ctx.waitUntil(Promise.all([flushBoardLines(env), requestCardEdit(env, { dirty: false })]).catch(() => {}));
      return;
    }
    const origin = env.API_ORIGIN || "https://api.leeroy.party";
    ctx.waitUntil(runScheduledSourceSweep(env, origin));
    ctx.waitUntil(cleanupAnswerUx(env));
    // GROUP_MEMORY (with ASK_RESEARCH): the wiki refresher, one Claude call at most, when 10 new rows or 24 hours have gathered (research/group-wiki.js). No D1 read and no call while either flag is off.
    if (groupWikiCronOn(env)) ctx.waitUntil(maybeRefreshGroupWiki(env, { call: callAnthropicClaude }).catch(() => {}));
    // INTEREST_NUDGES: read-only counts of Interested clicks and reactions on Leeroy's own events and posts (no D1 read, no Discord call while off).
    ctx.waitUntil(collectInterest({ env }).catch((err) => console.error("interest counts failed:", String((err && err.message) || err))));
    // CARDS_ENABLED: this tick also flushes a due board line and retries an unfinished card edit (both no-ops when there is nothing to do).
    if (cardsEnabled(env)) ctx.waitUntil(Promise.all([flushBoardLines(env), requestCardEdit(env, { dirty: false })]).catch(() => {}));
  },
};

// Every response (success, error, preflight, 404) gets the security headers; websocket upgrades pass through.
export default {
  ...worker,
  fetch: async (req, env, ctx) => withSecurityHeaders(await worker.fetch(req, env, ctx)),
};
