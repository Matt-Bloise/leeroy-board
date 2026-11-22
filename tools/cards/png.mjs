// A small PNG decoder for the card renderer and its CI check. Decoded pixels, not PNG bytes, are what the cards promise: two clean CI runs must
// give identical decoded pixels (docs/runbooks/card-images.md). The bytes may differ between runs because the encoder's deflate is free to pick
// other matches; the pixels may not. So every hash and every comparison here is over decoded RGBA.
//
// Supports what Chromium writes for a screenshot and what any tool might commit for a card: 8-bit samples, colour types 0 (grey), 2 (RGB),
// 3 (palette, with tRNS), 4 (grey and alpha) and 6 (RGBA), filter types 0 to 4, no interlacing. Anything else throws: a card in another shape
// is a mistake, and a decoder that guessed would hide it. Node only (node:zlib, node:crypto); never bundled into the Worker.
import zlib from "node:zlib";
import crypto from "node:crypto";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// A committed card is held to more than "decodes": what a viewer shows must be exactly what this decoder reads. Ancillary chunks can change
// that without changing IDAT: an animation (acTL, fcTL, fdAT) shows other frames, tRNS makes a colour transparent, gAMA, cHRM, iCCP and sRGB
// change colours. So a committed card may hold IHDR, IDAT and IEND only, in RGB or RGBA, and nothing after IEND (encodePng writes exactly that).
export const STRICT_CHUNKS = Object.freeze(["IHDR", "IDAT", "IEND"]);

/** Decode a PNG buffer to { width, height, rgba } (rgba: Uint8Array, 4 bytes per pixel, rows top to bottom). Throws on anything unsupported.
 *  { strict: true }: also throws on any chunk other than IHDR, IDAT and IEND, a colour type other than RGB or RGBA, or bytes after IEND. */
export function decodePng(buf, { strict = false } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG (bad signature)");
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    if (off + 12 + len > b.length) throw new Error(`PNG chunk ${type} runs past the end of the file`);
    const data = b.subarray(off + 8, off + 8 + len);
    const crc = b.readUInt32BE(off + 8 + len);
    if (zlib.crc32 && (zlib.crc32(b.subarray(off + 4, off + 8 + len)) >>> 0) !== crc) throw new Error(`PNG chunk ${type} has a bad CRC`);
    off += 12 + len;
    if (strict && !STRICT_CHUNKS.includes(type)) throw new Error(`PNG chunk ${type} is not allowed in a committed card (IHDR, IDAT and IEND only)`);
    if (type === "IHDR") {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], compression: data[10], filter: data[11], interlace: data[12] };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") { ended = true; break; }
  }
  if (!ihdr) throw new Error("PNG has no IHDR");
  if (!ended) throw new Error("PNG has no IEND (truncated)");
  if (strict && off !== b.length) throw new Error(`PNG has ${b.length - off} bytes after IEND`);
  if (strict && ihdr.color !== 2 && ihdr.color !== 6) throw new Error(`PNG colour type ${ihdr.color} is not allowed in a committed card (RGB or RGBA only)`);
  const { width, height, depth, color, compression, filter, interlace } = ihdr;
  if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) throw new Error(`PNG size ${width}x${height} is out of range`);
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
  if (!(color in CHANNELS)) throw new Error(`PNG colour type ${color} is not supported`);
  if (compression !== 0 || filter !== 0) throw new Error("PNG uses an unknown compression or filter method");
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (color === 3 && !palette) throw new Error("palette PNG without PLTE");
  const channels = CHANNELS[color];
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error(`PNG image data is ${raw.length} bytes, expected ${(stride + 1) * height}`);
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const up = y > 0 ? px[prev + x] : 0;
      const c = y > 0 && x >= channels ? px[prev + x - channels] : 0;
      let out;
      if (ft === 0) out = v;
      else if (ft === 1) out = v + a;
      else if (ft === 2) out = v + up;
      else if (ft === 3) out = v + ((a + up) >> 1);
      else if (ft === 4) out = v + paeth(a, up, c);
      else throw new Error(`PNG row ${y} has unknown filter type ${ft}`);
      px[dst + x] = out & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    if (color === 6) { rgba[j] = px[i * 4]; rgba[j + 1] = px[i * 4 + 1]; rgba[j + 2] = px[i * 4 + 2]; rgba[j + 3] = px[i * 4 + 3]; }
    else if (color === 2) { rgba[j] = px[i * 3]; rgba[j + 1] = px[i * 3 + 1]; rgba[j + 2] = px[i * 3 + 2]; rgba[j + 3] = 255; }
    else if (color === 0) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[i]; rgba[j + 3] = 255; }
    else if (color === 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[i * 2]; rgba[j + 3] = px[i * 2 + 1]; }
    else {
      const k = px[i];
      if (k * 3 + 2 >= palette.length) throw new Error(`PNG palette index ${k} is out of range`);
      rgba[j] = palette[k * 3]; rgba[j + 1] = palette[k * 3 + 1]; rgba[j + 2] = palette[k * 3 + 2];
      rgba[j + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, rgba };
}

/** sha256 (hex) of the decoded pixels: a fixed header with the size, then the RGBA bytes. Independent of how the PNG was encoded. */
export function pixelHash(decoded) {
  const { width, height, rgba } = decoded;
  return crypto.createHash("sha256").update(`rgba8 ${width}x${height}\n`).update(rgba).digest("hex");
}

/** Convenience: decode and hash a PNG buffer. */
export const pngPixelHash = (buf) => pixelHash(decodePng(buf));

// ---- encoder -------------------------------------------------------------------------------------------------------------------------
// Chromium's own PNG is larger than it needs to be (fast deflate). The committed cards are re-encoded here: RGB when every pixel is opaque
// (RGBA otherwise), filter type None on every row, deflate level 9. Measured on 12 cards (Nov 22): None gave 750 KiB against 958 KiB for the
// usual per-row choice by smallest sum of absolute differences, because flat colour and repeated glyphs are long literal matches for deflate
// that the Sub/Up/Paeth residues break up. The decoded pixels are unchanged by construction, and encodePng checks that by decoding its output.
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode { width, height, rgba } as a PNG Buffer. Lossless; throws if its own output does not decode to the same pixels. */
export function encodePng(decoded) {
  const { width, height, rgba } = decoded;
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4;
  const stride = width * ch;
  const raw = Buffer.alloc(stride * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += ch) {
    raw[j] = rgba[i]; raw[j + 1] = rgba[i + 1]; raw[j + 2] = rgba[i + 2];
    if (ch === 4) raw[j + 3] = rgba[i + 3];
  }
  const out = Buffer.alloc((stride + 1) * height); // each row: filter byte 0 (None), then the row's samples
  for (let y = 0; y < height; y++) raw.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(out, { level: 9, memLevel: 9 })), chunk("IEND", Buffer.alloc(0))]);
  if (pixelHash(decodePng(png)) !== pixelHash(decoded)) throw new Error("encodePng: the re-encoded PNG does not decode to the same pixels");
  return png;
}

/** Count differing pixels between two decoded images of the same size (Infinity when the sizes differ), and the largest channel difference. */
export function pixelDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { pixels: Infinity, maxDelta: 255 };
  let pixels = 0, maxDelta = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.rgba[i + c] - b.rgba[i + c]));
    if (d) { pixels++; if (d > maxDelta) maxDelta = d; }
  }
  return { pixels, maxDelta };
}
