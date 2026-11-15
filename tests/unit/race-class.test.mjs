// One helper writes "Race Class" for a member of the public party document, where race or class can be absent because the member hid it.
// The Worker has raceClass in member-model.js, the page has the same function in js/board.js (and hands it to the scenes as K.raceClass). This pins the two
// together and fails if a template that joins ${x.race} and ${x.class} by hand comes back anywhere in the Worker, the page scripts or the scenes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { raceClass } from "../../infrastructure/worker/member-model.js";
import { tonightLines } from "../../infrastructure/worker/tonight-copy.js";

const ROOT = new URL("../../", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const page = new Function(`return ${/const raceClass = ([^\n]*);\n/.exec(src("js/board.js"))[1]}`)();

test("the Worker's raceClass and the page's raceClass agree on every shape a hidden build can take", () => {
  const cases = [{ race: "Orc", class: "Mage" }, { race: "Orc" }, { class: "Mage" }, {}, { race: "", class: "" }, { race: undefined, class: "Mage" }, null, undefined];
  for (const m of cases) assert.equal(page(m), raceClass(m), JSON.stringify(m));
  assert.equal(raceClass({ race: "Orc", class: "Mage" }), "Orc Mage");
  assert.equal(raceClass({}), "Build hidden");
  assert.equal(raceClass({ race: "Orc" }), "Orc");
});

test("/tonight never says undefined for a member who hides race, class or both", () => {
  const party = { members: [{ name: "Ada", role: "tank" }, { name: "Bo", race: "Troll", role: "healer" }, { name: "Di", class: "Priest", role: "healer" }, { name: "Ed", race: "Orc", class: "Mage", role: "damage" }] };
  const text = tonightLines({ now: 1, byName: "Ada", party, signups: { entries: [] }, boardUrl: "https://x.test" }).join("\n");
  assert.ok(!/undefined|null/.test(text), text);
  assert.ok(text.includes("Ada (Build hidden)") && text.includes("Bo (Troll)") && text.includes("Di (Priest)") && text.includes("Ed (Orc Mage)"));
});

test("no template joins a member's race and class by hand any more", () => {
  const files = (dir) => readdirSync(new URL(dir, ROOT), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(`${dir}${d.name}/`) : /\.(js|mjs)$/.test(d.name) ? [`${dir}${d.name}`] : []));
  const bad = [];
  // scenes/import.js and js/characters.js show the member's OWN characters and exports (never the public party document); everything else shows the party.
  const OWN = new Set(["scenes/import.js", "js/characters.js", "js/addon-import.js"]);
  for (const f of [...files("infrastructure/worker/"), ...files("js/"), ...files("scenes/")]) {
    if (OWN.has(f)) continue;
    for (const [i, line] of src(f).split("\n").entries()) if (/\$\{[\w.]+\.race\}[ ,]+\$\{[\w.]+\.class\}/.test(line)) bad.push(`${f}:${i + 1}`);
  }
  assert.deepEqual(bad, []);
});
