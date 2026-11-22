// Which characters the board's fonts can draw, read from the fonts themselves (the `cmap` table inside each WOFF2 in fonts/).
// A character no card font has would be drawn by whatever system font the machine offers, or as an empty box ("tofu") when none has it,
// and DevTools then reports the card's own font, so the render check alone cannot see the box. render.mjs and the unit test therefore refuse
// any card whose text holds a character that is not in EVERY card font (the fonts are latin subsets with near-identical coverage, so the
// intersection is simple and safe; the text-transform lowercase of each character is checked too).
// Node only (node:zlib brotli). WOFF2: https://www.w3.org/TR/WOFF2/ (table directory, one brotli stream, cmap is never transformed).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CARD_FONTS = ["alegreya-latin.woff2", "alegreya-italic-latin.woff2", "alegreya-sans-sc-500-latin.woff2", "alegreya-sans-sc-700-latin.woff2", "grenze-gotisch-latin.woff2"];

function base128(b, at) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const byte = b[at.i++];
    if (i === 0 && byte === 0x80) throw new Error("WOFF2: UIntBase128 with a leading zero");
    v = v * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return v;
  }
  throw new Error("WOFF2: UIntBase128 longer than 5 bytes");
}

/** The set of code points the font's cmap maps to a glyph other than .notdef. */
export function woff2Coverage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.toString("latin1", 0, 4) !== "wOF2") throw new Error("not a WOFF2 file");
  if (b.toString("latin1", 4, 8) === "ttcf") throw new Error("WOFF2 font collections are not supported");
  const numTables = b.readUInt16BE(12);
  const compressed = b.readUInt32BE(20);
  const at = { i: 48 };
  const tables = [];
  for (let t = 0; t < numTables; t++) {
    const flags = b[at.i++];
    const index = flags & 0x3f;
    const version = flags >> 6;
    let tag = null;
    if (index === 63) { tag = b.toString("latin1", at.i, at.i + 4); at.i += 4; }
    const orig = base128(b, at);
    // glyf (10) and loca (11) are transformed unless version 3; hmtx (3) is transformed when version 1; every other table never is.
    const transformed = index === 10 || index === 11 ? version !== 3 : index === 3 ? version === 1 : false;
    const length = transformed ? base128(b, at) : orig;
    tables.push({ index, tag, length });
  }
  const data = zlib.brotliDecompressSync(b.subarray(at.i, at.i + compressed));
  let off = 0;
  let cmap = null;
  for (const t of tables) {
    if (t.index === 0 || t.tag === "cmap") { cmap = data.subarray(off, off + t.length); break; }
    off += t.length;
  }
  if (!cmap) throw new Error("WOFF2 has no cmap table");
  const n = cmap.readUInt16BE(2);
  const subtables = [];
  for (let i = 0; i < n; i++) subtables.push({ platform: cmap.readUInt16BE(4 + i * 8), encoding: cmap.readUInt16BE(6 + i * 8), offset: cmap.readUInt32BE(8 + i * 8) });
  const pick = (p, e, fmt) => subtables.find((s) => s.platform === p && s.encoding === e && cmap.readUInt16BE(s.offset) === fmt);
  const sub = pick(3, 10, 12) || pick(0, 4, 12) || pick(0, 6, 12) || pick(3, 1, 4) || pick(0, 3, 4);
  if (!sub) throw new Error("WOFF2 cmap has no Unicode subtable of format 4 or 12");
  const set = new Set();
  const s = sub.offset;
  if (cmap.readUInt16BE(s) === 12) {
    const groups = cmap.readUInt32BE(s + 12);
    for (let g = 0; g < groups; g++) {
      const start = cmap.readUInt32BE(s + 16 + g * 12), end = cmap.readUInt32BE(s + 20 + g * 12), glyph = cmap.readUInt32BE(s + 24 + g * 12);
      for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) set.add(c);
    }
    return set;
  }
  const segs = cmap.readUInt16BE(s + 6) / 2;
  const ends = s + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
  for (let i = 0; i < segs; i++) {
    const end = cmap.readUInt16BE(ends + i * 2), start = cmap.readUInt16BE(starts + i * 2);
    const delta = cmap.readInt16BE(deltas + i * 2), range = cmap.readUInt16BE(ranges + i * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph;
      if (range === 0) glyph = (c + delta) & 0xffff;
      else {
        const g = cmap.readUInt16BE(ranges + i * 2 + range + (c - start) * 2);
        glyph = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (glyph !== 0) set.add(c);
    }
  }
  return set;
}

let cached = null;
/** Code points every card font can draw (the intersection over CARD_FONTS). */
export function cardCoverage() {
  if (cached) return cached;
  const sets = CARD_FONTS.map((f) => woff2Coverage(fs.readFileSync(path.join(ROOT, "fonts", f))));
  cached = new Set([...sets[0]].filter((c) => sets.every((s) => s.has(c))));
  return cached;
}

// Whitespace the layout collapses or breaks on is not drawn with a glyph.
const LAYOUT = new Set([0x09, 0x0a, 0x0d, 0x20]);
/** Every character in the strings of `value` (walked deeply) that some card font cannot draw, as "U+XXXX c" labels, sorted and unique. */
export function uncoveredChars(value) {
  const cover = cardCoverage();
  const bad = new Set();
  const visit = (v) => {
    if (typeof v === "string") {
      for (const ch of v + v.toLowerCase()) {
        const c = ch.codePointAt(0);
        if (!LAYOUT.has(c) && !cover.has(c)) bad.add(c);
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return [...bad].sort((a, b) => a - b).map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")} ${String.fromCodePoint(c)}`);
}
