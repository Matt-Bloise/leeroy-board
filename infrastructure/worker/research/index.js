// /ask research seam (W0). Behind the ASK_RESEARCH flag, answerWithAi offers the question here first.
// This is a stub: it never handles anything, so the existing answer path always runs. Later work items replace the body.
// Contract: returns { handled: false } to fall through, or { handled: true, answer: "<non-empty text>" }. Anything else counts as not handled.
import { legacyOn } from "../flags.js";

// ASK_RESEARCH is a wrangler.toml [vars] flag like ANSWER_UX and ASK_OPENER ("on" enables; unset or anything else is off). It is not on Flagship:
// a second Flagship key would change the committed key list that the flagship-ensure CLI tests and flags.test.mjs pin to D1_FEED alone.
export const researchEnabled = (env) => legacyOn(env, "ASK_RESEARCH");

export async function researchAnswer(_ctx) {
  return { handled: false };
}
