// /ask research mode: provider forcing. Every /ask prompt carries group context (PARTY_STATE names, YOUR_BUILD, PARTY_BUILDS), and the outside keys the Worker holds include a
// free-tier Gemini key whose terms allow product-improvement use. So with ASK_RESEARCH on, the chosen provider is always the Workers AI binding (never the asker's choice, never
// a fallback hop to Gemini or any other provider). The one outside hop is Claude, tried first in research/claude.js, and only after tokenising and the outbound guards; when it
// is skipped or fails, Workers AI (inside Cloudflare) answers. One helper so every work item reuses the same rule.
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
export const DEGRADED_NOTE = "My good brain is out right now, so that is only what the library holds. Put it to me again in a few minutes for the full take.";
export const DEGRADED_ANSWER = "**My good brain is out right now, so I am not going to guess at that one.**\nA Blizzard post or a party member who has played it would settle it, and I will take a proper run at it when you put it to me again in a few minutes.";
