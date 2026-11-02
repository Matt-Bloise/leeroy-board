// Noise budget for free-standing Discord posts (board lines today, any unprompted post later).
// The rule it keeps: status lives in pinned cards edited in place, not in new posts. So new posts are rare.
//   - at most `perDay` free-standing posts per channel per local day (default 3; per-day overrides come from the D1 config row `noise`)
//   - quiet hours 1 to 9 AM America/New_York: nothing is posted, the post is held and re-queued with `notBefore`
//   - card edits (PATCH of an existing message) are free and never come through here
// decidePost is pure. The D1 ledger helpers at the bottom store only counts: no message text, no names, no ids but the channel's.
// Day keys and quiet hours use the zone's own calendar through Intl, so a daylight-saving change moves nothing by hand.

export const NOISE_DEFAULTS = Object.freeze({ perDay: 3, quietStart: 1, quietEnd: 9, tz: "America/New_York" });
export const NOISE_MAX_PER_DAY = 50;

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// Wall-clock parts of an instant in a zone.
export function localParts(ms, tz = NOISE_DEFAULTS.tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { year: o.year, month: o.month, day: o.day, hour: o.hour === 24 ? 0 : o.hour, minute: o.minute, second: o.second };
}

export function dayKey(ms, tz = NOISE_DEFAULTS.tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// UTC offset (ms, local minus UTC) of a zone at an instant.
function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// The first instant after `ms` at which the zone's wall clock reads hour:00. Two passes absorb a DST change between now and then.
export function nextLocalHour(ms, hour, tz = NOISE_DEFAULTS.tz) {
  const p = localParts(ms, tz);
  let target = Date.UTC(p.year, p.month - 1, p.day, hour, 0, 0);
  if (target <= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)) target += 86400000;
  let guess = target - offsetAt(ms, tz);
  guess = target - offsetAt(guess, tz);
  return guess;
}

// Merge the D1 `noise` config over the defaults, ignoring anything malformed.
export function resolveConfig(config) {
  const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const q = c.quiet && typeof c.quiet === "object" ? c.quiet : {};
  const overrides = {};
  if (c.overrides && typeof c.overrides === "object" && !Array.isArray(c.overrides)) {
    for (const [day, n] of Object.entries(c.overrides)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && int(n, 0, NOISE_MAX_PER_DAY) !== null) overrides[day] = n;
    }
  }
  let tz = NOISE_DEFAULTS.tz;
  if (typeof q.tz === "string") {
    try { formatter(q.tz); tz = q.tz; } catch { /* unknown zone: keep the default */ }
  }
  return {
    perDay: int(c.perDay, 0, NOISE_MAX_PER_DAY) ?? NOISE_DEFAULTS.perDay,
    overrides,
    quietStart: int(q.start, 0, 23) ?? NOISE_DEFAULTS.quietStart,
    quietEnd: int(q.end, 0, 23) ?? NOISE_DEFAULTS.quietEnd,
    tz,
  };
}

export function validateNoiseConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "noise must be a JSON object";
  for (const k of Object.keys(value)) if (!["perDay", "overrides", "quiet"].includes(k)) return "noise allows perDay, overrides and quiet only";
  if (value.perDay !== undefined && !(Number.isInteger(value.perDay) && value.perDay >= 0 && value.perDay <= NOISE_MAX_PER_DAY)) return `perDay must be an integer from 0 to ${NOISE_MAX_PER_DAY}`;
  if (value.overrides !== undefined) {
    const o = value.overrides;
    if (!o || typeof o !== "object" || Array.isArray(o)) return "overrides must be a JSON object of YYYY-MM-DD to count";
    for (const [d, n] of Object.entries(o)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !(Number.isInteger(n) && n >= 0 && n <= NOISE_MAX_PER_DAY)) return "each override must be YYYY-MM-DD with an integer count";
    }
  }
  if (value.quiet !== undefined) {
    const q = value.quiet;
    if (!q || typeof q !== "object" || Array.isArray(q)) return "quiet must be a JSON object";
    for (const k of Object.keys(q)) if (!["start", "end", "tz"].includes(k)) return "quiet allows start, end and tz only";
    for (const k of ["start", "end"]) if (q[k] !== undefined && !(Number.isInteger(q[k]) && q[k] >= 0 && q[k] <= 23)) return `quiet.${k} must be an hour from 0 to 23`;
    if (q.tz !== undefined) {
      try { formatter(String(q.tz)); } catch { return "quiet.tz must be a valid IANA zone"; }
    }
  }
  return null;
}

export function inQuietHours(ms, cfg) {
  const h = localParts(ms, cfg.tz).hour;
  if (cfg.quietStart === cfg.quietEnd) return false;
  return cfg.quietStart < cfg.quietEnd ? h >= cfg.quietStart && h < cfg.quietEnd : h >= cfg.quietStart || h < cfg.quietEnd;
}

// The ledger day (local calendar date) a post made at `now` counts against; callers read the ledger for this day, then call decidePost.
export function noiseDay(now, config) {
  return dayKey(now, resolveConfig(config).tz);
}

// May one free-standing post go out now?
//   now     epoch ms
//   ledger  { "YYYY-MM-DD": n } posts already made in this channel, by local day
//   config  the D1 `noise` row (or null)
// Returns { ok: true, day } or { ok: false, reason: "quiet_hours" | "budget", notBefore } (notBefore is epoch ms).
export function decidePost({ now, ledger, config } = {}) {
  const cfg = resolveConfig(config);
  const day = dayKey(now, cfg.tz);
  if (inQuietHours(now, cfg)) return { ok: false, reason: "quiet_hours", notBefore: nextLocalHour(now, cfg.quietEnd, cfg.tz) };
  const limit = Object.prototype.hasOwnProperty.call(cfg.overrides, day) ? cfg.overrides[day] : cfg.perDay;
  const used = Number(ledger && ledger[day]) || 0;
  if (used >= limit) return { ok: false, reason: "budget", notBefore: nextLocalHour(now, 0, cfg.tz) };
  return { ok: true, day, used, limit };
}

// ---- D1 ledger: noise_ledger(day TEXT, channel TEXT, n INTEGER, PRIMARY KEY (day, channel)). Counts only.
export async function readLedger(db, channel, day) {
  const row = await db.prepare("SELECT n FROM noise_ledger WHERE day = ? AND channel = ?").bind(day, channel).first();
  return { [day]: row ? Number(row.n) || 0 : 0 };
}

export async function recordPost(db, channel, day) {
  await db
    .prepare("INSERT INTO noise_ledger (day, channel, n) VALUES (?, ?, 1) ON CONFLICT(day, channel) DO UPDATE SET n = n + 1")
    .bind(day, channel)
    .run();
}

// Shadow mode (CARDS_SHADOW): "would edit" and "would post" are counted under a label channel, apart from the real budget. Counts only.
export const shadowChannel = (kind, channel) => `shadow:${kind}:${channel}`;
export async function recordShadow(db, kind, channel, day) {
  await recordPost(db, shadowChannel(kind, channel), day);
}
