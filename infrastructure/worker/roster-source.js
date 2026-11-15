// Where the roster comes from when the flag ROSTER_FROM_D1 is on (ADR 0002 step 1). Flag off: nothing here reads D1 and every caller keeps its built-in list.
// Flag on and a valid kv_state 'party_roster' row: the roster, the default admin and the redaction names come from that row.
// Flag on and the row absent, unreadable or invalid: null, so the caller uses the built-in lists exactly as with the flag off (and the redaction roster keeps
// covering the built-in names). Never throws.
import { flagOn } from "./flags.js";
import { loadConfigKeyStrict } from "./config.js";
import { validateRosterConfig, sheetMembersFromConfig, rosterDataFromConfig, privacyMembersFromConfig } from "./roster-shape.js";
import { setRosterOverride } from "./privacy/roster-config.js";

export const ROSTER_FLAG = "ROSTER_FROM_D1";

// -> null | { sheetMembers, rosterData, privacyMembers, defaultAdminSlug }
export async function activeRoster(env) {
  try {
    if (!(await flagOn(env, "ROSTER_FROM_D1"))) return null;
    const read = await loadConfigKeyStrict(env, "party_roster");
    if (read.status !== "ok" || validateRosterConfig(read.value) !== null) return null;
    return {
      sheetMembers: sheetMembersFromConfig(read.value),
      rosterData: rosterDataFromConfig(read.value),
      privacyMembers: privacyMembersFromConfig(read.value),
      defaultAdminSlug: read.value.default_admin,
    };
  } catch {
    return null;
  }
}

// Points the privacy layer (tokeniser and outbound guard) at the same roster. Called at the top of fetch and scheduled. Flag off or no valid row: clears any
// override, so the privacy roster is the built-in one only.
export async function primeRosterPrivacy(env) {
  const r = await activeRoster(env);
  setRosterOverride(r ? r.privacyMembers : null);
}
