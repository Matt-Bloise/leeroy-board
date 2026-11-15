// Server-side checks for sheet values, one rule per field that has one. Pure; no I/O.
// The level cap is the game's: data/client.json "level" (60, the client build's spell table is scaled to it). js/brain.js sheetVocab caps
// levelMax at the same 60. tests/unit/sheet-level.test.mjs fails if this constant and data/client.json disagree.
export const LEVEL_CAP = 60;

// Fields the admin may fill on a friend's sheet through POST /admin/sheet. Only fields with a server-side rule below.
export const ADMIN_SHEET_FIELDS = ["level"];

// Why data/client.json is the one source of the cap: the board's sheet reads levelMax from D.client.level (scenes/sheet.js vocab()), and
// js/brain.js sheetVocab clamps levelMax to 60 at most. The Worker's kv `vocab` row (PUT /vocab) does not carry levelMax and the client never
// reads it for the cap. tests/unit/sheet-level.test.mjs pins all three (this constant, data/client.json, the brain's clamp) together.

// A value-less write that carries only visible (the sheet's switch on an empty level line) is a visibility change, not a value: it is allowed
// for level when visible is a boolean. visibilityOnly() says whether a body is one.
export const visibilityOnly = (field, body) => field === "level" && body && body.value === undefined && typeof body.visible === "boolean";

// Returns null when the value may be stored, or a short reason. `value` is the raw body value (undefined when the key is absent).
// level: an integer from 1 to LEVEL_CAP. A missing value (without a visible flag), 0, a float, a numeric string and anything else are refused.
// null is "clear the level": only where the caller allows it (the owner's POST /sheet: { allowClear: true }); the admin route and Discord refuse it.
export function sheetValueProblem(field, value, body, { allowClear = false } = {}) {
  if (field === "level") {
    if (value === undefined && visibilityOnly(field, body)) return null;
    if (value === null && allowClear) return null;
    if (value === undefined || value === null) return "level needs a value: a whole number from 1 to " + LEVEL_CAP;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LEVEL_CAP) return "level must be a whole number from 1 to " + LEVEL_CAP;
    return null;
  }
  return null;
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const blank = (v) => v === null || v === undefined;

// The level rule for one write onto the stored field (pure; used by the live commit and by the slow-path replay so both end the same):
//   - visibleGiven false (a value write that carries no visible: sheet Save, Import from game): the stored visibility stays. A hidden level
//     stays hidden when its value changes. With no stored field the default is shown, as before.
//   - valueGiven false: a visibility change. The stored value, at and source stay.
//   - same value as stored: only visible may change; at and source stay (the age is the age of the value, an admin fill stays "admin").
//   - an older write (at before the stored value's at) with a new value is stale: nothing changes, except that a hide still hides. A stored
//     placeholder ({ value: null }) has no value age, so a write onto it is never stale.
//   - keepHidden: a stored hide stays a hide.
//   - no value and shown: there is nothing to show, so the field is removed (field null), never published as { value: null }. No value and
//     hidden stays as the placeholder { value: null, visible: false }, so the hide holds when a value arrives later.
// Returns { field, stale, changed }; field null means "no level line". changed false: the stored field is exactly as before (no event, no
// intent, no broadcast).
export function nextLevelField(prior, { value, valueGiven = true, visible = true, visibleGiven = true, source = "board", at }, { keepHidden = false } = {}) {
  const p = prior && typeof prior === "object" ? prior : null;
  const hiddenNow = !!(p && p.visible === false);
  let vis = visibleGiven ? Boolean(visible) : p ? !hiddenNow : true;
  if (keepHidden && hiddenNow) vis = false;
  const nextValue = valueGiven ? value : p ? p.value : null;
  const sameValue = !!p && same(p.value, nextValue);
  const stale = !!(valueGiven && p && !sameValue && !blank(p.value) && p.at && Date.parse(p.at) > Date.parse(at));
  let field;
  if (stale) field = vis === false && !hiddenNow ? { ...p, visible: false } : p;
  else if (sameValue) field = { ...p, value: p.value, visible: vis, source: p.source || source, at: p.at || at };
  else field = { value: blank(nextValue) ? null : nextValue, visible: vis, source, at };
  if (field && blank(field.value) && field.visible !== false) field = null;
  const changed = !p ? field !== null : field === null || !same(p.value, field.value) || (p.visible !== false) !== (field.visible !== false) || p.at !== field.at || p.source !== field.source;
  return { field, stale, changed };
}