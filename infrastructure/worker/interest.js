// INTEREST_NUDGES (Flagship flag, [vars] fallback "off"; q-20261114-24 "Buttons + interest counts").
//
// Two small things, both behind the one flag:
//   1. Nudge buttons on Leeroy's existing interactions: an "Ask: what should I do at my level?" button that opens a short
//      /ask form, a "How many are interested?" button that shows the stored counts, and an "I'm in" button on /tonight
//      while the friend's RSVP is still empty (that one is the existing sign-up button id, handled by the existing code).
//   2. A read-only count of interest on Leeroy's OWN things, run on the existing 6-hour cron over the Discord REST API with
//      the existing DISCORD_BOT_TOKEN: the Interested count (user_count) of the scheduled events in our own map
//      (kv_state "scheduled_events", written by scheduled-events.js) and the reaction counts on our own recent posts
//      (the sign-up cards in kv_state "cards" and the timed posts in kv_state "moments_state").
//
// Rules the code enforces:
//   - GET only. Nothing here posts, edits, reacts, deletes or writes a sign-up. The only D1 write is the one kv_state row
//     "interest_counts" (private: config.js denies it on the public document routes).
//   - counts only: no message text, no author, no user ids, no reaction user lists. Event and post labels are our own keys.
//   - an event or message that is not in our own stores is never asked for; a hand-made event in the guild list is ignored.
//   - no gateway, no listener, no Message Content intent. Flag off: no D1 read and no Discord call.
import { flagOn } from "./flags.js";
import { MAX_QUESTION_CHARS } from "./limits.js";

export const INTEREST_COUNTS_KEY = "interest_counts";
export const ASK_LEVEL_BUTTON_ID = "nudge:ask-level";
export const ASK_LEVEL_MODAL_ID = "nudge:ask-modal";
export const COUNTS_BUTTON_ID = "nudge:counts";
export const ASK_LEVEL_PREFILL = "What should I do next at my level? I am level ";
export const MAX_POSTS = 8; // message reads per run, plus one guild event list: far inside the subrequest limit
export const RECENT_MS = 14 * 24 * 3600 * 1000; // a timed post older than this is not read again
export const MAX_EMOJI = 10;
const DISCORD_API = "https://discord.com/api/v10";
const ID = /^[0-9]{5,25}$/;

export const interestOn = (env) => flagOn(env, "INTEREST_NUDGES");

// ---- buttons and the /ask form ---------------------------------------------------------------------------------------------------
export const askLevelButton = () => ({ type: 2, style: 1, label: "Ask: what should I do at my level?", custom_id: ASK_LEVEL_BUTTON_ID });
export const countsButton = () => ({ type: 2, style: 2, label: "How many are interested?", custom_id: COUNTS_BUTTON_ID });

export function askLevelModal() {
  return {
    type: 9,
    data: {
      custom_id: ASK_LEVEL_MODAL_ID,
      title: "Ask Leeroy",
      components: [
        {
          type: 18,
          label: "Your question (only you see the answer)",
          component: { type: 4, custom_id: "question", style: 2, required: true, min_length: 3, max_length: MAX_QUESTION_CHARS, value: ASK_LEVEL_PREFILL },
        },
      ],
    },
  };
}

// The question typed into the form, trimmed, or "" when absent. Accepts label (18) and action-row (1) layouts.
export function questionFromModal(components) {
  const walk = (list) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== "object") continue;
      if (c.custom_id === "question" && typeof c.value === "string") return c.value;
      const inner = c.component ? walk([c.component]) : walk(c.components);
      if (inner !== null) return inner;
    }
    return null;
  };
  const v = walk(components);
  return typeof v === "string" ? v.trim() : "";
}

// ---- pure extraction --------------------------------------------------------------------------------------------------------------
// Reaction counts of one message, and nothing else from it. Unicode emoji keep their character; a custom emoji keeps its name
// (a server emoji name, not a person). Returns { total, emoji: { name: count } } or null for a message that is not a bot's.
export function reactionCounts(message) {
  if (!message || typeof message !== "object") return null;
  if (!message.author || message.author.bot !== true) return null;
  const emoji = Object.create(null); // "constructor", "toString" and friends are names like any other
  let total = 0;
  for (const r of Array.isArray(message.reactions) ? message.reactions : []) {
    const n = Number(r && r.count);
    if (!Number.isInteger(n) || n < 0) continue;
    const name = r && r.emoji && typeof r.emoji.name === "string" ? r.emoji.name.slice(0, 32) : "";
    if (!name) continue;
    total += n;
    const seen = Object.hasOwn(emoji, name);
    if (seen || Object.keys(emoji).length < MAX_EMOJI) emoji[name] = (seen ? emoji[name] : 0) + n;
  }
  return { total, emoji: { ...emoji } };
}

// Interested counts for the events in our own map. `list` is Discord's guild event list; anything not in the map is dropped.
export function eventCounts(list, map) {
  const byId = new Map();
  for (const [key, e] of Object.entries(map && typeof map === "object" && !Array.isArray(map) ? map : {})) {
    if (e && typeof e.id === "string" && e.id) byId.set(e.id, key);
  }
  const out = {};
  for (const ev of Array.isArray(list) ? list : []) {
    const key = ev && byId.get(String(ev.id));
    if (!key) continue;
    const n = Number(ev.user_count);
    out[key] = { interested: Number.isInteger(n) && n >= 0 ? n : 0 };
  }
  return out;
}

// Our own posts worth reading: every sign-up card, then the timed posts with a message id posted within RECENT_MS, newest first.
// Returns [{ ref, channel, message }] capped at MAX_POSTS. ref is "card:<name>" or "moment:<id>".
export function ownPosts({ cards, momentsState, momentsSchedule, now }) {
  const out = [];
  for (const [name, c] of Object.entries(cards && typeof cards === "object" && !Array.isArray(cards) ? cards : {})) {
    if (c && ID.test(String(c.channel || "")) && ID.test(String(c.message || ""))) out.push({ ref: `card:${name}`, channel: String(c.channel), message: String(c.message), at: Infinity });
  }
  const channels = new Map();
  for (const m of Array.isArray(momentsSchedule) ? momentsSchedule : []) if (m && typeof m.id === "string" && ID.test(String(m.channelId || ""))) channels.set(m.id, String(m.channelId));
  const moments = momentsState && momentsState.moments && typeof momentsState.moments === "object" ? momentsState.moments : {};
  const recent = [];
  for (const [id, e] of Object.entries(moments)) {
    if (!e || !ID.test(String(e.messageId || "")) || !channels.has(id)) continue;
    const at = Number(e.postedAt || e.doneAt || 0);
    if (!(at > 0) || now - at > RECENT_MS) continue;
    recent.push({ ref: `moment:${id}`, channel: channels.get(id), message: String(e.messageId), at });
  }
  recent.sort((a, b) => b.at - a.at);
  return [...out, ...recent].slice(0, MAX_POSTS).map(({ ref, channel, message }) => ({ ref, channel, message }));
}

// ---- the cron run -------------------------------------------------------------------------------------------------------------------
// null for a missing row. THROWS on a D1 error or corrupt JSON: a failed read is not an empty answer.
async function readKv(db, key) {
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.json) : null;
}

// A failed run keeps the previous snapshot and its `at`; it only adds failedAt, so the counts reply can say they are stale.
async function markFailed(db, now) {
  try {
    const prev = await readKv(db, INTEREST_COUNTS_KEY);
    const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : { at: null, events: {}, posts: {} };
    const at = new Date(now).toISOString();
    await db.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(INTEREST_COUNTS_KEY, JSON.stringify({ ...base, failedAt: at }), at).run();
  } catch {
    /* the stored row is unreadable or unwritable: leave it exactly as it is */
  }
}

// collectInterest({ env, fetchImpl, now })
// Returns { ok, skipped?, stopped?, events, posts, wrote }. Never throws on a Discord answer. Writes interest_counts only after a run
// that was not stopped by 401, 403 or 429; a stopped run keeps the last stored counts.
export async function collectInterest({ env, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!(await interestOn(env))) return { ok: true, skipped: "off", wrote: false };
  if (!env || !env.DB) return { ok: false, skipped: "no_db", wrote: false };
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, skipped: "no_token", wrote: false };
  let roster, map, cards, momentsState, momentsSchedule;
  try {
    [roster, map, cards, momentsState, momentsSchedule] = await Promise.all([
      readKv(env.DB, "discord_roster"),
      readKv(env.DB, "scheduled_events"),
      readKv(env.DB, "cards"),
      readKv(env.DB, "moments_state"),
      readKv(env.DB, "moments"),
    ]);
  } catch {
    await markFailed(env.DB, now);
    return { ok: false, failed: "kv_read", wrote: false };
  }
  const guildId = roster && ID.test(String(roster.guildId || "")) ? String(roster.guildId) : null;
  const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` };
  const get = async (path) => {
    try {
      const res = await fetchImpl(`${DISCORD_API}${path}`, { method: "GET", headers });
      let json = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, ok: res.ok, json };
    } catch {
      return { status: 0, ok: false, json: null };
    }
  };
  const stop = (r) => (r.status === 401 ? "unauthorized" : r.status === 403 ? "forbidden" : r.status === 429 ? "rate_limited" : null);
  // A read that did not answer (network error, 5xx) or answered with a body we cannot use fails the run.
  const broken = (r, shape) => r.status === 0 || r.status >= 500 || (r.ok && !shape(r.json));
  const fail = async (why) => {
    await markFailed(env.DB, now);
    return { ok: false, failed: why, wrote: false };
  };

  let events = {};
  const hasEvents = map && typeof map === "object" && Object.keys(map).length > 0;
  if (guildId && hasEvents) {
    const r = await get(`/guilds/${guildId}/scheduled-events?with_user_count=true`);
    if (stop(r)) {
      await markFailed(env.DB, now);
      return { ok: false, stopped: stop(r), wrote: false };
    }
    // Any answer that is not a usable list (404, 408, 400, 5xx, a network error, a wrong shape) fails the run and keeps the last counts.
    if (!r.ok || !Array.isArray(r.json)) return fail("events_read");
    events = eventCounts(r.json, map);
  }

  const posts = {};
  for (const p of ownPosts({ cards, momentsState, momentsSchedule, now })) {
    const r = await get(`/channels/${p.channel}/messages/${p.message}`);
    // A 403 on one message means the bot cannot read that channel or message: skip that post like a 404. 401 and 429 still stop the run.
    if (r.status !== 403 && stop(r)) {
      await markFailed(env.DB, now);
      return { ok: false, stopped: stop(r), wrote: false };
    }
    if (broken(r, (j) => j && typeof j === "object" && !Array.isArray(j))) return fail("post_read");
    if (!r.ok) continue; // deleted (404) or not readable (403): leave it out
    const counts = reactionCounts(r.json);
    if (counts) posts[p.ref] = counts;
  }

  const doc = { at: new Date(now).toISOString(), events, posts };
  await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(INTEREST_COUNTS_KEY, JSON.stringify(doc), doc.at).run();
  return { ok: true, events, posts, wrote: true };
}

// ---- showing the counts inside Discord ---------------------------------------------------------------------------------------------
export const COUNTS_REPLY_MAX = 1900; // Discord's content limit is 2000; leave room for the "and N more" line
// Ephemeral reply text. Event labels come from our own events_schedule names; posts are named by kind.
export function countsReply(doc, schedule) {
  if (doc && doc.unavailable) return "Counts are unavailable right now: Leeroy could not read them. Try again later.";
  const names = new Map((Array.isArray(schedule) ? schedule : []).filter((e) => e && typeof e.key === "string").map((e) => [e.key, String(e.name || e.key).slice(0, 100)]));
  const lines = [];
  const events = doc && doc.events && typeof doc.events === "object" ? doc.events : {};
  const posts = doc && doc.posts && typeof doc.posts === "object" ? doc.posts : {};
  for (const [key, e] of Object.entries(events)) lines.push(`• **${names.get(key) || key}**: ${Number(e && e.interested) || 0} interested`);
  for (const [ref, p] of Object.entries(posts)) {
    const label = ref.startsWith("card:") ? `Sign-up card (${ref.slice(5)})` : ref.startsWith("moment:") ? `Leeroy's post (${ref.slice(7)})` : ref;
    const parts = Object.entries((p && p.emoji) || {}).map(([k, n]) => `${k} ${n}`);
    lines.push(`• ${label}: ${Number(p && p.total) || 0} reactions${parts.length ? ` (${parts.join(", ")})` : ""}`);
  }
  const failed = Boolean(doc && doc.failedAt);
  if (!lines.length) {
    return failed
      ? "Counts are unavailable: the last count run failed and nothing has been counted before. Leeroy tries again every six hours."
      : "Nothing counted yet. Leeroy counts Interested clicks and reactions on his own posts every six hours.";
  }
  const t = Date.parse(doc.at);
  const when = Number.isFinite(t) ? ` (counted <t:${Math.floor(t / 1000)}:R>)` : "";
  const stale = failed ? " The last count run failed, so these numbers may be out of date." : "";
  const head = `**Interest so far**${when}. Counts only; nobody is signed up by a click.${stale}`;
  const out = [head];
  let used = head.length;
  let shown = 0;
  for (const line of lines) {
    if (used + 1 + line.length > COUNTS_REPLY_MAX) break;
    out.push(line);
    used += 1 + line.length;
    shown += 1;
  }
  if (shown < lines.length) out.push(`and ${lines.length - shown} more`);
  return out.join("\n");
}

export async function loadCountsReply(env) {
  try {
    const [doc, schedule] = await Promise.all([readKv(env.DB, INTEREST_COUNTS_KEY), readKv(env.DB, "events_schedule")]);
    return countsReply(doc, schedule);
  } catch {
    return countsReply({ unavailable: true }, null);
  }
}
