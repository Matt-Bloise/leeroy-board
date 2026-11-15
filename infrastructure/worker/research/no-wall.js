// /ask research mode (ASK_RESEARCH on), work item W5: a roster member never meets a wall.
// With the flag on, the per-user daily cap (40), the tenant share, the neuron cap and "ask 41" degrade the answer (Claude if available and inside its monthly token
// cap, then Workers AI, then library facts with an honest in-voice line) instead of refusing. The per-user counters keep counting for the owner's visibility.
// Guests (anonymous web visitors, Discord users who are not on the roster) are NOT members: they keep their rate limit and their refusals, on budget keys of their own
// (a "guests" tenant row with a share of the day), so a guest flood can neither fill a member's rows nor spend more than that share of the neuron cap.
// Pure helpers, no I/O except the flag read. With the flag off none of this is reached and every old string and refusal is unchanged.
import { researchModeOn } from "./provider.js";
import { askBudgetKeys } from "../budget.js";

// What counts as a wall in a member-facing string. Nothing a member can be shown on /ask with the flag on may match.
export const WALL_RE = /try again|try (?:me|it|that|asking) again|limit|midnight|back at|quota|too many|tomorrow|come back|(?:you(?:'ve| have)|already|have) reached|reached (?:your|the|today)|\b(?:daily|monthly|usage|ask|question)s? cap\b|\bcap (?:is |was )?(?:hit|reached|used)\b|out of (?:questions|asks|credits)|used up|all (?:your|today's) (?:questions|asks)|ask (?:me )?again|\bretry\b|cool ?down|slow down|one at a time|asked enough|give it an? (?:hour|minute|moment|while)|in the last hour|open up again|send(?:ing)? it again/i;

export const GUEST_TENANT = "guests";
export const GUEST_SHARE_PCT = 25; // guests together may use this share of the daily neuron cap; members keep the rest

// Budget keys for a non-member with the flag on. guest=true is an anonymous web visitor (no per-user ask cap, the 2 per hour rate limit applies instead);
// guest=false is a Discord user who is not on the roster (keeps the per-user cap). Both count against the "guests" tenant row and its smaller share.
export function guestBudgetKeys({ userPart, guest = true } = {}) {
  const k = askBudgetKeys({ userPart, tenantId: GUEST_TENANT, guest });
  // userFirst: the per-user cap is checked before the global and tenant caps, so a non-roster user at their daily cap still gets the old refusal when the guests' share is spent.
  return k ? { ...k, tenantSharePct: GUEST_SHARE_PCT, userFirst: true } : null;
}

// The one call each ask entry point makes. research: the flag (fails closed, never in a PR preview). noWall: research AND the asker is a member (membership comes from the
// roster or the member key, never from the request body). budget: the keys to hand to answerWithAi. With the flag off this is exactly askBudgetKeys({ userPart, guest }).
export async function askWallPlan(env, { isMember, userPart, preview = false, guest = false }) {
  const research = await researchModeOn(env, { preview });
  return { research, noWall: research && Boolean(isMember), budget: research && !isMember ? guestBudgetKeys({ userPart, guest }) : askBudgetKeys({ userPart, guest }) };
}

// What a roster member sees when the interaction itself throws (research mode): the old line says "before you try again". No retry wording.
export const MEMBER_FAILED_LINE = "Something broke on my side, and I have logged it. Check the board for the answer.";

// In-voice lines for a member when a reply could not be produced at all (deadline, an unexpected error). None says "try again", none names a limit or a time.
export const MEMBER_FALLBACK_LINES = [
  "That one got away from me this time. A Blizzard post or someone in the party who has played it would settle it, and I will take a proper run at it next.",
  "I could not pull a proper answer together on that one just now; a patch note or a player who has seen it would settle it.",
];

const hash = (seed) => { let h = 2166136261; for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };

// The persona pack's own error lines are used when they are clean; any that reads as a wall is skipped. Never the persona default ("Try again in a moment").
export function memberLine(persona, seed = "") {
  const own = persona && Array.isArray(persona.errorLines) ? persona.errorLines.filter((l) => typeof l === "string" && l && !WALL_RE.test(l)) : [];
  const pool = own.length ? own : MEMBER_FALLBACK_LINES;
  return pool[hash(seed) % pool.length];
}

// The "thinking" line a member sees first. Filtered exactly like the error lines: a persona ack line that reads as a wall is skipped; the default is Leeroy's plain one.
export const DEFAULT_ACK = "Leeroy is thinking...";
export function memberAck(persona, seed = "") {
  const own = persona && Array.isArray(persona.ackLines) ? persona.ackLines.filter((l) => typeof l === "string" && l && !WALL_RE.test(l)) : [];
  const pool = own.length ? own : [DEFAULT_ACK];
  return pool[hash(seed) % pool.length];
}

// Timeout for one Workers AI attempt in research mode: never past (deadline - 4 s), so the worst case after Claude's 9 s still leaves 4 s to store and deliver.
// Returns null when less than 1 s is left: the caller skips the attempt (library facts), it never starts one past the margin.
// The margin is 4 s of a 24 s deadline (a sixth, at most 4 s), so an ASK_DEADLINE_MS override keeps the same proportions.
export const hardEndMs = (deadlineMs = 24000) => Math.floor(deadlineMs - Math.min(4000, deadlineMs / 6));
export const researchTimeoutMs = (elapsedMs, maxMs, deadlineMs = 24000, marginMs = Math.min(4000, deadlineMs / 6)) => {
  const left = Math.floor(deadlineMs - marginMs - elapsedMs);
  return left < 1000 ? null : Math.min(maxMs, left);
};

// A guest (never a member) whose verdict is anything but the per-user cap is answered from library facts with no model call, instead of a refusal text.
// Only research mode; with the flag off every verdict keeps its old refusal.
export const guestLibraryOnly = (research, verdict) => Boolean(research && verdict && verdict.code !== "budget_user");
