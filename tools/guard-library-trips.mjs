// Offline: which checked-in library pages trip the strict outbound guard on their own with the real roster, and WHY. Run: node tools/guard-library-trips.mjs
// Prints page ids and, per hit, the name kind (display/alias/first/character/guild), the matching layer (short/plain/collapse/partial/reverse) and the key length.
// Never a member name or a fragment of one. Page text = every string value of the page, scanned as one segment (up to 60,000 characters), the way the Worker's
// whole-prompt strict guard scans it (research/claude.js promptSegments).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanUserText } from "../infrastructure/worker/privacy/outbound-guard.js";
import { researchRoster } from "../infrastructure/worker/privacy/roster-config.js";

const textOf = (p) => { const vals = []; const walk = (v) => { if (typeof v === "string") vals.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); }; walk(p); return vals.join("\n"); };

export function libraryPages(dir = new URL("../data/library/", import.meta.url)) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "search.json") continue;
    const j = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    for (const p of Array.isArray(j) ? j : j.pages || [j]) if (p && typeof p === "object" && typeof p.id === "string" && p.id.includes("/")) out.push({ id: String(p.id || `${f}:?`), text: textOf(p) });
  }
  return out;
}

// Pure: [{ id, why: ["kind/layer/len", ...] }] for every page with at least one strict-guard leak.
export function libraryTrips(roster, pages = libraryPages(), opts = { noFragments: true }) {
  const trips = [];
  for (const p of pages) {
    const leaks = scanUserText([p.text], roster, { maxChars: 60000, blockScripts: false, ...opts });
    if (leaks.length) trips.push({ id: p.id, why: [...new Set(leaks.map((l) => (l.layer ? `${l.ekind}/${l.layer}/len${l.keylen}` : l.kind)))].sort() });
  }
  return { checked: pages.length, trips };
}

export function tripsReport({ checked, trips }) {
  return [`pages checked: ${checked}; tripping: ${trips.length}`, ...trips.map((t) => `${t.id}: ${t.why.join(", ")}`)].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const base = researchRoster();
  const roster = { members: base.members, genericAliases: base.genericAliases };
  console.log("prompt scan (whole-name layers, what the Worker runs on library text):");
  console.log(tripsReport(libraryTrips(roster)));
  if (process.argv.includes("--full")) {
    console.log("full rule incl. 5-letter fragments (what friend-typed text gets; for comparison):");
    console.log(tripsReport(libraryTrips(roster, libraryPages(), {})));
  }
}
void fileURLToPath;
