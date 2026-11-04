// B49 (2026-11-03): from 24 h before launch (Nov 4 2026 6 PM ET = 23:00Z) #launch-hero sits in #top in normal flow, so the first-visit document grew to 1835px in a 860x360 window
// and the layout sweep invariant doc-fit failed on production. The fix clamps #board while the first-visit sheet is open; CI now sweeps the gate at three faked clocks (--clock).
// The browser proof is tests/browser/layout-sweep.mjs --states gate --clock <iso>; this file pins the pieces that proof depends on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClock, applyClock, expectedHero, LAUNCH_CLOCKS } from "../helpers/clock-arg.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const LAUNCH = Date.parse("2026-11-04T23:00:00Z"), HOUR = 3600e3;

test("the three CI clocks sit before T-24h, inside the hero window before launch, and after launch (hero live)", () => {
  const t = Object.fromEntries(Object.entries(LAUNCH_CLOCKS).map(([k, v]) => [k, Date.parse(v)]));
  assert.ok(t.before < LAUNCH - 24 * HOUR, "before: no hero yet");
  assert.ok(t.hero > LAUNCH - 24 * HOUR && t.hero < LAUNCH, "hero: countdown phase");
  assert.ok(t.after > LAUNCH + 12 * HOUR && t.after < LAUNCH + 24 * HOUR, "after: live phase, hero still shown, and past the 12 h the page opens on the wall (no first-visit sheet inside it)");
  assert.ok(t.before < LAUNCH - 1 * HOUR && t.hero < LAUNCH - 1 * HOUR, "before and hero: outside the T-1h wall window");
  assert.match(read("js", "v15.js"), /heroBefore: 24 \* HOUR, heroAfter: 24 \* HOUR, openBefore: 1 \* HOUR, openAfter: 12 \* HOUR/, "the hero window these clocks are chosen for");
});

test("the board is clamped to the window only while the first-visit sheet itself is the open scene", () => {
  const rule = read("css", "v15.css").split(/\r?\n/).find((l) => l.includes("scene-open") && l.includes("#board") && l.startsWith("html.nx-first-run")) || "";
  assert.ok(rule, "rule exists");
  // nx-first-run stays on for a first-run visitor who closed the sheet (js/next.js firstRun: peek is not set by X or Esc, nor on the wall from T-1h), so the selector must also need the tonight tab selected (js/board.js selectPanel sets aria-selected before any other tile shows)
  assert.match(rule, /^html\.nx-first-run\.scene-open:has\(#tab-tonight\[aria-selected="true"\]\) #board \{/, "narrowed to the first-visit panel");
  assert.match(rule, /max-height: 100svh/);
  assert.match(rule, /overflow: clip/);
  assert.ok(!/launch-hero/.test(rule), "the hero itself is untouched, so it looks the same once the sheet is closed");
  assert.ok(!read("css", "v15.css").split(/\r?\n/).some((l) => /^html\.nx-first-run\.scene-open #board/.test(l)), "the broad selector (any open scene for a first-run visitor) is gone");
  assert.match(read("js", "board.js"), /aria-selected", String\(on\)/, "board.js still sets aria-selected on the tabs in selectPanel");
});

test("the launch hero is not rendered while the wall is cold, and its coin and picture load only when the wall warms", () => {
  assert.ok(read("css", "v15.css").split(/\r?\n/).includes("html.wall-cold #launch-hero { display: none; }"), "hidden while html.wall-cold (tests/browser/first-load-weight.mjs: no covered-wall art before the first tap)");
  assert.match(read("js", "v15.js"), /class: "lh-art"[^\n]*loading: "lazy"/, "the plate picture is lazy");
  assert.match(read("js", "seals.js"), /K\.wallCold && K\.wallCold\(\) && K\.whenSettled\) K\.whenSettled\(putMedal\)/, "a coin made while the wall is cold loads its medal on settle");
});

test("the checklist summary has a real dark background under its cream text, so axe measures the plank the visitor sees", () => {
  const css = read("css", "v15.css").split(/\r?\n/);
  assert.ok(css.includes(".lh-check-sum { background-color: var(--oak-2); background-clip: content-box; }"), "dark colour under the text only");
  assert.match(read("css", "kit.css"), /\.lh-check-sum\)\{[^}]*color:var\(--cream\)[^}]*border-image:url\("\.\.\/img\/kit\/dc-row-c\.webp"\) 20 10 20 76 fill/, "kit.css still paints the summary as a dark plank with cream text (the colour sits under its fill)");
});

test("expectedHero follows the hero window (T-24h to T+24h)", () => {
  for (const [iso, want] of [["2026-11-03T22:59:59Z", ""], ["2026-11-03T23:00:00Z", "soon"], ["2026-11-04T22:59:59Z", "soon"], ["2026-11-04T23:00:00Z", "live"], ["2026-11-05T22:59:59Z", "live"], ["2026-11-05T23:00:00Z", ""]]) assert.equal(expectedHero(new Date(iso)), want, iso);
  assert.deepEqual(Object.values(LAUNCH_CLOCKS).map((v) => expectedHero(new Date(v))), ["", "soon", "live"]);
});

test("--clock parsing", () => {
  assert.equal(parseClock(["--url", "x"]), null);
  assert.equal(parseClock(["--clock", "2026-11-04T10:00:00Z"]).toISOString(), "2026-11-04T10:00:00.000Z");
  assert.equal(parseClock(["--clock", "2026-11-04T18:00:00-05:00"]).toISOString(), "2026-11-04T23:00:00.000Z");
  assert.throws(() => parseClock(["--clock"]), /needs an ISO time/);
  assert.throws(() => parseClock(["--clock", "--engine", "webkit"]), /needs an ISO time/);
  assert.throws(() => parseClock(["--clock", "tomorrow"]), /ISO 8601/);
  assert.throws(() => parseClock(["--clock", "2026-11-04T10:00:00"]), /with a zone/);
  assert.throws(() => parseClock(["--clock", "2026-13-45T10:00:00Z"]), /not a real date/);
});

test("applyClock installs the clock only when one is given", async () => {
  const calls = [], page = { clock: { install: async (o) => calls.push(o) } };
  await applyClock(page, null);
  assert.equal(calls.length, 0);
  const d = new Date("2026-11-04T10:00:00Z");
  await applyClock(page, d);
  assert.deepEqual(calls, [{ time: d }]);
});

test("both suites accept --clock and the CI runs sweep the first-visit gate at all three clocks, in the PR run and in the scheduled cross-engine run", () => {
  for (const f of ["layout-sweep.mjs", "live-smoke.mjs", "first-load-weight.mjs"]) assert.match(read("tests", "browser", f), /parseClock\(argv\)[\s\S]*applyClock\(page, CLOCK\)/, f);
  for (const f of ["cross-engine.yml", "preview-tests.yml"]) {
    const y = read(".github", "workflows", f), step = y.split(/\r?\n/).filter((l) => l.includes("--clock") || l.includes("for clock in")).join("\n");
    for (const c of Object.values(LAUNCH_CLOCKS)) assert.ok(step.includes(c), `${f} runs the sweep at ${c}`);
    assert.match(y, /layout-sweep\.mjs[^\n]*--states gate --clock/, `${f}: gate state only, so the extra cost stays small`);
    assert.ok(!/--live-api/.test(step), `${f}: the clock runs answer the API from fixtures`);
    assert.match(y, /first-load-weight\.mjs[^\n]*--clock/, `${f}: the covered-wall art rule runs at the faked clocks`);
    assert.match(y, /--states gate --clock[^\n]*--budget-min 2/, `${f}: each clock sweep is capped at 2 minutes`);
    assert.ok(!/report-[^\n]*\$clock[^\n]*\.json/.test(y.replace(/\$\{clock\/\/:\/\}/g, "")), `${f}: no colon may reach an artifact file name`);
  }
});
