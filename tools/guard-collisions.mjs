// Offline: which game / dictionary words does the strict outbound guard (privacy/outbound-guard.js) still flag as USER text, by kind of roster name.
// Roster source: privacy/roster-config.js researchRoster() (the same one the tests use). Run: node tools/guard-collisions.mjs
// Output is counts and the colliding GAME WORDS by name kind. It never prints a member name or a fragment of one: a fragment (partial) collision prints only the
// fragment length. A probe word that IS a name (whole key) is counted, never listed.
import { pathToFileURL } from "node:url";
import { scanUserText } from "../infrastructure/worker/privacy/outbound-guard.js";
import { researchRoster, researchMembersFor, genericAliases, fragmentWords } from "../infrastructure/worker/privacy/roster-config.js";
import { skeleton } from "../infrastructure/worker/privacy/skeleton.js";

export const PROBE_WORDS = (
  "Skinning Leatherworking Blacksmithing Enchanting Engineering Alchemy Herbalism Mining Tailoring Fishing Cooking Aid Warrior Paladin Hunter Rogue Priest Shaman Mage Warlock Druid Tank Healer " +
  "Light Retribution Protection Holy Shadow Frost Fire Arcane Feral Elemental Restoration Enhancement Balance Guardian Discipline Assassination Combat Subtlety Arms Fury Beast Marksmanship Survival " +
  "Destruction Affliction Demonology Stormwind Orgrimmar Ironforge Darnassus Undercity Elwynn Durotar Barrens Westfall Duskwood Stranglethorn Tanaris Ungoro Winterspring Silithus Felwood Ashenvale " +
  "Darkshore Teldrassil Morogh Modan Redridge Badlands Blasted Swamp Hinterlands Plaguelands Sword Dagger Mace Staff Shield Robe Cloak Ring Amulet Trinket Boots Gloves Helm Belt Bracers Leather Cloth " +
  "Mail Plate Potion Elixir Flask Bandage Mount Gold Silver Copper Quest Dungeon Raid Guild Party Group Talent Level Class Race Horde Alliance Human Dwarf Gnome Elf Orc Troll Tauren Undead Damage " +
  "Healing Mana Rage Energy Armor Weapon Spell Skill Strength Agility Intellect Stamina Spirit Crit Dodge Parry Block Threat Aggro Taunt Pull Wipe Loot Roll Need Greed Vendor Auction Bank Mail"
).split(" ");

const KINDS = ["display", "alias", "first", "character"];
const FIELD = { alias: "aliases", first: "firstNames", character: "characterNames" };
const PLACEHOLDER = "qzxjvkkw";

// Pure: returns { kinds: { kind: { names, exactWords, substringWords: [], partialCount, partialLengths: Set } } } with no member name in it.
export function collisions(roster, words = PROBE_WORDS) {
  const out = {};
  const members = roster.members;
  for (const kind of KINDS) {
    const rec = { names: 0, exact: 0, substringWords: new Set(), partial: 0, partialLengths: new Set() };
    out[kind] = rec;
    for (const m of members) {
      const list = kind === "display" ? [m.display] : m[FIELD[kind]] || [];
      for (const name of list) {
        if (typeof name !== "string" || !name.trim()) continue;
        if (kind === "alias" && genericAliases.includes(name.toLowerCase())) continue;
        rec.names++;
        const single = { members: [kind === "display" ? { display: name } : { display: PLACEHOLDER, [FIELD[kind]]: [name] }], genericAliases: roster.genericAliases, fragmentWords: roster.fragmentWords };
        const key = skeleton(name);
        for (const w of words) {
          let leaks;
          try { leaks = scanUserText([w], single); } catch { continue; }
          const mine = leaks.filter((l) => l.kind === "name" || l.kind === "partial");
          if (!mine.length) continue;
          if (skeleton(w) === key) { rec.exact++; continue; }
          if (mine.some((l) => l.kind === "partial")) { rec.partial++; rec.partialLengths.add(5); } else rec.substringWords.add(w);
        }
      }
    }
  }
  return out;
}

export function report(result, probeCount = PROBE_WORDS.length) {
  const lines = [`probe words: ${probeCount}`];
  for (const [kind, r] of Object.entries(result)) {
    lines.push(`${kind}: ${r.names} names checked; ${r.exact} probe words equal a name (not listed); ${r.partial} fragment collisions (fragment length only: ${[...r.partialLengths].join(",") || "-"}); ${r.substringWords.size} word-contains-name collisions${r.substringWords.size ? `: ${[...r.substringWords].sort().join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // Options: --sheets <file.json> adds sheet-derived members (a party_sheets array) the way the Worker does; --no-stop shows the old behaviour (no fragmentWords).
  const argv = process.argv.slice(2);
  const sheetsAt = argv.indexOf("--sheets");
  const base = researchRoster();
  let members = base.members;
  if (sheetsAt >= 0) {
    const { readFileSync } = await import("node:fs");
    members = researchMembersFor(JSON.parse(readFileSync(argv[sheetsAt + 1], "utf8")));
  }
  console.log(report(collisions({ members, genericAliases: base.genericAliases, ...(argv.includes("--no-stop") ? {} : { fragmentWords }) })));
}
