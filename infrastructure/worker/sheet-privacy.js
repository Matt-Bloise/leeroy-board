// Party sheet fields carry a `visible` flag. A field with visible:false belongs to its owner only: the public routes
// (GET /state, GET /bootstrap, the live socket) and other members never see it, nor what is derived from it (public-party.js CASCADE).
// These two are the names callers already use; the one implementation is projectSheets in public-party.js. Pure; returns new objects.
import { projectSheets } from "./public-party.js";

export function publicParty(party) {
  if (!Array.isArray(party)) return party;
  return projectSheets(party);
}

// Everyone else's sheet with hidden fields removed, and `ownerSlug`'s own sheet left whole.
export function partyForMember(party, ownerSlug) {
  if (!Array.isArray(party)) return party;
  return projectSheets(party, ownerSlug || null);
}
