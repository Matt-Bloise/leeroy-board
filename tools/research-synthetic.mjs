// Synthetic, fictional corpus shared by tools/measure-research-cpu.mjs and tools/measure-claude-latency.mjs.
// No friend text: every name below is invented. Roster names are NOT written here; when a question should exercise the tokeniser, the name is taken
// from researchMembers() at run time, so no real name is a literal in this file and none is ever printed by the tools.
import { researchMembers } from "../infrastructure/worker/privacy/roster-config.js";
import { RESEARCH_RULES } from "../infrastructure/worker/research/rules.js";

const FICTIONAL_SHEETS = [
  { name: "Quillfeather", slug: "quillfeather", fields: { class: "mage", race: "gnome", level: "40", role: "dps", professions: "tailoring, enchanting", plan_zone: "Zul'Farrak with the whole party on Friday", goals: "finish the bracers for the fire set" } },
  { name: "Brindlewick", slug: "brindlewick", fields: { class: "warrior", race: "dwarf", level: "38", role: "tank", professions: "mining, blacksmithing", plan_zone: "Scarlet Monastery", goals: "get the shield from the library wing" } },
  { name: "Tallowmere", slug: "tallowmere", fields: { class: "priest", race: "human", level: "41", role: "healer", professions: "herbalism, alchemy", plan_zone: "Uldaman", goals: "farm herbs for flasks" } },
  { name: "Orrinwhistle", slug: "orrinwhistle", fields: { class: "rogue", race: "night elf", level: "37", role: "dps", professions: "fishing, cooking", plan_zone: "Stranglethorn", goals: "keep the lockpicking skill up" } },
];
export const FICTIONAL_ASKER = "Pemberlow";

const TOPICS = [
  "what is the best talent order for a mage at level 40 in a dungeon group",
  "does the third boss in the monastery wing drop anything a tank wants",
  "how much does a flask cost to make and is it worth it for a casual night",
  "which professions pair well for a player who spends most of the evening in dungeons",
  "should I take the shield or the sword from the quest chain",
  "what is the fastest route between the two capital cities for a level 38 character",
  "is it worth farming herbs on the weekend or buying them from the auction house",
  "what happens if we pull the second pack before the healer has mana",
  "how do I handle the patrol in the cave without wiping the group",
  "which gear slots matter most before the next dungeon",
];

// The library block of the prompt: filler the size of a real retrieved page set (a few thousand tokens at the default size). Invented facts only.
function libraryText(chars) {
  const lines = [];
  let total = 0;
  let i = 0;
  while (total < chars) {
    const line = `[page-${i}] Fictional entry ${i}: the Hollowbrook Annex lists a reagent called glimmerroot that sells for ${(i % 9) + 2} silver, a patrol that resets after ${(i % 7) + 3} minutes, and a quest giver who asks for ${(i % 5) + 4} bundles of thornwheat. As of patch ${(i % 4) + 1}.${i % 10}.`;
    lines.push(line);
    total += line.length + 1;
    i += 1;
  }
  return lines.join("\n").slice(0, chars);
}

export function systemPromptFor(chars = 3000) {
  return `You are the party assistant. ${RESEARCH_RULES}\n\nLIBRARY (fictional, for measurement only):\n${libraryText(chars)}`;
}

// `i` selects a question; `withRosterName` puts a current roster name into the question so the tokeniser has real work.
export function questionFor(i, { withRosterName = false, nonce = "" } = {}) {
  const roster = researchMembers();
  const who = withRosterName && roster.length ? ` Asking for ${roster[i % roster.length].display}.` : "";
  return `${TOPICS[i % TOPICS.length]}?${who}${nonce ? ` (ref ${nonce})` : ""}`;
}

export function sheetsFor() {
  return FICTIONAL_SHEETS.map((s) => ({ ...s, fields: { ...s.fields } }));
}

export function userPromptFor({ question, previousQuestion = "", asker = FICTIONAL_ASKER, sheets = FICTIONAL_SHEETS, chars = 6000 }) {
  const sheetBlock = sheets.map((s) => `Sheet ${s.name}: ${Object.entries(s.fields).map(([k, v]) => `${k}=${typeof v === "object" ? v.value : v}`).join("; ")}`).join("\n");
  const history = libraryText(chars);
  return [`Asker: ${asker} (journey 3)`, sheetBlock, previousQuestion ? `PREVIOUS_QUESTION: ${previousQuestion}` : "", `RETRIEVED:\n${history}`, `Question from ${asker} (journey 3): ${question}`].filter(Boolean).join("\n\n");
}

export const SAMPLE_REPLY =
  "Take the arcane line first, then fire once you have the mana to hold it. **Classic value, not confirmed for Forever:** the third boss drops a cloak around level 40, and a flask costs about 8 silver in herbs. " +
  "Choose the shield if you are tanking and the sword if you are not.\n-# Sources: page-1, page-2";

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
export function summarise(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: percentile(s, 50), p95: percentile(s, 95), max: s.length ? s[s.length - 1] : NaN };
}
