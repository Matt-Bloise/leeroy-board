// Board decision lines: when sign-ups change, wait for a 5-minute quiet window, then post ONE silent line summarising the changes.
//   "From the board: Ada is tentative."  Several changes share one line. At most 120 characters. Display names only.
//   Only sign-up state (in, tentative, running late, out) is ever reported. Pack, meeting point and time changes are not.
// The post is a free-standing post, so it goes through the noise budget (noise.js: perDay, quiet hours) like any unprompted post.
// Flags: CARDS_ENABLED must be on; a real post also needs BOARD_LINES_ENABLED (default off); CARDS_SHADOW=1 only records "would post".
// Pending state lives in kv_state `board_lines_pending`: display names and states, no ids. It is flushed on the next interaction and on
// every scheduled tick, including the every-minute one in wrangler.toml, so a line goes out about a minute after its window.

import { RSVP_STATES, RSVP_PHRASE, cleanName, cardsEnabled, cardsShadow, boardLinesEnabled, loadCards, discordRest } from "./cards.js";
import { decidePost, noiseDay, readLedger, recordPost, recordShadow } from "./noise.js";
import { lookupRosterId } from "./announce.js";
import { loadConfigKey } from "./config.js";

export const PENDING_KEY = "board_lines_pending";
export const QUIET_WINDOW_MS = 5 * 60 * 1000;
export const LINE_MAX = 120;
export const SUPPRESS_NOTIFICATIONS = 4096; // message flag SUPPRESS_NOTIFICATIONS (1 << 12): https://discord.com/developers/docs/resources/message#message-object-message-flags
const PREFIX = "From the board: ";

// Name-level rsvp differences between two sign-up documents. A removed entry or an unknown state reports nothing.
export function diffRsvp(before, after) {
  const prev = new Map();
  for (const e of Array.isArray(before && before.entries) ? before.entries : []) prev.set(String(e.name || "").toLowerCase(), RSVP_STATES.includes(e.rsvp) ? e.rsvp : null);
  const out = [];
  for (const e of Array.isArray(after && after.entries) ? after.entries : []) {
    if (!RSVP_STATES.includes(e.rsvp)) continue;
    const from = prev.has(String(e.name || "").toLowerCase()) ? prev.get(String(e.name || "").toLowerCase()) : null;
    if (from !== e.rsvp) out.push({ name: cleanName(e.name), key: String(e.name || "").toLowerCase(), from, to: e.rsvp });
  }
  return out;
}

// Fold changes into the pending record. The first `from` per person is kept, the latest `to` wins, and a person who ends where they began
// drops out. Returns null when nothing is left to say. pending = { lastChangeAt, notBefore?, changes: { key: { name, from, to } } }.
export function recordChanges(pending, changes, now) {
  const next = { lastChangeAt: now, changes: { ...(pending && pending.changes) } };
  if (pending && pending.notBefore) next.notBefore = pending.notBefore;
  for (const c of changes) {
    const cur = next.changes[c.key];
    const from = cur ? cur.from : c.from;
    if (from === c.to) delete next.changes[c.key];
    else next.changes[c.key] = { name: c.name, from, to: c.to };
  }
  return Object.keys(next.changes).length ? next : null;
}

export function isDue(pending, now) {
  if (!pending || !pending.changes || !Object.keys(pending.changes).length) return false;
  if (now - pending.lastChangeAt < QUIET_WINDOW_MS) return false;
  return !(pending.notBefore && now < pending.notBefore);
}

const joinList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// One line, at most 120 characters. When the names do not fit, the tail becomes "and N more".
export function composeLine(changes) {
  const items = Object.values(changes || {}).filter((c) => c && RSVP_PHRASE[c.to]).map((c) => `${cleanName(c.name)} ${RSVP_PHRASE[c.to]}`);
  if (!items.length) return "";
  for (let k = items.length; k >= 1; k--) {
    const shown = items.slice(0, k);
    if (k < items.length) shown.push(`${items.length - k} more`);
    const line = `${PREFIX}${joinList(shown)}.`;
    if (line.length <= LINE_MAX) return line;
  }
  return `${PREFIX}${items.length} sign-ups changed.`.slice(0, LINE_MAX);
}

// ---- D1 -------------------------------------------------------------------------------------------------------------------------
async function readPending(db) {
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = ?").bind(PENDING_KEY).first();
  if (!row) return { raw: null, pending: null };
  try { return { raw: row.json, pending: JSON.parse(row.json) }; } catch { return { raw: row.json, pending: null }; }
}

async function writePending(db, raw, next, now) {
  const at = new Date(now).toISOString();
  if (next === null) {
    if (raw === null) return true;
    const r = await db.prepare("DELETE FROM kv_state WHERE key = ? AND json = ?").bind(PENDING_KEY, raw).run();
    return Boolean(r && r.meta && r.meta.changes > 0);
  }
  const json = JSON.stringify(next);
  const r = raw === null
    ? await db.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(PENDING_KEY, json, at).run()
    : await db.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(json, at, PENDING_KEY, raw).run();
  return Boolean(r && r.meta && r.meta.changes > 0);
}

// Called after a sign-up document changed. Records rsvp changes for a later line. Never throws.
export async function noteSignupChange(env, before, after, now = Date.now()) {
  try {
    if (!cardsEnabled(env) || !env.DB) return { status: "off" };
    if (!boardLinesEnabled(env) && !cardsShadow(env)) return { status: "lines_off" };
    const changes = diffRsvp(before, after);
    if (!changes.length) return { status: "no_change" };
    for (let i = 0; i < 4; i++) {
      const { raw, pending } = await readPending(env.DB);
      if (await writePending(env.DB, raw, recordChanges(pending, changes, now), now)) return { status: "recorded" };
    }
    return { status: "busy" };
  } catch {
    return { status: "error" };
  }
}

// Post the pending line if the window has passed. Safe to call on every interaction and every cron tick.
export async function flushBoardLines(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!cardsEnabled(env) || !env.DB) return { status: "off" };
    const shadow = cardsShadow(env);
    if (!boardLinesEnabled(env) && !shadow) return { status: "lines_off" };
    const { raw, pending } = await readPending(env.DB);
    if (!pending) {
      if (raw) await writePending(env.DB, raw, null, now); // unreadable record: drop it
      return { status: "none" };
    }
    if (!isDue(pending, now)) return { status: "waiting" };
    const line = composeLine(pending.changes);
    if (!line) { await writePending(env.DB, raw, null, now); return { status: "empty" }; }

    const cards = await loadCards(env.DB);
    const channel = (cards && cards.signups && cards.signups.channel) || lookupRosterId(await loadConfigKey(env, "discord_roster"), "channels", "signups");
    if (!channel) return { status: "no_channel" };

    const noise = await loadConfigKey(env, "noise");
    const day = noiseDay(now, noise);
    const decision = decidePost({ now, ledger: await readLedger(env.DB, channel, day), config: noise });
    if (!decision.ok) {
      // held: keep the changes, re-queue with notBefore
      await writePending(env.DB, raw, { ...pending, notBefore: decision.notBefore }, now);
      return { status: "held", reason: decision.reason, notBefore: decision.notBefore };
    }
    // claim the line first so two racing flushes cannot post it twice
    if (!(await writePending(env.DB, raw, null, now))) return { status: "claimed_elsewhere" };
    if (shadow) {
      await recordShadow(env.DB, "post", channel, day);
      return { status: "shadow", line };
    }
    if (!env.DISCORD_BOT_TOKEN) { await restore(env.DB, pending, now, 60 * 60 * 1000); return { status: "unconfigured" }; }
    const r = await discordRest(env, "POST", `/channels/${channel}/messages`, { content: line, flags: SUPPRESS_NOTIFICATIONS, allowed_mentions: { parse: [] } }, fetchImpl);
    if (!r.ok) {
      // Put the line back, but not for an immediate retry: every interaction flushes, so a refusing channel must not be hit each time.
      const wait = r.status === 429 ? r.retryAfterMs || 60000 : r.status === 401 || r.status === 403 ? 60 * 60 * 1000 : 60000;
      await restore(env.DB, pending, now, wait);
      return { status: "failed", http: r.status, retryInMs: wait };
    }
    await recordPost(env.DB, channel, day).catch(() => {});
    return { status: "posted", line };
  } catch {
    return { status: "error" };
  }
}

// Put a claimed record back after a failed post, held until now + waitMs, unless new changes already created a fresh one.
async function restore(db, pending, now, waitMs) {
  const next = { ...pending, notBefore: Math.max(pending.notBefore || 0, now + waitMs) };
  await db.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(PENDING_KEY, JSON.stringify(next), new Date(now).toISOString()).run();
}
