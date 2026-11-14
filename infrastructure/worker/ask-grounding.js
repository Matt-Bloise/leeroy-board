// =============================================================================
// /ask grounding helpers (`worker/ask-grounding.js`): facts the prompt derives from DATA instead of assuming, and the deterministic checks that
// keep a claim the library never made out of the answer. Pure: no I/O, no clock, no model call.
//   groupComposition   the party's factions, read from the visible race of each sheet (never assumed: a mixed group is said to be mixed)
//   factionTag         marks a library fact that is for the other faction than the asker's
//   scopeOf            the source scope of a library fact (beta reports, guide, podcast recap, datamined, unsettled), so the answer can carry it
//   stripVerdictOpener a leading Yes or No is removed when the group is mixed: the verdict was not derived from the group as composed
// =============================================================================
import { factionOf } from "./ask-opener.js";
import { stripFence } from "./prompt-fence.js";

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
// Facts that name an official Blizzard source (a post, a deep dive, an announcement, "Forever-confirmed") are never labelled as fan or guide sourced, whatever else they cite.
const OFFICIAL_RE = /\b(?:Blizzard(?:'s)? (?:[\w-]+ ){0,3}(?:posts?|deep dives?|blogs?|announcements?|patch notes|confirmed)|Forever-confirmed)\b/i;
export function scopeOf(key, value) {
  const t = String(value || "");
  const out = [];
  if (/(?:^|[.~])OPEN$/.test(String(key || "")) || /\b(?:unresolved|untested|unpublished|unconfirmed|speculative|no decision|no fetched source|not (?:yet )?(?:published|settled|announced))\b/i.test(t)) out.push("unsettled");
  if (/\bbeta (?:reports?|feedback|data|testers?|players?)\b/i.test(t)) out.push("beta reports");
  if (/\bpodcast\b|\brecaps?\b/i.test(t)) out.push("podcast recap");
  if (/\bdatamin\w*|\bwowforevertalents\b|\bclient \d{4,}\b/i.test(t)) out.push("datamined");
  if (!OFFICIAL_RE.test(t) && /\b(?:guide|wiki|wowhead|icy veins|warcraft tavern)\b/i.test(t)) out.push("guide or fan site");
  return out;
}
export const scopeTag =(key, value) => {
  const s = scopeOf(key, value);
  return s.length ? ` [scope: ${s.join(", ")}]` : "";
};

export const GROUNDING_RULE =
  "GROUNDING: (1) Never assume the party's faction or make-up: use GROUP_COMPOSITION and YOUR_BUILD. A fact tagged [Horde fact ...] or [Alliance fact ...] is not for the asker: say which part applies to the asker's build, in the first two sentences, rather than presenting it as theirs. " +
  "(2) Do not open with Yes or No unless a LIBRARY fact says exactly that for the group as in GROUP_COMPOSITION; open with the fact that answers. " +
  "(3) A fact tagged [scope: ...] is not an official Blizzard statement: carry its label in the sentence in plain words (beta reports say, per the guide, the podcast recap says, datamined, not settled yet), and never give a time, date or number from it as settled. " +
  "(4) A list of what exists is not a statement of what does not: say that something is missing, absent, unavailable or has no trainer only when a LIBRARY fact says so in those words (no, none, not); otherwise say what the library lists and stop.";

// ---- verdict opener -----------------------------------------------------------------------------------------------------------
// "Yes, a Horde group can ..." in front of a mixed-faction group was assumed, not derived. With a mixed group the leading verdict word goes and the fact leads.
const VERDICT_RE = /^(\s*(?:\*\*)?)(?:yes|no|yep|nope|yeah)(?:\s*[,.:;!—]+|\s+[-–—]\s)\s*(?:\*\*)?\s*/i; // the verdict word must be followed by punctuation: "No Druid trainer ...", "No one ...", "Yes and no: ..." are not verdicts
export function stripVerdictOpener(answer, { mixed = false } = {}) {
  const text = String(answer || "");
  if (!mixed) return text;
  const m = VERDICT_RE.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  if (!/[A-Za-z]/.test(rest.slice(0, 40))) return text; // nothing but a verdict: leave it
  return `${(m[0].match(/\*\*/g) || []).length === 1 ? "**" : ""}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}
