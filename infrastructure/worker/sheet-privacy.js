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

// An intent body for a sheet write. A field written hidden (visible:false) carries its name and visibility but no value: the mailbox is
// read by the Discord /intents command and the admin API, and a hide is the owner's choice to keep the value private.
export function sheetIntentBody(field, value, visible, source) {
  return visible === false ? { field, visible: false, source } : { field, value, visible: visible !== false, source };
}

// A stored intent body as it is shown to a reader. Rows written before sheetIntentBody may hold a hidden value: any object body
// with visible === false is shown without `value`. Accepts the stored JSON string or a parsed body; a string that is not JSON returns null.
export function redactIntentBody(body) {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  if (parsed.visible !== false || !Object.prototype.hasOwnProperty.call(parsed, "value")) return parsed;
  const { value: _hidden, ...rest } = parsed;
  return rest;
}
