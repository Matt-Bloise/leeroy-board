// Where the roster comes from when the flag ROSTER_FROM_D1 is on (ADR 0002). Flag off: nothing here reads D1 and every caller keeps its built-in list.
// Flag on and a valid kv_state 'party_roster' row: the roster, the default admin and the redaction names come from that row, UNIONED with the built-ins (a built-in
// member the row omits keeps the member match, and the redaction roster always covers the built-ins: see withBuiltIns in roster-shape.js and researchMembers in
// privacy/roster-config.js). Flag off (a definite false), the interlock closed, or a flag-on row that is DEFINITELY absent (the D1 read succeeded and found none; ADR 0002 step 1, until step 6 removes the built-ins): null, so every caller uses the built-in lists exactly as with the flag off. Never throws.
//
// FAIL CLOSED (ADR 0002 F2, a pre-flip gate). With the interlock open, if the flag cannot be asked (timeout, throw, rejection, a non-boolean answer), or the flag is on and the
// row is unreadable, invalid or collides with a built-in member (F4), the snapshot is the CLOSED marker { closed: true, reason, ...empty lists }, never null. null means
// "the truth is known and it is the built-ins" (flag off, or flag on with the D1 read succeeding and finding NO row: step 1 behaviour until step 6 removes the built-ins, where absent becomes
// closed: ADR 0002 step 6 gate); closed means "the roster is unknown: act as nobody". What closed means for a request (every consumer checks `.closed` first):
//   - member auth (index.js resolveMemberAuth): no member, not even a signed-in one, and no default admin: the member routes answer their unauthorised response. The admin-only
//     routes (adminGate: PUT /api/config/party_roster included) read the admin token only and keep working, so an operator can repair the row;
//   - party-source loadPartyMembers and loadRoster: the empty list (also when the D1 read itself fails), never the built-ins;
//   - research asks (ai-models.js): no outside Claude call at all (tokenised or RESEARCH_NAMES real), members get the degraded line, guests library facts only.
// The reason is a fixed code, never a name.
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
import { flagState } from "./flags.js";
import { loadConfigKeyStrict } from "./config.js";
import { validateRosterConfig, sheetMembersFromConfig, rosterDataFromConfig, privacyMembersFromConfig, builtInPeople, builtInCollision } from "./roster-shape.js";
import { PARTY_MEMBERS } from "./party-source.js"; // a cycle with party-source.js, used only inside resolve() at call time (never at load)
import { ROSTER_DATA } from "./bot-data.js";
import { getFirstNameSource } from "./privacy/roster-config.js";

export const ROSTER_FLAG = "ROSTER_FROM_D1";
export const ROSTER_STEP2_READY = false;
let step2Override = null;
export function setStep2ReadyForTests(v) { step2Override = v === null || v === undefined ? null : Boolean(v); }
const step2Ready = () => (step2Override === null ? ROSTER_STEP2_READY : step2Override);

const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
};

// The marker for "the roster cannot be resolved". Same field names as a real snapshot with EMPTY lists, so a consumer that forgets to check `closed` sees nobody, not the built-ins.
const closed = (reason) => deepFreeze({ closed: true, reason, sheetMembers: [], rosterData: [], privacyMembers: [], defaultAdminSlug: null });
export const isClosed = (snap) => Boolean(snap && snap.closed === true);

// -> { snap, source, detail }. source: "built-in" (snap null: the code's own lists), "d1" (the row is live) or "closed" (snap is the closed marker); detail says why. Never throws.
const out = (snap, source, detail) => ({ snap, source, detail });
async function decide(env) {
  try {
    if (!step2Ready()) return out(null, "built-in", "interlock closed (the flag is not read)"); // interlock: checked before the flag, so a refused flag costs nothing (no Flagship call, no D1 read)
    const state = await flagState(env, "ROSTER_FROM_D1");
    if (state === "off") return out(null, "built-in", "flag off");
    if (state !== "on") return out(closed("flag-unknown"), "closed", "flag-unknown");
    const read = await loadConfigKeyStrict(env, "party_roster");
    if (read.status === "absent") return out(null, "built-in", "row absent"); // the D1 read SUCCEEDED and found no row: until step 6 removes the built-ins this is today's behaviour (nothing about identity or privacy is unknown)
    if (read.status !== "ok") return out(closed("row-unreadable"), "closed", "row-unreadable");
    if (validateRosterConfig(read.value) !== null) return out(closed("row-invalid"), "closed", "row-invalid");
    if (builtInCollision(read.value, builtInPeople(PARTY_MEMBERS, ROSTER_DATA, getFirstNameSource())) !== null) return out(closed("row-collides-with-built-in"), "closed", "row-collides-with-built-in");
    return out(deepFreeze({
      sheetMembers: sheetMembersFromConfig(read.value),
      rosterData: rosterDataFromConfig(read.value),
      privacyMembers: privacyMembersFromConfig(read.value),
      defaultAdminSlug: read.value.default_admin,
    }), "d1", "row valid");
  } catch {
    return out(closed("error"), "closed", "error");
  }
}
const resolve = async (env) => (await decide(env)).snap;

// Which roster is live, for the admin health output (index.js GET /health with the admin token): one fresh resolution, nothing memoised, no name and no member in it.
// -> { source: "built-in" | "d1" | "closed", detail: string }. With the interlock closed it reads neither the flag nor D1.
export async function rosterSourceReport(env) {
  const { source, detail } = await decide(env);
  return { source, detail };
}

const memo = new WeakMap(); // op -> Promise<snapshot | null>

// -> Promise<null | closed marker | { sheetMembers, rosterData, privacyMembers, defaultAdminSlug }> (frozen). One resolution per `op`.
export function rosterSnapshot(env, op) {
  if (op === null || (typeof op !== "object" && typeof op !== "function")) return resolve(env);
  let p = memo.get(op);
  if (!p) { p = resolve(env); memo.set(op, p); }
  return p;
}
