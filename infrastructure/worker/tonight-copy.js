import { SLASH_COPY } from "./slash-copy.js";
import { raceClass } from "./member-model.js";
// Copy for `/tonight`. Dates are the ones in data/tonight.json (events); a test keeps them in step.
export const LAUNCH_EPOCH = 1793833200; // Wed, Nov 4, 2026, 6 PM ET
export const NEXT_DATED = { label: "Raids open", when: "Wed, Dec 9", epoch: 1796857200 };
// Dated events after launch, soonest first (a test keeps these in step with data/tonight.json). nextDated(now) is the first one still ahead, or null when none is posted, so the line never reads "N days ago".
export const DATED_AFTER_LAUNCH = [NEXT_DATED];
export function nextDated(now) { return DATED_AFTER_LAUNCH.find((e) => e.epoch > now) || null; }

// Returns the reply lines. Before launch it keeps the sign-up prompt; after it, launch night is history and the next dated event leads.
export function tonightLines({ now, byName, party, signups, boardUrl }) {
  const members = (party && party.members) || [], entries = (signups && signups.entries) || [];
  const inList = entries.filter((e) => e.rsvp === "in").map((e) => e.name);
  // /tonight gets the PROJECTED party document: a hidden race or class is absent. Print only what is a non-empty string, and skip a member with no usable name.
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const shown = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === "object" && str(m.name)).map((m) => {
    const build = { race: str(m.race), class: str(m.class) };
    return build.race || build.class ? `${str(m.name)} (${raceClass(build)})` : str(m.name); // raceClass says "Build hidden" for neither: the roster prints the bare name
  });
  // Roster line, capped so the whole reply stays inside Discord's 2000-char content limit; a cut says "and N more".
  const rosterLine = (budget) => {
    const head = `• **Party (${shown.length}):** `;
    const full = head + shown.join(" · ");
    if (full.length <= budget) return full;
    for (let k = shown.length - 1; k >= 0; k--) {
      const line = head + [...shown.slice(0, k), `and ${shown.length - k} more`].join(" · ");
      if (line.length <= budget) return line;
    }
    return head + `and ${shown.length} more`;
  };
  const finish = (before, after) => {
    const rest = [...before, ...after];
    const budget = 2000 - rest.join("\n").length - 1;
    return [...before, rosterLine(budget), ...after];
  };
  if (now >= LAUNCH_EPOCH) {
    return finish([
      `**Launch night was Wed Nov 4, 6:00 PM ET** (<t:${LAUNCH_EPOCH}:F>)`,
      (() => { const n = nextDated(now); return n ? `• **Next dated event:** ${n.label}, ${n.when} (<t:${n.epoch}:R>)` : "• **Next dated event:** none posted yet. The board has the dates when Blizzard posts them."; })(),
    ], [
      `• **Launch-night sign-ups, as they stood (${inList.length} in):** ${inList.length ? inList.join(", ") : "none recorded"}`,
      `• **Next gathering:** not picked yet. The board has the dates: ${boardUrl}/#timeline`,
    ]);
  }
  const mine = entries.find((e) => (e.name || "").toLowerCase() === String(byName).toLowerCase());
  const nextStep = !mine || !mine.rsvp
    ? SLASH_COPY.tonightRsvp()
    : !mine.meet
    ? SLASH_COPY.tonightMeet()
    : SLASH_COPY.tonightDone();
  return finish([
    `**Launch Night: Wed Nov 4, 6:00 PM ET** (<t:${LAUNCH_EPOCH}:F>)`,
  ], [
    `• **RSVP In (${inList.length}):** ${inList.length ? inList.join(", ") : "None yet"}`,
    `• **Next for ${byName}:** ${nextStep}`,
    `• **Board:** ${boardUrl}/#tonight`,
  ]);
}
