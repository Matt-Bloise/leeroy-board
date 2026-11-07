// Member data for the Discord cards, shaped from the same public party document /api/state serves (kv_state `party`).
// Hidden sheet fields are absent from that document (index.js publicParty path), so a hidden class or race never reaches a card.
// Pure: no I/O. The one D1 read lives in cards.js (loadCardState), outside the interaction hot path (cards redraw after the reply).
import { slugify, CLASSES } from "./member-model.js";

// Control, zero-width and line-separator characters (escaped codes below), mention and markdown syntax.
const BAD = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>@\x60*_~|\\\[\]()]`, "g");
const clean = (v, max = 24) => String(v === undefined || v === null ? "" : v).normalize("NFKC").replace(BAD, "").replace(/\s+/g, " ").trim().slice(0, max);
export const EMOJI_RE = /^<a?:[A-Za-z0-9_]{2,32}:[0-9]{15,25}>$/;

// Party document -> [{ slug, name, classKey, classLabel, race, role }]. Members without a usable name are skipped.
export function cardMembers(partyDoc) {
  const list = partyDoc && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m.name !== "string") continue;
    const slug = slugify(m.name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const key = typeof m.class_key === "string" && CLASSES[m.class_key] ? m.class_key : "";
    out.push({ slug, name: clean(m.name) || "Someone", classKey: key, classLabel: key ? CLASSES[key].label : clean(m.class, 16), race: clean(m.race, 16), role: clean(m.role, 12) });
  }
  return out;
}

// Application emoji map from the optional CARD_CLASS_EMOJI var (JSON { druid: "<:class_druid:ID>" }). Bad entries are dropped.
export function parseClassEmoji(raw) {
  if (!raw) return {};
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { return {}; } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (CLASSES[k] && typeof v === "string" && EMOJI_RE.test(v)) out[k] = v;
  return out;
}

export const memberFor = (members, entry) => {
  if (!Array.isArray(members) || !entry) return null;
  const bySlug = typeof entry.slug === "string" && entry.slug ? entry.slug : null;
  const byName = slugify(entry.name || "");
  return members.find((m) => m.slug === bySlug || m.slug === byName) || null;
};
export const iconFor = (member, emoji) => (member && member.classKey && emoji && emoji[member.classKey] ? `${emoji[member.classKey]} ` : "");
