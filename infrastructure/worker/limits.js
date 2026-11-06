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

// Sign-up row matching. The seed data names some rows with decoration ("=Bloise="), so an exact lower-case name match missed them and the first
// member write appended a second row for the same person. nameKey keeps letters and digits only.
export const nameKey = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// Finds the member's row in doc.entries (by slug; by exact name; or, for a row with no slug, by name ignoring punctuation and case), folds any
// further rows for the same person into it (newer values win), stamps the member's slug and display name on it, and creates it when absent.
// Mutates doc.entries and returns the entry.
export function upsertSignupEntry(doc, member) {
  const entries = Array.isArray(doc.entries) ? doc.entries : (doc.entries = []);
  const want = nameKey(member.name), lower = String(member.name || "").toLowerCase();
  const isMine = (e) => e && typeof e === "object" && (e.slug ? e.slug === member.slug || String(e.name || "").toLowerCase() === lower : (want !== "" && nameKey(e.name) === want) || String(e.name || "").toLowerCase() === lower);
  const mine = entries.filter(isMine);
  if (!mine.length) {
    const fresh = { slug: member.slug, name: member.name };
    entries.push(fresh);
    return fresh;
  }
  const primary = mine[0];
  for (const e of [...mine.slice(1)].sort((a, b) => String(a.updated || "").localeCompare(String(b.updated || "")))) {
    if (String(e.updated || "") >= String(primary.updated || "")) Object.assign(primary, e);
    else for (const [k, v] of Object.entries(e)) if (primary[k] === undefined || primary[k] === null) primary[k] = v;
    entries.splice(entries.indexOf(e), 1);
  }
  primary.slug = member.slug;
  primary.name = member.name;
  return primary;
}
