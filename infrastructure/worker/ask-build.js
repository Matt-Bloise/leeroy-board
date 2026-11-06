// Personalisation for /ask: who is asking, their own build (YOUR_BUILD), the others' published builds (PARTY_BUILDS, visible fields
// only), and a cheap grounding check that replaces an answer naming things the library never gave. Pure functions; no I/O.
import { slugify } from "./member-model.js";
import { ROSTER_DATA } from "./bot-data.js";
import { stripFence } from "./prompt-fence.js";

export const NOT_PUBLISHED_LINE = "The library does not have that yet.";
export const EMPTY_BUILD_LINE = "No build on file for the asker yet. Say so once and ask them to fill in their sheet on the board.";

// Sheet fields shown to the model, in order. Mirrors SHEET_FIELDS in index.js plus role if a sheet carries one.
const FIELD_ORDER = ["class", "race", "spec_path", "spec_at_40", "level", "role", "professions", "launch_state", "plan_zone", "goals"];

const clip = (s, n) => String(s).replace(/\s+/g, " ").trim().slice(0, n);

function fieldText(f) {
  const v = f && typeof f === "object" && !Array.isArray(f) && "value" in f ? f.value : f;
  if (v === null || v === undefined || v === "") return "";
  return clip(stripFence(Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v, { oneLine: true }), 120);
}

// The asker's sheet: by member slug first, then by display name, then by roster alias. Visitors never match.
export function findAskerSheet(sheets, { by, memberSlug, isMember = true } = {}) {
  if (!isMember || !Array.isArray(sheets)) return null;
  const want = new Set();
  if (memberSlug && memberSlug !== "guest") want.add(slugify(memberSlug));
  if (by && String(by).trim().toLowerCase() !== "visitor") {
    want.add(slugify(by));
    const lower = String(by).trim().toLowerCase();
    for (const r of ROSTER_DATA) if (r.display.toLowerCase() === lower || (r.aliases || []).includes(lower)) want.add(slugify(r.display));
  }
  want.delete("");
  return sheets.find((s) => s && (want.has(slugify(s.slug || "")) || want.has(slugify(s.name || "")))) || null;
}

function stateFor(sheet, stateMap) {
  const out = [];
  const roster = stateMap && stateMap.signups && stateMap.signups.roster;
  if (roster && typeof roster === "object") {
    for (const [k, v] of Object.entries(roster)) if (slugify(k) === slugify(sheet.slug || sheet.name || "")) out.push(`signup: ${clip(stripFence(v, { oneLine: true }), 40)}`);
  }
  const t = stateMap && stateMap.tonight;
  if (t) {
    const label = typeof t === "object" ? t.title || t.status || "" : t;
    if (label) out.push(`tonight: ${clip(stripFence(label, { oneLine: true }), 60)}`);
  }
  return out;
}

// All of the asker's own fields, visible or not: it is their data going into their own answer.
export function renderAskerBuild(sheet, stateMap) {
  if (!sheet) return EMPTY_BUILD_LINE;
  const fields = sheet.fields || {};
  const parts = [];
  for (const k of FIELD_ORDER) {
    const t = fieldText(fields[k]);
    if (t) parts.push(`${k}: ${t}`);
  }
  if (!parts.length) return EMPTY_BUILD_LINE;
  return [`${clip(stripFence(sheet.name || sheet.slug, { oneLine: true }), 40)} (the asker)`, ...parts, ...stateFor(sheet, stateMap)].join("; ");
}

// Other members: ONLY fields marked visible. A hidden field's value must never reach the prompt.
export function renderPartyBuilds(sheets, askerSheet) {
  const lines = [];
  for (const s of Array.isArray(sheets) ? sheets : []) {
    if (!s || s === askerSheet) continue;
    const parts = [];
    for (const k of FIELD_ORDER) {
      const f = (s.fields || {})[k];
      if (!f || f.visible === false) continue;
      const t = fieldText(f);
      if (t) parts.push(`${k} ${t}`);
    }
    lines.push(`${clip(stripFence(s.name || s.slug, { oneLine: true }), 40)}: ${parts.join(", ") || "no public build yet"}`);
  }
  return lines.join("\n");
}

// ---- grounding check -------------------------------------------------------------------------------------------------------
// A Title Case phrase of two or more words that appears nowhere in the retrieved library text, the asker's build, the party names or
// the question is an invented spell, place or item. Conservative: single capitalised words and the house names never trigger it, and a
// phrase's first word is ignored when it only opens a sentence.
const PHRASE_RE = /\b[A-Z][a-z']+(?:\s+(?:of|the|in|for|to)\s+[A-Z][a-z']+|\s+[A-Z][a-z']+)+/g;
const HOUSE = [...ROSTER_DATA.map((r) => r.display), "leeroy", "leeroy jenkins", "dungeons and drinking", "wow classic", "classic forever", "world of warcraft"];

export function unknownNames(answer, allowedText) {
  const body = String(answer || "").split(/\n-#\s*Sources?:/i)[0].replace(/[*_`]/g, "");
  const allowed = `${allowedText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  const bad = [];
  for (const m of body.matchAll(PHRASE_RE)) {
    const phrase = m[0].trim();
    const start = m.index;
    const opens = start === 0 || /[.!?:\n]\s*$/.test(body.slice(Math.max(0, start - 3), start)) || /(^|\n)\s*[-•]\s*$/.test(body.slice(Math.max(0, start - 6), start));
    const words = phrase.split(/\s+/);
    const checked = opens ? words.slice(1).join(" ") : phrase;
    if (!checked || checked.split(/\s+/).length < 2) continue;
    if (!allowed.includes(checked.toLowerCase()) && !allowed.includes(phrase.toLowerCase())) bad.push(phrase);
  }
  return bad;
}

export function groundedOrNotPublished(answer, allowedText) {
  const bad = unknownNames(answer, allowedText);
  return bad.length ? { ok: false, bad, answer: NOT_PUBLISHED_LINE } : { ok: true, bad: [], answer };
}
