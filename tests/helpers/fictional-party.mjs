// Fictional stand-ins for the member names in data/party.json, so a recorded or served TEST document never says which real person plays what.
// The repository is public: tests/fixtures/api-snapshot/snapshot.json and what tests/helpers/api-stub.mjs serves to the browser suites carry these names instead.
// The real names are never written here or in the fixtures: they are read from data/party.json (members, in order) at the moment of use and mapped by position, so this
// file stays free of them and keeps working when the party document changes. A member whose name is already one of the stand-ins is left alone.
//   fictionalise(text)  ->  text with every real member name and member slug replaced (whole words only: "Matt-Bloise" in a URL is not a member)
// These are not the names in data/sample/* (the sample roster would put a viewer of the same name in its group). The builds (class, race, spec, professions) are not touched: they are the table's, and what a test needs; only the link from a person to them is cut.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const STAND_INS = Object.freeze(["Aldous Thorne", "Mirelle Voss", "Dagny Pell", "Quill Frostmere", "Gloam Hexley", "Tansy Rooke", "Fenwick Lark", "Ottoline Brack", "Harlan Vesper", "Sorrel Pike"]);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let cache = null;

// [[pattern, replacement], ...] for the names and slugs of the members in `members` (array of {name}).
export function pairsFor(members) {
  const out = [];
  (members || []).forEach((m, i) => {
    const real = m && typeof m.name === "string" ? m.name : "";
    const to = STAND_INS[i % STAND_INS.length];
    if (!real || STAND_INS.includes(real)) return;
    // not preceded or followed by a letter, digit or hyphen: "=Name=" and "Name's" match, "Matt-Name" and "Name-lore" do not
    out.push([new RegExp(`(?<![A-Za-z0-9-])${esc(real)}(?![A-Za-z0-9-])`, "g"), to]);
    if (slug(real) && slug(real) !== slug(to)) out.push([new RegExp(`(?<![A-Za-z0-9-])${esc(slug(real))}(?![A-Za-z0-9-])`, "g"), slug(to)]);
  });
  return out;
}

export function repoPairs() {
  if (cache) return cache;
  try { cache = pairsFor(JSON.parse(readFileSync(path.join(here, "..", "..", "data", "party.json"), "utf8")).members); } catch { cache = []; }
  return cache;
}

export function fictionalise(text, pairs = repoPairs()) {
  let t = String(text);
  for (const [re, to] of pairs) t = t.replace(re, to);
  return t;
}
