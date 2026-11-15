// Size limits for member and guest write routes. Over the limit answers 413 (body) or 400 (field), before any work is done.
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_QUESTION_CHARS = 2000;
// Keys a member may set on their own sign-up entry (the same four the admin patch route copies).
export const SIGNUP_PATCH_KEYS = ["pack", "meet", "meet_other", "rsvp", "when"];
export const SIGNUP_VALUE_MAX = 200;

// Reads a JSON body of at most `max` bytes. Returns { body } (an empty object when the text is not JSON) or { tooLarge: true }.
export async function readJsonCapped(req, max = MAX_BODY_BYTES) {
  const read = await readTextCapped(req, max);
  if (read.tooLarge) return { tooLarge: true };
  const text = read.text;
  try {
    const parsed = JSON.parse(text);
    return { body: parsed && typeof parsed === "object" ? parsed : {} };
  } catch {
    return { body: {} };
  }
}

// Reads a request body as text, at most `max` bytes. Unlike req.text() it stops pulling once the cap is passed, so a body with no Content-Length
// (chunked) is not read to the end. Returns { text } or { tooLarge: true }.
export async function readTextCapped(req, max) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  if (!req.body) return { text: "" };
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { reader.cancel().catch(() => {}); return { tooLarge: true }; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all) };
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

// A row's `updated` as epoch ms when it is a full ISO 8601 date and time with a zone (Z or +hh:mm), else NaN. A zone-less or date-only stamp
// is read differently by different runtimes, so it counts as malformed.
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const stampMs = (v) => (typeof v === "string" && ISO_ZONED.test(v) ? Date.parse(v) : NaN);
// Orders two rows by `updated`: two valid stamps by instant; a valid stamp is always newer than a malformed or missing one; two malformed or
// missing stamps keep the earlier string order.
function compareUpdated(a, b) {
  const ta = stampMs(a.updated), tb = stampMs(b.updated);
  const va = Number.isFinite(ta), vb = Number.isFinite(tb);
  if (va && vb) return ta - tb;
  if (va !== vb) return va ? 1 : -1;
  const sa = String(a.updated || ""), sb = String(b.updated || "");
  return sa === sb ? 0 : sa > sb ? 1 : -1;
}

// Finds the member's row in doc.entries (by slug; by exact name; or, for a row with no slug, by name ignoring punctuation and case), folds any
// further rows for the same person into it (newer values win), stamps the member's slug and display name on it, and creates it when absent.
// Mutates doc.entries and returns the entry.
export function upsertSignupEntry(doc, member) {
  const entries = Array.isArray(doc.entries) ? doc.entries : (doc.entries = []);
  const want = nameKey(member.name), lower = String(member.name || "").toLowerCase();
  // A populated slug is authoritative: such a row is this member's only if the slug is equal. Name matching is for slug-less (seed) rows only.
  const isMine = (e) => e && typeof e === "object" && (e.slug ? e.slug === member.slug : (want !== "" && nameKey(e.name) === want) || String(e.name || "").toLowerCase() === lower);
  const mine = entries.filter(isMine);
  if (!mine.length) {
    const fresh = { slug: member.slug, name: member.name };
    entries.push(fresh);
    return fresh;
  }
  const primary = mine[0];
  for (const e of [...mine.slice(1)].sort(compareUpdated)) {
    if (compareUpdated(e, primary) >= 0) Object.assign(primary, e);
    else for (const [k, v] of Object.entries(e)) if (primary[k] === undefined || primary[k] === null) primary[k] = v;
    entries.splice(entries.indexOf(e), 1);
  }
  primary.slug = member.slug;
  primary.name = member.name;
  return primary;
}
