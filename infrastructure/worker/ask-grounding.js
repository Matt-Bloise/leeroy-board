// =============================================================================
// /ask grounding helpers (`worker/ask-grounding.js`): facts the PROMPT derives from data instead of assuming. Pure: no I/O, no clock, no model call.
//   groupComposition   the party's factions, read from the visible race of each sheet (never assumed: a mixed group is said to be mixed)
//   scopeOf / scopeTag the source scope of a library fact (beta reports, guide or fan site, community, podcast recap, datamined, unsettled), so the answer can carry it
//   GROUNDING_RULE     the prompt text that uses both, and tells the model not to open with Yes or No or to state an absence the library did not state
// Nothing here edits an answer. The opener and absence claims are prompt-guided, not code-guaranteed.
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

// The scope of a fact, from the words its own text carries (the library already writes its sources into the value). [] = nothing to label.
// A fact that names an official Blizzard source (a post, a deep dive, an announcement, "Forever-confirmed") is never labelled as guide, fan or community sourced, but a NEGATED
// mention ("not in Blizzard's post", "no Blizzard post read", "Blizzard has not confirmed") is not a source and is removed before that test.
const OFFICIAL_RE = /\bBlizzard(?:'s)? (?:[\w-]+ ){0,3}(?:posts?|deep dives?|blogs?|announcements?|patch notes|confirmed)\b|\bForever-confirmed\b/i;
export const officialSource = (t) =>
  OFFICIAL_RE.test(
    String(t || "")
      .replace(/\b(?:no|not|never|nor|without)\b[^;()]{0,40}\bBlizzard\b/gi, " ")
      .replace(/\bBlizzard(?:'s)?\s+(?:(?:has|have|had|did|does|is|are|was|were)\s+)?(?:not|never)\b/gi, " ")
      .replace(/\bBlizzard\s+\w*n't\b/gi, " ")
  );
export function scopeOf(key, value) {
  const t = String(value || "");
  const out = [];
  if (/(?:^|[.~])OPEN$/.test(String(key || "")) || /\b(?:unresolved|untested|unpublished|unconfirmed|speculative|no decision|no fetched source|not (?:yet )?(?:published|settled|announced))\b/i.test(t)) out.push("unsettled");
  if (/\bbeta (?:reports?|feedback|data|testers?|players?)\b/i.test(t)) out.push("beta reports");
  if (/\bpodcast\b|\brecaps?\b/i.test(t)) out.push("podcast recap");
  if (/\bdatamin\w*|\bwowforevertalents\b|\bclient \d{4,}\b/i.test(t)) out.push("datamined");
  if (!officialSource(t)) {
    if (/\b(?:guide|wiki|wowhead|icy veins|warcraft tavern)\b/i.test(t)) out.push("guide or fan site");
    if (/\b(?:forum|videos?|youtube|reddit|community|streamers?)\b/i.test(t)) out.push("community source");
  }
  return out;
}
export const scopeTag = (key, value) => {
  const s = scopeOf(key, value);
  return s.length ? ` [scope: ${s.join(", ")}]` : "";
};

export const GROUNDING_RULE =
  "GROUNDING: (1) Never assume the party's faction or make-up: use GROUP_COMPOSITION and YOUR_BUILD. Where a library fact is for one faction only, say which part applies to the asker's build, in the first two sentences, rather than presenting it as theirs. " +
  "(2) Do not open with Yes or No unless a LIBRARY fact says exactly that for the group as in GROUP_COMPOSITION; when the group is mixed, open with the fact that answers. " +
  "(3) A fact tagged [scope: ...] carries that limit: carry its label in the sentence in plain words (beta reports say, per the guide, the podcast recap says, datamined, not settled yet), and never give a time, date or number from it as settled. " +
  "(4) A list of what exists is not a statement of what does not: say that something is missing, absent, unavailable or has no trainer only when a LIBRARY fact says so in those words (no, none, not); otherwise say what the library lists and stop.";
