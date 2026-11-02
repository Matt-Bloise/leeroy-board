// Shared member model: one source of truth for tools/add-member.mjs and worker/projection.js. Pure, no I/O.
export const CLASSES = {
  warrior: { label: "Warrior", color: "#c79c6e", role: "damage" },
  paladin: { label: "Paladin", color: "#f48cba", role: "damage" },
  hunter: { label: "Hunter", color: "#aad372", role: "damage" },
  rogue: { label: "Rogue", color: "#fff468", role: "damage" },
  priest: { label: "Priest", color: "#ffffff", role: "healer" },
  shaman: { label: "Shaman", color: "#0070dd", role: "damage" },
  mage: { label: "Mage", color: "#3fc7eb", role: "damage" },
  warlock: { label: "Warlock", color: "#8788ee", role: "damage" },
  druid: { label: "Druid", color: "#ff7c0a", role: "damage" },
};
export const RACES = {
  orc: { label: "Orc", zone: "Durotar", faction: "Horde" },
  troll: { label: "Troll", zone: "Durotar", faction: "Horde" },
  tauren: { label: "Tauren", zone: "Mulgore", faction: "Horde" },
  undead: { label: "Undead", zone: "Tirisfal Glades", faction: "Horde" },
  human: { label: "Human", zone: "Elwynn Forest", faction: "Alliance" },
  dwarf: { label: "Dwarf", zone: "Coldridge Valley", faction: "Alliance" },
  gnome: { label: "Gnome", zone: "Coldridge Valley", faction: "Alliance" },
  "night-elf": { label: "Night Elf", zone: "Teldrassil", faction: "Alliance" },
};
// The names this board shows are game handles. Refuse anything that looks like contact details, and anything carrying a publisher's mark.
export const BAD_NAME = /[@<>\\/\u0000-\u001f]|https?:|www\.|blizzard|warcraft|battle\.net|activision/i;

export function slugify(name) {
  return String(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
}

// The party-document entry, in the shape the board already reads (see data/party.json). A new person has not chosen a spec yet.
export function partyEntry(v) {
  const c = CLASSES[v.cls], r = RACES[v.race];
  const raceLabel = r ? r.label : v.race;
  return {
    name: v.name,
    class_key: v.cls,
    class: c.label,
    race: raceLabel,
    spec: "Not chosen yet",
    spec_status: { status: "open", source: "board" },
    role: v.role,
    role_detail: null,
    color: c.color,
    start_zone: v.startZone || r.zone,
    board_line: `${raceLabel} ${c.label}`,
    professions: [],
  };
}

// The entry POST /api/admin/members takes (members.js validateMemberEntry): slug, name, lowercase match list, optional id.
export function rosterEntry(v) {
  return { slug: v.slug, name: v.name, match: [v.name.toLowerCase()], id: v.id };
}
