// Size limits for member and guest write routes. Over the limit answers 413 (body) or 400 (field), before any work is done.
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_QUESTION_CHARS = 2000;
// Keys a member may set on their own sign-up entry (the same four the admin patch route copies).
export const SIGNUP_PATCH_KEYS = ["pack", "meet", "meet_other", "rsvp", "when"];
export const SIGNUP_VALUE_MAX = 200;

// Reads a JSON body of at most `max` bytes. Returns { body } (an empty object when the text is not JSON) or { tooLarge: true }.
export async function readJsonCapped(req, max = MAX_BODY_BYTES) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  const text = await req.text();
  if (new TextEncoder().encode(text).length > max) return { tooLarge: true };
  try {
    const parsed = JSON.parse(text);
    return { body: parsed && typeof parsed === "object" ? parsed : {} };
  } catch {
    return { body: {} };
  }
}

export function questionTooLong(q) {
  return typeof q === "string" && Array.from(q).length > MAX_QUESTION_CHARS;
}

// Keeps only known keys with short scalar values; unknown keys are dropped (the caller answers 400 when nothing is left).
export function pickSignupPatch(patch) {
  const out = {};
  for (const k of SIGNUP_PATCH_KEYS) {
    const v = patch && patch[k];
    if (v === undefined) continue;
    if (typeof v === "string" ? v.length > SIGNUP_VALUE_MAX : typeof v !== "boolean" && typeof v !== "number") return { error: `Bad value for ${k}` };
    out[k] = v;
  }
  return { patch: out };
}
