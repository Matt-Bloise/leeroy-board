// Copy for `/tonight`. Dates are the ones in data/tonight.json (events); a test keeps them in step.
export const LAUNCH_EPOCH = 1793833200; // Wed, Nov 4, 2026, 6 PM ET
export const NEXT_DATED = { label: "Raids open", when: "Wed, Dec 9", epoch: 1796857200 };

// Returns the reply lines. Before launch it keeps the sign-up prompt; after it, launch night is history and the next dated event leads.
export function tonightLines({ now, byName, party, signups, boardUrl }) {
  const members = (party && party.members) || [], entries = (signups && signups.entries) || [];
  const inList = entries.filter((e) => e.rsvp === "in").map((e) => e.name);
  const roster = `• **Party (${members.length}):** ${members.map((m) => `${m.name} (${m.race} ${m.class})`).join(" · ")}`;
  if (now >= LAUNCH_EPOCH) {
    return [
      `**Launch night was Wed Nov 4, 6:00 PM ET** (<t:${LAUNCH_EPOCH}:F>)`,
      `• **Next dated event:** ${NEXT_DATED.label}, ${NEXT_DATED.when} (<t:${NEXT_DATED.epoch}:R>)`,
      roster,
      `• **Launch-night sign-ups, as they stood (${inList.length} in):** ${inList.length ? inList.join(", ") : "none recorded"}`,
      `• **Next gathering:** not picked yet. The board has the dates: ${boardUrl}/#timeline`,
    ];
  }
  const mine = entries.find((e) => (e.name || "").toLowerCase() === String(byName).toLowerCase());
  const nextStep = !mine || !mine.rsvp
    ? "Say whether you are **in** for launch night (`/signup rsvp:in`)."
    : !mine.meet
    ? "Pick where the party meets (`/signup meet:Valley of Strength` or `The Crossroads`)."
    : "Your launch-night answers are in — check your character sheet with `/sheet`.";
  return [
    `**Launch Night: Wed Nov 4, 6:00 PM ET** (<t:${LAUNCH_EPOCH}:F>)`,
    roster,
    `• **RSVP In (${inList.length}):** ${inList.length ? inList.join(", ") : "None yet"}`,
    `• **Next for ${byName}:** ${nextStep}`,
    `• **Board:** ${boardUrl}/#tonight`,
  ];
}
