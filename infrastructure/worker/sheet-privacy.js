// Party sheet fields carry a `visible` flag. A field with visible:false belongs to its owner only: the public routes
// (GET /state, GET /bootstrap, the live socket) and other members never see it. Pure; returns new objects.
export function publicParty(party) {
  if (!Array.isArray(party)) return party;
  return party.map((m) => stripHidden(m));
}

// Everyone else's sheet with hidden fields removed, and `ownerSlug`'s own sheet left whole.
export function partyForMember(party, ownerSlug) {
  if (!Array.isArray(party)) return party;
  return party.map((m) => (ownerSlug && m && m.slug === ownerSlug ? m : stripHidden(m)));
}

function stripHidden(sheet) {
  if (!sheet || typeof sheet !== "object" || !sheet.fields || typeof sheet.fields !== "object") return sheet;
  const fields = {};
  for (const [k, f] of Object.entries(sheet.fields)) {
    if (f && typeof f === "object" && f.visible === false) continue;
    fields[k] = f;
  }
  return { ...sheet, fields };
}
