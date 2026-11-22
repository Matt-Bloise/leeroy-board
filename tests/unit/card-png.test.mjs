// The PNG decoder and encoder behind the picture cards (tools/cards/png.mjs). The cards promise identical DECODED pixels between clean CI runs,
// so the decoder is the instrument of that promise: it must read every filter and colour type a card can arrive in, and refuse what it cannot read.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodePng, encodePng, pixelHash, pngPixelHash, pixelDiff } from "../../tools/cards/png.mjs";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
function ihdr(w, h, depth, color, interlace = 0) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = depth; b[9] = color; b[10] = 0; b[11] = 0; b[12] = interlace;
  return chunk("IHDR", b);
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
// Hand-built PNG with a given filter type on every row (the encoder under test only writes type 0).
function pngWithFilter(w, h, channels, color, samples, ft, extra = []) {
  const stride = w * channels;
  const rows = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (stride + 1)] = ft;
    for (let x = 0; x < stride; x++) {
      const v = samples[y * stride + x], a = x >= channels ? samples[y * stride + x - channels] : 0, b = y ? samples[(y - 1) * stride + x] : 0, c = y && x >= channels ? samples[(y - 1) * stride + x - channels] : 0;
      rows[y * (stride + 1) + 1 + x] = (ft === 0 ? v : ft === 1 ? v - a : ft === 2 ? v - b : ft === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c)) & 0xff;
    }
  }
  return Buffer.concat([SIG, ihdr(w, h, 8, color), ...extra, chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
// A deterministic pseudo-random image (no Math.random: the test must be the same on every run).
function image(w, h, opaque) {
  const rgba = new Uint8Array(w * h * 4);
  let s = 12345;
  for (let i = 0; i < rgba.length; i++) { s = (s * 1103515245 + 12345) >>> 0; rgba[i] = (s >>> 16) & 0xff; }
  if (opaque) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width: w, height: h, rgba };
}

test("encodePng round-trips opaque and translucent images exactly, as RGB and RGBA", () => {
  for (const opaque of [true, false]) {
    const img = image(37, 23, opaque);
    const png = encodePng(img);
    const back = decodePng(png);
    assert.equal(back.width, 37);
    assert.equal(back.height, 23);
    assert.deepEqual(Buffer.from(back.rgba), Buffer.from(img.rgba));
    assert.equal(png[25], opaque ? 2 : 6, "colour type: RGB when every pixel is opaque, RGBA otherwise");
    assert.equal(pixelHash(back), pixelHash(img));
  }
});

test("every PNG filter type decodes to the same pixels (Chromium and other encoders choose filters freely)", () => {
  const img = image(19, 11, true);
  const rgb = new Uint8Array(19 * 11 * 3);
  for (let i = 0, j = 0; i < img.rgba.length; i += 4, j += 3) { rgb[j] = img.rgba[i]; rgb[j + 1] = img.rgba[i + 1]; rgb[j + 2] = img.rgba[i + 2]; }
  const want = pixelHash(img);
  for (const ft of [0, 1, 2, 3, 4]) assert.equal(pngPixelHash(pngWithFilter(19, 11, 3, 2, rgb, ft)), want, `filter ${ft}`);
  const rgbaImg = image(13, 7, false);
  for (const ft of [0, 1, 2, 3, 4]) assert.equal(pngPixelHash(pngWithFilter(13, 7, 4, 6, rgbaImg.rgba, ft)), pixelHash(rgbaImg), `RGBA filter ${ft}`);
});

test("grey, grey with alpha and palette (with tRNS) decode to RGBA", () => {
  const grey = pngWithFilter(2, 1, 1, 0, Uint8Array.from([0, 200]), 1);
  assert.deepEqual([...decodePng(grey).rgba], [0, 0, 0, 255, 200, 200, 200, 255]);
  const ga = pngWithFilter(2, 1, 2, 4, Uint8Array.from([10, 20, 30, 40]), 2);
  assert.deepEqual([...decodePng(ga).rgba], [10, 10, 10, 20, 30, 30, 30, 40]);
  const plte = chunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255]));
  const trns = chunk("tRNS", Buffer.from([128]));
  const pal = pngWithFilter(3, 1, 1, 3, Uint8Array.from([0, 1, 0]), 0, [plte, trns]);
  assert.deepEqual([...decodePng(pal).rgba], [255, 0, 0, 128, 0, 0, 255, 255, 255, 0, 0, 128]);
});

test("the pixel hash ignores how the PNG was compressed", () => {
  const img = image(31, 17, true);
  const a = encodePng(img);
  const rows = Buffer.alloc((31 * 3 + 1) * 17);
  for (let y = 0; y < 17; y++) for (let x = 0; x < 31; x++) for (let c = 0; c < 3; c++) rows[y * (31 * 3 + 1) + 1 + x * 3 + c] = img.rgba[(y * 31 + x) * 4 + c];
  const b = Buffer.concat([SIG, ihdr(31, 17, 8, 2), chunk("IDAT", zlib.deflateSync(rows, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
  assert.notDeepEqual(a, b, "different bytes");
  assert.equal(pngPixelHash(a), pngPixelHash(b), "same pixels, same hash");
});

test("the pixel hash covers the size, so the same bytes in another shape are a different picture", () => {
  const rgba = new Uint8Array(4 * 6).fill(7);
  assert.notEqual(pixelHash({ width: 2, height: 3, rgba }), pixelHash({ width: 3, height: 2, rgba }));
});

test("malformed or unsupported PNGs are refused, never guessed", () => {
  const good = encodePng(image(4, 4, true));
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /signature/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 12)), /IEND|truncated|past the end/);
  const badCrc = Buffer.from(good);
  badCrc[30] ^= 0xff; // inside IHDR data
  assert.throws(() => decodePng(badCrc), /CRC/);
  const rows = Buffer.alloc((4 * 2 + 1) * 4);
  assert.throws(() => decodePng(Buffer.concat([SIG, ihdr(4, 4, 16, 0), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])), /bit depth/);
  assert.throws(() => decodePng(Buffer.concat([SIG, ihdr(4, 4, 8, 2, 1), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])), /interlaced/);
  assert.throws(() => decodePng(Buffer.concat([SIG, ihdr(4, 4, 8, 2), chunk("IDAT", zlib.deflateSync(Buffer.alloc(5))), chunk("IEND", Buffer.alloc(0))])), /expected/);
  const badFilter = Buffer.alloc((4 * 3 + 1) * 4);
  badFilter[0] = 9;
  assert.throws(() => decodePng(Buffer.concat([SIG, ihdr(4, 4, 8, 2), chunk("IDAT", zlib.deflateSync(badFilter)), chunk("IEND", Buffer.alloc(0))])), /filter type 9/);
});

test("pixelDiff counts differing pixels and reports a size mismatch as Infinity", () => {
  const a = image(5, 5, true);
  const b = { ...a, rgba: Uint8Array.from(a.rgba) };
  assert.deepEqual(pixelDiff(a, b), { pixels: 0, maxDelta: 0 });
  b.rgba[0] = (b.rgba[0] + 9) & 0xff;
  b.rgba[40] = (b.rgba[40] + 200) & 0xff;
  const d = pixelDiff(a, b);
  assert.equal(d.pixels, 2);
  assert.ok(d.maxDelta >= 9);
  assert.equal(pixelDiff(a, image(5, 6, true)).pixels, Infinity);
});

// Review finding (PR 437): the decoder reads IDAT only, so a committed card with an animation (acTL/fcTL/fdAT) or a tRNS chunk could SHOW other
// pixels than the ones its name hashes. Committed cards are therefore decoded strictly: IHDR, IDAT and IEND only.
test("strict decoding refuses every chunk that can change what a viewer shows, and bytes after IEND", () => {
  const img = image(6, 4, true);
  const good = encodePng(img);
  assert.equal(pixelHash(decodePng(good, { strict: true })), pixelHash(img), "encodePng writes a strict PNG");
  const iend = good.length - 12;
  const insert = (c) => Buffer.concat([good.subarray(0, iend), c, good.subarray(iend)]);
  const acTL = Buffer.alloc(8); acTL.writeUInt32BE(1, 0); acTL.writeUInt32BE(0, 4);
  for (const [type, data] of [["acTL", acTL], ["tRNS", Buffer.from([0, 0, 0, 0, 0, 0])], ["gAMA", Buffer.from([0, 0, 0xb1, 0x8f])], ["iCCP", Buffer.from("x\0\0")], ["sRGB", Buffer.from([0])], ["tEXt", Buffer.from("k\0v")]]) {
    const png = insert(chunk(type, data));
    assert.equal(pngPixelHash(png), pixelHash(img), `${type}: the lenient decoder still reads the same IDAT`);
    assert.throws(() => decodePng(png, { strict: true }), new RegExp(`${type} is not allowed`), type);
  }
  assert.throws(() => decodePng(Buffer.concat([good, Buffer.from("trailing")]), { strict: true }), /after IEND/);
  const plte = chunk("PLTE", Buffer.from([1, 2, 3]));
  const pal = pngWithFilter(2, 1, 1, 3, Uint8Array.from([0, 0]), 0, [plte]);
  assert.throws(() => decodePng(pal, { strict: true }), /PLTE is not allowed|colour type 3/);
});

// Second review of PR 437: strict mode must also fix the chunk ORDER. A second IHDR, or an IDAT before the IHDR, leaves the lenient decoder's
// pixels (so the hash) unchanged, while a browser shows a broken image.
test("strict decoding requires IHDR first and once, the IDATs together, and IEND last", () => {
  const img = image(6, 4, true);
  const good = encodePng(img);
  const ihdrChunk = good.subarray(8, 8 + 12 + 13);
  const idatStart = 8 + 12 + 13;
  const iendStart = good.length - 12;
  const idatChunk = good.subarray(idatStart, iendStart);
  const iendChunk = good.subarray(iendStart);
  const build = (...parts) => Buffer.concat([SIG, ...parts]);
  assert.equal(pngPixelHash(build(ihdrChunk, ihdrChunk, idatChunk, iendChunk)), pixelHash(img), "a second IHDR does not change the lenient pixels");
  assert.throws(() => decodePng(build(ihdrChunk, ihdrChunk, idatChunk, iendChunk), { strict: true }), /second IHDR/);
  assert.throws(() => decodePng(build(idatChunk, ihdrChunk, iendChunk), { strict: true }), /before IHDR/);
  assert.throws(() => decodePng(build(ihdrChunk, iendChunk), { strict: true }), /IEND does not follow IDAT/);
  assert.throws(() => decodePng(build(ihdrChunk, idatChunk, ihdrChunk, idatChunk, iendChunk), { strict: true }), /second IHDR/);
  const half = Math.floor(zlib.inflateSync(idatChunk.subarray(8, idatChunk.length - 4)).length / 2);
  assert.ok(half > 0);
  // two consecutive IDATs are legal and decode the same
  const raw = zlib.deflateSync(zlib.inflateSync(idatChunk.subarray(8, idatChunk.length - 4)));
  const a = chunk("IDAT", raw.subarray(0, 10)), c = chunk("IDAT", raw.subarray(10));
  assert.equal(pixelHash(decodePng(build(ihdrChunk, a, c, iendChunk), { strict: true })), pixelHash(img));
  assert.equal(pixelHash(decodePng(good, { strict: true })), pixelHash(img));
});
