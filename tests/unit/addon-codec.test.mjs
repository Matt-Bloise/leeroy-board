// Unit tests for the WoW add-on export codec. The Lua codec (addon/LeeroyBuild/LeeroyBuild_Codec.lua) cannot be run
// in CI, so this file holds a line-for-line JS twin of it and checks the twin against independent references
// (the zlib trailer, a closed-form Adler-32, a published vector). It also pins the Lua source to the twin's constants.
// Run: node --test tests/unit/addon-codec.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";

const root = new URL("../../addon/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("vectors.json", root), "utf8"));
const luaSrc = readFileSync(new URL("LeeroyBuild/LeeroyBuild_Codec.lua", root), "utf8");

// ---- JS twin of LeeroyBuild_Codec.lua (same structure, same arithmetic; strings are byte arrays like Lua strings) ----
const TAG = "LEEROY1";
const KEY_ORDER = ["v", "iface", "t", "name", "class", "race", "level", "prof", "talents", "zone"];
const bytes = (s) => Buffer.from(String(s), "utf8");
const hex = (n, width) => n.toString(16).padStart(width, "0");

function escape(value) {
  const s = bytes(value);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let piece;
    if (c === 37) piece = "%25";
    else if (c === 59) piece = "%3B";
    else if (c === 61) piece = "%3D";
    else if (c === 124) piece = "%7C";
    else if (c === 10) piece = "%0A";
    else if (c < 32 || c > 126) piece = "%" + hex(c, 2).toUpperCase();
    else piece = String.fromCharCode(c);
    out.push(piece);
  }
  return out.join("");
}

function adler32(s) {
  let a = 1, b = 0;
  for (let i = 0; i < s.length; i++) {
    a = (a + s[i]) % 65521;
    b = (b + a) % 65521;
  }
  return [a, b];
}

function check(s) {
  const [a, b] = adler32(bytes(s));
  return hex(b, 4) + hex(a, 4);
}

function payload(values) {
  const parts = [];
  for (const key of KEY_ORDER) {
    let v = values[key];
    if (v !== undefined && v !== null) {
      v = String(v);
      if (v !== "") parts.push(key + "=" + escape(v));
    }
  }
  return parts.join(";");
}

const wrap = (p) => TAG + "|" + p + "|" + check(p);
const encode = (values) => wrap(payload(values));
// ---- end twin ----

const zlibAdler = (s) => zlib.deflateSync(Buffer.from(s)).subarray(-4).toString("hex");

// Independent closed form: a = 1 + sum(d_i); b = n + sum((n - i) * d_i), i from 0.
function closedForm(buf) {
  const n = BigInt(buf.length);
  let sum = 0n, weighted = 0n;
  buf.forEach((d, i) => { sum += BigInt(d); weighted += (n - BigInt(i)) * BigInt(d); });
  const a = (1n + sum) % 65521n;
  const b = (n + weighted) % 65521n;
  return hex(Number(b), 4) + hex(Number(a), 4);
}

test("Adler-32 twin matches the published Wikipedia vector", () => {
  assert.equal(check("Wikipedia"), "11e60398");
});

test("golden vector 1: check equals zlib trailer and closed form", () => {
  const v = vectors.vectors[0];
  const built = payload({ v: 1, iface: 16001, t: 1794000000, class: "PALADIN", race: "Human", level: 40 });
  assert.equal(built, v.payload);
  assert.equal(check(v.payload), zlibAdler(v.payload));
  assert.equal(check(v.payload), closedForm(bytes(v.payload)));
  assert.equal(v.check, check(v.payload));
  assert.equal(wrap(v.payload), v.string);
  assert.match(v.check, /^[0-9a-f]{8}$/);
});

test("check matches zlib for random byte strings and long inputs (exercises the modulo)", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let n = 0; n < 200; n++) {
    const len = 1 + (rnd() % 6000);
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = rnd() % 256;
    const [a, b] = adler32(buf);
    assert.equal(hex(b, 4) + hex(a, 4), zlib.deflateSync(buf).subarray(-4).toString("hex"));
  }
  const big = Buffer.alloc(200000, 255);
  const [a, b] = adler32(big);
  assert.equal(hex(b, 4) + hex(a, 4), zlibAdler(big));
});

test("golden vector 2: escapes", () => {
  const v = vectors.vectors[1];
  assert.equal(escape(v.value), v.escaped);
  assert.equal(escape("A;b=c"), "A%3Bb%3Dc");
  assert.equal(decodeURIComponent(escape("A;b=c")), "A;b=c");
  assert.equal(escape("a|b%c\nd"), "a%7Cb%25c%0Ad");
});

test("ASCII-only wire: bytes above 126 and control bytes become %XX of the UTF-8 bytes", () => {
  assert.equal(escape("é"), "%C3%A9");
  assert.equal(escape("über"), "%C3%BCber");
  assert.equal(escape("\x7f"), "%7F");
  assert.equal(escape("\t"), "%09");
  const wire = encode({ v: 1, iface: 16001, t: 1, name: "Zöe;=|%\n", class: "MAGE", race: "Gnome", level: 1 });
  assert.match(wire, /^[\x20-\x7e]+$/);
  assert.equal(decodeURIComponent(escape("Zöe;=|%\n")), "Zöe;=|%\n");
});

test("fixed key order, absent keys omitted, empty values omitted", () => {
  const p = payload({ zone: "Durotar", level: 12, v: 1, class: "WARRIOR", race: "Orc", t: 5, iface: 16001, prof: "164:75,333:30", talents: "", extra: "x", name: "Thrall" });
  assert.equal(p, "v=1;iface=16001;t=5;name=Thrall;class=WARRIOR;race=Orc;level=12;prof=164:75,333:30;zone=Durotar");
  assert.equal(payload({ v: 1, iface: 16001, t: 5 }), "v=1;iface=16001;t=5");
});

test("tamper: changing one payload character changes the check", () => {
  const v = vectors.vectors[0];
  const tampered = v.payload.replace("level=40", "level=41");
  assert.notEqual(check(tampered), v.check);
  const swapped = v.payload.replace("PALADIN", "PALADIM");
  assert.notEqual(check(swapped), v.check);
});

test("wire length for a full export stays far below 2048", () => {
  const wire = encode({ v: 1, iface: 16001, t: 1794000000, name: "Abcdefghijkl", class: "PALADIN", race: "NightElf", level: 60, prof: "164:300,333:300", talents: "31,20,0", zone: "Stranglethorn Vale" });
  assert.ok(wire.length < 400, String(wire.length));
});

test("Lua source is pinned to the twin: tag, key order, modulus, no bit/5.2 constructs", () => {
  const order = KEY_ORDER.map((k) => `"${k}"`).join(", ");
  assert.ok(luaSrc.includes(`Codec.KEY_ORDER = { ${order} }`), "key order differs from twin");
  assert.ok(luaSrc.includes(`Codec.TAG = "${TAG}"`));
  assert.equal((luaSrc.match(/% 65521/g) || []).length, 2);
  assert.ok(luaSrc.includes('string.format("%04x%04x", b, a)'));
  for (const piece of ['c == 37 then piece = "%25"', 'c == 59 then piece = "%3B"', 'c == 61 then piece = "%3D"', 'c == 124 then piece = "%7C"', 'c == 10 then piece = "%0A"', "c < 32 or c > 126"]) {
    assert.ok(luaSrc.includes(piece), piece);
  }
  assert.ok(!/\bbit\./.test(luaSrc));
});

test("level above 60 is encoded as the real integer (the importer rejects it, not the add-on)", () => {
  assert.equal(payload({ v: 1, iface: 16001, t: 1, class: "MAGE", race: "Gnome", level: 61 }), "v=1;iface=16001;t=1;class=MAGE;race=Gnome;level=61");
});
