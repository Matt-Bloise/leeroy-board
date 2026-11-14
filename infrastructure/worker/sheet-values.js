// Server-side checks for sheet values, one rule per field that has one. Pure; no I/O.
// The level cap is the game's: data/client.json "level" (60, the client build's spell table is scaled to it). js/brain.js sheetVocab caps
// levelMax at the same 60. tests/unit/sheet-level.test.mjs fails if this constant and data/client.json disagree.
export const LEVEL_CAP = 60;

// Fields the admin may fill on a friend's sheet through POST /admin/sheet. Only fields with a server-side rule below.
export const ADMIN_SHEET_FIELDS = ["level"];

// Returns null when the value may be stored, or a short reason. `value` is the raw body value (undefined when the key is absent).
// level: an integer from 1 to LEVEL_CAP. A missing value, null, 0, a float, a numeric string and anything else are refused. A friend who wants
// the line off the party table hides it (visible:false with the current value); clearing it is not a write the server takes.
export function sheetValueProblem(field, value) {
  if (field === "level") {
    if (value === undefined || value === null) return "level needs a value: a whole number from 1 to " + LEVEL_CAP;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LEVEL_CAP) return "level must be a whole number from 1 to " + LEVEL_CAP;
    return null;
  }
  return null;
}
