// Pure decision logic for the live-smoke retry and for the smoke state that ship.mjs logs (no I/O except appendAlert).
// A check row is [name, ok, extra]. A failed first run is retried once in a fresh context; a check that fails first and passes on the retry is
// "WARN transient" and does not fail; a check that fails twice fails. Used by board/tools/harness/live-smoke.mjs, scripts/ship.mjs and the tests.
import fs from "node:fs";
import path from "node:path";

export const RETRY_DELAY_MS = 25000;

/* retry only when something failed and this context is not an injected-fault one (the worker503 selftest context stays out of it) */
export function needsRetry(rows, { fault = false } = {}) { return !fault && rows.some((r) => !r[1]); }

/* judge the first run against its retry: returns rows [name, ok, extra, transient]. Checks that only the retry has are kept as they are. */
export function mergeRuns(first, retry) {
  const byName = new Map(retry.map((r) => [r[0], r])), retryFails = retry.filter((r) => !r[1]), seen = new Set(), out = [];
  for (const r of first) {
    seen.add(r[0]);
    if (r[1]) { out.push([r[0], true, "", false]); continue; }
    const again = byName.get(r[0]);
    if (again) out.push(again[1] ? [r[0], true, r[2] || "", true] : [r[0], false, again[2], false]);
    /* the retry never ran this check: it passed it only when the retry itself failed nothing */
    else out.push(retryFails.length ? [r[0], false, r[2], false] : [r[0], true, r[2] || "", true]);
  }
  for (const r of retry) if (!seen.has(r[0])) out.push([r[0], r[1], r[2], false]);
  return out;
}

/* the state ship.mjs logs, from live-smoke's exit status and output */
export function smokeState(status, out) {
  if (status !== 0) return "SMOKE FAIL";
  return /^WARN transient /m.test(out || "") ? "smoke warn (transient)" : "smoke ok";
}

export const alertLine = (branch, text, now = new Date()) => JSON.stringify({ at: now.toISOString(), branch, text: String(text).replace(/\s+/g, " ").slice(0, 300) });

export function appendAlert(file, branch, text, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, alertLine(branch, text, now) + "\n");
}

/* newest 5 alerts within 6 hours, newest first; bad lines are skipped */
export function recentAlerts(text, now, { max = 5, windowMs = 6 * 3600e3 } = {}) {
  const out = [];
  for (const l of String(text || "").split("\n")) {
    if (!l.trim()) continue;
    try { const a = JSON.parse(l), at = new Date(a.at); if (!isNaN(at) && at <= now && now - at <= windowMs && a.text) out.push({ at, branch: String(a.branch || ""), text: String(a.text) }); } catch {}
  }
  return out.sort((x, y) => y.at - x.at).slice(0, max);
}
