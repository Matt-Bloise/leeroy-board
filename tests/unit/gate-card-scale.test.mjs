// B59: the first-visit card must fill at least 25 percent of its parchment at ultra-wide sizes in every engine (production run 41817101970: WebKit read 2.9 to 5.7 percent at 3440x1440, 3840x2160, 5120x1440).
// Cause: the card was scaled with CSS `zoom`, and WebKit (Safari 18.2) reports a box under zoom at its unzoomed size. The card is now scaled with a multiplier on its own sizes, and the sweep measures with the zoom-aware helper.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const css = fs.readFileSync(path.join(root, "css/fit.css"), "utf8");
const sweep = fs.readFileSync(path.join(root, "tests/browser/layout-sweep.mjs"), "utf8");
const cardRules = css.split("\n").filter((l) => /\.nx-fr2/.test(l) && /min-width:\s*2400px|--gz|#scene \.nx-fr2/.test(l));

test("the first-visit card is not scaled with CSS zoom", () => {
  assert.ok(cardRules.length >= 4, "the card's ultra-wide rules are found");
  assert.deepEqual(css.match(/\.nx-fr2[^{]*\{[^}]*\bzoom\s*:/g) || [], []);
});
test("the card grows in four steps by window height through --gz (2.6, 3.2, 3.9, 4.6)", () => {
  for (const [h, z] of [[1300, "2.6"], [1900, "3.2"], [2600, "3.9"], [3800, "4.6"]]) {
    assert.ok(new RegExp(`min-height:\\s*${h}px\\)[^{]*\\{[^}]*--gz:\\s*${z.replace(".", "\\.")}`).test(css), `step ${h}px -> ${z}`);
  }
  assert.match(css, /--step-0:\s*calc\(1\.0625rem \* var\(--gz\)\)/);
  assert.match(css, /--step-1:\s*calc\(1\.3rem \* var\(--gz\)\)/);
  assert.match(css, /min-height:\s*calc\(48px \* var\(--gz\)\)/);
});
test("the sweep measures the fill with the zoom-aware helper (window.__lz.rect), not raw getBoundingClientRect", () => {
  const i = sweep.indexOf("const measureGate");
  const body = sweep.slice(i, sweep.indexOf("\n  });", i));
  assert.match(body, /window\.__lz\.rect\(card\)/);
  assert.match(body, /window\.__lz\.rect\(box\)/);
  assert.ok(!/card\.getBoundingClientRect|box\.getBoundingClientRect/.test(body));
});

// Follow-up (production run 41829291747): WebKit still read the card at 18.5 to 22.2 percent, so the steps were raised (1.85/2.3/2.8/3.2 -> 2.6/3.2/3.9/4.6).
// And WebKit tile-clip at 2560px and wider: the wall tile bodies carried zoom: 1.4 (board.css, min-width 2200px), which WebKit measures at the unzoomed size, so the text looked outside its tile.
const board = fs.readFileSync(path.join(root, "css/board.css"), "utf8");
test("wall tile bodies are not scaled with CSS zoom at 2200px and wider", () => {
  assert.deepEqual(board.match(/\.tile-body[^{]*\{[^}]*\bzoom\s*:/g) || [], []);
});
test("the 1.4 scale is applied to the tile body's own type, padding and gaps through --tz", () => {
  assert.match(board, /--tz:\s*1\.4/);
  assert.match(board, /\.tile-body \{ font-size: calc\(max\(var\(--fs-small\), 0\.88rem\) \* var\(--tz\)\)/);
  assert.match(board, /\.mini b \{ font-size: calc\(var\(--step-1\) \* var\(--tz\)\)/);
});
