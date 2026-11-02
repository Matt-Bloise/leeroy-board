// Timed Discord "moments": posts the Worker makes on a schedule so nothing has to run on a personal computer.
// Replaces the old PC bot's moment list. Two halves:
//   1. planMoments(): a pure planner. Given the schedule, the saved state and the clock it returns actions (post, edit, skip). No network, no D1.
//   2. runMoments(): a thin executor. Performs the actions over Discord REST, writing state BEFORE each post (claim) and reconciling after.
// The schedule lives in D1 kv_state key "moments" (admin-only PUT /api/config/moments); the state in key "moments_state".
// Neither is in the repo or served publicly (both are private kv keys): they hold channel and user ids.
// Off by default: nothing is read, planned or posted unless a flag is on. Flags:
//   MOMENTS_ENABLED  live: posts to Discord.
//   MOMENTS_SHADOW   shadow: plans and "posts" against its own state, writes would_post / would_edit rows to the D1 ledger, never calls
//                    Discord. Mutually exclusive with MOMENTS_ENABLED: both on means nothing runs.
//   MOMENTS_DRY_RUN  logs the plan only: no ledger, no state, no Discord.
// The ledger (kv_state "moments_ledger") also records the status and rate-limit headers of every real Discord call.

import { clampContent, ALLOWED_MENTIONS_NONE } from "./discord-safety.js";
import { webBoardLinks } from "./ai-models.js";
import { sha256Hex } from "./crypto.js";

export const MOMENTS_KEY = "moments";
export const MOMENTS_STATE_KEY = "moments_state";
export const MOMENTS_SHADOW_STATE_KEY = "moments_shadow_state"; // what shadow mode believes it has posted; never shared with the live state
export const MOMENTS_LEDGER_KEY = "moments_ledger";
export const LEDGER_MAX = 500;
export const MOMENTS_CRON = "* * * * *";
export const MOMENT_KINDS = ["text", "card", "countdown"];
export const PINGABLE_MOMENT_IDS = Object.freeze(["launch-0"]); // the only moment allowed to ping anyone
export const DEFAULT_LATE_CUTOFF_MINUTES = 30;
export const DEFAULT_COUNTDOWN_MINUTES = 60;
export const MAX_MOMENTS = 50;
export const MAX_ACTIONS_PER_RUN = 10;
export const MAX_ATTEMPTS = 5;
export const CLAIM_WAIT_MS = 60 * 1000; // a fresh claim belongs to a run still in flight: wait
export const CLAIM_RETRY_MS = 3 * 60 * 1000; // past this a claim without a message id is not retried (Discord's nonce window is short)
export const RETRY_AFTER_CAP_MS = 8000;
export const ABANDON_AFTER_MS = 6 * 3600 * 1000; // stop retrying a final edit this long after T-0
export const IMAGE_HOSTS = Object.freeze(["leeroy.party", "www.leeroy.party"]);

const DISCORD_API = "https://discord.com/api/v10";
const EMBED_DESCRIPTION_MAX = 4000;
const EMBED_COLOR = 0xc9a24b;

function isId(v) {
  return typeof v === "string" && /^[0-9]{5,25}$/.test(v);
}

function isIso(v) {
  return typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v) && Number.isFinite(Date.parse(v));
}

function flagOn(v) {
  return typeof v === "string" && ["1", "on", "true", "yes"].includes(v.trim().toLowerCase());
}

export const momentsEnabled = (env) => flagOn(env && env.MOMENTS_ENABLED);
export const momentsDryRun = (env) => flagOn(env && env.MOMENTS_DRY_RUN);
export const momentsShadow = (env) => flagOn(env && env.MOMENTS_SHADOW);

function toMs(now) {
  if (typeof now === "number") return now;
  if (now instanceof Date) return now.getTime();
  return Date.parse(now);
}

// ---- schedule validation (used by PUT /api/config/moments and by the planner)

// Returns an error string, or null when the schedule is well formed.
export function validateSchedule(value) {
  if (!Array.isArray(value)) return "moments must be a JSON array";
  if (value.length > MAX_MOMENTS) return `moments allows at most ${MAX_MOMENTS} entries`;
  const seen = new Set();
  for (const m of value) {
    const err = validateMoment(m);
    if (err) return err;
    if (seen.has(m.id)) return `duplicate moment id ${m.id}`;
    seen.add(m.id);
  }
  return null;
}

export function validateMoment(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "each moment must be an object";
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(m.id)) return "moment id must be lowercase letters, digits and dashes (40 max)";
  const who = `moment ${m.id}`;
  if (!isIso(m.at)) return `${who}: at must be an ISO UTC time ending in Z`;
  if (!isId(m.channelId)) return `${who}: channelId must be a digit string`;
  if (!MOMENT_KINDS.includes(m.kind)) return `${who}: kind must be text, card or countdown`;
  if (typeof m.content !== "string" || !m.content.trim() || m.content.length > 3500) return `${who}: content must be 1 to 3500 characters`;
  if (m.imageUrl !== undefined && m.imageUrl !== null) {
    let u;
    try {
      u = new URL(m.imageUrl);
    } catch {
      return `${who}: imageUrl must be an https URL on the site`;
    }
    if (u.protocol !== "https:" || !IMAGE_HOSTS.includes(u.hostname)) return `${who}: imageUrl must be an https URL on the site`;
  }
  if (m.boardToken !== undefined && m.boardToken !== null && !(typeof m.boardToken === "string" && /^[a-z0-9.-]{1,80}$/.test(m.boardToken))) return `${who}: boardToken must match [a-z0-9.-] (80 max)`;
  if (m.allowPing !== undefined && typeof m.allowPing !== "boolean") return `${who}: allowPing must be true or false`;
  if (m.allowPing === true && !PINGABLE_MOMENT_IDS.includes(m.id)) return `${who}: only ${PINGABLE_MOMENT_IDS.join(", ")} may ping`;
  if (m.allowPing === true && m.kind === "countdown") return `${who}: a countdown cannot ping`;
  if (m.ping !== undefined && m.ping !== null) {
    if (!Array.isArray(m.ping) || m.ping.length > 10 || !m.ping.every(isId)) return `${who}: ping must be an array of up to 10 digit strings`;
  }
  if (m.lateCutoffMinutes !== undefined && !(Number.isInteger(m.lateCutoffMinutes) && m.lateCutoffMinutes >= 0 && m.lateCutoffMinutes <= 1440)) return `${who}: lateCutoffMinutes must be an integer from 0 to 1440`;
  if (m.endsAt !== undefined && m.endsAt !== null) {
    if (m.kind !== "countdown") return `${who}: endsAt is only for a countdown`;
    if (!isIso(m.endsAt)) return `${who}: endsAt must be an ISO UTC time ending in Z`;
    const span = Date.parse(m.endsAt) - Date.parse(m.at);
    if (!(span > 0 && span <= 24 * 3600 * 1000)) return `${who}: endsAt must be after at and within 24 hours`;
  }
  return null;
}

// A validated moment in milliseconds, with defaults filled in. Returns null when invalid.
export function normalizeMoment(m) {
  if (validateMoment(m)) return null;
  const atMs = Date.parse(m.at);
  const pingAllowed = m.allowPing === true && PINGABLE_MOMENT_IDS.includes(m.id) && m.kind !== "countdown";
  return {
    id: m.id,
    kind: m.kind,
    atMs,
    endsAtMs: m.kind === "countdown" ? (m.endsAt ? Date.parse(m.endsAt) : atMs + DEFAULT_COUNTDOWN_MINUTES * 60000) : null,
    channelId: m.channelId,
    content: m.content,
    imageUrl: m.imageUrl || null,
    boardToken: m.boardToken || null,
    ping: pingAllowed && Array.isArray(m.ping) ? [...new Set(m.ping)] : [],
    lateMs: (m.lateCutoffMinutes === undefined ? DEFAULT_LATE_CUTOFF_MINUTES : m.lateCutoffMinutes) * 60000,
  };
}

// ---- message bodies

function remainingLabel(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const r = mins % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  return `${mins}m`;
}

// Body for a post or an edit. `final` marks the T-0 edit of a countdown. Mentions are NONE unless the moment may ping.
export function buildMomentBody(m, nowMs, { final = false, edit = false } = {}) {
  let text = m.content;
  if (m.boardToken) text = `${text}\n{board:${m.boardToken}}`;
  if (m.kind === "countdown") {
    text = final || nowMs >= m.endsAtMs ? `${text}\n**Now.**` : `${text}\nStarts in **${remainingLabel(m.endsAtMs - nowMs)}**`;
  }
  text = webBoardLinks(text);
  const mentions = !edit && m.ping.length ? m.ping : [];
  const body = { allowed_mentions: mentions.length ? { parse: [], users: mentions } : { parse: [] } };
  const pingLine = mentions.filter((id) => !text.includes(`<@${id}>`)).map((id) => `<@${id}>`).join(" ");
  if (m.kind === "text") {
    body.content = clampContent(pingLine ? `${text}\n${pingLine}` : text);
    if (m.imageUrl) body.embeds = [{ image: { url: m.imageUrl }, color: EMBED_COLOR }];
  } else {
    const embed = { description: clampContent(text, EMBED_DESCRIPTION_MAX), color: EMBED_COLOR };
    if (m.imageUrl) embed.image = { url: m.imageUrl };
    body.embeds = [embed];
    body.content = clampContent(pingLine);
  }
  return body;
}

// Discord de-duplicates a create call that repeats a nonce for a few minutes (with enforce_nonce), which makes a retry after an
// unclear failure safe. At most 25 characters.
export function nonceFor(id) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < id.length; i++) {
    a = Math.imul(a ^ id.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ id.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `m${a.toString(36)}${b.toString(36)}`.slice(0, 25);
}

// ---- the planner

const minuteOf = (ms) => Math.floor(ms / 60000);

// schedule: array of moments (raw JSON). state: { moments: { [id]: entry } } or null. now: ms, Date or ISO string.
// Returns actions in schedule order (by time, then position):
//   { type: "post", id, channelId, body, nonce }
//   { type: "edit", id, channelId, messageId, body, final }
//   { type: "skip", id, reason, persist }   persist=false means log only (bad input), true means record it so it is never retried
export function planMoments({ schedule, state, now } = {}) {
  const nowMs = toMs(now);
  const actions = [];
  if (!Number.isFinite(nowMs) || !Array.isArray(schedule)) return actions;
  const entries = (state && state.moments) || {};
  const list = schedule
    .map((raw, i) => ({ raw, i, m: normalizeMoment(raw) }))
    .sort((x, y) => (x.m && y.m ? x.m.atMs - y.m.atMs || x.i - y.i : x.i - y.i));
  const seen = new Set();
  for (const { raw, m } of list) {
    if (!m) {
      actions.push({ type: "skip", id: raw && typeof raw.id === "string" ? raw.id : "?", reason: "invalid", persist: false });
      continue;
    }
    if (seen.has(m.id)) {
      actions.push({ type: "skip", id: m.id, reason: "duplicate_id", persist: false });
      continue;
    }
    seen.add(m.id);
    const e = entries[m.id] || {};
    if (e.status === "done" || e.status === "skipped" || e.status === "deleted") continue;
    if (nowMs < m.atMs) continue;

    // A countdown that is already on screen: edit once per minute, then a final edit at T-0 and it is left alone.
    if (m.kind === "countdown" && e.status === "counting" && e.messageId) {
      if (nowMs >= m.endsAtMs + ABANDON_AFTER_MS) {
        actions.push({ type: "skip", id: m.id, reason: "abandoned", persist: true });
      } else if (nowMs >= m.endsAtMs) {
        actions.push({ type: "edit", id: m.id, plannedAtMs: m.atMs, channelId: m.channelId, messageId: e.messageId, body: buildMomentBody(m, nowMs, { final: true, edit: true }), final: true });
      } else if (minuteOf(nowMs) > minuteOf(Number.isFinite(e.lastEditAt) ? e.lastEditAt : 0)) {
        actions.push({ type: "edit", id: m.id, plannedAtMs: m.atMs, channelId: m.channelId, messageId: e.messageId, body: buildMomentBody(m, nowMs, { edit: true }), final: false });
      }
      continue;
    }

    // Not posted yet (or a post that failed or was interrupted).
    if (nowMs - m.atMs > m.lateMs) {
      actions.push({ type: "skip", id: m.id, reason: "late", persist: true });
      continue;
    }
    if (m.kind === "countdown" && nowMs >= m.endsAtMs) {
      actions.push({ type: "skip", id: m.id, reason: "ended", persist: true });
      continue;
    }
    if ((e.attempts || 0) >= MAX_ATTEMPTS) {
      actions.push({ type: "skip", id: m.id, reason: "too_many_failures", persist: true });
      continue;
    }
    if (e.status === "claimed") {
      const age = Math.max(0, nowMs - (Number.isFinite(e.claimedAt) ? e.claimedAt : 0)); // a claim stamped in the future (clock skew) counts as brand new
      if (!Number.isFinite(e.claimedAt)) {
        actions.push({ type: "skip", id: m.id, reason: "claim_stale", persist: true });
        continue;
      }
      if (age < CLAIM_WAIT_MS) continue; // another run is mid-post
      if (age > CLAIM_RETRY_MS) {
        actions.push({ type: "skip", id: m.id, reason: "claim_stale", persist: true });
        continue;
      }
    }
    actions.push({ type: "post", id: m.id, kind: m.kind, plannedAtMs: m.atMs, channelId: m.channelId, body: { ...buildMomentBody(m, nowMs), nonce: nonceFor(m.id), enforce_nonce: true }, nonce: nonceFor(m.id) });
  }
  return actions;
}

// Status for mission control: no channel ids, user ids, message ids or content.
export function momentsStatus({ schedule, state, now, enabled = false, dryRun = false, shadow = false, ledger = null } = {}) {
  const nowMs = toMs(now);
  const entries = (state && state.moments) || {};
  const rows = [];
  for (const raw of Array.isArray(schedule) ? schedule : []) {
    const m = normalizeMoment(raw);
    if (!m) {
      rows.push({ id: raw && typeof raw.id === "string" ? raw.id : "?", status: "invalid" });
      continue;
    }
    const e = entries[m.id] || {};
    rows.push({
      id: m.id,
      kind: m.kind,
      at: new Date(m.atMs).toISOString(),
      status: e.status || "pending",
      reason: e.reason || null,
      attempts: e.attempts || 0,
      hasMessage: Boolean(e.messageId),
      lastError: e.lastError || null,
      canPing: m.ping.length > 0,
    });
  }
  rows.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  const open = rows.filter((r) => r.at && r.status !== "done" && r.status !== "skipped" && r.status !== "deleted" && r.status !== "invalid");
  const next = open[0] || null;
  return {
    enabled,
    shadow,
    dryRun,
    ledger: ledger ? { entries: ledger.length, last: ledger.slice(-50) } : null,
    now: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
    total: rows.length,
    next: next ? { id: next.id, at: next.at, inMinutes: Number.isFinite(nowMs) ? Math.round((Date.parse(next.at) - nowMs) / 60000) : null } : null,
    done: rows.filter((r) => r.status === "done").map((r) => r.id),
    skipped: rows.filter((r) => r.status === "skipped").map((r) => ({ id: r.id, reason: r.reason })),
    deleted: rows.filter((r) => r.status === "deleted").map((r) => r.id),
    moments: rows,
  };
}

// ---- state stores. A store is { read(): { state, raw }, cas(raw, nextState): boolean }.
// cas writes only when the row still holds `raw` (null means no row yet), so two runs in the same minute cannot both claim a moment.

export function d1Store(env, key = MOMENTS_STATE_KEY, field = "moments") {
  const empty = () => (field === "moments" ? { moments: {} } : { entries: [] });
  return {
    async read() {
      const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(key).first();
      const raw = row && typeof row.json === "string" ? row.json : null;
      let state = empty();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && parsed[field] && typeof parsed[field] === "object") state = parsed;
        } catch {}
      }
      return { state, raw };
    },
    async cas(raw, nextState) {
      const now = new Date().toISOString();
      const json = JSON.stringify(nextState);
      const res =
        raw === null
          ? await env.DB.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(key, json, now).run()
          : await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(json, now, key, raw).run();
      return Boolean(res && res.meta && res.meta.changes === 1);
    },
  };
}

// In-memory store with the same compare-and-swap rule (tests).
export function memoryStore(initial = null, empty = { moments: {} }) {
  let raw = initial === null ? null : JSON.stringify(initial);
  return {
    async read() {
      return { state: raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(empty)), raw };
    },
    async cas(expected, next) {
      if (expected !== raw) return false;
      raw = JSON.stringify(next);
      return true;
    },
    snapshot: () => (raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(empty))),
  };
}

// Apply a change to one moment's entry with compare-and-swap, retrying on a lost race. `fn(entry)` returns the new entry.
async function updateEntry(store, id, fn) {
  for (let i = 0; i < 6; i++) {
    const { state, raw } = await store.read();
    const moments = { ...(state.moments || {}) };
    moments[id] = fn(moments[id] || {});
    if (await store.cas(raw, { ...state, moments })) return true;
  }
  return false;
}

// Append rows to the ledger (newest last, capped). A ledger failure must never stop or change a post, so errors are swallowed.
export async function appendLedger(ledger, rows) {
  if (!ledger || !rows.length) return false;
  try {
    for (let i = 0; i < 6; i++) {
      const { state, raw } = await ledger.read();
      const entries = [...(Array.isArray(state.entries) ? state.entries : []), ...rows].slice(-LEDGER_MAX);
      if (await ledger.cas(raw, { ...state, entries })) return true;
    }
  } catch {}
  return false;
}

// ---- Discord REST

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One call, one retry on 429 honouring retry_after (seconds). Returns { ok, status, json, error, attempts } where attempts lists the
// status and rate-limit headers (X-RateLimit-Remaining, X-RateLimit-Reset-After) of every HTTP response, for the ledger.
export async function discordCall(fetchImpl, token, method, path, body, sleep = defaultSleep) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${DISCORD_API}${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://leeroy.party, 1)" },
        body: JSON.stringify(body),
      });
    } catch {
      attempts.push({ status: 0, error: "network" });
      return { ok: false, status: 0, error: "network", attempts };
    }
    let json = null;
    try {
      json = await res.json();
    } catch {}
    const h = (name) => {
      const v = res.headers && res.headers.get ? res.headers.get(name) : null;
      return v === null || v === undefined || v === "" ? null : Number(v);
    };
    const row = { status: res.status, remaining: h("x-ratelimit-remaining"), resetAfter: h("x-ratelimit-reset-after") };
    if (res.status === 429) row.retryAfter = json && Number.isFinite(Number(json.retry_after)) ? Number(json.retry_after) : h("retry-after");
    attempts.push(row);
    if (res.status === 429 && attempt === 0) {
      const fromBody = json && Number(json.retry_after);
      const fromHeader = h("retry-after");
      const waitMs = Math.ceil((Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 1) * 1000);
      if (waitMs > RETRY_AFTER_CAP_MS) return { ok: false, status: 429, error: "rate_limited", attempts };
      await sleep(waitMs);
      continue;
    }
    if (res.ok) return { ok: true, status: res.status, json, attempts };
    return { ok: false, status: res.status, error: `http_${res.status}`, attempts };
  }
  return { ok: false, status: 429, error: "rate_limited", attempts };
}

// ---- the executor

function logLine(log, event, fields) {
  log(JSON.stringify({ moments: event, ...fields }));
}

const textOf = (body) => (body && (body.content || (body.embeds && body.embeds[0] && body.embeds[0].description))) || "";
const shortHash = async (salt, v) => (await sha256Hex(`${salt}:${v}`)).slice(0, 16);

// env: MOMENTS_ENABLED (live), MOMENTS_SHADOW (ledger only, never Discord), MOMENTS_DRY_RUN (log only), DISCORD_BOT_TOKEN, DB.
// Live and shadow are mutually exclusive: with both on, nothing runs.
// opts (tests): fetchImpl, clock, sleep, store, ledger, loadSchedule, log.
export async function runMoments(env, opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const enabled = momentsEnabled(env);
  const shadow = momentsShadow(env);
  const dry = momentsDryRun(env);
  if (enabled && shadow) {
    logLine(log, "flags_conflict", { problem: "MOMENTS_ENABLED and MOMENTS_SHADOW are both on; nothing runs" });
    return { ran: false, reason: "flags_conflict", done: [] };
  }
  if (!enabled && !shadow && !dry) return { ran: false, reason: "disabled", done: [] };
  const clock = opts.clock || (() => Date.now());
  // Shadow keeps its own state, so turning it off and live on later never inherits a pretend "done".
  const store = opts.store || d1Store(env, shadow ? MOMENTS_SHADOW_STATE_KEY : MOMENTS_STATE_KEY);
  const ledger = dry ? null : opts.ledger || d1Store(env, MOMENTS_LEDGER_KEY, "entries");
  const schedule = opts.loadSchedule ? await opts.loadSchedule() : null;
  if (!Array.isArray(schedule) || schedule.length === 0) return { ran: false, reason: "no_schedule", done: [] };
  const problem = validateSchedule(schedule);
  if (problem) logLine(log, "schedule_invalid", { problem }); // planMoments skips the bad entries and handles the good ones
  const sendsToDiscord = enabled && !dry && !shadow;
  if (sendsToDiscord && !env.DISCORD_BOT_TOKEN) {
    logLine(log, "no_bot_token", {});
    return { ran: false, reason: "no_token", done: [] };
  }
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const sleep = opts.sleep || defaultSleep;
  const token = env.DISCORD_BOT_TOKEN;
  const salt = String(env.KEY_SALT || "moments");
  const attempted = new Set();
  const results = [];
  const mode = shadow ? "shadow" : "live";

  // Shadow never calls Discord: it answers as if Discord had said yes.
  const send = async (action, method, path) => {
    if (!shadow) return discordCall(fetchImpl, token, method, path, action.body, sleep);
    return { ok: true, status: 0, json: { id: `shadow-${action.id}` }, attempts: [], shadow: true };
  };
  // One ledger row per real HTTP response (status + rate-limit headers); in shadow, one would_post / would_edit row.
  const record = async (action, r, nowMs) => {
    if (!ledger) return;
    const rows = [];
    if (shadow) {
      const text = textOf(action.body);
      rows.push({
        at: nowMs, mode, op: action.type === "post" ? "would_post" : "would_edit", id: action.id, final: Boolean(action.final) || undefined,
        plannedAt: new Date(action.plannedAtMs).toISOString(), channelHash: await shortHash(salt, action.channelId),
        contentHash: await shortHash(salt, text), chars: text.length,
      });
    } else {
      for (const a of r.attempts || []) rows.push({ at: nowMs, mode, op: action.type, id: action.id, ...a });
    }
    await appendLedger(ledger, rows);
  };

  for (let n = 0; n < MAX_ACTIONS_PER_RUN * 3 && results.length < MAX_ACTIONS_PER_RUN; n++) {
    const nowMs = clock();
    const { state } = await store.read();
    const plan = planMoments({ schedule, state, now: nowMs });
    const action = plan.find((a) => !attempted.has(`${a.id}:${a.type}`));
    if (!action) break;
    attempted.add(`${action.id}:${action.type}`);

    if (dry) {
      logLine(log, "dry_run", { action: action.type, id: action.id, reason: action.reason, final: action.final, content: action.body && action.body.content, embeds: action.body && action.body.embeds ? action.body.embeds.length : 0, allowed_mentions: action.body && action.body.allowed_mentions });
      results.push({ id: action.id, type: action.type, dry: true });
      continue;
    }

    if (action.type === "skip") {
      logLine(log, "skip", { id: action.id, reason: action.reason, mode });
      if (action.persist) {
        await updateEntry(store, action.id, (e) => ({ ...e, status: "skipped", reason: action.reason, skippedAt: nowMs }));
        await appendLedger(ledger, [{ at: nowMs, mode, op: shadow ? "would_skip" : "skip", id: action.id, reason: action.reason }]);
      }
      results.push({ id: action.id, type: "skip", reason: action.reason });
      continue;
    }

    if (action.type === "post") {
      // Claim first. Losing the compare-and-swap means another run got there; re-plan.
      const { state: fresh, raw } = await store.read();
      const prev = (fresh.moments || {})[action.id] || {};
      if (["done", "skipped", "counting", "deleted"].includes(prev.status)) continue;
      const claimed = await store.cas(raw, { ...fresh, moments: { ...(fresh.moments || {}), [action.id]: { ...prev, status: "claimed", claimedAt: nowMs, attempts: (prev.attempts || 0) + 1 } } });
      if (!claimed) {
        attempted.delete(`${action.id}:post`);
        continue;
      }
      const r = await send(action, "POST", `/channels/${action.channelId}/messages`);
      await record(action, r, nowMs);
      if (r.ok && r.json && typeof r.json.id === "string") {
        await updateEntry(store, action.id, (e) => (action.kind === "countdown"
          ? { ...e, status: "counting", messageId: r.json.id, postedAt: nowMs, lastEditAt: nowMs }
          : { ...e, status: "done", messageId: r.json.id, doneAt: nowMs }));
        logLine(log, shadow ? "would_post" : "posted", { id: action.id });
        results.push({ id: action.id, type: "post", ok: true, shadow: shadow || undefined });
      } else {
        await updateEntry(store, action.id, (e) => ({ ...e, status: "retry", lastError: r.error || "no_message_id", failedAt: nowMs }));
        logLine(log, "post_failed", { id: action.id, error: r.error || "no_message_id" });
        results.push({ id: action.id, type: "post", ok: false, error: r.error || "no_message_id" });
      }
      continue;
    }

    if (action.type === "edit") {
      if (!action.final) {
        // Mark the minute as taken before the call so a second run in the same minute does not edit again. A missed tick is caught
        // up by one edit, never two: the planner emits at most one edit per run and per minute.
        const marked = await updateEntry(store, action.id, (e) => ({ ...e, lastEditAt: nowMs }));
        if (!marked) continue;
      }
      const r = await send(action, "PATCH", `/channels/${action.channelId}/messages/${action.messageId}`);
      await record(action, r, nowMs);
      if (r.status === 404) {
        // Someone deleted the message. Record it and stop editing it; never loop.
        await updateEntry(store, action.id, (e) => ({ ...e, status: "deleted", deletedAt: nowMs }));
        logLine(log, "message_deleted", { id: action.id });
        results.push({ id: action.id, type: "edit", ok: false, deleted: true });
      } else if (r.ok) {
        if (action.final) await updateEntry(store, action.id, (e) => ({ ...e, status: "done", doneAt: nowMs }));
        logLine(log, shadow ? "would_edit" : "edited", { id: action.id, final: action.final });
        results.push({ id: action.id, type: "edit", ok: true, shadow: shadow || undefined });
      } else {
        logLine(log, "edit_failed", { id: action.id, error: r.error });
        results.push({ id: action.id, type: "edit", ok: false, error: r.error });
      }
    }
  }
  return { ran: true, mode, dry, done: results };
}
