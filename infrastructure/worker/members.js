// Pure helpers for the Discord member roster ('discord_members' config row). No I/O.
// Entry shape: { slug, name, match: [lowercase substrings], id?: numeric string }.

const SLUG_RE = /^[a-z0-9-]{1,32}$/;
const ID_RE = /^[0-9]{17,20}$/;

export function isMemberId(v) {
  return typeof v === "string" && ID_RE.test(v);
}

// Returns an error string, or null when the entry is well formed.
export function validateMemberEntry(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "member must be an object";
  if (typeof m.slug !== "string" || !SLUG_RE.test(m.slug)) return "slug must be 1 to 32 lowercase letters, digits or dashes";
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 40) return "name must be 1 to 40 characters";
  if (!Array.isArray(m.match) || !m.match.every((t) => typeof t === "string" && t === t.toLowerCase())) {
    return "match must be an array of lowercase strings";
  }
  if (m.id !== undefined && !isMemberId(m.id)) return "id must be a numeric string of 17 to 20 digits";
  return null;
}

// Id match wins; the display-name substring match is the fallback. Returns { slug, name } or null.
export function resolveMember(userId, displayName, members) {
  const list = Array.isArray(members) ? members : [];
  if (userId !== undefined && userId !== null && String(userId)) {
    const uid = String(userId);
    const byId = list.find((m) => m && typeof m.id === "string" && m.id === uid);
    if (byId) return { slug: byId.slug, name: byId.name };
  }
  const low = String(displayName || "").toLowerCase();
  for (const m of list) {
    if (m && Array.isArray(m.match) && m.match.some((t) => t && low.includes(t))) return { slug: m.slug, name: m.name };
  }
  return null;
}

// Adds or updates one entry by slug. Returns { members } (a new array) or { error }.
// Rejects an id already held by a different slug. An update keeps the existing match list and id when none is supplied.
export function upsertMember(members, entry) {
  const list = Array.isArray(members) ? members : [];
  if (!entry || typeof entry !== "object") return { error: "member must be an object" };
  const idx = list.findIndex((m) => m && m.slug === entry.slug);
  const prior = idx >= 0 ? list[idx] : null;
  const next = {
    slug: entry.slug,
    name: entry.name,
    match: entry.match !== undefined ? entry.match : prior && Array.isArray(prior.match) ? prior.match : [],
  };
  const id = entry.id !== undefined ? entry.id : prior ? prior.id : undefined;
  if (id !== undefined) next.id = id;
  const problem = validateMemberEntry(next);
  if (problem) return { error: problem };
  if (next.id !== undefined && list.some((m) => m && m.id === next.id && m.slug !== next.slug)) {
    return { error: "id already belongs to a different member" };
  }
  const out = list.slice();
  if (idx >= 0) out[idx] = next;
  else out.push(next);
  return { members: out };
}
