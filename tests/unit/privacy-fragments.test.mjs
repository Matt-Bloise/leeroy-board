// Strict outbound guard: the full fragment rule for friend-typed text, the whole-name-only scan for persona/library/sheet text, the work bound, and the two offline tools.
// Fictional names only; the real roster is read at runtime and no name is ever printed (failure messages carry indexes and counts).
// Run: node --test tests/unit/privacy-fragments.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanUserText } from "../../infrastructure/worker/privacy/outbound-guard.js";
import * as RC from "../../infrastructure/worker/privacy/roster-config.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { skeleton } from "../../infrastructure/worker/privacy/skeleton.js";
import { PROBE_WORDS, collisions, report, sharesFourLetters } from "../../tools/guard-collisions.mjs";
import { truncationTable, tableReport, TRUNCATION_FORMS } from "../../tools/guard-truncations.mjs";

const FULL = {};
const PROMPT = { noFragments: true };
const rosterOf = (members) => ({ members, genericAliases: RC.genericAliases });
// Fictional members A..E: ordinary names, names built on game words, and one whose whole name is itself a game word.
const FICTIONAL = [
  { display: "Mirabel Stormcrow", aliases: ["mira"], firstNames: ["Mirabel"], characterNames: ["Quillmage"] },
  { display: "Frostbrand", aliases: [], firstNames: [], characterNames: [] },
  { display: "Shadowhunter", aliases: ["Zxcvbnmasd"], firstNames: [], characterNames: ["Ironbark"] },
  { display: "Lightbringer", aliases: [], firstNames: ["Zorbal"], characterNames: [] },
  { display: "Paladin", aliases: [], firstNames: [], characterNames: ["Moonstalker"] },
];
const SHEET_NAMES = ["Frostbrand", "Leatherback", "Blacksmithy", "Moonshadow", "Fireblade", "Holysmith", "Arcanewind", "Mininggrub", "Cookingpot", "Skinwalker"];
const sheetMembers = () => RC.researchMembersFor(SHEET_NAMES.map((n) => ({ slug: n.toLowerCase(), name: n })));
const realKeys = () => new Set(ROSTER_DATA.flatMap((r) => [r.display, ...(r.aliases || [])]).map((x) => skeleton(x)));
const blocked = (text, roster, opts = FULL) => scanUserText([text], roster, opts).length > 0;

test("prompt scan: WoW profession/class/spec/zone/item words never trip it, fictional roster + sheet names and the real roster, with no word list", () => {
  const rosters = [["fictional", rosterOf([...FICTIONAL, ...sheetMembers()])], ["real", rosterOf(RC.researchRoster().members)]];
  const single = [...PROBE_WORDS, "Skinning, Leatherworking and First Aid", "Retribution Protection Holy"];
  const bad = [];
  for (const [label, roster] of rosters) {
    const phrases = label === "real" ? [...single, PROBE_WORDS.join(" "), PROBE_WORDS.join(", ")] : single; // adjacent words can spell a fictional compound whole name
    const own = label === "real" ? realKeys() : new Set(FICTIONAL.flatMap((m) => [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames]).map((x) => skeleton(x)));
    for (const [i, p] of phrases.entries()) {
      if (own.has(skeleton(p))) continue; // the word IS a name
      if (blocked(p, roster, PROMPT)) bad.push(`${label}#${i}`);
    }
  }
  assert.deepEqual(bad, [], `${bad.length} phrases tripped (indexes only)`);
});

test("friend-typed text keeps the FULL fragment rule: truncated and partial forms of display names and aliases all block", () => {
  const r = rosterOf(FICTIONAL);
  for (const t of ["Shadowhunte", "Shadowhun", "shado", "adowhunter", "unter", "Zxcvbnmas", "zxcvb", "nmasd", "xcvbnmasd", "Frostbra", "ostbrand"]) assert.ok(blocked(`ask ${t} about it`, r), `truncated form #${["Shadowhunte", "Shadowhun", "shado", "adowhunter", "unter", "Zxcvbnmas", "zxcvb", "nmasd", "xcvbnmasd", "Frostbra", "ostbrand"].indexOf(t)} passes`);
  assert.ok(blocked("ask odahsx about it", r), "reversed fragment typed in a word");
  assert.ok(blocked("ask bvcxzx about it", r), "reversed alias");
});

test("the prompt scan skips ONLY fragments: exact, spaced, hyphenated, leet, doubled-letter, reversed and short-name forms still block; bare fragments do not", () => {
  const r = rosterOf(FICTIONAL);
  for (const t of ["Shadowhunter", "S h a d o w h u n t e r", "Shad-ow-hunter", "Sh4d0whunt3r", "Shhaaddoowwhunter", "retnuhwodahs", "Paladin", "P a l a d i n", "nidalap", "Zorbal", "Z o r b a l", "Zxcvbnmasd", "dsamnbvcxz", "Mirabel", "mira"]) {
    assert.ok(blocked(`see ${t} here`, r, PROMPT), `whole-name form blocked? #${["Shadowhunter", "S h a d o w h u n t e r", "Shad-ow-hunter", "Sh4d0whunt3r", "Shhaaddoowwhunter", "retnuhwodahs", "Paladin", "P a l a d i n", "nidalap", "Zorbal", "Z o r b a l", "Zxcvbnmasd", "dsamnbvcxz", "Mirabel", "mira"].indexOf(t)}`);
  }
  for (const t of ["Shadowhun", "shado", "Zxcvbnmas", "unter"]) assert.equal(blocked(`see ${t} here`, r, PROMPT), false, "a bare fragment is not a prompt-scan hit");
});

test("every member still matches exact, spaced, leet and reversed forms under BOTH scans (fictional A..E and the real roster)", () => {
  const rev = (s) => [...s].reverse().join("");
  const leet = (s) => s.replace(/a/g, "4").replace(/e/g, "3").replace(/i/g, "1").replace(/o/g, "0");
  const miss = [];
  const check = (label, members) => {
    const roster = rosterOf(members);
    members.forEach((m, mi) => {
      const names = [["display", m.display], ...(m.aliases || []).map((x) => ["alias", x]), ...(m.firstNames || []).map((x) => ["first", x]), ...(m.characterNames || []).map((x) => ["character", x])];
      names.forEach(([kind, name], ni) => {
        const low = String(name).toLowerCase();
        if (!low || (kind === "alias" && RC.genericAliases.includes(low))) return;
        const forms = [["exact", name]]; // keys of 4 letters or fewer match whole words only: no spaced, leet or reversed forms
        if (skeleton(low).length >= 5) forms.push(["spaced", [...low].join(" ")], ["leet", leet(low)], ["reversed", rev(low)]);
        for (const [fk, text] of forms) for (const [sn, opts] of [["full", FULL], ["prompt", PROMPT]]) if (!blocked(`ask about ${text} tonight`, roster, opts)) miss.push(`${label} m${mi} n${ni} ${kind} ${fk} ${sn}`);
      });
    });
  };
  check("fictional", FICTIONAL);
  check("real", RC.researchRoster().members);
  assert.deepEqual(miss, [], `${miss.length} forms lost (indexes only)`);
});

test("real roster truncation forms: first 5, first 6, minus last 1-2 letters, reversed minus last letter all block in friend-typed text, for every 7+ letter display and alias", () => {
  const res = truncationTable(RC.researchRoster().members);
  assert.ok(res.rows.length >= 4, "the table has rows");
  const lost = res.rows.flatMap((r) => TRUNCATION_FORMS.filter((f) => !r.forms[f]).map((f) => `m${r.member} ${r.kind} ${f}`));
  assert.deepEqual(lost, [], `${lost.length} truncation forms pass the guard (member index, kind, form)`);
  const text = tableReport(res).toLowerCase();
  const names = ROSTER_DATA.flatMap((r) => [r.display, ...(r.aliases || [])]).map((n) => n.toLowerCase().replace(/\s+/g, ""));
  assert.equal(names.flatMap((n) => [n, n.slice(0, 4), n.slice(-4)]).filter((s) => s.length >= 4 && text.includes(s)).length, 0, "the table carries a name or fragment (count)");
});

test("work bound: no clock. A worst-case many-candidate input hits the step cap deterministically and fails closed; a normal prompt does not", () => {
  const roster = rosterOf(RC.researchRoster().members);
  const chunk = Array.from({ length: 30 }, (_, i) => Buffer.from(`word${i} text`).toString("base64")).join(" "); // ~31 decode candidates per segment
  const segs = Array.from({ length: 70 }, () => chunk);
  const work = { steps: 0, max: 20000 };
  const leaks = scanUserText(segs, roster, { work, maxChars: 1e6 });
  assert.ok(leaks.some((l) => l.kind === "toolong"), "the step cap fires");
  assert.ok(work.steps > work.max);
  const again = { steps: 0, max: 20000 };
  scanUserText(segs, roster, { work: again, maxChars: 1e6 });
  assert.equal(again.steps, work.steps, "deterministic: same input, same step count");
  const normal = { steps: 0, max: 20000 };
  const ok = scanUserText(["who tanks tonight", "what about the paladin in the barrens", ...Array.from({ length: 10 }, (_, i) => `class warrior level ${i} mining`)], roster, { work: normal });
  assert.equal(ok.length, 0);
  assert.ok(normal.steps < 2000, `a normal prompt used ${normal.steps} steps`);
});

test("work bound counts candidates and roster entries separately and exactly", () => {
  const one = { members: [{ display: "Zibblerward" }], genericAliases: [] };
  const w = { steps: 0, max: 1000 };
  scanUserText(["hello"], one, { work: w });
  assert.equal(w.steps, 2, "1 candidate + 1 entry");
  // entries skipped by the kind filter: only candidates count, and they alone can hit the cap
  const chunk = Array.from({ length: 30 }, (_, i) => Buffer.from(`word${i} text`).toString("base64")).join(" ");
  const w2 = { steps: 0, max: 20 };
  const leaks = scanUserText([chunk], one, { work: w2, kinds: new Set(["guild"]) });
  assert.ok(leaks.some((l) => l.kind === "toolong"), "candidates alone hit the cap");
  const w3 = { steps: 0, max: 1 };
  assert.ok(scanUserText(["hello"], one, { work: w3 }).some((l) => l.kind === "toolong"), "an entry visit alone hits the cap");
});

test("tryResearchClaude: the input length bound runs before any scan; each segment class carries the work cap; party segments keep the full fragment rule", async () => {
  const { tryResearchClaude, workBound } = await import("../../infrastructure/worker/research/claude.js");
  const env = { ANTHROPIC_API_KEY: "sk-ant-FAKE-TEST-0000" };
  const roster = rosterOf(FICTIONAL);
  const call = async () => { throw new Error("must not be called"); };
  const mk = (over) => ({ ok: true, ms: 0, system: "s", user: "u", userSegments: [], partySegments: [], promptSegments: [], roster, ...over });
  // 1. over-long input: refused before the scans (a poisoned roster would throw guard:config if any scan ran first)
  const poison = new Proxy({}, { get() { throw new Error("roster touched"); } });
  const long = await tryResearchClaude({ env, priv: mk({ system: "x".repeat(70000), roster: poison, userSegments: ["hi"] }), deep: true, call });
  assert.equal(long.reason, "cpu:budget");
  // 2. the step cap reaches each segment class (a cap of 1 fires on the first roster entry or candidate)
  const saved = workBound.guardSteps;
  try {
    workBound.guardSteps = 1;
    for (const key of ["userSegments", "partySegments", "promptSegments"]) {
      const r = await tryResearchClaude({ env, priv: mk({ [key]: ["who tanks tonight"] }), deep: true, call });
      assert.equal(r.reason, "guard:toolong", key);
    }
  } finally { workBound.guardSteps = saved; }
  // 3. party segments are friend-typed: a fragment there stops Claude; in the prompt segments it does not
  const frag = "shado";
  assert.equal((await tryResearchClaude({ env, priv: mk({ partySegments: [`raid ${frag} night`] }), deep: true, call })).reason, "guard:partial");
  assert.equal((await tryResearchClaude({ env, priv: mk({ userSegments: [`raid ${frag} night`] }), deep: true, call })).reason, "guard:partial");
  const passed = await tryResearchClaude({ env, priv: mk({ promptSegments: [`raid ${frag} night`] }), deep: true, call });
  assert.doesNotMatch(String(passed.reason), /^guard:/, "a prompt-segment fragment is not a guard hit (it proceeds to the spend step, which has no DB here)");
});

test("prepareResearchPrivacy: an over-long prompt is refused before any tokenising (no map is built)", async () => {
  const { prepareResearchPrivacy } = await import("../../infrastructure/worker/research/claude.js");
  const r = prepareResearchPrivacy({ systemPrompt: "x".repeat(40000), userPrompt: "y".repeat(30000), question: "hi", previousQuestion: "", by: "Visitor", party: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cpu:budget");
  assert.equal(r.map, undefined);
  assert.equal(prepareResearchPrivacy({ systemPrompt: "s", userPrompt: "u", question: "hi", previousQuestion: "", by: "Visitor", party: null }).ok, true);
});

test("work bound in the tokeniser: loop iterations count, not only entries", async () => {
  const { buildNameMap, tokenise } = await import("../../infrastructure/worker/privacy/tokenise.js");
  const map = buildNameMap(RC.researchRoster().members, null, { genericAliases: RC.genericAliases, nonce: "abcd" });
  const entries = map.entries.length;
  map.work = { steps: 0, max: entries + 5 };
  const alias = ROSTER_DATA[0].display;
  assert.throws(() => tokenise(`${alias} `.repeat(40), map), /work bound/, "many matches exceed a cap that the entry count alone would not");
});

test("work bound in the tokeniser: a cap hit throws, a normal prompt stays far under the default", async () => {
  const { buildNameMap, tokenise } = await import("../../infrastructure/worker/privacy/tokenise.js");
  const { workBound } = await import("../../infrastructure/worker/research/claude.js");
  const map = buildNameMap(RC.researchRoster().members, null, { genericAliases: RC.genericAliases, nonce: "abcd" });
  map.work = { steps: 0, max: 5 };
  assert.throws(() => tokenise("hello there ".repeat(200) + "x".repeat(500), map), /work bound/);
  const map2 = buildNameMap(RC.researchRoster().members, null, { genericAliases: RC.genericAliases, nonce: "abcd" });
  map2.work = { steps: 0, max: workBound.tokeniseSteps };
  tokenise("who tanks tonight and what about the paladin in the barrens, level 12 mining", map2);
  assert.ok(map2.work.steps < 500, `a normal question used ${map2.work.steps} steps`);
});

test("tools/guard-collisions.mjs prints counts and game words only: no member name or piece of one, even for a probe word that contains one", () => {
  const members = [...FICTIONAL, ...sheetMembers(), { display: "Chantelle Smithwick", aliases: ["Brillgate", "Chanting", "Smithing"], firstNames: [], characterNames: [] }];
  const probes = [...PROBE_WORDS, "Enchanting", "Blacksmithing", "Brilliant"]; // contain the fragments of a name: "chant", "smith", "brill"
  const text = report(collisions(rosterOf(members), probes), probes.length);
  const lower = text.toLowerCase();
  const keysAll = members.flatMap((m) => [m.display, ...(m.aliases || []), ...(m.firstNames || []), ...(m.characterNames || [])]).map((n) => skeleton(n));
  const leaked = [];
  for (const k of keysAll) for (let i = 0; i + 4 <= k.length; i++) if (lower.includes(k.slice(i, i + 4))) leaked.push(k.length);
  assert.equal(leaked.length, 0, `${leaked.length} 4-letter pieces of fixture names appear in the output (name lengths only)`);
  assert.ok(sharesFourLetters("Enchanting", keysAll) && sharesFourLetters("Blacksmithing", keysAll), "the probe does contain a fragment, so it must have been withheld");
  assert.match(text, /withheld/);
  const friend = /\[friend-typed\]\ndisplay: \d+ names checked; \d+ probe words equal a name \(not listed\); (\d+) fragment collisions/.exec(text);
  const prompt = /\[prompt\]\ndisplay: \d+ names checked; \d+ probe words equal a name \(not listed\); (\d+) fragment collisions/.exec(text);
  assert.ok(friend && Number(friend[1]) > 0, "friend-typed text has fragment collisions (the full rule)");
  assert.ok(prompt && Number(prompt[1]) === 0, "the prompt scan has none");
  const cli = execFileSync(process.execPath, [fileURLToPath(new URL("../../tools/guard-collisions.mjs", import.meta.url))], { encoding: "utf8" }).toLowerCase();
  const real = ROSTER_DATA.flatMap((r) => [r.display, ...(r.aliases || [])]).map((n) => n.toLowerCase().replace(/\s+/g, ""));
  const out = [];
  for (const n of real) for (let i = 0; i + 4 <= n.length; i++) { const w = n.slice(i, i + 4); if (cli.includes(w) && !PROBE_WORDS.some((p) => p.toLowerCase().includes(w))) out.push(n.length); }
  assert.equal(out.length, 0, "real names or pieces in CLI output (count)");
});

test("tools/guard-library-trips.mjs: the prompt scan trips no checked-in library page with the real roster; output carries ids, kind, layer, length only", async () => {
  const { libraryTrips, tripsReport } = await import("../../tools/guard-library-trips.mjs");
  const base = RC.researchRoster();
  const roster = { members: base.members, genericAliases: base.genericAliases };
  const res = libraryTrips(roster);
  assert.equal(res.trips.length, 0, `${res.trips.length} pages trip the prompt scan`);
  const full = libraryTrips(roster, undefined, {});
  assert.ok(full.trips.length > res.trips.length, "the full rule trips more pages: that is the cost the prompt scan avoids");
  const text = tripsReport(full).toLowerCase().split("\n").map((l) => l.replace(/^[^:]*:/, "")).join("\n");
  const real = ROSTER_DATA.flatMap((r) => [r.display, ...(r.aliases || [])]).map((n) => n.toLowerCase().replace(/\s+/g, ""));
  assert.equal(real.flatMap((n) => [n, n.slice(0, 5), n.slice(-5)]).filter((s) => s.length >= 4 && text.includes(s)).length, 0, "kind/layer/length text carries a name or fragment (count)");
});
