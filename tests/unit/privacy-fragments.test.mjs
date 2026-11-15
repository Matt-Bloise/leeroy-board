// Strict outbound guard vs game words: the partial/fragment rule (first/last 5 letters of 7+ letter names) must not drop Claude on ordinary WoW vocabulary, while every
// exact, spaced, leet and reversed form of a real name still blocks. Fictional names only; the real roster is read at runtime and no name is ever printed.
// Run: node --test tests/unit/privacy-fragments.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanUserText } from "../../infrastructure/worker/privacy/outbound-guard.js";
import * as RC from "../../infrastructure/worker/privacy/roster-config.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { skeleton } from "../../infrastructure/worker/privacy/skeleton.js";
import { PROBE_WORDS, collisions, report } from "../../tools/guard-collisions.mjs";

const rosterOf = (members, extra = {}) => ({ members, genericAliases: RC.genericAliases, fragmentWords: RC.fragmentWords, ...extra });
// Fictional members A..E: ordinary names, names built on game words, and one whose whole name is itself a game word.
const FICTIONAL = [
  { display: "Mirabel Stormcrow", aliases: ["mira"], firstNames: ["Mirabel"], characterNames: ["Quillmage"] },
  { display: "Frostbrand", aliases: [], firstNames: [], characterNames: [] },
  { display: "Shadowhunter", aliases: ["shadowh"], firstNames: [], characterNames: ["Ironbark"] },
  { display: "Lightbringer", aliases: [], firstNames: ["Zorbal"], characterNames: [] },
  { display: "Paladin", aliases: [], firstNames: [], characterNames: ["Moonstalker"] },
];
const SHEET_NAMES = ["Frostbrand", "Leatherback", "Blacksmithy", "Moonshadow", "Fireblade", "Holysmith", "Arcanewind", "Mininggrub", "Cookingpot", "Skinwalker"];
const sheetMembers = () => RC.researchMembersFor(SHEET_NAMES.map((n) => ({ slug: n.toLowerCase(), name: n })));
const realKeys = () => new Set(ROSTER_DATA.flatMap((r) => [r.display, ...(r.aliases || [])]).map((x) => skeleton(x)));

test("WoW profession/class/spec/zone/item words as user text never trip the strict guard (fictional roster + sheet-derived names + the real roster)", () => {
  const rosters = [["fictional", rosterOf([...FICTIONAL, ...sheetMembers()])], ["real", rosterOf(RC.researchRoster().members)]];
  // Joined lists are tested against the real roster only: in the despaced skeleton two adjacent game words can spell a fictional compound name ("Holy"+"Smith"), which is
  // a true residual (flags.md), not a fragment false positive.
  const single = [...PROBE_WORDS, "Skinning, Leatherworking and First Aid", "Retribution Protection Holy"];
  const bad = [];
  for (const [label, roster] of rosters) {
    const phrases = label === "real" ? [...single, PROBE_WORDS.join(" "), PROBE_WORDS.join(", ")] : single;
    const own = label === "real" ? realKeys() : new Set(FICTIONAL.flatMap((m) => [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames]).map((x) => skeleton(x)));
    for (const [i, p] of phrases.entries()) {
      if (own.has(skeleton(p))) continue; // the word IS a name
      if (scanUserText([p], roster).length) bad.push(`${label}#${i}`);
    }
  }
  assert.deepEqual(bad, [], `${bad.length} phrases tripped (indexes only)`);
});

test("every member still matches exact, spaced, leet and reversed forms with fragmentWords set (fictional A..E and the real roster)", () => {
  const rev = (s) => [...s].reverse().join("");
  const leet = (s) => s.replace(/a/g, "4").replace(/e/g, "3").replace(/i/g, "1").replace(/o/g, "0");
  const miss = [];
  const check = (label, members) => {
    const withStop = rosterOf(members);
    members.forEach((m, mi) => {
      const names = [["display", m.display], ...(m.aliases || []).map((x) => ["alias", x]), ...(m.firstNames || []).map((x) => ["first", x]), ...(m.characterNames || []).map((x) => ["character", x])];
      names.forEach(([kind, name], ni) => {
        const low = String(name).toLowerCase();
        if (!low || (kind === "alias" && RC.genericAliases.includes(low))) return;
        const forms = [["exact", name], ["spaced", [...low].join(" ")]];
        if (skeleton(low).length >= 5) forms.push(["leet", leet(low)], ["reversed", rev(low)]);
        for (const [fk, text] of forms) {
          const hit = scanUserText([`ask about ${text} tonight`], withStop).length > 0;
          const without = scanUserText([`ask about ${text} tonight`], { members, genericAliases: RC.genericAliases }).length > 0;
          if (without && !hit) miss.push(`${label} m${mi} n${ni} ${kind} ${fk} lost`);
          if (fk === "exact" && !hit) miss.push(`${label} m${mi} n${ni} ${kind} exact unmatched`);
        }
      });
    });
  };
  check("fictional", FICTIONAL);
  check("real", RC.researchRoster().members);
  assert.deepEqual(miss, [], `${miss.length} forms lost (indexes only)`);
});

test("partial rule applies to display/character/first kinds only; a name that is itself a game word has no fragments; exact forms still block", () => {
  const r = rosterOf([{ display: "Qwertyuiop", aliases: ["Zxcvbnmasd"], firstNames: [], characterNames: [] }]);
  assert.ok(scanUserText(["Qwert is here"], r).length, "display fragment still blocks");
  assert.equal(scanUserText(["Zxcvb is here"], r).length, 0, "an alias is not fragment-matched");
  assert.ok(scanUserText(["Zxcvbnmasd is here"], r).length, "alias exact still blocks");
  const g = rosterOf([{ display: "Paladin", aliases: [], firstNames: [], characterNames: [] }]);
  assert.equal(scanUserText(["a Palad idea"], g).length, 0);
  assert.ok(scanUserText(["Paladin tonight"], g).length && scanUserText(["P a l a d i n"], g).length && scanUserText(["nidalap"], g).length);
});

test("without fragmentWords the old partial rule is unchanged (callers that do not pass it)", () => {
  assert.ok(scanUserText(["Frost"], { members: [{ display: "Frostbrand" }], genericAliases: [] }).length);
});

test("tools/guard-collisions.mjs prints counts and game words only: no member name, key or fragment (fictional fixtures and the real roster)", () => {
  const fixture = report(collisions(rosterOf([...FICTIONAL, ...sheetMembers()]))).toLowerCase();
  const names = [...FICTIONAL.flatMap((m) => [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames]), ...SHEET_NAMES].map((n) => n.toLowerCase());
  assert.equal(names.filter((n) => fixture.includes(n)).length, 0, "fixture names in the output (count)");
  const cli = execFileSync(process.execPath, [fileURLToPath(new URL("../../tools/guard-collisions.mjs", import.meta.url))], { encoding: "utf8" }).toLowerCase();
  const probes = new Set(PROBE_WORDS.map((w) => w.toLowerCase()));
  const real = ROSTER_DATA.flatMap((r) => [r.display, ...(r.aliases || [])]).map((n) => n.toLowerCase().replace(/\s+/g, ""));
  const leaked = real.flatMap((n) => [n, n.slice(0, 5), n.slice(-5)]).filter((s) => s.length >= 4 && !probes.has(s) && cli.includes(s));
  assert.equal(leaked.length, 0, "real names or fragments in CLI output (count)");
});
