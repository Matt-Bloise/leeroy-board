// Where the roster comes from when the flag ROSTER_FROM_D1 is on (ADR 0002). Flag off: nothing here reads D1 and every caller keeps its built-in list.
// Flag on and a valid kv_state 'party_roster' row: the roster, the default admin and the redaction names come from that row, UNIONED with the built-ins (a built-in
// member the row omits keeps the member match, and the redaction roster always covers the built-ins: see withBuiltIns in roster-shape.js and researchMembers in
// privacy/roster-config.js). Flag on and the row absent, unreadable or invalid: null, so every caller uses the built-in lists exactly as with the flag off. Never throws.
//
// OPERATION SNAPSHOT (ADR 0002 step 2). rosterSnapshot(env, op) resolves the roster ONCE per operation and hands every consumer of that operation the same frozen
// snapshot, so the flag or the row cannot change between auth and redaction inside one operation. An operation is whatever object the caller passes as `op`:
//   - fetch:      the Request (index.js routes pass `req` to resolveMemberAuth, loadPartyMembers, loadRoster and answerWithAi({ rosterOp: req }));
//   - scheduled:  the controller of the run (no scheduled handler reads the roster today; a future one passes `controller`);
//   - listener:   the listen event (listener.js answerEvent passes `rosterOp: ev`);
//   - answerWithAi / buildAnswerInputs called without an op: a fresh object per answer, so one answer is still one snapshot.
// The memo is a WeakMap keyed by `op`, so it holds nothing past the operation and shares nothing between operations. There is NO module-level mutable roster state in the
// Worker (the old privacy override is gone), and nothing wraps, copies or proxies env (the step 1 finding: a wrapper hid every secret from Object.keys(env), which the
// outbound privacy guard uses). Without an `op` (a test or an entry point that has none) every call resolves afresh and memoises nothing.
//
// INTERLOCK (ROSTER_STEP2_READY): stays false in this PR. While it is false ROSTER_FROM_D1 on is REFUSED: it behaves as off for auth and redaction alike, and the flag is
// not even read. Flipping it is the owner's decision after the step 2 gates have run green in production with the flag off; tests/unit/roster-step2-gates.test.mjs fails
// if the constant is true while the gate tests are missing. Tests may open the interlock through setStep2ReadyForTests; nothing in the Worker does.
import { flagOn } from "./flags.js";
import { loadConfigKeyStrict } from "./config.js";
import { validateRosterConfig, sheetMembersFromConfig, rosterDataFromConfig, privacyMembersFromConfig } from "./roster-shape.js";

export const ROSTER_FLAG = "ROSTER_FROM_D1";
export const ROSTER_STEP2_READY = false;
let step2Override = null;
export function setStep2ReadyForTests(v) { step2Override = v === null || v === undefined ? null : Boolean(v); }
const step2Ready = () => (step2Override === null ? ROSTER_STEP2_READY : step2Override);

const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
};

async function resolve(env) {
  try {
    if (!step2Ready()) return null; // interlock: checked before the flag, so a refused flag costs nothing (no Flagship call, no D1 read)
    if (!(await flagOn(env, "ROSTER_FROM_D1"))) return null;
    const read = await loadConfigKeyStrict(env, "party_roster");
    if (read.status !== "ok" || validateRosterConfig(read.value) !== null) return null;
    return deepFreeze({
      sheetMembers: sheetMembersFromConfig(read.value),
      rosterData: rosterDataFromConfig(read.value),
      privacyMembers: privacyMembersFromConfig(read.value),
      defaultAdminSlug: read.value.default_admin,
    });
  } catch {
    return null;
  }
}

const memo = new WeakMap(); // op -> Promise<snapshot | null>

// -> Promise<null | { sheetMembers, rosterData, privacyMembers, defaultAdminSlug }> (frozen). One resolution per `op`.
export function rosterSnapshot(env, op) {
  if (op === null || (typeof op !== "object" && typeof op !== "function")) return resolve(env);
  let p = memo.get(op);
  if (!p) { p = resolve(env); memo.set(op, p); }
  return p;
}
