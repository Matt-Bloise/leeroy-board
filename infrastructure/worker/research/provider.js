// /ask research mode: provider forcing. Every /ask prompt carries group context (PARTY_STATE names, YOUR_BUILD, PARTY_BUILDS), and the only outside key the Worker holds
// is a free-tier Gemini key whose terms allow product-improvement use. So with ASK_RESEARCH on, the model call goes to the Workers AI binding and nowhere else: not the
// asker's chosen provider, and not as a fallback hop. One helper so later work items (W5 budget, W6a name aliasing) reuse the same rule.
export const RESEARCH_PROVIDER = "workers-ai";

// requested: the provider the caller would have used. With the flag on the answer is always "workers-ai".
export const forceResearchProvider = (research, requested) => (research ? RESEARCH_PROVIDER : requested);

// Honest in-voice lines for when Workers AI cannot answer. Neither is the old refusal text, and neither sends the asker elsewhere.
export const RESEARCH_DOWN_NOTE = "My research hand is out of reach right now, so this is only what the library holds, nothing from outside.";
export const RESEARCH_DOWN_ANSWER = "**My research hand is out of reach right now, so I have nothing solid on that yet.**\nTry me again in a bit and I will take a proper run at it.";
