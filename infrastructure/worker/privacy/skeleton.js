// Shared text-skeleton helpers for the outbound-privacy modules. Pure, no I/O.
//
// A "skeleton" is what a human reads when text is deliberately obfuscated: invisible and
// combining characters removed, every separator or punctuation mark dropped, case folded,
// lookalike letters (Cyrillic, Greek, Armenian, small caps, IPA, stroke letters, squared and
// negative-squared letters, math alphanumerics, fullwidth) folded to Latin, non-ASCII digits
// folded to 0-9. Leet digits and doubled letters are handled as extra skeleton variants.

// Zero-based starts of the contiguous 0-9 runs of Unicode decimal digits (BMP + a few).
const ND_ZEROS = [
  0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0xed0,
  0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40,
  0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0,
];

// Lookalike groups: [latin target, characters]. Applied after lower-casing.
const GROUPS = [
  ["a", "аᴀɑα"],
  ["b", "вʙβьƀɓ"],
  ["c", "сᴄϲ"],
  ["d", "ԁᴅđðɗ"],
  ["e", "еᴇεєɇ"],
  ["f", "ꜰƒ"],
  ["g", "ɡɢԍց"],
  ["h", "һʜħнђհ"],
  ["i", "іıɪιɩɨї"],
  ["j", "јᴊ"],
  ["k", "кᴋκĸ"],
  ["l", "ӏʟłɫǀ"],
  ["m", "мᴍɱ"],
  ["n", "пոɲηɴπ"],
  ["o", "оᴏοօøɵσθѳ"],
  ["p", "рᴘρ"],
  ["q", "ԛգ"],
  ["r", "гʀґ"],
  ["s", "ѕꜱςʂ"],
  ["t", "тᴛτŧʈ"],
  ["u", "υᴜμսи"],
  ["v", "ѵᴠνʋ"],
  ["w", "ѡԝᴡωա"],
  ["x", "хχ"],
  ["y", "уʏγү"],
  ["z", "ᴢʐ"],
  ["ss", "ß"],
  ["ae", "æ"],
  ["oe", "œ"],
];
const CONF = new Map();
for (const [target, chars] of GROUPS) for (const ch of chars) CONF.set(ch.codePointAt(0), target);

// Ranges whose letters run A..Z: squared, circled negative, negative squared, regional indicators.
const RANGE_STARTS = [0x1f130, 0x1f150, 0x1f170, 0x1f1e6];

const SEP_RE = /\s/u;
const INVIS_RE = /[\p{Cf}\p{Mn}\p{Me}\p{Cc}\p{Co}\p{Cn}⠀ㅤᅟᅠﾠ឴឵᠎͏]/u;
const LETTER_RE = /\p{L}/u;
const NUMBER_RE = /\p{N}/u;

export function ndValue(cp) {
  for (const z of ND_ZEROS) if (cp >= z && cp < z + 10) return cp - z;
  return -1;
}

function classifyLower(cp, ch) {
  const f = CONF.get(cp);
  if (f) return f;
  for (const s of RANGE_STARTS) if (cp >= s && cp < s + 26) return String.fromCharCode(97 + cp - s);
  const d = ndValue(cp);
  if (d >= 0) return String(d);
  if (LETTER_RE.test(ch)) return ch;
  if (NUMBER_RE.test(ch)) return null;
  return null;
}

// null = separator, "" = invisible (ignored), else one or more skeleton characters.
function classify(cp, ch) {
  if (cp < 128) {
    if (cp >= 97 && cp <= 122) return ch;
    if (cp >= 65 && cp <= 90) return String.fromCharCode(cp + 32);
    if (cp >= 48 && cp <= 57) return ch;
    if (cp === 9 || cp === 10 || cp === 11 || cp === 12 || cp === 13 || cp === 32) return null;
    if (cp < 32 || cp === 127) return "";
    return null;
  }
  if (SEP_RE.test(ch)) return null;
  if (INVIS_RE.test(ch)) return "";
  const lower = ch.toLowerCase();
  let out = "";
  let sawSep = false;
  for (const lc of lower) {
    const lcp = lc.codePointAt(0);
    if (lcp < 128) {
      const r = classify(lcp, lc);
      if (r === null) sawSep = true;
      else out += r;
    } else if (INVIS_RE.test(lc)) {
      // ignore
    } else {
      const r = classifyLower(lcp, lc);
      if (r === null) sawSep = true;
      else out += r;
    }
  }
  if (out === "") return sawSep ? null : "";
  return out;
}

/**
 * Split text into skeleton elements. Returns parallel arrays over elements:
 *   c   skeleton string (one char per element)
 *   s,e start/end UTF-16 offsets of the source code point in `text`
 *   sp  number of separator code points between the previous element and this one
 *   sf  char code of the first of those separators (0 if none)
 */
const PART_CACHE = new Map();
function partResults(ch) {
  let r = PART_CACHE.get(ch);
  if (r === undefined) {
    r = [];
    for (const part of ch.normalize("NFKD")) r.push([part.codePointAt(0), classify(part.codePointAt(0), part)]);
    if (PART_CACHE.size > 20000) PART_CACHE.clear();
    PART_CACHE.set(ch, r);
  }
  return r;
}

export function elementsOf(text) {
  const cs = [];
  const s = [];
  const e = [];
  const sp = [];
  const sf = [];
  const str = String(text ?? "");
  let sepN = 0;
  let sepF = 0;
  let i = 0;
  let curI = 0;
  let curLen = 1;
  const emit = (pcp, r) => {
    if (r === null) {
      sepN++;
      if (sepN === 1) sepF = pcp;
    } else if (r !== "") {
      for (let k = 0; k < r.length; k++) {
        cs.push(r[k]);
        s.push(curI);
        e.push(curI + curLen);
        sp.push(k === 0 ? Math.min(sepN, 255) : 0);
        sf.push(k === 0 ? sepF : 0);
      }
      sepN = 0;
      sepF = 0;
    }
  };
  while (i < str.length) {
    const cp = str.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    curI = i;
    curLen = len;
    if (cp < 0xc0) emit(cp, classify(cp, str[i]));
    else for (const [pcp, r] of partResults(str.slice(i, i + len))) emit(pcp, r);
    i += len;
  }
  return { c: cs.join(""), s, e, sp, sf, n: cs.length };
}

export function skeleton(text) {
  return elementsOf(text).c;
}

const LEET_I = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };
const LEET_L = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t" };
export function leet(str, oneAs = "i") {
  const m = oneAs === "l" ? LEET_L : LEET_I;
  return str.replace(/[013457]/g, (d) => m[d] ?? d);
}
export const hasLeetDigit = (str) => /[013457]/.test(str);

export function collapse(str) {
  return str.replace(/(.)\1+/gs, "$1");
}

// Collapse with a map from each collapsed index to the first/last source index of its run.
export function collapseWithMap(str, sp) {
  // doubled letters collapse only when glued (no separator between them)
  const first = [];
  const last = [];
  let out = "";
  for (let i = 0; i < str.length; ) {
    let j = i;
    while (j + 1 < str.length && str[j + 1] === str[i] && (!sp || sp[j + 1] === 0)) j++;
    out += str[i];
    first.push(i);
    last.push(j);
    i = j + 1;
  }
  return { str: out, first, last };
}

/** Skeleton variants of a text: plain, leet (1->i), leet (1->l), and the collapsed form of each. */
export function textVariants(sk) {
  const plain = [sk];
  if (hasLeetDigit(sk)) {
    const a = leet(sk, "i");
    const b = leet(sk, "l");
    if (a !== sk) plain.push(a);
    if (b !== a && b !== sk) plain.push(b);
  }
  const collapsed = [...new Set(plain.map(collapse))];
  return { plain, collapsed };
}

/** Needles for a key: the key itself, its leet forms when it carries digits, and collapsed forms. */
export function keyNeedles(key) {
  const u = new Set([key]);
  if (hasLeetDigit(key)) {
    u.add(leet(key, "i"));
    u.add(leet(key, "l"));
  }
  const c = new Set([...u].map(collapse));
  return { plain: [...u], collapsed: [...c] };
}

// ---- decoding (HTML entities, percent-encoding, literal \u escapes) ----

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "­", zwnj: "‌", zwj: "‍" };
const DECODE_RE = /&#(\d{1,7});|&#x([0-9a-f]{1,6});|&(amp|lt|gt|quot|apos|nbsp|shy|zwnj|zwj);|((?:%[0-9a-f]{2}){1,64})|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi;

function safeFromCp(n) {
  try {
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
  } catch {
    return null;
  }
}

function decodePercent(run) {
  try {
    return decodeURIComponent(run);
  } catch {
    return String.fromCharCode(...run.split("%").slice(1).map((h) => parseInt(h, 16)));
  }
}

/** Decode one layer. Returns {text, os, oe, identity}; os/oe map decoded UTF-16 index -> original offsets. */
export function decodeWithMap(text) {
  const str = String(text ?? "");
  DECODE_RE.lastIndex = 0;
  if (!/[&%\\]/.test(str)) return { text: str, identity: true };
  let out = "";
  const os = [];
  const oe = [];
  let last = 0;
  let any = false;
  const push = (piece, start, end) => {
    for (let k = 0; k < piece.length; k++) {
      os.push(start);
      oe.push(end);
    }
    out += piece;
  };
  const copy = (from, to) => {
    for (let k = from; k < to; k++) {
      os.push(k);
      oe.push(k + 1);
    }
    out += str.slice(from, to);
  };
  let m;
  while ((m = DECODE_RE.exec(str))) {
    let rep = null;
    if (m[1] !== undefined) rep = safeFromCp(Number(m[1]));
    else if (m[2] !== undefined) rep = safeFromCp(parseInt(m[2], 16));
    else if (m[3] !== undefined) rep = NAMED[m[3].toLowerCase()] ?? null;
    else if (m[4] !== undefined) rep = decodePercent(m[4]);
    else if (m[5] !== undefined) rep = String.fromCharCode(parseInt(m[5], 16));
    else if (m[6] !== undefined) rep = String.fromCharCode(parseInt(m[6], 16));
    if (rep === null) continue;
    copy(last, m.index);
    push(rep, m.index, m.index + m[0].length);
    last = m.index + m[0].length;
    any = true;
  }
  if (!any) return { text: str, identity: true };
  copy(last, str.length);
  return { text: out, os, oe, identity: false };
}

export const decodeText = (text) => decodeWithMap(text).text;
