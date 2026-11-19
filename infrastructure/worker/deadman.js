// The dead-man check: detection that lives OUTSIDE the PC. docs/runbooks/deadman.md.
//   POST /api/heartbeat          the PC side (bot, session) sends a signed heartbeat about once a minute; one kv_state row records the last one per source.
//   POST /api/heartbeat/status   signed read of that row and the open incidents (tools/deadman-status.mjs).
//   runDeadmanCheck(env)         one more step of the existing one-minute cron: a source silent for DEADMAN_STALE_SECONDS gets one open incidents row; its next heartbeat closes it.
// Flag DEADMAN ("off" default; only the exact value "on" turns it on). Off: both routes answer 404, the cron step returns at once and nothing is read or written. Never in a PR preview.
// Keys: one independent key per source ("leeroy-heartbeat-v1:<source>") and a separate read-only key for the status route ("leeroy-heartbeat-status-v1"), all derived from the bot token (listener-config.js).
// A listener, self-test or shadow signature, another source's key, or the status key never verifies on a heartbeat; a heartbeat key never opens the status route.
// Signature and headers are the listener's: X-Listen-Timestamp / X-Listen-Signature, 120 s window. No friend data in a body, a row or a response. NO outbound message of any kind: alerting is NOT built (notifyIncident below is a stub).
import { isPrPreviewEnv } from "./ai-models.js";
import { heartbeatKeyFor, heartbeatStatusKeyFor, verifyListen } from "./listener-config.js";
import { updateKvJson } from "./kv-cas.js";
import { readBounded } from "./listener.js";

export const DEADMAN_FLAG = "DEADMAN";
export const deadmanOn = (env) => String((env && env[DEADMAN_FLAG]) || "").trim().toLowerCase() === "on";

export const HEARTBEAT_ROW = "heartbeat"; // kv_state key
export const HEARTBEAT_MAX_BODY = 1024;
export const HEARTBEAT_SOURCES = Object.freeze(["pc-bot", "pc-session"]);
export const HEARTBEAT_PURPOSE = "heartbeat";
export const STATUS_PURPOSE = "heartbeat-status";
export const HEARTBEAT_MIN_WRITE_MS = 20 * 1000; // at most one write per source per 20 s; extra calls answer 200 recorded:false
export const STALE_DEFAULT_S = 300;
export const STALE_MIN_S = 120;
export const STALE_MAX_S = 3600;
const MAX_OPEN_LISTED = 20;

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

// DEADMAN_STALE_SECONDS: a number clamped to 120..3600; unset or anything else is 300.
export function staleSeconds(env) {
  const raw = env && env.DEADMAN_STALE_SECONDS;
  const n = typeof raw === "number" ? raw : /^\s*\d{1,7}\s*$/.test(String(raw ?? "")) ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return STALE_DEFAULT_S;
  return Math.min(STALE_MAX_S, Math.max(STALE_MIN_S, Math.floor(n)));
}
// DEADMAN_EXPECT: a comma list of sources expected even before their first heartbeat. Only names from the fixed list count.
export function expectedSources(env) {
  return String((env && env.DEADMAN_EXPECT) || "").split(",").map((s) => s.trim()).filter((s) => HEARTBEAT_SOURCES.includes(s));
}

// The ONLY body a heartbeat accepts: {"purpose":"heartbeat","source":<fixed list>} and optionally "seq" (a non-negative integer). Any other key, value or type is refused.
export function parseHeartbeatBody(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.some((k) => !["purpose", "source", "seq"].includes(k))) return null;
  if (v.purpose !== HEARTBEAT_PURPOSE || !HEARTBEAT_SOURCES.includes(v.source)) return null;
  if ("seq" in v && !(Number.isSafeInteger(v.seq) && v.seq >= 0)) return null;
  return { source: v.source, seq: "seq" in v ? v.seq : null };
}
export const isStatusBody = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && v.purpose === STATUS_PURPOSE;

// Shared front of both routes. -> { res } to answer now, or { checked, source } once the signature has been verified with the key that route and source own.
//   "heartbeat": the key is the claimed source's own, chosen from the (still unverified) body; a body without a listed source cannot be signed by anyone, so it is 401.
//   "status":    the one read-only status key.
async function gate(req, env, kind, validate) {
  if (!deadmanOn(env) || isPrPreviewEnv(env)) return { res: json({ error: "not found" }, 404) };
  if (!(await heartbeatStatusKeyFor(env))) return { res: json({ error: "not found" }, 404) }; // no usable bot token
  const raw = await readBounded(req, HEARTBEAT_MAX_BODY);
  if (raw === null) return { res: json({ error: "too large" }, 413) };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  let source = null;
  let key = null;
  if (kind === "heartbeat") {
    source = parsed && typeof parsed === "object" && !Array.isArray(parsed) && HEARTBEAT_SOURCES.includes(parsed.source) ? parsed.source : null;
    key = source ? await heartbeatKeyFor(env, source) : null;
  } else key = await heartbeatStatusKeyFor(env);
  const ok = key ? await verifyListen(key, req.headers.get("X-Listen-Timestamp"), raw, req.headers.get("X-Listen-Signature"), Math.floor(Date.now() / 1000)) : false;
  if (!ok) return { res: json({ error: "unauthorized" }, 401) };
  const checked = validate(parsed); // after the signature: a validly signed body of another shape is refused before anything is stored
  if (!checked) return { res: json({ error: "bad body" }, 400) };
  return { checked, source };
}

// Closes the source's open incident, if any. A no-match UPDATE writes no row. -> true when nothing is left open (or the table does not exist yet: deploy before migration 0015), false when D1 failed.
async function closeOpenIncident(env, source, nowMs) {
  try {
    const at = new Date(nowMs).toISOString();
    await env.DB.prepare("UPDATE incidents SET closed_at = ?, last_seen_at = ? WHERE source = ? AND closed_at IS NULL").bind(at, at, source).run();
    return true;
  } catch (e) {
    return /no such table/i.test(String((e && e.message) || e));
  }
}

// deps.now: a clock returning a Date.
//   Replay: the signed timestamp must be strictly greater than the last accepted one for the source (stored in the row), so a captured request, throttled or not, is refused once a later one was accepted,
//   and liveness is never moved past the time the PC actually signed: lastAt = max(previous, min(now, signed time)).
export async function handleHeartbeat(req, env, deps = {}) {
  const g = await gate(req, env, "heartbeat", parseHeartbeatBody);
  if (g.res) return g.res;
  const { source, seq } = g.checked;
  const nowMs = (deps.now || (() => new Date()))().getTime();
  const signedS = Number(req.headers.get("X-Listen-Timestamp")); // an integer: verifyListen refused anything else
  let replay = false;
  let throttled = false;
  try {
    await updateKvJson(env, HEARTBEAT_ROW, (cur) => {
      replay = false; throttled = false; // a lost compare-and-set race recomputes from the fresh row
      const doc = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
      const prev = doc[source] && typeof doc[source] === "object" ? doc[source] : {};
      if (signedS <= (Number.isFinite(prev.ts) ? prev.ts : 0)) { replay = true; return { skip: true }; }
      const lastAt = Number.isFinite(prev.lastAt) ? prev.lastAt : 0;
      if (nowMs - lastAt < HEARTBEAT_MIN_WRITE_MS) { throttled = true; return { skip: true }; }
      return { doc: { ...doc, [source]: { lastAt: Math.max(lastAt, Math.min(nowMs, signedS * 1000)), ts: signedS, seq: seq ?? (Number.isSafeInteger(prev.seq) ? prev.seq : null), count: (Number.isSafeInteger(prev.count) ? prev.count : 0) + 1 } } };
    }, { tries: 3, now: () => new Date(nowMs).toISOString() });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (replay) return json({ error: "replay" }, 409);
  // The source is alive: close its open incident. Also on a throttled call, so a sender that retries after a failed close gets it closed. A failed close is NOT success: 503 makes the sender retry.
  if (!(await closeOpenIncident(env, source, nowMs))) return json({ error: "unavailable" }, 503);
  return json({ ok: true, recorded: !throttled });
}

export async function handleHeartbeatStatus(req, env, deps = {}) {
  const g = await gate(req, env, "status", (v) => (isStatusBody(v) ? true : null));
  if (g.res) return g.res;
  const nowMs = (deps.now || (() => new Date()))().getTime();
  let doc = null;
  let incidents = [];
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(HEARTBEAT_ROW).first();
    doc = row ? JSON.parse(row.json) : null;
    const { results } = await env.DB.prepare("SELECT id, source, kind, opened_at, last_seen_at FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT ?").bind(MAX_OPEN_LISTED).all();
    incidents = (results || []).map((r) => ({ id: r.id, source: r.source, kind: r.kind, openedAt: r.opened_at, lastSeenAt: r.last_seen_at || null }));
  } catch { return json({ error: "unavailable" }, 503); } // never an empty list that could be read as "no incident"
  const sources = HEARTBEAT_SOURCES.filter((s) => doc && doc[s] && Number.isFinite(doc[s].lastAt)).map((s) => ({ source: s, ageSeconds: Math.max(0, Math.floor((nowMs - doc[s].lastAt) / 1000)), seq: Number.isSafeInteger(doc[s].seq) ? doc[s].seq : null, count: Number.isSafeInteger(doc[s].count) ? doc[s].count : 0 }));
  return json({ ok: true, staleSeconds: staleSeconds(env), sources, openIncidents: incidents });
}

// ALERTING IS NOT BUILT. This is the hook a later change will fill in. A separate flag, DEADMAN_ALERT (off), will be added AFTER the owner decides who is notified and how.
// Until then this does nothing and returns: no outbound message, no fetch, no Discord call, no email, no webhook. It receives only the incident row (no friend data exists in it).
export function notifyIncident(env, incident) { // eslint-disable-line no-unused-vars
  return;
}

// The cron step. One kv_state read; when a source is stale, at most one D1 batch (an insert per stale source that has no open incident). Idempotent across runs.
// Never throws: the caller also wraps it. opts.now: a clock returning a Date.
export async function runDeadmanCheck(env, opts = {}) {
  if (!deadmanOn(env) || isPrPreviewEnv(env)) return { ran: false };
  try {
    const nowMs = (opts.now || (() => new Date()))().getTime();
    const limitMs = staleSeconds(env) * 1000;
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(HEARTBEAT_ROW).first();
    const doc = row ? JSON.parse(row.json) : {};
    const expected = new Set(expectedSources(env));
    const names = HEARTBEAT_SOURCES.filter((s) => expected.has(s) || (doc && doc[s] && Number.isFinite(doc[s].lastAt)));
    const stale = [];
    for (const s of names) {
      const lastAt = doc && doc[s] && Number.isFinite(doc[s].lastAt) ? doc[s].lastAt : null;
      if (lastAt === null) { stale.push({ source: s, kind: "never_seen", lastAt: null, silentS: null }); continue; }
      const silentMs = nowMs - lastAt;
      if (silentMs > limitMs) stale.push({ source: s, kind: "stale", lastAt, silentS: Math.floor(silentMs / 1000) });
    }
    if (!stale.length) return { ran: true, opened: 0 };
    const openedAt = new Date(nowMs).toISOString();
    const incidents = stale.map((x) => ({
      id: crypto.randomUUID(), source: x.source, kind: x.kind, opened_at: openedAt,
      last_seen_at: x.lastAt === null ? null : new Date(x.lastAt).toISOString(),
      detail: x.kind === "never_seen" ? `expected, no heartbeat ever received (limit ${limitMs / 1000}s)` : `no heartbeat for ${x.silentS}s (limit ${limitMs / 1000}s)`,
    }));
    // ATOMIC with the freshness check. The snapshot above can be stale by the time this runs (a heartbeat may land in between, or another cron run may have opened and a heartbeat closed an incident), so each insert
    // re-checks, inside the one statement: no open incident for the source AND the heartbeat row's CURRENT lastAt for it is still older than the cutoff (or absent). A heartbeat that landed first wins.
    // The unique partial index idx_incidents_open is the last backstop for one open incident per source.
    const cutoff = nowMs - limitMs;
    const stmts = incidents.map((i) => env.DB.prepare(
      "INSERT OR IGNORE INTO incidents (id, source, kind, opened_at, last_seen_at, closed_at, detail) SELECT ?, ?, ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM incidents WHERE source = ? AND closed_at IS NULL) AND COALESCE((SELECT CAST(json_extract(json, ?) AS INTEGER) FROM kv_state WHERE key = '" + HEARTBEAT_ROW + "'), 0) < ?"
    ).bind(i.id, i.source, i.kind, i.opened_at, i.last_seen_at, i.detail, i.source, `$."${i.source}"."lastAt"`, cutoff));
    const res = await env.DB.batch(stmts);
    let opened = 0;
    incidents.forEach((inc, idx) => {
      const changes = res && res[idx] && res[idx].meta ? Number(res[idx].meta.changes) : 0;
      if (changes === 1) { opened++; try { notifyIncident(env, { id: inc.id, source: inc.source, kind: inc.kind, openedAt: inc.opened_at }); } catch {} }
    });
    if (opened) console.log(JSON.stringify({ evt: "deadman_incident", opened, sources: incidents.map((i) => i.source) }));
    return { ran: true, opened };
  } catch (err) {
    console.warn(JSON.stringify({ evt: "deadman_check_failed" }));
    return { ran: true, error: true };
  }
}
