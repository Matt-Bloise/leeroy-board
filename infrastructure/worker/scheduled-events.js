// Discord Scheduled Events for the guild: launch night, raid nights and the like, kept in step with data.
//
// Pure planner (planEvents) plus a small executor over Discord REST. The desired events live in D1 kv_state key
// `events_schedule` (written by the admin-token PUT /api/config/events_schedule, never committed). The map from our own
// event key to the Discord event id, with the fields we last sent, lives in kv_state key `scheduled_events`.
//
// Rules the code enforces:
//   - create and update only. Nothing here deletes an event, ever.
//   - only events in our map are PATCHed. An event somebody made by hand in Discord is never seen, let alone touched.
//   - an event whose start time is not in the future is skipped (Discord answers 400 for a past scheduled_start_time).
//   - the plan is computed from the map alone, so a dry run makes no Discord call and an applied run is idempotent:
//     after a successful run the map matches the schedule and the next plan is empty.
// No network at import time and no bindings read at import time.

export const DISCORD_API = "https://discord.com/api/v10";
export const SCHEDULE_KEY = "events_schedule";
export const MAP_KEY = "scheduled_events";

export const ENTITY_TYPE_EXTERNAL = 3; // external event: a place outside Discord, given in entity_metadata.location
export const PRIVACY_LEVEL_GUILD_ONLY = 2; // the only value Discord accepts for guild scheduled events
export const MAX_EVENTS = 50; // desired events kept in the schedule row
export const MAX_ACTIONS_PER_RUN = 20; // keeps one invocation well inside the free plan's subrequest limit
export const MAX_RETRY_WAIT_MS = 10000; // longest 429 wait we will sit through inside one request
export const MAX_RATE_LIMIT_RETRIES = 2;

// Manage Events (1 << 33) or Create Events (1 << 44). Create Events lets the bot create and edit only events it made itself.
export const PERMISSION_MANAGE_EVENTS = 8589934592n;
export const PERMISSION_CREATE_EVENTS = 17592186044416n;
export const PERMISSION_HELP = "Discord refused: the bot needs the Manage Events (bit 33) or Create Events (bit 44) permission in this server. The server owner grants it in Server Settings > Roles; this Worker cannot grant it.";

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAME_MAX = 100;
const LOCATION_MAX = 100;
const DESCRIPTION_MAX = 1000;

function isoOrNull(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// One desired event, normalized. Returns { ok: true, event } or { ok: false, error }.
export function normalizeDesired(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "event must be an object" };
  if (typeof raw.key !== "string" || !KEY_RE.test(raw.key)) return { ok: false, error: "key must be lowercase letters, digits, - or _ (1 to 64)" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > NAME_MAX) return { ok: false, error: `name must be 1 to ${NAME_MAX} characters` };
  const location = typeof raw.location === "string" ? raw.location.trim() : "";
  if (!location || location.length > LOCATION_MAX) return { ok: false, error: `location must be 1 to ${LOCATION_MAX} characters` };
  const start = isoOrNull(raw.start);
  const end = isoOrNull(raw.end);
  if (!start) return { ok: false, error: "start must be an ISO 8601 date-time" };
  if (!end) return { ok: false, error: "end must be an ISO 8601 date-time (Discord requires one for external events)" };
  if (Date.parse(end) <= Date.parse(start)) return { ok: false, error: "end must be after start" };
  let description = "";
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== "string" || raw.description.length > DESCRIPTION_MAX) return { ok: false, error: `description must be text up to ${DESCRIPTION_MAX} characters` };
    description = raw.description;
  }
  return { ok: true, event: { key: raw.key, name, location, start, end, description } };
}

// Shape check for PUT /api/config/events_schedule. Returns an error string or null.
export function validateSchedule(value) {
  if (!Array.isArray(value)) return "events_schedule must be a JSON array";
  if (value.length > MAX_EVENTS) return `events_schedule holds at most ${MAX_EVENTS} events`;
  const seen = new Set();
  for (const raw of value) {
    const r = normalizeDesired(raw);
    if (!r.ok) return r.error;
    if (seen.has(r.event.key)) return "event keys must be unique";
    seen.add(r.event.key);
  }
  return null;
}

// The part of an event we compare and send. Same shape for desired events and for map entries.
function fingerprint(e) {
  return { name: e.name, location: e.location, start: e.start, end: e.end, description: e.description || "" };
}
function sameFields(a, b) {
  return a.name === b.name && a.location === b.location && a.start === b.start && a.end === b.end && (a.description || "") === (b.description || "");
}

// Discord request body for one event. privacy_level and entity_type are constants, never read from data.
export function buildEventBody(e) {
  const body = {
    name: e.name,
    privacy_level: PRIVACY_LEVEL_GUILD_ONLY,
    entity_type: ENTITY_TYPE_EXTERNAL,
    entity_metadata: { location: e.location },
    scheduled_start_time: e.start,
    scheduled_end_time: e.end,
  };
  if (e.description) body.description = e.description;
  return body;
}

// planEvents({ desired, existing, now })
//   desired:  array of { key, name, location, start, end, description? }
//   existing: our map, { [key]: { id, name, location, start, end, description } }; events not in it are not ours
//   now:      Date, epoch ms or ISO string
// Returns { actions, skipped }. actions: { action: "create" | "update", key, id?, body }. skipped: { key, reason } with
// reason "past", "unchanged" or "invalid: ...". Keys in the map but not in desired produce nothing: no delete exists.
export function planEvents({ desired, existing, now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  const owned = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const actions = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of Array.isArray(desired) ? desired : []) {
    const r = normalizeDesired(raw);
    if (!r.ok) {
      skipped.push({ key: raw && typeof raw.key === "string" ? raw.key : null, reason: `invalid: ${r.error}` });
      continue;
    }
    const e = r.event;
    if (seen.has(e.key)) {
      skipped.push({ key: e.key, reason: "invalid: duplicate key" });
      continue;
    }
    seen.add(e.key);
    if (Number.isNaN(nowMs) || Date.parse(e.start) <= nowMs) {
      skipped.push({ key: e.key, reason: "past" });
      continue;
    }
    const mine = Object.prototype.hasOwnProperty.call(owned, e.key) ? owned[e.key] : null;
    if (!mine || typeof mine.id !== "string" || !mine.id) {
      actions.push({ action: "create", key: e.key, body: buildEventBody(e) });
    } else if (sameFields(fingerprint(e), fingerprint(mine))) {
      skipped.push({ key: e.key, reason: "unchanged" });
    } else {
      actions.push({ action: "update", key: e.key, id: mine.id, body: buildEventBody(e) });
    }
  }
  return { actions, skipped };
}

function entryFor(e, id) {
  return { id, ...fingerprint(e) };
}
// Fingerprint stored after Discord accepted a body.
function entryFromBody(body, id) {
  return { id, name: body.name, location: body.entity_metadata.location, start: body.scheduled_start_time, end: body.scheduled_end_time, description: body.description || "" };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retryAfterMs(res) {
  let secs = NaN;
  try {
    const j = await res.json();
    secs = Number(j && j.retry_after);
  } catch {
    // no JSON body
  }
  if (!Number.isFinite(secs)) secs = Number(res.headers && res.headers.get ? res.headers.get("Retry-After") : NaN);
  if (!Number.isFinite(secs) || secs < 0) secs = 1;
  return Math.ceil(secs * 1000);
}

// One Discord call with 429 handling. Returns { res } or { rateLimited: true, retryAfterMs }.
async function discordCall(fetchImpl, sleep, url, init) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429) return { res };
    const wait = await retryAfterMs(res);
    if (attempt >= MAX_RATE_LIMIT_RETRIES || wait > MAX_RETRY_WAIT_MS) return { rateLimited: true, retryAfterMs: wait };
    await sleep(wait);
  }
}

// applyPlan({ plan, existing, guildId, token, fetchImpl, sleep })
// Runs create and update calls one at a time. Stops at the first 401/403 (nothing later can succeed) and at an exhausted 429
// (the rest runs on the next sync). Never throws on a Discord answer; the token is only ever put in the Authorization header.
// Returns { ok, results, map, changed, stopped?, error?, retry_after_ms? } where map is the new key -> entry map to persist.
export async function applyPlan({ plan, existing, guildId, token, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const map = { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}) };
  const results = [];
  const out = { ok: true, results, map, changed: false };
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const base = `${DISCORD_API}/guilds/${guildId}/scheduled-events`;
  const todo = (plan && plan.actions ? plan.actions : []).slice(0, MAX_ACTIONS_PER_RUN);
  const deferred = (plan && plan.actions ? plan.actions.length : 0) - todo.length;
  if (deferred > 0) out.deferred = deferred;

  for (const a of todo) {
    let call;
    try {
      const isUpdate = a.action === "update";
      call = await discordCall(fetchImpl, sleep, isUpdate ? `${base}/${a.id}` : base, { method: isUpdate ? "PATCH" : "POST", headers, body: JSON.stringify(a.body) });
    } catch {
      results.push({ key: a.key, action: a.action, ok: false, error: "Discord request failed" });
      out.ok = false;
      continue;
    }
    if (call.rateLimited) {
      results.push({ key: a.key, action: a.action, ok: false, status: 429, error: "rate limited" });
      out.ok = false;
      out.stopped = "rate_limited";
      out.retry_after_ms = call.retryAfterMs;
      break;
    }
    const res = call.res;
    if (res.status === 401 || res.status === 403) {
      await res.arrayBuffer().catch(() => {});
      results.push({ key: a.key, action: a.action, ok: false, status: res.status });
      out.ok = false;
      out.stopped = res.status === 403 ? "forbidden" : "unauthorized";
      out.error = res.status === 403 ? PERMISSION_HELP : "Discord rejected the bot token";
      break;
    }
    if (a.action === "update" && res.status === 404) {
      // The event was deleted in Discord by hand. Forget it; the next sync creates it again. We never delete anything ourselves.
      await res.arrayBuffer().catch(() => {});
      delete map[a.key];
      out.changed = true;
      results.push({ key: a.key, action: a.action, ok: false, status: 404, error: "event no longer exists in Discord; it will be created on the next sync" });
      out.ok = false;
      continue;
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      results.push({ key: a.key, action: a.action, ok: false, status: res.status, error: "Discord refused the event" });
      out.ok = false;
      continue;
    }
    let id = a.id;
    if (a.action === "create") {
      try {
        const j = await res.json();
        id = j && typeof j.id === "string" ? j.id : null;
      } catch {
        id = null;
      }
      if (!id) {
        results.push({ key: a.key, action: a.action, ok: false, status: res.status, error: "Discord answered without an event id" });
        out.ok = false;
        continue;
      }
    } else {
      await res.arrayBuffer().catch(() => {});
    }
    map[a.key] = entryFromBody(a.body, id);
    out.changed = true;
    results.push({ key: a.key, action: a.action, ok: true, status: res.status });
  }
  return out;
}

// ---- D1 helpers (fresh reads: this runs rarely and must not act on a cached schedule)
async function readRow(db, key) {
  try {
    const row = await db.prepare("SELECT json FROM kv_state WHERE key = ?").bind(key).first();
    return row ? JSON.parse(row.json) : null;
  } catch {
    return null;
  }
}
export async function loadSchedule(db) {
  const v = await readRow(db, SCHEDULE_KEY);
  return Array.isArray(v) ? v : [];
}
export async function loadMap(db) {
  const v = await readRow(db, MAP_KEY);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
async function saveMap(db, map, nowIso) {
  await db.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(MAP_KEY, JSON.stringify(map), nowIso).run();
}

export function eventsEnabled(env) {
  return !!env && String(env.EVENTS_ENABLED || "").toLowerCase() === "on";
}

// POST /api/admin/events/sync after the admin gate. `dry` is true unless the caller passed dry=0.
// Returns { status, body }. Dry run reads D1 only: no Discord call, no token needed, nothing written.
export async function runSync({ env, dry = true, now = new Date(), fetchImpl = fetch, sleep = defaultSleep, guildId = null } = {}) {
  const desired = await loadSchedule(env.DB);
  const existing = await loadMap(env.DB);
  const plan = planEvents({ desired, existing, now });
  const summary = { create: plan.actions.filter((a) => a.action === "create").length, update: plan.actions.filter((a) => a.action === "update").length, skipped: plan.skipped.length };
  const view = { actions: plan.actions.map((a) => ({ action: a.action, key: a.key, body: a.body })), skipped: plan.skipped, summary };
  if (dry) return { status: 200, body: { ok: true, dry: true, ...view } };
  if (plan.actions.length === 0) return { status: 200, body: { ok: true, dry: false, ...view, results: [] } };
  if (!env.DISCORD_BOT_TOKEN) return { status: 503, body: { error: "Discord bot token not configured" } };
  if (!guildId) return { status: 503, body: { error: "discord_roster guildId is not configured" } };
  const r = await applyPlan({ plan, existing, guildId, token: env.DISCORD_BOT_TOKEN, fetchImpl, sleep });
  if (r.changed) await saveMap(env.DB, r.map, new Date().toISOString());
  const body = { ok: r.ok, dry: false, ...view, results: r.results };
  if (r.error) body.error = r.error;
  if (r.stopped) body.stopped = r.stopped;
  if (r.retry_after_ms !== undefined) body.retry_after_ms = r.retry_after_ms;
  if (r.deferred) body.deferred = r.deferred;
  const status = r.ok ? 200 : r.stopped === "forbidden" ? 403 : r.stopped === "rate_limited" ? 429 : r.stopped === "unauthorized" ? 502 : 502;
  return { status, body };
}
