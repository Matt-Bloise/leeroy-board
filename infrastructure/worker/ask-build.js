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

// The asker's sheet. The authenticated member slug decides on its own; the display name is a fallback only when there is no slug, and
// a name-only match is never trusted with hidden fields (bySlug false). Visitors never match.
export function findAsker(sheets, { by, memberSlug, isMember = true } = {}) {
  if (!isMember || !Array.isArray(sheets)) return { sheet: null, bySlug: false };
  const slug = memberSlug && memberSlug !== "guest" ? slugify(memberSlug) : "";
  if (slug) {
    const hit = sheets.find((s) => s && slugify(s.slug || "") === slug);
    if (hit) return { sheet: hit, bySlug: true };
    return { sheet: null, bySlug: false };
  }
  const want = new Set();
  if (by && String(by).trim().toLowerCase() !== "visitor") {
    want.add(slugify(by));
    const lower = String(by).trim().toLowerCase();
    for (const r of ROSTER_DATA) if (r.display.toLowerCase() === lower || (r.aliases || []).includes(lower)) want.add(slugify(r.display));
  }
  want.delete("");
  const hit = sheets.find((s) => s && (want.has(slugify(s.slug || "")) || want.has(slugify(s.name || ""))));
  return { sheet: hit || null, bySlug: false };
}

export const findAskerSheet = (sheets, o) => findAsker(sheets, o).sheet;

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

// The asker's own fields. A hidden field is included only for a private ask (includeHidden): a public ask is posted in the channel,
// where the model could repeat it to everyone.
export function renderAskerBuild(sheet, stateMap, { includeHidden = false } = {}) {
  if (!sheet) return EMPTY_BUILD_LINE;
  const fields = sheet.fields || {};
  const parts = [];
  for (const k of FIELD_ORDER) {
    if (!includeHidden && fields[k] && fields[k].visible === false) continue;
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
// A Title Case phrase of two or more words that appears nowhere in the retrieved library text, the asker's build, the party state, the
// party names or the question is an invented spell, place or item. Conservative: single capitalised words, house names, generic prose
// words ("Recommended Next Steps"), headings and leading connector words never trigger it. A hit removes only the sentence or bullet that
// holds the name; the whole answer falls back to the not-published line only when nothing substantive is left.
const PHRASE_RE = /\b[A-Z][a-z']+(?:\s+(?:of|the|in|for|to)\s+[A-Z][a-z']+|\s+[A-Z][a-z']+)+/g;
const HOUSE = [...ROSTER_DATA.map((r) => r.display), "leeroy", "leeroy jenkins", "dungeons and drinking", "wow classic", "classic forever", "world of warcraft"];
const CONNECTORS = new Set(["of", "the", "in", "for", "to", "and", "a", "an", "at", "on", "with"]);
// Words that make ordinary prose look like a name: sentence openers, heading words, filler.
const GENERIC = new Set((
  "a an and any as at also all be best both but by can check consider choose do does each either even every first for from get good great " +
  "have here how if in is it its just key last later less let like luck look make many more most much next no not now of on one only open " +
  "option options or other our overview point points quick recommended remember same see second set should since so some start step steps " +
  "summary take tell tip tips that the their then there these they third this those though three tonight today too try two up use want was " +
  "way we well what when where which while who why will with without worth would yes you your meet pick keep give note notes plan " +
  "reminder reminders also still once before after during until across about above below over under per via ask answer answers question " +
  "questions party board library sign signup signups ups trade offs long short high low early late new old big small full half"
).split(/\s+/));

const words = (t) => t.split(/\s+/).filter(Boolean);

function trimPhrase(phrase, opens) {
  let w = words(phrase);
  // Leading connectors and generic filler are not part of a name ("Meet in Deadmines" -> "Deadmines").
  while (w.length && (CONNECTORS.has(w[0].toLowerCase()) || (GENERIC.has(w[0].toLowerCase()) && (opens || w.length > 2)))) w.shift();
  while (w.length && (CONNECTORS.has(w[w.length - 1].toLowerCase()) || GENERIC.has(w[w.length - 1].toLowerCase()))) w.pop();
  return w;
}

function isHeading(line) {
  const t = line.replace(/[*_`#>\-•\s]+/g, " ").trim();
  if (!t) return true;
  if (/:\s*$/.test(line.trim()) || /^\s*#/.test(line)) return true;
  return words(t).length <= 5 && !/[.!?]$/.test(t) && /^\*\*.*\*\*$|^__.*__$/.test(line.trim().replace(/^[-•]\s*/, ""));
}

const tokenCache = new Map();
function tokens(allowed) {
  let t = tokenCache.get(allowed);
  if (!t) {
    t = new Set(allowed.match(/[a-z']+/g) || []);
    if (tokenCache.size > 20) tokenCache.clear();
    tokenCache.set(allowed, t);
  }
  return t;
}

function badPhrases(text, allowed) {
  const bad = [];
  for (const m of text.replace(/[*_`]/g, "").matchAll(PHRASE_RE)) {
    const full = m[0].trim();
    if (allowed.includes(full.toLowerCase())) continue;
    const core = trimPhrase(full, true);
    if (core.length < 2) continue;
    const coreText = core.join(" ");
    if (allowed.includes(coreText.toLowerCase())) continue;
    // Every word of the name is individually grounded and the phrase is just two grounded things side by side ("Paladin Deadmines").
    if (core.filter((x) => !CONNECTORS.has(x.toLowerCase())).every((x) => tokens(allowed).has(x.toLowerCase())) && core.filter((x) => !CONNECTORS.has(x.toLowerCase())).length <= 3) continue;
    bad.push(full);
  }
  return bad;
}

export function unknownNames(answer, allowedText) {
  const body = String(answer || "").split(/\n-#\s*Sources?:/i)[0];
  const allowed = `${allowedText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  const bad = [];
  for (const line of body.split("\n")) {
    if (isHeading(line)) continue;
    bad.push(...badPhrases(line, allowed));
  }
  return bad;
}

// Remove only the sentences/bullets that hold an unknown name; keep everything else, the headline and the Sources line.
export function groundedOrNotPublished(answer, allowedText) {
  const text = String(answer || "");
  const cut = text.search(/\n-#\s*Sources?:/i);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const tail = cut >= 0 ? text.slice(cut) : "";
  const allowed = `${allowedText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  const bad = [];
  const kept = [];
  for (const line of body.split("\n")) {
    if (isHeading(line)) { kept.push(line); continue; }
    const parts = line.split(/(?<=[.!?])\s+/);
    const ok = parts.filter((sent) => {
      const b = badPhrases(sent, allowed);
      bad.push(...b);
      return b.length === 0;
    });
    if (ok.length === parts.length) kept.push(line);
    else if (ok.length) kept.push(ok.join(" "));
    // a line that lost every sentence is dropped
  }
  if (!bad.length) return { ok: true, bad: [], answer: text };
  const left = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const substantive = left.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2).length;
  if (substantive < 4) return { ok: false, bad, answer: NOT_PUBLISHED_LINE };
  return { ok: false, bad, answer: `${left}${tail}` };
}
