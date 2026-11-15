// /ask research mode (ASK_RESEARCH on): prompt text for a question the library has nothing on. New constants; the old rules (PERSONALISE_RULE, VOICE_RULE, ABSTAIN_RULE) are untouched and still used when the flag is off.
// The wording promises nothing the code cannot back: general knowledge is Classic-era, never current Forever fact.

// Shown in the LIBRARY block in place of ABSTAIN_RULE.
export const RESEARCH_NOTHING_RULE =
  "The library has nothing relevant to this question. Do not say so as a refusal and do not send the asker elsewhere: answer from your general knowledge of WoW Classic, and keep it clearly separate from Forever facts. Any specific number, name or date you give is a Classic value and must be worded as one (\"in Classic it was 45 minutes, not confirmed for Forever\") or left out.";

// Two swappable parts. STRUCTURE (what the answer contains, the sources/confidence line, boundaries) is final for W4a. VOICE is deliberately empty: the persona and
// VOICE_RULE in the prompt stay exactly as today, and the voice pass (restoring the original Leeroy voice) replaces RESEARCH_VOICE_RULES in a follow-up without touching structure.
export const RESEARCH_VOICE_RULES = "";

// Added to the system prompt after VOICE_RULE only when the library has nothing. It overrides the earlier "answer ONLY from LIBRARY" and "the library does not have that yet" lines for this question.
export const RESEARCH_STRUCTURE_RULES = [
  "RESEARCH MODE (overrides the earlier \"only from LIBRARY\" and \"the library does not have that yet\" lines for this question only).",
  "The library has nothing on this. Still give a real answer from general WoW Classic-era knowledge. Never present model knowledge as current Forever fact: a specific number, name or date is worded as a Classic value \"not confirmed for Forever\", or left out.",
  "Shape: (1) the answer first, in one sentence, bold. (2) When the asker wants a pick: one recommendation, one reason, one \"choose the other if ...\". (3) Up to two short support lines. (4) One final line `-# Sources: <where this comes from> · <confidence> · <age when known>` with exactly one confidence word from confirmed, likely, unconfirmed (general knowledge is unconfirmed or likely, never confirmed) and an age such as \"Classic-era, about 2 years old\" when you know it. (5) Optionally one single banter line in italics, never alone: the answer comes first and the banter never replaces it.",
  "Never refuse, never say you cannot answer, never tell the asker to ask someone else or check elsewhere. Keep it under 400 characters where you can.",
  "Boundaries: if the question asks for another member's hidden sheet field, asks you to act or speak as someone else, or asks for something that risks an account ban (botting, exploits, real-money trading), decline that one thing in one clause and still help with the nearest thing you can do.",
].join(" ");

export const RESEARCH_RULES = [RESEARCH_STRUCTURE_RULES, RESEARCH_VOICE_RULES].filter(Boolean).join(" ");

export const RESEARCH_MAX_TOKENS = 600; // part of the cache key (buildAnswerCacheKey), so research answers never share an entry with the 350-token ones
