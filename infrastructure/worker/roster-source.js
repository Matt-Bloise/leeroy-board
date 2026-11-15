// Where the roster comes from when the flag ROSTER_FROM_D1 is on (ADR 0002 step 1). Flag off: nothing here reads D1 and every caller keeps its built-in list.
// Flag on and a valid kv_state 'party_roster' row: the roster, the default admin and the redaction names come from that row.
// Flag on and the row absent, unreadable or invalid: null, so the caller uses the built-in lists exactly as with the flag off (and the redaction roster keeps
// covering the built-in names). Never throws.
//
// INTERLOCK (ADR 0002 step 2 gate): the redaction roster is still module state (privacy/roster-config.js setRosterOverride), which concurrent requests in one
// isolate can race. Until step 2 replaces it with a per-operation snapshot, ROSTER_FROM_D1 on is REFUSED: it behaves as off, for auth and for redaction alike,
// so turning the flag on cannot change either roster. The constant below is flipped to true only by the step 2 PR. Tests may open the interlock through
// setStep2ReadyForTests; nothing in the Worker does.
import { flagOn } from "./flags.js";
import { loadConfigKeyStrict } from "./config.js";
import { validateRosterConfig, sheetMembersFromConfig, rosterDataFromConfig, privacyMembersFromConfig } from "./roster-shape.js";
import { setRosterOverride } from "./privacy/roster-config.js";

export const ROSTER_FLAG = "ROSTER_FROM_D1";
export const ROSTER_STEP2_READY = false;
let step2Override = null;
export function setStep2ReadyForTests(v) { step2Override = v === null || v === undefined ? null : Boolean(v); }
const step2Ready = () => (step2Override === null ? ROSTER_STEP2_READY : step2Override);

// One roster decision per request. rosterScope(env) returns an object that delegates to env and carries its own memo; fetch and scheduled use it for the whole request, so
// the flag is asked of Flagship at most once per request (a binding call with a 100 ms timeout) however many places need the roster. An env that was not scoped
// (a direct call from a test or another entry point) is not memoised.
const memo = new WeakMap();
export function rosterScope(env) {
  if (!env || typeof env !== "object") return env;
  const scoped = Object.create(env); // delegates every read to env (no property is copied, so a throwing getter is not triggered here)
  memo.set(scoped, { p: null });
  return scoped;
}

async function resolve(env) {
  try {
    if (!step2Ready()) return null; // interlock: checked before the flag, so a refused flag costs nothing
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

// -> null | { sheetMembers, rosterData, privacyMembers, defaultAdminSlug }
export function activeRoster(env) {
  const slot = env && typeof env === "object" ? memo.get(env) : undefined;
  if (!slot) return resolve(env);
  return (slot.p ||= resolve(env));
}

// Points the privacy layer (tokeniser and outbound guard) at the same roster. Called where research privacy is about to be used (ai-models.js), not on every
// request. Flag off, interlock closed or no valid row: clears any override, so the privacy roster is the built-in one only.
export async function primeRosterPrivacy(env) {
  const r = await activeRoster(env);
  setRosterOverride(r ? r.privacyMembers : null);
}
