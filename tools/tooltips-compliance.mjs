// Rewrites data/library/tooltips.json so it carries no verbatim game tooltip prose.
//   node tools/tooltips-compliance.mjs --write   rewrite the file in place (idempotent)
//   node tools/tooltips-compliance.mjs --check   exit 1 if the file still holds prose
// Kept: name, rank, level, quality, url, and the numeric/structured lines (cost, range, cast time, cooldown,
// class and level requirements, item stat lines, sell price). Dropped: the description sentences, flavour
// quotes and Equip/Use effect prose copied from Wowhead (link-only host). Each spell gets a short `desc` we
// compose ourselves from the numeric fields; the card links to the full tooltip on Wowhead.
// No network, no AI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "library", "tooltips.json");
export const DESC_MAX = 160;

const KEEP = /^(?:\d[\d,]* (?:Mana|Rage|Energy|Focus)|\d+% of base mana|\d+(?:\.\d+)? (?:sec|min) cast|\d+(?: - \d+)? yd range|Melee Range|Unlimited range|Instant|Instant cast|Channeled(?: \([\d.]+ sec cast\))?|Next Melee|Talent|\d+(?:\.\d+)? (?:sec|min|hour) cooldown|Requires (?:[Ll]evel \d+|[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)|Tools:|Reagents:)$/;
const ITEM_BAD = /^(?:["“]|Equip:|Use:|Chance on hit:|Set\s*:|\(\d\) Set\s*:)/;
const SCHOOL = "(?:Arcane |Fire |Frost |Nature |Shadow |Holy |Physical )?";
const DMG = new RegExp(`(\\d[\\d,]*(?: to \\d[\\d,]*)?) (${SCHOOL})(damage|healing)\\b`);
const HEAL = /\bheals?\b[^.]*? for (\d[\d,]*(?: to \d[\d,]*)?)\b/i;

function shortName(l) { return l.length <= 28 && !/[.:,"]/.test(l) && !/^(?:Gain|Teaches|Counters|Restores|Create)\b/.test(l); }

export function sanitize(t) {
  const src = Array.isArray(t.lines) ? t.lines : [];
  let kept, prose;
  if (t.kind === "item") {
    kept = src.filter((l) => l.length <= 45 && !ITEM_BAD.test(l));
    prose = [];
  } else {
    kept = []; prose = [];
    let inList = false;
    for (const l of src) {
      if (KEEP.test(l)) { kept.push(l); inList = /^(?:Tools|Reagents):$/.test(l); }
      else if (inList && shortName(l)) kept.push(l);
      else { inList = false; if (l.length > 28) prose.push(l); else if (shortName(l) && /^(?:Light|Sacred|Holy|Rune|Earth|Air|Fire|Water|Ankh|Arcane)/.test(l)) kept.push(l); }
    }
  }
  const out = { id: t.id, kind: t.kind, name: t.name, rank: t.rank, level: t.level, quality: t.quality, url: t.url, lines: kept };
  if (t.kind !== "item") {
    const cls = (kept.find((l) => /^Requires [A-Z]/.test(l) && !/level/i.test(l)) || "").replace(/^Requires /, "");
    const lvl = (kept.find((l) => /^Requires level \d+/i.test(l)) || "").replace(/\D+/g, "");
    const text = prose.join(" ");
    const d = text.match(DMG), hl = d ? null : text.match(HEAL);
    const num = d ? `${d[1]} ${d[2] || ""}${d[3]}`.replace(/\s+/g, " ") : hl ? `${hl[1]} healing` : "";
    const parts = [`${cls ? `${cls} spell` : "Spell"}${lvl ? `, level ${lvl}` : ""}.`];
    if (num) parts.push(`${d ? "Deals" : "Heals for"} ${d ? num : hl[1]}.`);
    const desc = parts.join(" ");
    if (!prose.length && typeof t.desc === "string") out.desc = t.desc.slice(0, DESC_MAX); // already clean: keep ours
    else if (desc.length <= DESC_MAX) out.desc = desc;
  }
  return out;
}

export function run(write) {
  const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const tooltips = j.tooltips.map(sanitize);
  const before = JSON.stringify(j.tooltips);
  const changed = before !== JSON.stringify(tooltips);
  if (write && changed) fs.writeFileSync(FILE, JSON.stringify({ ...j, tooltips }));
  return { changed, count: tooltips.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const r = run(write);
  console.log(`${r.count} tooltips${r.changed ? (write ? " rewritten" : " would change") : " already clean"}`);
  if (!write && r.changed) process.exit(1);
}
