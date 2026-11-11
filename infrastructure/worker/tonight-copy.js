import { SLASH_COPY } from "./slash-copy.js";
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
  const roster = `• **Party (${members.length}):** ${members.map((m) => `${m.name} (${m.race} ${m.class})`).join(" · ")}`;
  if (now >= LAUNCH_EPOCH) {
    return [
      `**Launch night was Wed Nov 4, 6:00 PM ET** (<t:${LAUNCH_EPOCH}:F>)`,
      (() => { const n = nextDated(now); return n ? `• **Next dated event:** ${n.label}, ${n.when} (<t:${n.epoch}:R>)` : "• **Next dated event:** none posted yet. The board has the dates when Blizzard posts them."; })(),
      roster,
      `• **Launch-night sign-ups, as they stood (${inList.length} in):** ${inList.length ? inList.join(", ") : "none recorded"}`,
      `• **Next gathering:** not picked yet. The board has the dates: ${boardUrl}/#timeline`,
    ];
  }
  const mine = entries.find((e) => (e.name || "").toLowerCase() === String(byName).toLowerCase());
  const nextStep = !mine || !mine.rsvp
    ? SLASH_COPY.tonightRsvp()
    : !mine.meet
    ? SLASH_COPY.tonightMeet()
    : SLASH_COPY.tonightDone();
  return [
    `**Launch Night: Wed Nov 4, 6:00 PM ET** (<t:${LAUNCH_EPOCH}:F>)`,
    roster,
    `• **RSVP In (${inList.length}):** ${inList.length ? inList.join(", ") : "None yet"}`,
    `• **Next for ${byName}:** ${nextStep}`,
    `• **Board:** ${boardUrl}/#tonight`,
  ];
}
