// Pinned cards, edited in place: the sign-up card and the party board card. Status lives in these cards, not in new posts.
// Everything is behind CARDS_ENABLED (default off). Pure renderers and planners first, then small D1 and REST executors that take
// their fetch and sleep as arguments so tests never touch the network.
//
// Message shape: a classic embed plus action rows of buttons. That is what this Worker already sends everywhere (votes.js renderMessage,
// build-modal.js, discord.js link buttons), so no Components v2 flag (1 << 15) is needed and a card can be edited with the same PATCH body.
// Discord docs: Message resource, Embed object limits (title 256, field name 256, field value 1024, 25 fields, 6000 total):
//   https://discord.com/developers/docs/resources/message#embed-object-embed-limits
// Components: action rows hold up to 5 buttons and a message up to 5 rows: https://discord.com/developers/docs/components/reference
// Edit Message (PATCH /channels/{channel.id}/messages/{message.id}, bot may edit only its own messages):
//   https://discord.com/developers/docs/resources/message#edit-message
// Channel and message ids live only in the D1 kv_state row `cards`, written through PUT /api/config/cards or POST /api/admin/cards/post.

import { noiseDay, recordShadow } from "./noise.js";
import { cardMembers, parseClassEmoji, iconFor, claimEntries } from "./card-members.js";

export const CARDS_KEY = "cards";
export const CARD_EDIT_KEY = "cards_edit";
export const CARD_NAMES = ["signups", "board", "party"]; // party: id stored, no renderer yet
export const CARD_EDIT_MIN_GAP_MS = 3000; // at most one edit per 3 s
export const WRITE_IN_MAX = 40;
export const NAME_MAX = 24;
const GOLD = 0xffd100;
const ON = ["1", "true", "on", "yes"];
const flag = (v) => ON.includes(String(v || "").trim().toLowerCase());

export const cardsEnabled = (env) => flag(env && env.CARDS_ENABLED);
export const cardsShadow = (env) => flag(env && env.CARDS_SHADOW);
export const boardLinesEnabled = (env) => flag(env && env.BOARD_LINES_ENABLED);

// ---- sign-up vocabulary -------------------------------------------------------------------------------------------------------
export const RSVP_STATES = ["in", "maybe", "late", "out"];
export const RSVP_LABEL = { in: "In", maybe: "Tentative", late: "Running late", out: "Out" };
export const RSVP_PHRASE = { in: "is in", maybe: "is tentative", late: "is running late", out: "is out" };
export const DEFAULT_MEET = ["Valley of Strength", "The Crossroads"];
export const DEFAULT_WHEN = ["6pm", "8pm", "later"];

const meetOptions = (options) => (Array.isArray(options && options.meet) && options.meet.length ? options.meet.map(String) : DEFAULT_MEET);
// A `when` option ends up in a custom_id (`signup:when:<option>`, max 100 characters) and is split on ":" when clicked, so only short
// printable options without a colon are accepted. Anything else is dropped; if nothing is left the defaults apply. At most 5 (one row).
export const WHEN_OPTION_MAX = 40;
const safeWhen = (w) => typeof w === "string" && w.length >= 1 && w.length <= WHEN_OPTION_MAX && !/[:\u0000-\u001f\u007f]/.test(w) && w.trim() === w;
export const whenOptions = (options) => {
  const ok = (Array.isArray(options && options.when) ? options.when : []).filter(safeWhen).slice(0, 5);
  return ok.length ? ok : DEFAULT_WHEN;
};
const meetToken = (name, i) => (name === "Valley of Strength" ? "vos" : name === "The Crossroads" ? "xroads" : `m${i}`);

// Remove control and zero-width characters, mention and markdown syntax, links; collapse spaces; cap by code points.
export function sanitiseWriteIn(raw, max = WRITE_IN_MAX) {
  let s = String(raw === undefined || raw === null ? "" : raw).normalize("NFKC");
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ");
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/[@`*_~|\\[\]()<>]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return [...s].slice(0, max).join("").trim();
}

// A display name safe to print in a card or a board line.
export function cleanName(raw) {
  return sanitiseWriteIn(raw, NAME_MAX) || "Someone";
}

// Turn a button token or select value into the stored value, or null when it is not an allowed choice.
export function resolveChoice(field, token, options) {
  const t = String(token === undefined || token === null ? "" : token);
  if (field === "rsvp") return RSVP_STATES.includes(t) ? t : null;
  if (field === "pack") return t === "yes" || t === "no" ? t : null;
  if (field === "when") return whenOptions(options).includes(t) ? t : null;
  if (field === "meet") {
    const opts = meetOptions(options);
    if (t === "vos") return "Valley of Strength";
    if (t === "xroads") return "The Crossroads";
    const m = /^m(\d{1,2})$/.exec(t);
    if (m && opts[Number(m[1])] !== undefined) return opts[Number(m[1])];
    return null;
  }
  return null;
}

// Pure state transition. Returns { ok, doc (a copy), changed, before, after } or { ok: false, error }.
// change = { name, slug, field, value (already resolved), now (ms) }. The caller recomputes tallies and saves.
export function applySignupChange(doc, change) {
  const { name, slug, field, value, now } = change || {};
  if (!["rsvp", "pack", "meet", "when"].includes(field)) return { ok: false, error: "field" };
  if (typeof value !== "string" || !value) return { ok: false, error: "value" };
  const next = structuredClone(doc && typeof doc === "object" ? doc : { entries: [] });
  next.entries = Array.isArray(next.entries) ? next.entries : [];
  const key = String(name || "").toLowerCase();
  let entry = next.entries.find((e) => String(e.name || "").toLowerCase() === key);
  if (!entry) {
    entry = { name, ...(slug ? { slug } : {}) };
    next.entries.push(entry);
  }
  const before = entry[field] === undefined ? null : entry[field];
  entry[field] = value;
  const changed = before !== value;
  if (changed) entry.updated = new Date(now).toISOString();
  return { ok: true, doc: next, changed, before, after: value };
}

// The six rotating ephemeral confirmations. `seed` is any integer (an interaction id hash, a counter).
export const CONFIRM_LINES = [
  "Got it, {what}.",
  "Noted: {what}.",
  "Done, {what}.",
  "Locked in: {what}.",
  "You're on the card: {what}.",
  "Marked: {what}.",
];
export function confirmationLine(seed, what) {
  const i = Math.abs(Math.trunc(Number(seed) || 0)) % CONFIRM_LINES.length;
  return CONFIRM_LINES[i].replace("{what}", what);
}
export function describeChange(field, value) {
  if (field === "rsvp") return `you're ${RSVP_PHRASE[value] ? RSVP_PHRASE[value].replace(/^is /, "") : value}`;
  if (field === "pack") return `pre-order pack: ${value}`;
  if (field === "meet") return `meeting at ${value}`;
  if (field === "when") return `arriving ${value}`;
  return `${field}: ${value}`;
}

// ---- rendering ------------------------------------------------------------------------------------------------------------------
const clampText = (s, max) => (s.length <= max ? s : s.slice(0, max - 1) + "…");
const listNames = (names) => (names.length ? clampText(names.join(", "), 1024) : "—");

// Count the entries (the card never trusts the stored tallies).
export function tallyEntries(state) {
  const entries = Array.isArray(state && state.entries) ? state.entries : [];
  const out = { rsvp: { in: [], maybe: [], late: [], out: [] }, pack: { yes: [], no: [] }, meet: new Map(), when: new Map() };
  const mopts = meetOptions(state && state.options);
  for (const e of entries) {
    const n = cleanName(e && e.name);
    if (e && out.rsvp[e.rsvp]) out.rsvp[e.rsvp].push(n);
    if (e && out.pack[e.pack]) out.pack[e.pack].push(n);
    if (e && typeof e.meet === "string" && e.meet) {
      const label = mopts.includes(e.meet) ? e.meet : e.meet === "vos" ? "Valley of Strength" : e.meet === "xroads" ? "The Crossroads" : `Elsewhere: ${sanitiseWriteIn(e.meet)}`;
      out.meet.set(label, [...(out.meet.get(label) || []), n]);
    }
    if (e && typeof e.when === "string" && e.when) out.when.set(e.when, [...(out.when.get(e.when) || []), n]);
  }
  return out;
}

const fmtUpdated = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
};

const NO_MENTIONS = { parse: [] };

// The sign-up card. Returns a message body usable for POST and PATCH: { embeds, components, allowed_mentions }.
export function renderSignupCard(state) {
  const t = tallyEntries(state);
  const fields = [];
  const members = state && Array.isArray(state.members) ? state.members : null;
  const emoji = (state && state.classEmoji) || {};
  const entries = Array.isArray(state && state.entries) ? state.entries : [];
  const claimed = members ? claimEntries(members, entries) : null;
  const byState = (st) => entries.filter((e) => e && e.rsvp === st).map((e) => `${iconFor(claimed.byEntry.get(e), emoji)}${cleanName(e.name)}`);
  for (const s of RSVP_STATES) {
    if (s === "in" || t.rsvp[s].length) {
      const names = members ? byState(s) : t.rsvp[s];
      fields.push({ name: `${RSVP_LABEL[s]} (${names.length})`, value: listNames(names), inline: false });
    }
  }
  if (members) {
    const quiet = members.filter((m) => { const e = claimed.byMember.get(m); return !(e && e.rsvp); });
    if (quiet.length) fields.push({ name: `No answer yet (${quiet.length})`, value: clampText(quiet.map((m) => `${iconFor(m, emoji)}${m.name}`).join(", "), 1024), inline: false });
  }
  if (t.pack.yes.length || t.pack.no.length) {
    fields.push({ name: "Pre-order pack", value: clampText(`Yes ${t.pack.yes.length} · No ${t.pack.no.length}`, 1024), inline: true });
  }
  if (t.meet.size) {
    fields.push({ name: "Meeting point", value: clampText([...t.meet].map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n"), 1024), inline: true });
  }
  if (t.when.size) {
    fields.push({ name: "Arriving", value: clampText([...t.when].map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n"), 1024), inline: true });
  }
  const embed = {
    title: "Launch-night sign-ups",
    description: "Tap a button to sign up. This card updates itself.",
    color: GOLD,
    fields,
  };
  const when = fmtUpdated(state && state.updated);
  if (when) embed.footer = { text: `Updated ${when}` };
  const thumb = assetUrl(state, "img/seal.png");
  if (thumb) embed.thumbnail = { url: thumb };
  capEmbedText(embed);

  const mopts = meetOptions(state && state.options).slice(0, 2);
  const wopts = whenOptions(state && state.options).slice(0, 5);
  const btn = (style, label, id) => ({ type: 2, style, label: clampText(label, 80), custom_id: id });
  const components = [
    { type: 1, components: [btn(3, "I'm in", "signup:rsvp:in"), btn(2, RSVP_LABEL.maybe, "signup:rsvp:maybe"), btn(1, RSVP_LABEL.late, "signup:rsvp:late"), btn(4, RSVP_LABEL.out, "signup:rsvp:out")] },
    {
      type: 1,
      components: [
        btn(2, "Pack: yes", "signup:pack:yes"),
        btn(2, "Pack: no", "signup:pack:no"),
        ...mopts.map((m, i) => btn(2, m, `signup:meet:${meetToken(m, i)}`)),
        btn(2, "Elsewhere…", "signup:meet:other"),
      ],
    },
    { type: 1, components: wopts.map((w) => btn(2, `Arrive ${w}`, `signup:when:${w}`)) },
  ];
  return { embeds: [embed], components, allowed_mentions: NO_MENTIONS };
}

// Discord rejects an embed whose text (title + description + field names + values + footer) passes 6000 characters, and a rejected
// edit leaves the card stale. Trim field values from the last field back until it fits.
export const EMBED_TEXT_MAX = 6000;
const embedTextLength = (e) => (e.title || "").length + (e.description || "").length + ((e.footer && e.footer.text) || "").length + (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
function capEmbedText(embed) {
  let over = embedTextLength(embed) - EMBED_TEXT_MAX;
  for (let i = embed.fields.length - 1; over > 0 && i >= 0; i--) {
    const f = embed.fields[i];
    const keep = Math.max(1, f.value.length - over);
    over -= f.value.length - keep;
    f.value = clampText(f.value, keep);
  }
}

// A static board image for embeds (Pages serves it; no Worker work). Only when the card state carries an https site base.
function assetUrl(state, path) {
  const base = state && typeof state.siteBase === "string" ? state.siteBase.replace(/\/+$/, "") : "";
  return /^https:\/\/[^\s/]+$/.test(base) ? `${base}/${path}` : null;
}

const DETAIL_MAX = 1024;
const detailBits = (e) => {
  const bits = [RSVP_LABEL[e && e.rsvp] || "No answer"];
  if (e && e.when) bits.push(sanitiseWriteIn(e.when));
  if (e && e.meet) bits.push(sanitiseWriteIn(e.meet));
  if (e && (e.pack === "yes" || e.pack === "no")) bits.push(`pack ${e.pack}`);
  return bits;
};
// One person per two lines: name and class, then a `-#` detail line. People with no sign-up still show; sign-ups from people the
// party sheets do not list yet show with a plain note.
function boardBlocks(state, entries) {
  const emoji = state.classEmoji || {};
  const claimed = claimEntries(state.members, entries);
  const blocks = [];
  for (const m of state.members) {
    const e = claimed.byMember.get(m);
    const head = [m.classLabel, m.role].filter(Boolean).join(" · ");
    blocks.push(`${iconFor(m, emoji)}**${m.name}**${head ? ` · ${head}` : ""}\n-# ${[m.race, ...detailBits(e)].filter(Boolean).join(" · ")}`);
  }
  for (const e of entries) {
    if (!e || claimed.byEntry.has(e)) continue;
    blocks.push(`**${cleanName(e && e.name)}**\n-# Not on the party sheets yet · ${detailBits(e).join(" · ")}`);
  }
  return blocks;
}

// Fill fields person by person (a person is never split across fields: 1024 characters per value) and stop before the WHOLE embed
// would pass the 6000-character budget. `fixedChars` is title + description + footer. Returns the values and how many people did not fit.
const OMIT_NOTE_MAX = 40; // room kept in the footer for " · +NN more on the board"
function fitBlocks(blocks, fixedChars) {
  const values = [];
  let used = fixedChars + OMIT_NOTE_MAX;
  let shown = 0;
  for (const blk of blocks) {
    const piece = clampText(blk, DETAIL_MAX);
    const last = values.length - 1;
    const joins = last >= 0 && values[last].length + 1 + piece.length <= DETAIL_MAX;
    const cost = joins ? 1 + piece.length : piece.length + (values.length ? 1 : 3); // a new field also costs its name ("Who" 3, later ones 1)
    if (used + cost > EMBED_TEXT_MAX || (!joins && values.length >= 25)) break;
    if (joins) values[last] += `\n${piece}`; else values.push(piece);
    used += cost;
    shown += 1;
  }
  return { values, omitted: blocks.length - shown };
}

// The party board card: one line per person, no buttons (an optional https link button to the board).
// With state.members (the party document) each person shows class, role and race, including people with no sign-up and sign-ups
// from people the party sheets do not list yet. Without it the original one-line shape is kept.
export function renderBoardCard(state) {
  const entries = Array.isArray(state && state.entries) ? state.entries : [];
  const t = tallyEntries(state);
  let fields;
  let omitted = 0;
  const description = clampText(`${t.rsvp.in.length} in \u00b7 ${t.rsvp.maybe.length} tentative \u00b7 ${t.rsvp.late.length} running late \u00b7 ${t.rsvp.out.length} out`, 4096);
  const updatedText = fmtUpdated(state && state.updated);
  if (state && Array.isArray(state.members)) {
    const fit = fitBlocks(boardBlocks(state, entries), "Party board".length + description.length + (updatedText ? `Updated ${updatedText}`.length : 0));
    omitted = fit.omitted;
    fields = fit.values.map((value, i) => ({ name: i === 0 ? "Who" : "\u200b", value, inline: false }));
  } else {
    const lines = entries.map((e) => {
      const bits = [RSVP_LABEL[e && e.rsvp] || "No answer"];
      if (e && e.when) bits.push(String(e.when));
      if (e && e.meet) bits.push(sanitiseWriteIn(e.meet));
      if (e && e.pack) bits.push(`pack ${e.pack}`);
      return `**${cleanName(e && e.name)}**: ${bits.join(" · ")}`;
    });
    fields = lines.length ? [{ name: "Who", value: clampText(lines.join("\n"), 1024), inline: false }] : [];
  }
  const embed = {
    title: "Party board",
    description,
    color: GOLD,
    fields,
  };
  const footer = [updatedText ? `Updated ${updatedText}` : null, omitted ? `+${omitted} more on the board` : null].filter(Boolean).join(" · ");
  if (footer) embed.footer = { text: footer };
  const thumb = assetUrl(state, "img/seal.png");
  if (thumb) embed.thumbnail = { url: thumb };
  capEmbedText(embed);
  const body = { embeds: [embed], components: [], allowed_mentions: NO_MENTIONS };
  const url = state && state.boardUrl;
  if (typeof url === "string" && /^https:\/\//.test(url) && url.length <= 512) {
    body.components = [{ type: 1, components: [{ type: 2, style: 5, label: "Open the board", url }] }];
  }
  return body;
}

export const RENDERERS = { signups: renderSignupCard, board: renderBoardCard };

// ---- coalescing -----------------------------------------------------------------------------------------------------------------
// Edits are limited to one per 3 s. Inputs are epoch ms: lastEditAt (null if never), pendingSince (null when nothing waits), now.
// Returns { action: "none" } | { action: "edit", waitMs: 0 } | { action: "wait", waitMs }.
export function planCardEdit({ lastEditAt, pendingSince, now } = {}) {
  if (pendingSince === null || pendingSince === undefined || !Number.isFinite(Number(pendingSince))) return { action: "none" };
  const last = Number(lastEditAt);
  if (lastEditAt === null || lastEditAt === undefined || !Number.isFinite(last)) return { action: "edit", waitMs: 0 };
  const elapsed = Math.max(0, now - last); // a clock that stepped back counts as "just edited"
  if (elapsed >= CARD_EDIT_MIN_GAP_MS) return { action: "edit", waitMs: 0 };
  return { action: "wait", waitMs: Math.min(CARD_EDIT_MIN_GAP_MS, CARD_EDIT_MIN_GAP_MS - elapsed) };
}

// ---- config shape ---------------------------------------------------------------------------------------------------------------
const isId = (v) => typeof v === "string" && /^[0-9]{5,25}$/.test(v);
// kv_state `cards`: { signups: { channel, message, deleted? }, board: {...}, party: {...}, allowedChannels: [id, ...] }
export function validateCardsConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "cards must be a JSON object";
  for (const [k, v] of Object.entries(value)) {
    if (k === "allowedChannels") {
      if (!Array.isArray(v) || v.length > 10 || !v.every(isId)) return "allowedChannels must be an array of up to 10 digit strings";
    } else if (CARD_NAMES.includes(k)) {
      if (!v || typeof v !== "object" || Array.isArray(v) || !isId(v.channel) || !isId(v.message)) return `${k} needs channel and message as digit strings`;
      for (const flagName of ["deleted", "errored"]) {
        if (v[flagName] !== undefined && typeof v[flagName] !== "boolean") return `${k}.${flagName} must be true or false`;
      }
    } else return "cards allows signups, board, party and allowedChannels only";
  }
  return null;
}

// Which channels count sign-up clicks. No config at all means no restriction (the flag-off behaviour).
export function channelAllowed(cards, channelId) {
  const set = new Set(Array.isArray(cards && cards.allowedChannels) ? cards.allowedChannels : []);
  for (const n of CARD_NAMES) if (cards && cards[n] && cards[n].channel) set.add(cards[n].channel);
  if (set.size === 0) return true;
  return set.has(String(channelId || ""));
}

// ---- D1 ---------------------------------------------------------------------------------------------------------------------------
const parse = (raw, fallback) => { try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : fallback; } catch { return fallback; } };

export async function loadCards(db) {
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = ?").bind(CARDS_KEY).first();
  return row ? parse(row.json, null) : null;
}

export async function saveCards(db, cards, now) {
  await db.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(CARDS_KEY, JSON.stringify(cards), new Date(now).toISOString()).run();
}

export async function loadSignups(db) {
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
  return row ? parse(row.json, { entries: [] }) : { entries: [] };
}

// The card state: sign-ups plus the party members (the same public document /api/state serves) and the optional class emoji map.
// Runs in the deferred redraw, never in the 3 s interaction path. A failed party read leaves the legacy card shape.
export async function loadCardState(env) {
  const state = await loadSignups(env.DB);
  const base = env.BOARD_PUBLIC_URL ? String(env.BOARD_PUBLIC_URL).replace(/\/+$/, "") : "";
  state.boardUrl = base ? `${base}/#signups` : undefined;
  state.siteBase = base || undefined;
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first();
    if (row && row.json) state.members = cardMembers(JSON.parse(row.json));
  } catch { /* legacy shape */ }
  state.classEmoji = parseClassEmoji(env.CARD_CLASS_EMOJI);
  return state;
}

async function readEdit(db) {
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = ?").bind(CARD_EDIT_KEY).first();
  const raw = row ? row.json : null;
  const s = raw ? parse(raw, {}) : {};
  return { raw, state: { lastEditAt: Number.isFinite(s.lastEditAt) ? s.lastEditAt : null, pendingSince: Number.isFinite(s.pendingSince) ? s.pendingSince : null, retryAt: Number.isFinite(s.retryAt) ? s.retryAt : null } };
}

// Compare-and-swap on the raw JSON string, so two Workers waking together cannot both claim the same edit.
async function casEdit(db, raw, next, now) {
  const json = JSON.stringify(next);
  const at = new Date(now).toISOString();
  const r = raw === null
    ? await db.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(CARD_EDIT_KEY, json, at).run()
    : await db.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(json, at, CARD_EDIT_KEY, raw).run();
  return Boolean(r && r.meta && r.meta.changes > 0);
}

// ---- REST -------------------------------------------------------------------------------------------------------------------------
export async function discordRest(env, method, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  const out = { ok: res.ok, status: res.status, json };
  if (res.status === 429) out.retryAfterMs = retryAfterMs(res, json);
  return out;
}

export const MAX_BACKOFF_MS = 60 * 60 * 1000;
// Retry-After header (seconds), else the body's retry_after (seconds, may be fractional), else 5 s. Capped at one hour.
export function retryAfterMs(res, json) {
  const raw = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  const header = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  const body = Number(json && json.retry_after);
  const sec = Number.isFinite(header) && header >= 0 ? header : Number.isFinite(body) && body >= 0 ? body : 5;
  return Math.min(MAX_BACKOFF_MS, Math.max(1000, Math.ceil(sec * 1000)));
}

// Redraw every configured, live card from the current sign-ups. A 404 means a person deleted the message: mark it deleted and stop
// editing it (never retry it), so a missing card cannot loop. POST /api/admin/cards/post recreates it.
export async function redrawCards(env, cards, { fetchImpl = fetch, now = Date.now() } = {}) {
  const state = await loadCardState(env);
  const results = [];
  let marked = false;
  let retryAfter = 0;
  const next = structuredClone(cards);
  for (const name of Object.keys(RENDERERS)) {
    const c = cards[name];
    if (!c || c.deleted || c.errored) continue;
    if (cardsShadow(env)) {
      await recordShadow(env.DB, "edit", c.channel, noiseDay(now, null)).catch(() => {});
      results.push({ card: name, status: "shadow" });
      continue;
    }
    const r = await discordRest(env, "PATCH", `/channels/${c.channel}/messages/${c.message}`, RENDERERS[name](state), fetchImpl);
    if (r.status === 404) {
      next[name].deleted = true;
      marked = true;
      results.push({ card: name, status: "deleted" });
    } else if (r.status === 401 || r.status === 403) {
      // The bot may not edit here (token revoked, permission removed). Retrying cannot help: stop until an admin reposts the card.
      next[name].errored = true;
      marked = true;
      results.push({ card: name, status: "errored", http: r.status });
    } else if (r.status === 429) {
      retryAfter = Math.max(retryAfter, r.retryAfterMs || 0);
      results.push({ card: name, status: "failed", http: 429 });
    } else results.push({ card: name, status: r.ok ? "edited" : "failed", http: r.status });
  }
  if (marked) await saveCards(env.DB, next, now);
  return { ok: results.every((r) => r.status !== "failed"), retryAfterMs: retryAfter, results };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After a sign-up state change: mark the card dirty and redraw it, at most once per 3 s. With no card recorded this does nothing.
// dirty: false is the retry path (a tick or an interaction finding an unfinished edit).
export async function requestCardEdit(env, { clock = Date.now, fetchImpl = fetch, sleep = defaultSleep, dirty = true } = {}) {
  if (!cardsEnabled(env) || !env.DB) return { status: "off" };
  if (!cardsShadow(env) && !env.DISCORD_BOT_TOKEN) return { status: "unconfigured" };
  const cards = await loadCards(env.DB);
  const live = cards && Object.keys(RENDERERS).some((n) => cards[n] && !cards[n].deleted && !cards[n].errored);
  if (!live) return { status: "no_card" };
  let { raw, state } = await readEdit(env.DB);
  // Discord said "slow down" (429): do nothing until Retry-After has passed. The pending mark stays, so a later tick retries.
  if (state.retryAt !== null && clock() < state.retryAt) {
    if (dirty && state.pendingSince === null) await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(CARD_EDIT_KEY, JSON.stringify({ ...state, pendingSince: clock() }), new Date(clock()).toISOString()).run();
    return { status: "backoff" };
  }
  if (dirty && state.pendingSince === null) {
    const t = clock();
    const next = { ...state, pendingSince: t };
    if (await casEdit(env.DB, raw, next, t)) { raw = JSON.stringify(next); state = next; } else ({ raw, state } = await readEdit(env.DB));
  }
  for (let i = 0; i < 4; i++) {
    const t = clock();
    const plan = planCardEdit({ lastEditAt: state.lastEditAt, pendingSince: state.pendingSince, now: t });
    if (plan.action === "none") return { status: "coalesced" };
    if (plan.action === "wait") { await sleep(plan.waitMs); ({ raw, state } = await readEdit(env.DB)); continue; }
    if (!(await casEdit(env.DB, raw, { lastEditAt: t, pendingSince: null, retryAt: null }, t))) { ({ raw, state } = await readEdit(env.DB)); continue; }
    const out = await redrawCards(env, cards, { fetchImpl, now: t });
    if (!out.ok) {
      // keep the mark so a later tick retries, after the 3 s gap or Discord's Retry-After, whichever is longer
      const retryAt = out.retryAfterMs ? t + out.retryAfterMs : null;
      await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(CARD_EDIT_KEY, JSON.stringify({ lastEditAt: t, pendingSince: t, retryAt }), new Date(t).toISOString()).run();
      return { status: "failed", results: out.results };
    }
    return { status: "edited", results: out.results };
  }
  return { status: "busy" };
}

// Admin: post a card for the first time (or recreate one a person deleted) and record its id. Pins best effort.
export async function postCard(env, { card, channelId, fetchImpl = fetch, now = Date.now(), replace = false }) {
  if (!RENDERERS[card]) return { ok: false, error: "card must be signups or board" };
  const cards = (await loadCards(env.DB)) || {};
  if (cards[card] && !cards[card].deleted && !cards[card].errored && !replace) return { ok: false, error: "card_exists", status: 409 };
  const state = await loadCardState(env);
  const body = RENDERERS[card](state);
  if (cardsShadow(env)) {
    await recordShadow(env.DB, "post", channelId, noiseDay(now, null)).catch(() => {});
    return { ok: true, shadow: true, card };
  }
  const r = await discordRest(env, "POST", `/channels/${channelId}/messages`, body, fetchImpl);
  if (!r.ok || !r.json || !isId(String(r.json.id))) return { ok: false, error: "discord_refused", status: 502, http: r.status };
  const messageId = String(r.json.id);
  await saveCards(env.DB, { ...cards, [card]: { channel: channelId, message: messageId } }, now);
  // The 2025 route first, the older one if Discord answers 404/405. A pin failure never fails the post.
  let pinned = false;
  try {
    let p = await discordRest(env, "PUT", `/channels/${channelId}/messages/pins/${messageId}`, undefined, fetchImpl);
    if (p.status === 404 || p.status === 405) p = await discordRest(env, "PUT", `/channels/${channelId}/pins/${messageId}`, undefined, fetchImpl);
    pinned = p.ok;
  } catch { /* ignore */ }
  return { ok: true, card, pinned };
}
