// Request gauge (flag REQUEST_GAUGE, default off): the Worker counts its own requests per UTC day, so the owner can see roughly how close the
// account is to the Workers Free limit of 100,000 requests a day. It is an APPROXIMATION. Cloudflare's dashboard "Requests today" is the source of truth.
//
// How it stays cheap (the hot path must not add a Worker request or a D1 write per request):
//   - hit() only adds 1 to an in-memory counter in the running isolate. No await, no D1, no subrequest.
//   - Every FLUSH_EVERY requests, or once FLUSH_MS has passed since the last flush, the pending delta is written with ONE upsert
//     (`n = n + delta`) through ctx.waitUntil, inside the request that tripped the threshold. So D1 row writes are about 1 per FLUSH_EVERY requests (4%),
//     and a UTC day change flushes yesterday's delta to yesterday's row first.
//   - Stored: one row per UTC day { day, n }. No IP, no user id, no path, no header: nothing identifies a visitor.
// What it does not see (so it under-counts, never over-counts):
//   - the delta still in memory when an isolate is evicted (at most FLUSH_EVERY - 1 requests per eviction, production eviction rate is not measurable locally)
//   - a failed flush that is retried only while the isolate lives
//   - cron triggers (scheduled events are not counted here; whether Cloudflare counts them toward the 100,000 is unverified)
//   - requests to OTHER Workers on the account (per-PR preview Workers, which have their own database): the account total is higher
// Requests answered before the Worker runs (static Pages files) are not Worker requests and are not counted.
import { timingSafeEqualStr } from "./crypto.js";
import { extractKey } from "./request-key.js";

export const GAUGE_LIMIT = 100000;
export const FLUSH_EVERY = 25;
export const FLUSH_MS = 60000;
export const gaugeEnabled = (env) => String((env && env.REQUEST_GAUGE) || "").trim().toLowerCase() === "on";
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// The state is per isolate. createGauge exists so tests get a fresh one; the Worker uses the shared instance below.
export function createGauge({ flushEvery = FLUSH_EVERY, flushMs = FLUSH_MS } = {}) {
  const s = { day: null, pending: 0, lastFlush: 0, inflight: 0 };
  const flush = (env, ctx, day, n) => {
    s.inflight += n;
    const p = env.DB.prepare("INSERT INTO request_gauge (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = n + excluded.n").bind(day, n).run()
      .then(() => { s.inflight -= n; })
      .catch(() => { s.inflight -= n; if (s.day === day) s.pending += n; }); // keep the count for the next flush; the error text is not logged (nothing to leak, nothing useful)
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
    return p;
  };
  return {
    // Called once at the top of fetch. Synchronous. Returns nothing the caller needs.
    hit(env, ctx, now = Date.now()) {
      if (!gaugeEnabled(env) || !env.DB) return;
      const day = utcDay(now);
      if (s.day !== null && s.day !== day) { // new UTC day: yesterday's delta goes to yesterday's row
        const old = s.pending; const oldDay = s.day;
        s.pending = 0; s.day = day; s.lastFlush = now;
        if (old > 0) flush(env, ctx, oldDay, old);
      }
      if (s.day === null) { s.day = day; s.lastFlush = now; }
      s.pending++;
      if (s.pending >= flushEvery || now - s.lastFlush >= flushMs) {
        const n = s.pending; s.pending = 0; s.lastFlush = now;
        flush(env, ctx, day, n);
      }
    },
    // Not yet written, in this isolate: pending plus writes in flight. Added to the stored count so the isolate that answers the gauge is exact about itself.
    unflushed(day) { return s.day === day ? s.pending + s.inflight : 0; },
    _state: s,
  };
}
export const gauge = createGauge();

// -> { utcDay, count, limit, pct } for the day of `now`. count = stored row + this isolate's unflushed requests (including the one asking).
export async function readGauge(env, now = Date.now(), g = gauge) {
  const day = utcDay(now);
  const row = await env.DB.prepare("SELECT n FROM request_gauge WHERE day = ?").bind(day).first();
  const count = (row ? Number(row.n) : 0) + g.unflushed(day);
  return { utcDay: day, count, limit: GAUGE_LIMIT, pct: Math.round((count / GAUGE_LIMIT) * 10000) / 100 };
}

const json = (status, body, cors) => new Response(JSON.stringify(body), { status, headers: { ...(cors || {}), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

// GET /admin/requests. Admin token only (checked first), then 404 while the flag is off (nothing is counted then); read only. The caller has matched the route.
export async function handleGauge(req, env, cors, now = Date.now(), g = gauge) {
  if (!env.BOARD_ADMIN_TOKEN) return json(503, { error: "Admin token not configured" }, cors);
  const k = extractKey(req);
  if (!k || !timingSafeEqualStr(k, env.BOARD_ADMIN_TOKEN)) return json(401, { error: "Unauthorized" }, cors); // auth first: a caller without the token cannot tell whether the flag is on
  if (!gaugeEnabled(env)) return json(404, { error: "Not found" }, cors);
  try {
    return json(200, await readGauge(env, now, g), cors);
  } catch (e) {
    return json(500, { error: "gauge failed" }, cors);
  }
}
