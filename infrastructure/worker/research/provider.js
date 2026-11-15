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
export const RESEARCH_DOWN_ANSWER = "**My research hand is out of reach right now, so I have nothing solid on that yet.**\nOnce my research hand is free I will take a proper run at it.";
