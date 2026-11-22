// PNG decode and encode with node:zlib only (no dependency), for the visual baseline gate (tests/browser/visual-baseline.mjs).
// The comparison is done here in Node, on the exact bytes of the files, so no browser colour management or canvas premultiplication can move a pixel.
//   decodePng(buf)                 -> { width, height, data }   data: Uint8Array RGBA, 4 bytes a pixel, row after row
//   encodePng({ width, height, data })  -> Buffer (8-bit RGBA, filter 0 on every row)
// Decodes 8-bit greyscale, RGB, palette, grey+alpha and RGBA, non-interlaced: what Chromium, WebKit and Firefox screenshots are. Anything else throws.
import { inflateSync, deflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG file (bad signature)");
  let pos = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (pos + 12 + len > buf.length) throw new Error(`PNG chunk ${type} runs past the end of the file`);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) throw new Error(`PNG chunk ${type} has a bad CRC`);
    if (type === "IHDR") ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("PNG has no IHDR chunk");
  const { width, height, depth, color, interlace } = ihdr;
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const ch = CHANNELS[color];
  if (!ch) throw new Error(`PNG colour type ${color} is not supported`);
  if (color === 3 && !palette) throw new Error("palette PNG without a PLTE chunk");
  const raw = inflateSync(Buffer.concat(idat)), stride = width * ch;
  if (raw.length < height * (stride + 1)) throw new Error(`PNG image data is short: ${raw.length} bytes for ${width}x${height}`);
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x], a = x >= ch ? px[dst + x - ch] : 0, b = y > 0 ? px[up + x] : 0, c = x >= ch && y > 0 ? px[up + x - ch] : 0;
      let out;
      if (f === 0) out = v;
      else if (f === 1) out = v + a;
      else if (f === 2) out = v + b;
      else if (f === 3) out = v + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error(`PNG row ${y} has an unknown filter ${f}`);
      px[dst + x] = out & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += ch) {
    const o = i * 4;
    if (color === 6) { data[o] = px[j]; data[o + 1] = px[j + 1]; data[o + 2] = px[j + 2]; data[o + 3] = px[j + 3]; }
    else if (color === 2) { data[o] = px[j]; data[o + 1] = px[j + 1]; data[o + 2] = px[j + 2]; data[o + 3] = 255; }
    else if (color === 0) { data[o] = data[o + 1] = data[o + 2] = px[j]; data[o + 3] = 255; }
    else if (color === 4) { data[o] = data[o + 1] = data[o + 2] = px[j]; data[o + 3] = px[j + 1]; }
    else { const k = px[j]; data[o] = palette[k * 3]; data[o + 1] = palette[k * 3 + 1]; data[o + 2] = palette[k * 3 + 2]; data[o + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return { width, height, data };
}

function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng({ width, height, data }) {
  if (!(width > 0 && height > 0) || data.length !== width * height * 4) throw new Error(`encodePng: ${data.length} bytes do not make a ${width}x${height} RGBA image`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
