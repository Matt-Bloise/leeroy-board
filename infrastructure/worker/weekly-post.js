// Weekly board post (flag WEEKLY_POST, default off): once a week, a set time before play night, one quiet post in the sign-ups channel:
// who has signed up, which roles nobody has signed up for, and one short library fact per signed-up build, each with its source.
//
// Facts composed by code, never by a model: every sentence is a template filled from the public board documents (party, signups)
// or a library fact copied as the library wrote it, with that fact's own first source. Nothing here calls an AI model.
// Inputs are the PUBLIC documents only (the same rows GET /api/data/party and /api/data/signups serve, and the library blobs), so a hidden
// sheet field, a Discord id or a private config row cannot reach the post. Names are the names the board shows.
//
// Pieces:
//   composeWeeklyPost(): pure. Documents in, { text, facts, skipped } out. Used by the runner and by tools/weekly-post-dry-run.mjs.
//   planWeeklyPost(): pure. Schedule, state and clock in, { due, playAt, postAt, week } out.
//   runWeeklyPost(): the executor. Reads nothing while the flag is off. Needs the admin config row `weekly_post` (PUT /api/config/weekly_post):
//     { weekday: 0-6 (UTC, 0 = Sunday), hour: 0-23 (UTC), minute?: 0-59, lead_hours?: 1-72 (default 24), channel?: id }
//   Runs on the 6-hourly cron, so a post goes out within 6 hours after play night minus lead_hours, once per play week (state row
//   `weekly_post_state`, claimed before the post), and through the noise budget like every unprompted post.

import { RSVP_STATES, cleanName, discordRest, loadCards } from "./cards.js";
import { decidePost, noiseDay, readLedger, recordPost } from "./noise.js";
import { lookupRosterId } from "./announce.js";
import { loadConfigKey } from "./config.js";
import { flagOn } from "./flags.js";
import { ALLOWED_MENTIONS_NONE } from "./discord-safety.js";
import { validateWeeklyConfig } from "./weekly-post-config.js";

export { validateWeeklyConfig };

export const WEEKLY_FLAG = "WEEKLY_POST";
export const WEEKLY_CONFIG_KEY = "weekly_post";
export const WEEKLY_STATE_KEY = "weekly_post_state";
export const POST_MAX = 1900; // under Discord's 2000, with room for the "and N more" line
export const TIP_MAX = 220; // a library fact longer than this is skipped, never cut (a cut fact can change its meaning)
export const DEFAULT_LEAD_HOURS = 24;
export const SUPPRESS_NOTIFICATIONS = 4096; // a quiet post: it pings nobody and does not buzz phones
const WEEK_MS = 7 * 24 * 3600 * 1000;
const SIGNED = ["in", "late", "maybe"]; // "out" is not signed up
const STATE_WORD = { in: "in", late: "running late", maybe: "tentative" };
const ROLE_WORD = { tank: "tank", healer: "healer", damage: "damage" };
const ROLE_WORDS = { tank: ["tank", "tanking", "threat"], healer: ["heal", "healer", "healing"], damage: ["damage", "dps"] };

// Markdown and mention characters are escaped so a name or fact cannot format the post or ping anyone (allowed_mentions is empty too).
// < and > are dropped (a <@id> or <#id> form), and [ ] escaped (a masked link); parentheses stay as written.
export function plain(s) {
  return String(s == null ? "" : s).replace(/[<>]/g, "").replace(/[\\*_~`|[\]]/g, (c) => `\\${c}`).replace(/@/g, "@​").replace(/\s+/g, " ").trim();
}
// Names compare on letters and digits only: a sign-up written as "=Red Fox=" is the party's "Red Fox".
export const nameKey = (s) => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const httpsUrl = (u) => typeof u === "string" && /^https:\/\/[^\s<>]+$/.test(u);
function sourceOf(fact) {
  const r = (Array.isArray(fact && fact.refs) ? fact.refs : []).find((x) => x && httpsUrl(x.url));
  return r ? { id: r.id || null, label: String(r.label || r.host || "source"), url: r.url } : null;
}
const cite = (src) => `(${plain(src.label)}: <${src.url}>)`;
const pages = (doc) => (doc && Array.isArray(doc.pages) ? doc.pages : []);
const factsOf = (page) => (page && Array.isArray(page.facts) ? page.facts : []);

// ISO week number of a time, as "2026-W47". The tip rotates by it, so each week brings a different fact for the same build.
export function isoWeek(ms) {
  const d = new Date(ms);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(t).getUTCDay() || 7;
  const thursday = new Date(t + (4 - day) * 86400000);
  const y = thursday.getUTCFullYear();
  const w = Math.ceil(((thursday - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return { key: `${y}-W${String(w).padStart(2, "0")}`, n: y * 53 + w };
}

// "warlock.curse_of_elements.ranks" on the warlock page reads "Curse of elements, ranks": the fact's own key is its subject, so a value that
// is a fragment ("every magic school; ranks at 20 ...") still says what it is about.
export function subjectOf(key, classKey) {
  const parts = String(key || "").split(".").filter(Boolean);
  if (parts.length > 1 && parts[0] === classKey) parts.shift();
  const t = parts.map((x) => x.replace(/_/g, " ")).join(", ");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}
const keyWords = (key) => new Set(String(key || "").toLowerCase().split(/[._\s-]+/).filter(Boolean));
const specWords = (m) => String((m && m.spec) || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
const quotable = (f) => f && typeof f.key === "string" && typeof f.value === "string" && f.value.length <= TIP_MAX && sourceOf(f);

// One library fact for a build, from its class page: short enough to quote whole and with an https source. The pool is the page's core
// facts (depth must) plus the good facts whose key names the build's role or a word of its spec. The week picks one, so it changes weekly.
export function pickTip(classesDoc, member, weekN) {
  const page = pages(classesDoc).find((p) => p && p.id === `classes/${member.class_key}`);
  const words = [...(ROLE_WORDS[member.role] || []), ...specWords(member)];
  const pool = factsOf(page).filter(quotable).filter((f) => f.depth === "must" || (f.depth === "good" && words.some((w) => keyWords(f.key).has(w))));
  if (!pool.length) return null;
  const f = pool[((weekN % pool.length) + pool.length) % pool.length];
  return { page: page.id, key: f.key, subject: subjectOf(f.key, member.class_key), value: f.value, source: sourceOf(f) };
}

// The library's group-size fact, only when it is short enough to quote whole.
function groupSizeFact(dungeonsDoc) {
  for (const p of pages(dungeonsDoc)) for (const f of factsOf(p)) if (f && f.key === "dungeons.people_per_group" && quotable(f)) return { page: p.id, key: f.key, value: f.value, source: sourceOf(f) };
  return null;
}

const playLabel = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
const joinList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// Documents in, post out. signups and party are the public documents; classes and dungeons are the library blobs of the same names.
export function composeWeeklyPost({ signups, party, classes, dungeons, playAt } = {}) {
  const facts = [], skipped = [];
  const entries = Array.isArray(signups && signups.entries) ? signups.entries : [];
  const members = Array.isArray(party && party.members) ? party.members : [];
  const byName = new Map(members.filter((m) => m && m.name).map((m) => [nameKey(m.name), m]));
  const signed = entries.filter((e) => e && e.name && SIGNED.includes(e.rsvp) && RSVP_STATES.includes(e.rsvp));
  const lines = [];
  lines.push(`**This week on the board**${Number.isFinite(playAt) ? `: play night ${plain(playLabel(playAt))}` : ""}`);
  if (!signed.length) {
    lines.push("Nobody has signed up yet. The sign-up card is in this channel.");
  } else {
    const shown = (e) => { const m = byName.get(nameKey(e.name)); return plain(cleanName(m ? m.name : e.name)); }; // the board's name when the sign-up matches a build
    const say = signed.map((e) => `${shown(e)}${e.rsvp === "in" ? "" : ` (${STATE_WORD[e.rsvp]})`}`);
    lines.push(`Signed up (${signed.length}): ${joinList(say)}.`);
    const count = { tank: 0, healer: 0, damage: 0 };
    let unknown = 0;
    for (const e of signed) { const m = byName.get(nameKey(e.name)); if (m && count[m.role] !== undefined) count[m.role]++; else unknown++; }
    const missing = Object.keys(count).filter((r) => count[r] === 0).map((r) => ROLE_WORD[r]);
    lines.push(`Roles signed up: tank ${count.tank}, healer ${count.healer}, damage ${count.damage}${unknown ? `, no build on the board ${unknown}` : ""}.${missing.length ? ` Nobody has signed up as ${joinList(missing)} yet.` : ""}`);
    const size = groupSizeFact(dungeons);
    if (size) { lines.push(`Group size, from the library: ${plain(size.value)} ${cite(size.source)}`); facts.push(size); }
    const week = isoWeek(Number.isFinite(playAt) ? playAt : Date.now()).n;
    const tips = [];
    for (const e of signed) {
      const m = byName.get(nameKey(e.name));
      if (!m || !m.class_key) { skipped.push({ name: cleanName(e.name), why: "no build on the board" }); continue; }
      const tip = pickTip(classes, m, week);
      if (!tip) { skipped.push({ name: cleanName(e.name), why: `no short sourced fact on classes/${m.class_key}` }); continue; }
      const build = m.board_line || [m.race, m.class].filter(Boolean).join(" ");
      tips.push(`- ${shown(e)} (${plain(build)}). ${plain(tip.subject)}: ${plain(tip.value)} ${cite(tip.source)}`);
      facts.push(tip);
    }
    if (tips.length) { lines.push("", "One fact per build, from the library:"); lines.push(...tips); }
  }
  lines.push("", "Want more on your build? Ask Leeroy with /ask.");
  let text = lines.join("\n");
  // Too long for one post: drop tips from the end and say how many were left out.
  const tipStart = lines.indexOf("One fact per build, from the library:");
  let cut = 0;
  while (text.length > POST_MAX && tipStart > 0) {
    const tipEnd = lines.findIndex((l, i) => i > tipStart && !l.startsWith("- "));
    if (tipEnd - tipStart <= 1) break;
    lines.splice(tipEnd - 1, 1); facts.pop(); cut++;
    const more = `(and ${cut} more)`;
    const at = lines.findIndex((l) => /^\(and \d+ more\)$/.test(l));
    if (at >= 0) lines[at] = more; else lines.splice(lines.indexOf("", tipStart), 0, more);
    text = lines.join("\n");
  }
  return { text, facts, skipped };
}

// ---- schedule ----

// The next play night at or after now, and whether this week's post is due: on or after play night minus lead_hours, before play night,
// and not already claimed for that play week.
export function planWeeklyPost({ config, state, now }) {
  if (validateWeeklyConfig(config)) return { due: false, why: "config" };
  const d = new Date(now);
  let playAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), config.hour, config.minute || 0) + ((config.weekday - d.getUTCDay() + 7) % 7) * 86400000;
  if (playAt <= now) playAt += WEEK_MS;
  const postAt = playAt - (config.lead_hours || DEFAULT_LEAD_HOURS) * 3600 * 1000;
  const week = isoWeek(playAt).key;
  if (state && state.week === week) return { due: false, why: "posted", playAt, postAt, week };
  if (now < postAt) return { due: false, why: "early", playAt, postAt, week };
  return { due: true, playAt, postAt, week };
}

// ---- executor ----

async function readJson(db, sql, key) {
  const row = await db.prepare(sql).bind(key).first();
  if (!row) return { raw: null, value: null };
  try { return { raw: row.json, value: JSON.parse(row.json) }; } catch { return { raw: row.json, value: null }; }
}
const KV = "SELECT json FROM kv_state WHERE key = ?";
const BLOB = "SELECT json FROM lib_blobs WHERE name = ?";

export async function loadWeeklyInput(db) {
  const [signups, party, classes, dungeons] = await Promise.all([readJson(db, KV, "signups"), readJson(db, KV, "party"), readJson(db, BLOB, "classes.json"), readJson(db, BLOB, "dungeons.json")]);
  return { signups: signups.value, party: party.value, classes: classes.value, dungeons: dungeons.value };
}

// Claim the play week before posting: a compare-and-swap on the state row, so two overlapping runs cannot both post.
async function claimWeek(db, raw, week, now) {
  const json = JSON.stringify({ week, at: new Date(now).toISOString() });
  const r = raw === null
    ? await db.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(WEEKLY_STATE_KEY, json, new Date(now).toISOString()).run()
    : await db.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(json, new Date(now).toISOString(), WEEKLY_STATE_KEY, raw).run();
  return !!(r && r.meta && r.meta.changes === 1) ? json : null;
}
async function releaseWeek(db, claimed, previousRaw, now) {
  if (previousRaw === null) await db.prepare("DELETE FROM kv_state WHERE key = ? AND json = ?").bind(WEEKLY_STATE_KEY, claimed).run();
  else await db.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(previousRaw, new Date(now).toISOString(), WEEKLY_STATE_KEY, claimed).run();
}

export async function runWeeklyPost(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!(await flagOn(env, "WEEKLY_POST"))) return { status: "off" }; // nothing is read while the flag is off
    if (!env.DB) return { status: "no_db" };
    const config = await loadConfigKey(env, WEEKLY_CONFIG_KEY);
    if (!config || validateWeeklyConfig(config)) return { status: "unconfigured" };
    const st = await readJson(env.DB, KV, WEEKLY_STATE_KEY);
    const plan = planWeeklyPost({ config, state: st.value, now });
    if (!plan.due) return { status: "not_due", why: plan.why, week: plan.week };
    const post = composeWeeklyPost({ ...(await loadWeeklyInput(env.DB)), playAt: plan.playAt });
    const cards = await loadCards(env.DB);
    const channel = config.channel || (cards && cards.signups && cards.signups.channel) || lookupRosterId(await loadConfigKey(env, "discord_roster"), "channels", "signups");
    if (!channel) return { status: "no_channel" };
    const noise = await loadConfigKey(env, "noise");
    const day = noiseDay(now, noise);
    const decision = decidePost({ now, ledger: await readLedger(env.DB, channel, day), config: noise });
    if (!decision.ok) return { status: "held", reason: decision.reason }; // the window stays open: the next tick tries again
    if (!env.DISCORD_BOT_TOKEN) return { status: "unconfigured_token" };
    const claimed = await claimWeek(env.DB, st.raw, plan.week, now);
    if (!claimed) return { status: "claimed_elsewhere" };
    const r = await discordRest(env, "POST", `/channels/${channel}/messages`, { content: post.text, flags: SUPPRESS_NOTIFICATIONS, allowed_mentions: ALLOWED_MENTIONS_NONE }, fetchImpl);
    if (!r || !r.ok) { await releaseWeek(env.DB, claimed, st.raw, now); return { status: "post_failed", code: r && r.status }; }
    await recordPost(env.DB, channel, day);
    return { status: "posted", week: plan.week, facts: post.facts.length };
  } catch (e) {
    console.error("weekly post failed:", String((e && e.message) || e));
    return { status: "error" };
  }
}
