// /ask research mode: provider forcing. Every /ask prompt carries group context (PARTY_STATE names, YOUR_BUILD, PARTY_BUILDS), and the outside keys the Worker holds include a
// free-tier Gemini key whose terms allow product-improvement use. So with ASK_RESEARCH on the chosen provider is always the Workers AI binding for the paths that use it (never the asker's choice,
// never a hop to Gemini or any other provider). A MEMBER's friend text never reaches Workers AI: Claude (research/claude.js) answers, and when it cannot the degraded line below (plus library
// facts) does. Workers AI answers GUESTS only, and only with the tokenised prompt; the admin evaluation tokenises too. One helper so every work item reuses the same rule.
import { researchEnabled } from "./index.js";

export const RESEARCH_PROVIDER = "workers-ai";

// Whether research mode (and so the Workers-AI-only rule) applies. Fails CLOSED: if reading the flag throws, treat it as ON, because the alternative is normal provider
// selection, which can send group context to an outside provider. A PR preview is never research (it is already Workers AI only).
export async function researchModeOn(env, { preview = false } = {}) {
  if (preview) return false;
  try { return Boolean(await researchEnabled(env)); } catch { return true; }
}

// requested: the provider the caller would have used. With the flag on the answer is always "workers-ai".
export const forceResearchProvider = (research, requested) => (research ? RESEARCH_PROVIDER : requested);

// Honest in-voice lines for when Workers AI cannot answer. Neither is the old refusal text, and neither sends the asker elsewhere.
export const RESEARCH_DOWN_NOTE = "My research hand is out of reach right now, so this is only what the library holds, nothing from outside.";
export const RESEARCH_DOWN_ANSWER = "**My research hand is out of reach right now, so I have nothing solid on that yet.**\nA Blizzard post, a patch note or someone in the party who has played it would settle it in the meantime, and I will take a proper run at it once my research hand is free.";

// The degraded chain (RESEARCH_NAMES era): a member's ask is answered by Claude (Sonnet-class compose, Haiku-class retry) or not at all by a model. When neither answers (no key, the monthly cap,
// a guard stop on a secret or a host, a timeout, an error) there is NO Workers AI, NO Gemini and NO other provider for friend text: an honest in-voice line, plus the library's own facts
// when the question matches the library. The stored model label ends with DEGRADED_SUFFIX so it is never silent. Neither line matches the no-walls WALL_RE (research/no-wall.js).
export const DEGRADED_SUFFIX = "+degraded";
// Two cause classes. TRANSIENT (a timeout, a 5xx or 529, a rate limit): a brief outage, no time promised. Everything else (the monthly cap, no key, a guard stop on a secret or a host, the CPU budget,
// a flagged or unusable reply): nothing is promised and the line says what would settle the question, because "ask again in a few minutes" would be false for a spent monthly cap.
// Neither class matches the no-walls WALL_RE or promises a time (tests/unit/ask-real-names-fixes.test.mjs).
const HEAD = "**My good brain is out right now, so I am not going to guess at that one.**";
export const DEGRADED_ANSWER = `${HEAD}\nA Blizzard post or a party member who has played it would settle it.`;
export const DEGRADED_ANSWER_TRANSIENT = `${HEAD}\nIt is a brief outage on my side, and a Blizzard post or a party member who has played it would settle it meanwhile.`;
export const DEGRADED_NOTE = "My good brain is out right now, so that is only what the library holds.";
export const DEGRADED_NOTE_TRANSIENT = "My good brain is out right now for a brief outage, so that is only what the library holds.";
export const DEGRADED_ANSWERS = new Set([DEGRADED_ANSWER, DEGRADED_ANSWER_TRANSIENT]);
const TRANSIENT_RE = /claude:(?:timeout|http-(?:5\d\d|429|408))/;
// reason: the fixed code the Claude hop returned (research/claude.js), possibly inside the stored note (" [claude:http-529]"); null for no reason (no key, an unusable reply).
export function degradedLines(reason) {
  return TRANSIENT_RE.test(String(reason ?? "")) ? { answer: DEGRADED_ANSWER_TRANSIENT, note: DEGRADED_NOTE_TRANSIENT } : { answer: DEGRADED_ANSWER, note: DEGRADED_NOTE };
}
