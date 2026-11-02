// Plans how one /build submit lands on the board's data. Pure: no I/O, no env, no D1, no network. Nothing here is wired yet.
// Shape and rules come from tools/add-member.mjs (through member-model.js), so the form and the runbook script cannot drift apart.
// The slug is ALWAYS slugify(handle): board.js finds people by name and recordSheetEventInD1 keys on name.toLowerCase(), so a suffixed slug would detach a person from their card.
import { BAD_NAME, CLASSES, RACES, slugify, partyEntry as buildPartyEntry, rosterEntry as buildRosterEntry } from "./member-model.js";
import { isSnowflake } from "./build-modal.js";

const ROLE_OF = { tank: "tank", healer: "healer", dps: "damage" };
const KEEP = ["spec", "spec_status", "role_detail", "professions", "board_line"];
const fail = (error) => ({ ok: false, error });

// { handle, build (parseBuildSubmit's .build), discordUserId, partyDoc, roster (array of { slug, name, match, id }) }
// -> { ok, error?, slug, partyEntry, rosterEntry, duplicate }
export function planProjection({ handle, build, discordUserId, partyDoc, roster, reservedSlugs = [] } = {}) {
  const name = typeof handle === "string" ? handle.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 40) return fail("handle must be 1 to 40 characters");
  if (BAD_NAME.test(name)) return fail("handle must be a game handle: no @, links, slashes or publisher marks");
  if (!isSnowflake(discordUserId)) return fail("bad Discord user id");
  const id = String(discordUserId);
  const slug = slugify(name);
  if (!slug) return fail("handle needs at least one letter or digit");

  const b = build || {};
  const cls = String(b.class || "").toLowerCase();
  const race = String(b.race || "").toLowerCase().replace(/[ _]/g, "-");
  const role = ROLE_OF[String(b.role || "").toLowerCase()];
  if (!CLASSES[cls]) return fail("unknown class");
  if (!RACES[race]) return fail("unknown race");
  if (!role) return fail("unknown role");

  const members = partyDoc && Array.isArray(partyDoc.members) ? partyDoc.members : [];
  const entries = Array.isArray(roster) ? roster : [];
  const lower = name.toLowerCase();
  const sameName = (n) => String(n).toLowerCase() === lower;

  const mine = entries.find((r) => r && String(r.id) === id);
  if (mine && !sameName(mine.name)) return fail("ask an admin");
  const owner = entries.find((r) => r && (r.slug === slug || sameName(r.name)));
  if (owner && String(owner.id) !== id) return fail("that handle is taken by another member");

  // Slug-level clash (advisor, Nov 2): "Bible_Boi" and "Bible-Boi" are different names but the same slug; the board and the roster key on the slug,
  // so a second card with a taken slug would point Discord attribution at the wrong person. Only the id that owns the slug may reuse it.
  const slugOwnedByMe = mine && slugify(String(mine.name)) === slug;
  if (!slugOwnedByMe) {
    if (members.some((m) => m && slugify(String(m.name)) === slug && !sameName(m.name))) return fail("that handle is too close to an existing member's");
    if (Array.isArray(reservedSlugs) && reservedSlugs.includes(slug)) return fail("that handle is taken by another member");
  }

  const existing = members.find((m) => sameName(m.name));
  if (existing && !mine) return fail("that handle is taken by another member");

  const v = { name, id, cls, race, slug, role, startZone: null };
  let entry = buildPartyEntry(v);
  if (existing && existing.class_key === entry.class_key && existing.race === entry.race) {
    for (const k of KEEP) if (existing[k] !== undefined) entry[k] = existing[k];
  }
  return { ok: true, slug, partyEntry: entry, rosterEntry: buildRosterEntry(v), duplicate: !!existing };
}
