// js/crest.js: every one of the nine classes has a crest address that needs no request that can 404. No network, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/crest.js"), "utf8"), { window: win });
const C = win.BoardCrest;
const NINE = ["druid", "priest", "paladin", "mage", "warlock", "hunter", "rogue", "shaman", "warrior"];

test("all nine classes are known", () => assert.deepEqual([...C.CLASS_KEYS].sort(), [...NINE].sort()));

test("ART lists exactly the crests that exist in img/crests/", () => {
  const onDisk = fs.readdirSync(path.join(ROOT, "img/crests")).filter((f) => /^[a-z]+\.png$/.test(f)).map((f) => f.slice(0, -4)).sort();
  assert.deepEqual([...C.ART].sort(), onDisk);
});

test("every class gets an address that cannot 404: a file that exists, or an inline data: SVG", () => {
  for (const k of NINE) {
    const s = C.src(k);
    if (C.hasArt(k)) { assert.equal(s, `img/crests/${k}.png`); assert.ok(fs.existsSync(path.join(ROOT, s)), s); }
    else assert.match(s, /^data:image\/svg\+xml,/, `${k} falls back to the medallion`);
  }
});

test("all nine classes have painted art, each with a 320 px WebP variant and a pin", () => {
  assert.deepEqual(NINE.filter((k) => !C.hasArt(k)), []);
  for (const k of NINE) for (const f of [`img/crests/${k}.png`, `img/crests/${k}.w320.webp`, `img/vector/pin-${k}.webp`]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test("the medallion is a well-formed SVG with the class colour and initial, per class", () => {
  const seen = new Set();
  for (const k of NINE) {
    const svg = C.medallion(k);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/);
    assert.ok(svg.endsWith("</svg>"));
    assert.equal((svg.match(/<(circle|path|text|stop|linearGradient|radialGradient|defs)\b/g) || []).length, (svg.match(/<\/(text|linearGradient|radialGradient|defs)>|\/>/g) || []).length, "tags balance");
    assert.ok(svg.includes(`>${k === "druid" ? "D" : k[0].toUpperCase()}</text>`), `${k} initial`);
    assert.ok(!/<script|on\w+=|href=/i.test(svg), "nothing active in it");
    const decoded = decodeURIComponent(C.fallback(k).replace(/^data:image\/svg\+xml,/, ""));
    assert.equal(decoded, svg, "the data URI round-trips");
    seen.add(svg);
  }
  assert.equal(seen.size, NINE.length, "each class draws a different medallion");
});

test("an unknown or hostile class key gets the neutral medallion and never a path", () => {
  for (const k of [undefined, null, "", "bard", "../../x", "Warrior", "war rior", 5, "x".repeat(40)]) {
    const s = C.src(k);
    assert.match(s, /^data:image\/svg\+xml,/, String(k));
    assert.ok(!s.includes(".."), String(k));
  }
  assert.ok(C.medallion("bard").includes(">?</text>"));
});

test("guard() swaps in the medallion once when a crest image fails", () => {
  let handler = null; const img = { tagName: "IMG", src: "img/crests/x.png", addEventListener: (t, f, o) => { assert.equal(t, "error"); assert.equal(JSON.stringify(o), "{\"once\":true}"); handler = f; } };
  C.guard(img, "warrior"); handler();
  assert.equal(img.src, C.fallback("warrior"));
  const attrs = {}; const svgImg = { tagName: "image", addEventListener: (t, f) => { handler = f; }, setAttribute: (k, v) => { attrs[k] = v; } };
  C.guard(svgImg, "rogue"); handler();
  assert.equal(attrs.href, C.fallback("rogue"));
});

test("no site code builds a crest path by hand any more (all go through BoardCrest.src or crestSrc)", () => {
  const files = ["js/board.js", "js/shell.js", "js/seals.js", "scenes/decide.js", "scenes/place.js", "scenes/sheet.js", "atlas/atlas.js"];
  for (const f of files) {
    const hits = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /`img\/crests\/\$\{/.test(l) && !/BoardCrest|crestSrc|probe\(|const crestSrc/.test(l));
    assert.deepEqual(hits.map(([n]) => `${f}:${n}`), []);
  }
});
