// /ask research seam (W0). Behind the ASK_RESEARCH flag, answerWithAi offers the question here first.
// This is a stub: it never handles anything, so the existing answer path always runs. Later work items replace the body.
// Contract: returns { handled: false } to fall through, or { handled: true, answer: "<non-empty text>" }. Anything else counts as not handled.
import { legacyOn } from "../flags.js";
import { understand } from "./understand.js";

// ASK_RESEARCH is a wrangler.toml [vars] flag like ANSWER_UX and ASK_OPENER ("on" enables; unset or anything else is off). It is not on Flagship:
// a second Flagship key would change the committed key list that the flagship-ensure CLI tests and flags.test.mjs pin to D1_FEED alone.
export const researchEnabled = (env) => legacyOn(env, "ASK_RESEARCH");

export async function researchAnswer(_ctx) {
  return { handled: false };
}

// The understand step's only effect: one static line appended to the compose system prompt that picks the answer mode and depth. No friend text, no names, no model-written text.
const DEPTH_NOTE = { short: "Keep it to 1 or 2 sentences before the sources line.", standard: "Aim for 600 to 900 characters.", deep: "Go into the detail the question asks for, up to 1400 characters, with short labelled bullets." };
const MODE_RULES = {
  casual: () => "ANSWER MODE: casual chat. Reply in 1 to 4 plain sentences in your own voice: no headers, no bullets, no Sources line, and no Classic-fact disclaimer unless you state a number.",
  build_help: (d) => `ANSWER MODE: build help. Give one plain pick, the one reason, and the one case to choose the other. ${DEPTH_NOTE[d]}`,
  game_fact: (d) => `ANSWER MODE: game fact. Answer first in one sentence, then support lines. ${DEPTH_NOTE[d]}`,
  false_premise: (d) => `ANSWER MODE: possible false premise. Check the premise before answering: if it is not confirmed to exist or to be true, say "that is not confirmed to exist" in the first sentence and give no invented detail, then give the nearest thing that is true. ${DEPTH_NOTE[d]}`,
};
export function modeRule(verdict) {
  const f = verdict && Object.prototype.hasOwnProperty.call(MODE_RULES, verdict.kind) ? MODE_RULES[verdict.kind] : null;
  return f && DEPTH_NOTE[verdict.depth] ? f(verdict.depth) : "";
}

// Called by ai-models.js in research mode only, just before the compose call. Returns { rule, verdict }; rule is "" when the flag is off, the flag read fails, or anything throws, which leaves the
// compose prompt exactly as it was. The step itself never blocks an answer (research/understand.js).
export async function researchPlan({ env, priv, call, now }) {
  try {
    if (!(await researchEnabled(env))) return { rule: "", verdict: null };
    const verdict = await understand({ env, priv, call, ...(now ? { now } : {}) });
    return { rule: modeRule(verdict), verdict };
  } catch {
    return { rule: "", verdict: null };
  }
}
