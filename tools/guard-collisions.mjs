// Offline: which game / dictionary words does the strict outbound guard (privacy/outbound-guard.js) still flag as text, by kind of roster name, under both scans the Worker
// runs: FRIEND-TYPED text (the full rule, fragments included) and the PROMPT scan (persona, library, sheet blocks: whole-name layers only, no fragments).
// Roster source: privacy/roster-config.js researchRoster() (the same one the tests use). Run: node tools/guard-collisions.mjs [--sheets file.json]
// The output is counts and GAME WORDS only. It never prints a member name or any piece of one: a fragment collision prints its fragment length; a probe word that shares
// four or more letters in a row with ANY name (a word that contains a name or a fragment of one) is not printed at all, only counted with its length; a probe word that is a name is counted.
import { pathToFileURL } from "node:url";
import { scanUserText } from "../infrastructure/worker/privacy/outbound-guard.js";
import { researchRoster, researchMembersFor, genericAliases } from "../infrastructure/worker/privacy/roster-config.js";
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

const allKeys = (members) => members.flatMap((m) => [m.display, ...(m.aliases || []), ...(m.firstNames || []), ...(m.characterNames || [])]).map((n) => skeleton(String(n || ""))).filter(Boolean);
// True when the word shares 4+ letters in a row with any name (either contains a piece of the other).
export function sharesFourLetters(word, keys) {
  const w = skeleton(word);
  for (let i = 0; i + 4 <= w.length; i++) { const win = w.slice(i, i + 4); if (keys.some((k) => k.includes(win))) return true; }
  return false;
}

// Pure. Returns { mode: { kind: { names, exact, partial, printable: Set, withheld: [lengths] } } } with no member name or fragment in it.
export function collisions(roster, words = PROBE_WORDS) {
  const keys = allKeys(roster.members);
  const out = {};
  for (const [mode, opts] of [["friend-typed", {}], ["prompt", { noFragments: true }]]) {
    out[mode] = {};
    for (const kind of KINDS) {
      const rec = { names: 0, exact: 0, partial: 0, printable: new Set(), withheld: [] };
      out[mode][kind] = rec;
      for (const m of roster.members) {
        const list = kind === "display" ? [m.display] : m[FIELD[kind]] || [];
        for (const name of list) {
          if (typeof name !== "string" || !name.trim()) continue;
          if (kind === "alias" && genericAliases.includes(name.toLowerCase())) continue;
          rec.names++;
          const single = { members: [kind === "display" ? { display: name } : { display: PLACEHOLDER, [FIELD[kind]]: [name] }], genericAliases: roster.genericAliases };
          const key = skeleton(name);
          for (const w of words) {
            let leaks;
            try { leaks = scanUserText([w], single, opts); } catch { continue; }
            const mine = leaks.filter((l) => l.kind === "name" || l.kind === "partial");
            if (!mine.length) continue;
            if (skeleton(w) === key) { rec.exact++; continue; }
            if (mine.some((l) => l.kind === "partial")) rec.partial++;
            else if (sharesFourLetters(w, keys)) rec.withheld.push(w.length);
            else rec.printable.add(w);
          }
        }
      }
    }
  }
  return out;
}

export function report(result, probeCount = PROBE_WORDS.length) {
  const lines = [`probe words: ${probeCount}`];
  for (const [mode, kinds] of Object.entries(result)) {
    lines.push(`[${mode}]`);
    for (const [kind, r] of Object.entries(kinds)) {
      const withheld = r.withheld.length ? `; ${r.withheld.length} words withheld (share 4+ letters with a name; word lengths: ${[...r.withheld].sort((a, b) => a - b).join(",")})` : "";
      const words = r.printable.size ? `: ${[...r.printable].sort().join(", ")}` : "";
      lines.push(`${kind}: ${r.names} names checked; ${r.exact} probe words equal a name (not listed); ${r.partial} fragment collisions (fragments are 5 letters; not listed); ${r.printable.size} whole-word collisions${words}${withheld}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // --sheets <file.json> adds sheet-derived members (a party_sheets array) the way the Worker does.
  const argv = process.argv.slice(2);
  const sheetsAt = argv.indexOf("--sheets");
  const base = researchRoster();
  let members = base.members;
  if (sheetsAt >= 0) {
    const { readFileSync } = await import("node:fs");
    members = researchMembersFor(JSON.parse(readFileSync(argv[sheetsAt + 1], "utf8")));
  }
  console.log(report(collisions({ members, genericAliases: base.genericAliases })));
}
