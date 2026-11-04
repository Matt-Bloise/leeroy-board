// A count word typed into party copy is the bug that made the board say "five" after Winton joined. The count becomes words in ONE place (js/board.js: K.pn.word(), K.pn.noun(),
// K.pn.title(), K.pn.say(n)); scene code builds its strings from it, and the static text in index.html is rewritten by partyCopy() (the PARTY_COPY table). This greps the shipped source
// (index.html, js, scenes, next, atlas, data/*.json, the other pages) for the words five / four / fifth in prose and fails on any that is not in ALLOWED below, and fails when an allowed
// entry no longer matches anything, so the list cannot go stale. To add copy that has a number in it: build it from K.pn (or the helper's `say`), do not add to ALLOWED unless the number is
// not the size of the party (a game rule, a count of cards, a number of sources) and say why.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const DIRS = ["js", "scenes", "next", "atlas", "room", "landing", "rate", "privacy", "terms"], TOP = ["index.html", "404.html"];
const SKIP_DATA = new Set(["client.json"]); // the spell tables of the game client
const files = () => {
  const out = [...TOP.filter((f) => fs.existsSync(path.join(ROOT, f)))];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) { if (e.name !== "node_modules") walk(r); } else if (/\.(?:js|html)$/.test(e.name)) out.push(r); } };
  for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  for (const e of fs.readdirSync(path.join(ROOT, "data"))) if (e.endsWith(".json") && !SKIP_DATA.has(e)) out.push(`data/${e}`);
  return out;
};
// comments are not copy
const stripComments = (f, t) => (f.endsWith(".json") ? t : t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|\s)\/\/.*$/gm, "$1"));
// prose: the bare word, not part of an identifier, a hash, a class, a scene id ("five" alone in quotes, five.sheet-x, #five), a key (five:) or a call
const RE = /(?<![\w#.\-/|])(five|four|fifth)(?![\w\-:|(]|\.[a-z$])/gi;
export function proseHits(file, text) {
  const hits = [];
  stripComments(file, text).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(RE)) {
      const b = line[m.index - 1] || "", a = line[m.index + m[0].length] || "";
      if (/[\\"'`]/.test(b) && /[\\"'`]/.test(a)) continue;
      hits.push({ file, line: i + 1, text: line.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).trim() });
    }
  });
  return hits;
}

// [file, pattern of the line, why, selector in the PARTY_COPY table of js/board.js that rewrites it (static index.html text only)]
const STATIC = [
  ["index.html", /for five friends heading/, 'meta[name="description"]'],
  ["index.html", /notice board for the five of us/, ".gate-card p"],
  ["index.html", /id="tt-five">The five</, "#tt-five"],
  ["index.html", /Open the five</, "#tt-five ~ .tile-go .word"],
  ["index.html", /id="sheet-title">The five</, "#sheet-title"],
  ["index.html", /<\/span>The five<\/button>/, "#tab-five"],
  ["index.html", /Swipe sideways for all five\./, "#panel-five .swipe-hint"],
  ["index.html", /What each of the five brings the others/, ".lede"],
  ["index.html", /<legend>Which of the five are you\?<\/legend>/, "fieldset legend"],
  ["index.html", /aria-label="Which of the five are you"/, "#as"],
];
const ALLOWED = [
  ...STATIC.map(([file, re, selector]) => ({ file, re, selector, why: "the page ships the five wording; partyCopy() rewrites it for any other count and puts it back for five" })),
  { file: "js/board.js", re: /\? "The five" : "The party"/, why: "the helper's own wording, the one place the title is typed" },
  { file: "index.html", re: /Four questions for launch night/, why: "the launch-night sign-up asks four questions; not the party size" },
  { file: "data/trust.json", re: /Four short answers/, why: "the trust card has four answers" },
  { file: "data/actions.json", re: /four cards that show where things are/, why: "the first-open walk has four cards" },
  { file: "js/v13d.js", re: /Five points (?:fewer|more)/, why: "the Bonuses dial steps by five points" },
  { file: "scenes/chamber.js", re: /five dispatches today/, why: "Leeroy's daily limit" },
  { file: "scenes/guided-atlas.js", re: /group of five players/, why: "a dungeon is a group of five players (game rule)" },
  { file: "data/guided-atlas.json", re: /group of five players/, why: "a dungeon is a group of five players (game rule)" },
  { file: "data/decide.json", re: /fifth \(reagent\) slot/, why: "the game's fifth bag slot" },
  { file: "data/decide.json", re: /three of five still travel/, why: "the game's summoning rule for a five-player dungeon group" },
  { file: "privacy/index.html", re: /four safe-area insets/, why: "the four edges of the screen" },
  { file: "js/shell.js", re: /const five = \$\("#panel-five"\)/, why: "a variable named for the scene id" },
  { file: "scenes/place.js", re: /five = \$\("#panel-five"\)|\[lib, five\]|if \(five &&|root: five/, why: "a variable named for the scene id" },
];

test("no count word is typed into party copy outside the helper and the allowed list", () => {
  const unexplained = [];
  for (const f of files()) for (const h of proseHits(f, read(f))) if (!ALLOWED.some((a) => a.file === h.file && a.re.test(h.text))) unexplained.push(`${h.file}:${h.line}: ${h.text}`);
  assert.deepEqual(unexplained, [], "a count word is typed in copy: build it from K.pn (js/board.js) instead:\n" + unexplained.join("\n"));
});
test("every allowed entry still matches something (the list cannot go stale)", () => {
  const all = files().flatMap((f) => proseHits(f, read(f)));
  const stale = ALLOWED.filter((a) => !all.some((h) => h.file === a.file && a.re.test(h.text))).map((a) => `${a.file} ${a.re}`);
  assert.deepEqual(stale, []);
});
test("each static five in index.html is rewritten by a PARTY_COPY entry in js/board.js", () => {
  const board = read("js/board.js"), table = board.slice(board.indexOf("const PARTY_COPY = ["), board.indexOf("function partyCopy()"));
  assert.ok(table.length > 200, "PARTY_COPY table not found");
  for (const [, , selector] of STATIC) assert.ok(selector === "#sheet-title" ? /#sheet-title/.test(board.slice(board.indexOf("function partyCopy()"), board.indexOf("function partyCopy()") + 1800)) : table.includes(JSON.stringify(selector).slice(1, -1).replace(/\\"/g, '"')) || table.includes(selector), `no PARTY_COPY entry for ${selector}`);
});
test("the scan itself: it catches a typed count and lets scene ids, keys and quoted ids through", () => {
  const bad = ["`Each of the five has`", "'Meet the other four at the meeting point'", '"All five"', "`Back to The five`", "text: `the five of us`"];
  for (const b of bad) assert.equal(proseHits("x.js", b).length, 1, b);
  const fine = ['go("five")', "{ five: 1 }", "`#five.party`", "data-scene=\"five\"", "`five.${slug}`", "const t = $('#tab-five')", "id=\"tt-five\"", "(timeline|five|roads)", "/* the five */", "// the five", "x.five(1)"];
  for (const g of fine) assert.equal(proseHits("x.js", g).length, 0, g);
});
test("js/board.js has one number table and the other scene files do not carry one", () => {
  const tables = files().filter((f) => /\.js$/.test(f)).filter((f) => /\[\s*"(?:no|zero|)"\s*,\s*"one"\s*,\s*"two"\s*,\s*"three"/.test(read(f)));
  assert.deepEqual(tables, ["js/board.js"], "a second words-for-numbers table: use K.pn.say(n)");
});
