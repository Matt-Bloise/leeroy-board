// =============================================================================
// /ask grounding helpers (`worker/ask-grounding.js`): facts the prompt derives from DATA instead of assuming, and the deterministic checks that
// keep a claim the library never made out of the answer. Pure: no I/O, no clock, no model call.
//   groupComposition   the party's factions, read from the visible race of each sheet (never assumed: a mixed group is said to be mixed)
//   factionTag         marks a library fact that is for the other faction than the asker's
//   scopeOf            the source scope of a library fact (beta reports, guide, podcast recap, datamined, unsettled), so the answer can carry it
//   absenceCheck       "no X", "none", "never" claims survive only when a library clause says so in those words (a list of what exists is not a list of what does not)
//   stripVerdictOpener a leading Yes or No is removed when the group is mixed: the verdict was not derived from the group as composed
// =============================================================================
import { factionOf } from "./ask-opener.js";
import { stripFence } from "./prompt-fence.js";
import { NOT_PUBLISHED_LINE } from "./ask-build.js";

const isVisible = (f) => Boolean(f) && typeof f === "object" && !Array.isArray(f) && f.visible === true;
const raceText = (f) => {
  const v = f && typeof f === "object" && !Array.isArray(f) && "value" in f ? f.value : f;
  return typeof v === "string" ? v : "";
};
const nameOf = (s) => stripFence(String((s && (s.name || s.slug)) || ""), { oneLine: true }).slice(0, 40);

// The party's factions from the races on the sheets. A race that is hidden (and not the asker's own on a private ask) counts as "not on file": nothing is guessed
// and nothing hidden leaks into a public ask. mixed = both factions are present among the sheets that say.
export function groupComposition(sheets, { askerSheet = null, includeHidden = false } = {}) {
  const horde = [], alliance = [], unknown = [];
  for (const s of Array.isArray(sheets) ? sheets : []) {
    if (!s) continue;
    const f = (s.fields || {}).race;
    const shown = isVisible(f) || (includeHidden && s === askerSheet && f);
    const fac = shown ? factionOf(raceText(f)) : "";
    (fac === "Horde" ? horde : fac === "Alliance" ? alliance : unknown).push(nameOf(s));
  }
  const total = horde.length + alliance.length + unknown.length;
  const mixed = horde.length > 0 && alliance.length > 0;
  let line = "";
  if (total) {
    const parts = [];
    if (horde.length) parts.push(`Horde: ${horde.join(", ")}`);
    if (alliance.length) parts.push(`Alliance: ${alliance.join(", ")}`);
    if (unknown.length) parts.push(`faction not on file: ${unknown.join(", ")}`);
    const lead = mixed ? "mixed faction" : horde.length || alliance.length ? `${horde.length ? "Horde" : "Alliance"} only among the sheets that say` : "no faction on file for anyone";
    line = `${lead}; ${parts.join("; ")}`;
  }
  return { horde, alliance, unknown, total, mixed, line };
}

// A fact that names only one faction is not for an asker of the other. "" when nothing to say.
export function factionTag(page, value, askerFaction) {
  if (askerFaction !== "Horde" && askerFaction !== "Alliance") return "";
  const text = `${page || ""} ${value || ""}`;
  const h = /\bhorde\b/i.test(text), a = /\balliance\b/i.test(text);
  if (askerFaction === "Alliance" && h && !a) return " [Horde fact: not the asker's faction]";
  if (askerFaction === "Horde" && a && !h) return " [Alliance fact: not the asker's faction]";
  return "";
}

// The scope of a fact, from the words its own text carries (the library already writes its sources into the value). [] = nothing to label.
export function scopeOf(key, value) {
  const t = String(value || "");
  const out = [];
  if (/(?:^|[.~])OPEN$/.test(String(key || "")) || /\b(?:unresolved|untested|unpublished|unconfirmed|speculative|no decision|no fetched source|not (?:yet )?(?:published|settled|announced))\b/i.test(t)) out.push("unsettled");
  if (/\bbeta (?:reports?|feedback|data|testers?|players?)\b/i.test(t)) out.push("beta reports");
  if (/\bpodcast\b|\brecaps?\b/i.test(t)) out.push("podcast recap");
  if (/\bdatamin\w*|\bwowforevertalents\b|\bclient \d{4,}\b/i.test(t)) out.push("datamined");
  if (/\b(?:guide|wiki|wowhead|icy veins|warcraft tavern|tier 2|forum)\b/i.test(t)) out.push("guide or fan site");
  return out;
}
export const scopeTag = (key, value) => {
  const s = scopeOf(key, value);
  return s.length ? ` [scope: ${s.join(", ")}]` : "";
};

export const GROUNDING_RULE =
  "GROUNDING: (1) Never assume the party's faction or make-up: use GROUP_COMPOSITION and YOUR_BUILD. A fact tagged [Horde fact ...] or [Alliance fact ...] is not for the asker: say which part applies to the asker's build, in the first two sentences, rather than presenting it as theirs. " +
  "(2) Do not open with Yes or No unless a LIBRARY fact says exactly that for the group as in GROUP_COMPOSITION; open with the fact that answers. " +
  "(3) A fact tagged [scope: ...] is not an official Blizzard statement: carry its label in the sentence in plain words (beta reports say, per the guide, the podcast recap says, datamined, not settled yet), and never give a time, date or number from it as settled. " +
  "(4) A list of what exists is not a statement of what does not: say that something is missing, absent, unavailable or has no trainer only when a LIBRARY fact says so in those words (no, none, not); otherwise say what the library lists and stop.";

// ---- absence claims -----------------------------------------------------------------------------------------------------------
const ABSENCE_RE = /\b(?:no|none|never|nothing|neither|lacks?|lacking|absent|unavailable|missing)\b|\bnot (?:available|offered|trained|taught|sold)\b|\b(?:does not|do not|doesn't|don't) (?:have|offer|train|teach|sell|include|exist)\b/i;
// A claim about the library's own coverage or a status ("no decision announced", "nothing published") is not a claim about the game. Tested on the words of the claim itself
// (from the marker to the clause end), never on the whole sentence: a status word elsewhere cannot exempt a game claim.
const STATUS_RE = /\b(?:library|published|publish|confirm\w*|settled|unresolved|speculative|untested|announced|decision|fetched)\b/i;
// The text the answer may rely on stops where the asker's own words begin (the question, the earlier question, the display name): a question's "no X" is not evidence.
export const ASKER_TEXT_MARK = "[[asker-text]]";
const evidenceOf = (text) => { const s = String(text || ""); const i = s.indexOf(ASKER_TEXT_MARK); return i >= 0 ? s.slice(0, i) : s; };
const NEG_RE = /\b(?:no|none|not|never|nothing|neither|nor|cannot|without|lacks?|lacking|unavailable|absent|unlisted|missing)\b|n't\b/i;
const STOP = new Set("the and any all for with from that this there here are was were can will would could should may might has have had does did not but into out per via while which who what when where also only still even more than then they them their you your our one ones such yet its it's".split(" "));
const norm = (w) => String(w || "").toLowerCase().replace(/'s$/, "").replace(/(?:es|s|e)$/, "");
const wordsOf = (t) => String(t || "").toLowerCase().match(/[a-z][a-z'-]*/g) || [];

function clausesOf(text) {
  return String(text || "")
    .replace(/\[\[retrieved:[^\]]*\]\]/g, " ")
    .split(/[;\n()]+|\.\s+|\s(?:but|whereas|however)\s/i) // a contrast splits a clause: "has trainers but no auction house" negates only the second part
    .map((c) => ({ neg: NEG_RE.test(c), text: c, stems: new Set(wordsOf(c).map(norm)) }))
    .filter((c) => c.neg);
}

// The key words of one claim: the content words right after its marker, up to the clause end or the next marker. A capitalised word (a class, a place, a name) must be
// in the supporting clause; of the lower-case words all (two or fewer) or a third must be (a paraphrase such as "automatically matches" for "no automatic matching" still stands).
// The subject before the marker counts too: "Stormwind has no trainers" needs Stormwind in the clause, not just trainers (capitalised words of the clause before the marker).
function keysAfter(sentence, m, end, prior = 0) {
  const rest = sentence.slice(m.index + m[0].length, end).split(/[,;:.!?()—]/)[0];
  const before = sentence.slice(prior, m.index).split(/[,;:!?()—]|\s-\s/).pop();
  const caps = [], low = [];
  const take = (text) => {
    for (const w of text.match(/[A-Za-z][A-Za-z'-]*/g) || []) {
      const lw = w.toLowerCase();
      if (lw.length < 3 || STOP.has(lw) || /^(?:or|and|in|at|of|on|to|by)$/.test(lw)) continue;
      (/^[A-Z]/.test(w) ? caps : low).push(norm(w));
    }
  };
  take(rest);
  take(before); // the subject before the marker, lower case too: "paladins have no trainers" needs paladins in the clause
  return { caps, low, text: rest, pre: before };
}
const has = (c, k) => { for (const t of c.stems) if (t === k || (k.length >= 5 && t.length >= 5 && t.slice(0, 5) === k.slice(0, 5))) return true; return false; };
const supports = (c, { caps, low }) => caps.every((k) => has(c, k)) && low.filter((k) => has(c, k)).length >= (low.length <= 2 ? low.length : Math.ceil(low.length / 3));

const balanceBold = (line) => ((line.match(/\*\*/g) || []).length % 2 ? line.replace(/\*\*/g, "") : line);

// Returns { ok, removed: [claim words], answer }. A claim with no supporting library clause is cut: back to the comma before it when enough sentence is left, else the sentence goes.
export function absenceCheck(answer, allowedText) {
  const text = String(answer || "");
  const cut = text.search(/\n-#\s*Sources?:/i);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const tail = cut >= 0 ? text.slice(cut) : "";
  const clauses = clausesOf(evidenceOf(allowedText));
  const removed = [];
  const kept = [];
  for (const line of body.split("\n")) {
    const parts = line.split(/(?<=[.!?])\s+/);
    const out = [];
    for (const sent of parts) {
      // A leading "No," / "No." is the answer's verdict, not a claim about the game: the claims after it are still checked.
      const marks = [...sent.matchAll(new RegExp(ABSENCE_RE.source, "gi"))].filter((mk) => !(/^no$/i.test(mk[0]) && /^[\s*]*$/.test(sent.slice(0, mk.index)) && /^\s*[,.:;!—-]/.test(sent.slice(mk.index + 2))));
      const bad = marks.find((mk, j) => {
        const k = keysAfter(sent, mk, j + 1 < marks.length ? marks[j + 1].index : sent.length, j > 0 ? marks[j - 1].index + marks[j - 1][0].length : 0);
        // Status test: the marker, its own words and the three words just before it ("Blizzard has published no figure"); a status word further back cannot exempt a game claim.
        if (STATUS_RE.test(`${k.pre.split(/\s+/).slice(-3).join(" ")} ${mk[0]} ${k.text}`)) return false;
        // No key words at all ("There are none."): supported only when a library clause uses the same marker word.
        if (k.caps.length + k.low.length === 0) return !clauses.some((c) => new RegExp(`\\b${mk[0]}\\b`, "i").test(c.text));
        return !clauses.some((c) => supports(c, k));
      });
      if (!bad) { out.push(sent); continue; }
      const m = bad;
      removed.push(sent.slice(m.index, m.index + 60));
      const prefix = sent.slice(0, m.index);
      const at = Math.max(prefix.lastIndexOf(", "), prefix.lastIndexOf("; "), prefix.lastIndexOf(" — "));
      if (at >= 15) {
        const end = /[.!?]$/.test(sent.trim()) ? sent.trim().slice(-1) : ".";
        out.push(`${sent.slice(0, at).replace(/[\s,;:—-]+$/, "").replace(/\s+(?:and|but|or|while|with)$/i, "")}${end}`);
      }
    }
    if (out.length === parts.length && out.every((o, i) => o === parts[i])) kept.push(line);
    else if (out.length) kept.push(balanceBold(out.join(" ")));
  }
  if (!removed.length) return { ok: true, removed: [], answer: text };
  const left = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const substantive = left.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2).length;
  if (substantive < 4) return { ok: false, removed, answer: NOT_PUBLISHED_LINE };
  return { ok: false, removed, answer: `${left}${tail}` };
}

// ---- verdict opener -----------------------------------------------------------------------------------------------------------
// "Yes, a Horde group can ..." in front of a mixed-faction group was assumed, not derived. With a mixed group the leading verdict word goes and the fact leads.
const VERDICT_RE = /^(\s*(?:\*\*)?)(?:yes|no|yep|nope|yeah)\b[\s,.:;!—-]*(?:\*\*)?\s*/i;
export function stripVerdictOpener(answer, { mixed = false } = {}) {
  const text = String(answer || "");
  if (!mixed) return text;
  const m = VERDICT_RE.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  if (!/[A-Za-z]/.test(rest.slice(0, 40))) return text; // nothing but a verdict: leave it
  return `${m[1].includes("**") ? "**" : ""}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}
