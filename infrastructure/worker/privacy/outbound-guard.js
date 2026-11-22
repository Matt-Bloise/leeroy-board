// Outbound guard: the fail-closed safety net in front of any external model or search call.
//
// SELF-CONTAINED ON PURPOSE. This file imports nothing. It has its own normaliser and its own
// confusables table and shares no code with skeleton.js or tokenise.js, so a bug (or a broken
// mutation) in the tokeniser cannot blind the guard. Keys come from the raw roster, not from
// the tokeniser's map.
//
// Two checks, for two jobs:
//
//   guardUserText(segments, roster, opts)   STRICT. Run only on the user-controlled segments of
//     an outbound request (the question, the previous turn, ...), after tokenising. The system
//     prompt, party block and asker are built with tokens by construction, so these segments
//     are the only place a real name can appear. Throws on any hit.
//
//   guardBody(body, roster)                 CHEAP, always on, over the whole body. Throws on any
//     hit. Only exact, low-false-positive things: multi-word display names, display/first/
//     character/guild names of 5+ letters at word boundaries, 15+ digit ids in one token,
//     mention syntax, @everyone/@here, invites, the canary, non-plain bodies, base64 blocks.
//
// Both THROW (code OUTBOUND_GUARD_CONFIG) when the roster is missing, empty or mistyped, or a
// member yields no key: a misconfigured guard must fail closed, not open. Hits throw
// OUTBOUND_IDENTIFIER_LEAK with err.leaks = [{kind, seg, ref}] (never the value).
// scanUserText / scanBody return the list instead of throwing on hits.
//
// STRICT rules (guardUserText), in the skeleton of the text (invisible, combining, punctuation
// and spaces removed, case folded, lookalikes folded, leet and doubled-letter variants):
//  - keys of 5+ letters match as substrings; keys of 7+ letters also match on their first 5 and
//    last 5 letters (partial names)
//  - keys of 4 letters or fewer match only as whole words (with s, es, y, ie, ies suffixes)
//  - generic aliases (roster.genericAliases, explicit lowercase list) are plain words: ignored
//  - text containing characters from scripts that are used as lookalikes and are not folded
//    (Lisu, Cherokee, Coptic, IPA and phonetic extensions, tag characters, bidi overrides) is
//    blocked outright
//  - base64 (padded, unpadded, url-safe), hex, %xx, HTML entities of any width, \uXXXX, \u{X}
//    and \xNN are decoded up to 3 layers deep and every layer is scanned; the reversed skeleton
//    is scanned too; segments are also scanned concatenated (names split across fields)
//  - ids: 15+ digits in one token, or any known roster id at all
//
// False-block cost (measured, see the test file and the commit message): partial matching
// blocks ordinary words that contain a 5-letter fragment of a long roster name.

export const CANARY = "LEEROY-CANARY-7f3a91c2";

// ---------- errors ----------
function configError(msg) {
  const e = new Error(`outbound guard config: ${msg}`);
  e.code = "OUTBOUND_GUARD_CONFIG";
  return e;
}
function leakError(leaks) {
  const summary = leaks.slice(0, 8).map((l) => `${l.kind}${l.ref !== undefined ? `(m${l.ref})` : ""}@${l.seg ?? "$"}`).join(", ");
  const e = new Error(`outbound guard: ${leaks.length} identifier leak(s): ${summary}`);
  e.code = "OUTBOUND_IDENTIFIER_LEAK";
  e.leaks = leaks;
  return e;
}

// ---------- own normaliser ----------
const FOLD_GROUPS = [
  ["a", "\u0430\u03b1\u0251"], ["b", "\u0432\u03b2\u044c\u0180\u0253"], ["c", "\u0441\u03f2"],
  ["d", "\u0501\u0111\u00f0\u0257"], ["e", "\u0435\u03b5\u0454\u044d\u0247"], ["f", "\u0192"],
  ["g", "\u0261\u050d\u0581\u0262"], ["h", "\u04bb\u0127\u043d\u0452\u0570"], ["i", "\u0456\u0131\u03b9\u0457\u0269\u0268"],
  ["j", "\u0458"], ["k", "\u043a\u03ba\u0138\u049b"], ["l", "\u04cf\u0142\u01c0"], ["m", "\u043c"],
  ["n", "\u043f\u0438\u0439\u0578\u03b7\u03c0\u04a3"], ["o", "\u043e\u03bf\u0585\u00f8\u03c3\u03b8\u04e9"],
  ["p", "\u0440\u03c1"], ["q", "\u051b\u0563"], ["r", "\u0433\u044f\u0491"], ["s", "\u0455\u03c2"],
  ["t", "\u0442\u03c4\u0167"], ["u", "\u03c5\u03bc\u057d"], ["v", "\u0475\u03bd"], ["w", "\u0461\u051d\u03c9\u0561\u0448"],
  ["x", "\u0445\u03c7\u04b3"], ["y", "\u0443\u03b3\u04af"], ["z", "\u03b6"],
  ["ss", "\u00df"], ["ae", "\u00e6"], ["oe", "\u0153"],
];
const FOLD = new Map();
for (const [to, chars] of FOLD_GROUPS) for (const c of chars) FOLD.set(c, to); // MUT:fold
const ND_ZEROS = [0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0];
const LETTER_RANGES = [0x1f130, 0x1f150, 0x1f170, 0x1f1e6]; // squared, circled neg., neg. squared, regional

function foldChar(c) {
  const hit = FOLD.get(c);
  if (hit !== undefined) return hit;
  const cp = c.codePointAt(0);
  for (const s of LETTER_RANGES) if (cp >= s && cp < s + 26) return String.fromCharCode(97 + cp - s);
  for (const z of ND_ZEROS) if (cp >= z && cp < z + 10) return String(cp - z);
  return c;
}

// Scripts used as lookalikes that are NOT folded: block instead.
const BLOCK_RE = /[\u0250-\u02af\u03e2-\u03ef\u13a0-\u13ff\u1d00-\u1dbf\u2c80-\u2cff\u202a-\u202e\u2066-\u2069\ua4d0-\ua4ff\ua720-\ua7ff\uab70-\uabbf]|\ud807[\udfb0-\udfbf]|\udb40[\udc00-\udc7f]/;
const INVISIBLE_RE = /[\p{M}\p{Cf}\u3164\u115f\u1160\uffa0\u17b4\u17b5\u180e\u2800\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu; // MUT:invisible
const NONASCII_RE = /[^\x00-\x7f]/;

/** Words of the text, folded, separated by single spaces (no leading/trailing space). */
function spaced(text) {
  let s = text;
  if (NONASCII_RE.test(s)) {
    s = s.normalize("NFKD").replace(INVISIBLE_RE, "").toLowerCase().replace(/[^\x00-\x7f]/gu, foldChar);
  } else {
    s = s.replace(INVISIBLE_RE, "").toLowerCase();
  }
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const skel = (text) => spaced(text).replace(/ /g, "");

const LEET_I = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };
const LEET_L = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t" };
const leetOf = (s, m) => s.replace(/[013457]/g, (d) => m[d]); // MUT:leet
const collapse = (s) => s.replace(/(.)\1+/gs, "$1"); // MUT:collapse
const reverse = (s) => Array.from(s).reverse().join("");

// ---------- roster parsing ----------
const parsed = new WeakMap();
const SUFFIXES = ["", "s", "es", "y", "ie", "ies"];

function namesOf(m, i) {
  const list = [];
  const take = (raw, kind) => {
    if (raw === undefined || raw === null || raw === "") return;
    if (typeof raw !== "string") throw configError(`member ${i} has a non-string ${kind}`);
    list.push({ raw, kind });
  };
  const arr = (v, kind) => {
    if (v === undefined || v === null) return;
    if (!Array.isArray(v)) throw configError(`member ${i} ${kind} must be an array`);
    for (const x of v) take(x, kind);
  };
  if (m === null || typeof m !== "object" || Array.isArray(m)) throw configError(`member ${i} is not an object`);
  take(m.display, "display");
  arr(m.aliases, "alias");
  arr(m.firstNames, "first");
  arr(m.characterNames, "character");
  take(m.guild, "guild");
  return list;
}

/** Validate a roster and compile keys. Throws OUTBOUND_GUARD_CONFIG when unusable. */
export function parseRoster(roster, opts = {}) {
  if (roster === null || roster === undefined) throw configError("roster is missing");
  if (typeof roster === "object" && parsed.has(roster)) return withAsker(parsed.get(roster), opts.asker);
  const members = Array.isArray(roster) ? roster : roster.members;
  const genericIn = Array.isArray(roster) ? [] : roster.genericAliases ?? [];
  if (!Array.isArray(members) || members.length === 0) throw configError("roster has no members");
  if (!Array.isArray(genericIn)) throw configError("genericAliases must be an array");
  const generic = new Set();
  for (const g of genericIn) {
    if (typeof g !== "string" || g !== g.toLowerCase()) throw configError("genericAliases entries must be lowercase strings");
    generic.add(skel(g));
  }
  const entries = [];
  const ids = [];
  const bodyNames = [];
  const seen = new Set();
  members.forEach((m, i) => {
    const names = namesOf(m, i);
    let got = 0;
    for (const { raw, kind } of names) {
      const key = skel(raw);
      if ([...key].length === 0) continue;
      if ([...key].length < 2) throw configError(`member ${i} has a one-character ${kind}`);
      if (kind === "alias" && generic.has(key)) continue; // generic word: left alone
      got++;
      const sig = `${i}|${key}|${kind}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      entries.push(compileKey(raw, key, kind, i));
      const lower = raw.toLowerCase().replace(/\s+/g, " ").trim();
      const letters = key.length;
      const multi = /\s/.test(lower);
      if ((kind === "display" || kind === "first" || kind === "character" || kind === "guild") && (multi || letters >= 5)) bodyNames.push(lower);
    }
    if (got === 0) throw configError(`member ${i} yields no key`);
    if (m.discordIds !== undefined && !Array.isArray(m.discordIds)) throw configError(`member ${i} discordIds must be an array`);
    for (const id of m.discordIds ?? []) if (/^\d{15,25}$/.test(String(id))) ids.push(String(id));
  });
  const alts = [...new Set(bodyNames)]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  const bodyRx = alts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?:'?s)?(?![\\p{L}\\p{N}])`, "iu") : null;
  const R = { entries, ids, bodyRx, generic };
  if (typeof roster === "object") parsed.set(roster, R);
  return withAsker(R, opts.asker);
}

function withAsker(R, asker) {
  if (!asker) return R;
  const raw = String(asker);
  if (/^\d{15,25}$/.test(raw)) return { ...R, ids: [...R.ids, raw] };
  const key = skel(raw);
  if ([...key].length < 2 || R.generic.has(key)) return R;
  return { ...R, entries: [...R.entries, compileKey(raw, key, "asker", -1)] };
}

function compileKey(raw, key, kind, member) {
  const e = { raw, key, kind, member, short: key.length <= 4, plain: [], coll: [], partial: [], words: null };
  if (e.short) {
    const w = spaced(raw);
    e.words = w;
    e.shortNeedles = [];
    for (const forms of [key, w]) for (const sfx of SUFFIXES) e.shortNeedles.push(` ${forms}${sfx} `);
    return e;
  }
  const u = new Set([key]);
  if (/[013457]/.test(key)) {
    u.add(leetOf(key, LEET_I));
    u.add(leetOf(key, LEET_L));
  }
  e.plain = [...u];
  e.coll = [...new Set([...u].map(collapse))];
  if (key.length >= 7) e.partial = [...new Set([key.slice(0, 5), key.slice(-5)])];
  e.rev = [key, ...e.partial].map(reverse);
  return e;
}

// ---------- decoding layers ----------
const ESC_RE = /&#(\d{1,12});|&#x([0-9a-f]{1,12});|&(amp|lt|gt|quot|apos|nbsp|shy|zwnj|zwj);|((?:%[0-9a-f]{2}){1,64})|\\u\{([0-9a-f]{1,8})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi;
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", shy: "\u00ad", zwnj: "\u200c", zwj: "\u200d" };
const cp = (n) => { try { return n <= 0x10ffff ? String.fromCodePoint(n) : null; } catch { return null; } };

function decodeEscapes(t) {
  ESC_RE.lastIndex = 0;
  return t.replace(ESC_RE, (m, dec, hex, named, pct, braced, u4, x2) => {
    let r = null;
    if (dec !== undefined) r = cp(Number(dec));
    else if (hex !== undefined) r = cp(parseInt(hex, 16));
    else if (named !== undefined) r = NAMED[named.toLowerCase()] ?? null;
    else if (pct !== undefined) { try { r = decodeURIComponent(pct); } catch { r = String.fromCharCode(...pct.split("%").slice(1).map((h) => parseInt(h, 16))); } }
    else if (braced !== undefined) r = cp(parseInt(braced, 16));
    else if (u4 !== undefined) r = String.fromCharCode(parseInt(u4, 16));
    else if (x2 !== undefined) r = String.fromCharCode(parseInt(x2, 16));
    return r ?? m;
  });
}

function printableText(bytes) {
  if (bytes.length < 3) return null;
  let ok = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || c >= 0x80) ok++;
  }
  if (ok / bytes.length < 0.95) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
}

const HEX_RE = /(?<![0-9a-fA-F])(?:[0-9a-fA-F]{2}){4,}(?![0-9a-fA-F])/g;
const B64_RE = /[A-Za-z0-9+/_-]{6,}={0,2}/g;
function decodeBinaryish(t, out) {
  let m;
  let budget = 30;
  if (/[0-9a-fA-F]{8}/.test(t)) {
    HEX_RE.lastIndex = 0;
    while (budget-- > 0 && (m = HEX_RE.exec(t))) {
      const bytes = [];
      for (let i = 0; i < m[0].length; i += 2) bytes.push(parseInt(m[0].slice(i, i + 2), 16));
      const d = printableText(bytes);
      if (d) out.push(d);
    }
  }
  budget = 30;
  B64_RE.lastIndex = 0;
  while (budget-- > 0 && (m = B64_RE.exec(t))) {
    const w = m[0];
    if (!/[A-Z0-9+/_-]/.test(w.slice(1))) continue; // plain lowercase words are not base64
    let core = w.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (core.length % 4 === 1) continue;
    try {
      const bin = atob(core.padEnd(Math.ceil(core.length / 4) * 4, "="));
      const bytes = Array.from(bin, (c) => c.charCodeAt(0));
      const d = printableText(bytes);
      if (d) out.push(d);
    } catch { /* not base64 */ }
  }
}

function candidates(text) {
  const all = [text];
  let frontier = [text];
  for (let layer = 0; layer < 3; layer++) {
    const next = [];
    for (const t of frontier) {
      if (/[&%\\]/.test(t)) {
        const d = decodeEscapes(t);
        if (d !== t) next.push(d);
      }
      decodeBinaryish(t, next);
    }
    if (!next.length) break;
    for (const n of next) all.push(n);
    frontier = next;
    if (all.length > 60) break;
  }
  return all;
}

// ---------- scanning ----------
const TOKEN_RE = /\{(?:P\d+|ID|ALL|INVITE|GUILD)(?:\.[a-z0-9]{2,8})?\}/g;
const TOKEN_TEST_RE = /\{(?:P\d+|ID|ALL|INVITE|GUILD)(?:\.[a-z0-9]{2,8})?\}/;
const MENTION_RE = /<\s{0,3}(?:@\s{0,3}[!&]?|#)\s{0,3}\d/;
const USER_URL_RE = /discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}(?:users|channels)\s{0,3}\/\s{0,3}\d/i;
const EVERYONE_RE = /@\s{0,3}(?:every\s{0,3}one|here)(?![a-z])/i;
const INVITE_RE = /(?:discord\s{0,3}\.\s{0,3}gg|dsc\s{0,3}\.\s{0,3}gg|discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}invites?|discord\s{0,3}\.\s{0,3}me)\s{0,3}\/\s{0,3}[\w-]/i;
const CANARY_KEY = skel(CANARY);

function structural(t, out, seg) {
  if (!/[<@dD]/.test(t)) return;
  const base = t.normalize("NFKC").replace(/[\p{Cf}\p{M}]/gu, "");
  if (MENTION_RE.test(base) || USER_URL_RE.test(base)) out.push({ kind: "mention", seg });
  if (EVERYONE_RE.test(base)) out.push({ kind: "everyone", seg });
  if (INVITE_RE.test(base)) out.push({ kind: "invite", seg });
}

function scanSkeleton(text, R, kinds, out, seg) {
  const clean = text.replace(TOKEN_RE, " ");
  const sp = spaced(clean);
  if (!sp) return;
  const sk = sp.replace(/ /g, "");
  if (sk.includes(CANARY_KEY)) out.push({ kind: "canary", seg });
  // ids: 15+ digits inside one token; any known id even when spaced out
  if (/\d{15,}/.test(sp)) out.push({ kind: "id", seg });
  else for (const id of R.ids) if (sk.includes(id)) { out.push({ kind: "id", seg }); break; }
  if (/[a-z]/.test(sk)) {
    if (/discordgg|dscgg|discordcominvite|discordappcominvite|discordme[a-z0-9]/.test(sk)) out.push({ kind: "invite", seg });
  }
  const padded = ` ${sp} `;
  let v = null;
  const variants = () => {
    if (v) return v;
    const plain = [sk];
    if (/[013457]/.test(sk)) {
      const a = leetOf(sk, LEET_I);
      const b = leetOf(sk, LEET_L);
      plain.push(a);
      if (b !== a) plain.push(b);
    }
    v = { plain, coll: [...new Set(plain.map(collapse))] };
    return v;
  };
  for (const e of R.entries) {
    if (kinds && !kinds.has(e.kind)) continue;
    if (e.short) {
      for (const n of e.shortNeedles) if (padded.includes(n)) { out.push({ kind: "name", seg, ref: e.member }); break; }
      continue;
    }
    const vs = variants();
    let hit = null;
    for (const n of e.plain) { for (const t of vs.plain) if (t.includes(n)) { hit = "name"; break; } if (hit) break; }
    if (!hit) for (const n of e.coll) { for (const t of vs.coll) if (t.includes(n)) { hit = "name"; break; } if (hit) break; }
    if (!hit) for (const n of e.partial) { for (const t of vs.plain) if (t.includes(n)) { hit = "partial"; break; } if (hit) break; }
    if (!hit && e.rev) {
      // the name typed backwards (or shown backwards by a bidi override that was stripped)
      // The leet forms of the text count here too: a name both reversed and written with digits ("kc1w3ldn1rB") must not slip past.
      for (const n of e.rev) { for (const t of variants().plain) if (t.includes(n)) { hit = "name"; break; } if (hit) break; }
    }
    if (hit) out.push({ kind: hit, seg, ref: e.member });
  }
}

function scanText(text, R, opts, out, seg) {
  if (!text) return;
  // A user segment this long is not a question; do not spend CPU on it, refuse it.
  if (text.length > (opts.maxChars ?? 20000)) { out.push({ kind: "toolong", seg }); return; }
  for (const c of candidates(text)) {
    if (opts.blockScripts !== false && BLOCK_RE.test(c)) out.push({ kind: "script", seg });
    scanSkeleton(c, R, opts.kinds, out, seg);
    structural(c, out, seg);
  }
}

const asSegments = (s) => (Array.isArray(s) ? s : [s]);

/** Strict scan of user-controlled segments. Returns leaks; throws only on a bad roster. */
export function scanUserText(segments, roster, opts = {}) {
  const R = parseRoster(roster, opts);
  const segs = asSegments(segments).map((s) => (typeof s === "string" ? s : s === null || s === undefined ? "" : String(s)));
  const out = [];
  segs.forEach((s, i) => scanText(s, R, opts, out, i));
  if (segs.length > 1) scanText(segs.join(""), R, opts, out, "joined");
  const seen = new Set();
  return out.filter((l) => { const k = `${l.kind}|${l.seg}|${l.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function guardUserText(segments, roster, opts = {}) {
  const leaks = scanUserText(segments, roster, opts);
  if (leaks.length) throw leakError(leaks);
  return { ok: true, leaks: [] };
}

// ---------- cheap whole-body check ----------
const isPlain = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

export function scanBody(body, roster, opts = {}) {
  const R = parseRoster(roster);
  const allowBlocks = new Set(opts.allowBlockTypes ?? []);
  const out = [];
  const seen = new WeakSet();
  const check = (s, path) => {
    if (!s) return;
    if (R.bodyRx && R.bodyRx.test(s)) out.push({ kind: "name", seg: path });
    if (/\d{15,}/.test(s)) out.push({ kind: "id", seg: path });
    if (s.length >= CANARY.length && s.toLowerCase().includes(CANARY.toLowerCase())) out.push({ kind: "canary", seg: path });
    if (/[<@dD]/.test(s)) {
      if (MENTION_RE.test(s) || USER_URL_RE.test(s)) out.push({ kind: "mention", seg: path });
      if (EVERYONE_RE.test(s)) out.push({ kind: "everyone", seg: path });
      if (INVITE_RE.test(s)) out.push({ kind: "invite", seg: path });
    }
  };
  const walk = (v, path) => {
    if (v === null || v === undefined) return;
    const t = typeof v;
    if (t === "string") return check(v, path);
    if (t === "number" || t === "boolean") return check(String(v), path);
    if (t !== "object") { out.push({ kind: "nonplain", seg: path }); return; }
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (!isPlain(v)) { out.push({ kind: "nonplain", seg: path }); return; }
    const type = v.type;
    if ((type === "image" || type === "document" || type === "file") && v.source && typeof v.source === "object" && (v.source.type === "base64" || typeof v.source.data === "string") && !allowBlocks.has(type)) {
      out.push({ kind: "binary-block", seg: path });
      return;
    }
    for (const k of Object.keys(v)) { check(k, `${path}.<key>`); walk(v[k], path ? `${path}.${k}` : k); }
  };
  walk(body, "");
  return out;
}

export function guardBody(body, roster, opts = {}) {
  const leaks = scanBody(body, roster, opts);
  if (leaks.length) throw leakError(leaks);
  return { ok: true, leaks: [] };
}

// ---------- reply policy ----------
/**
 * Run on the RAW model reply (before detokenise). True when the reply names a member in a way
 * policy forbids: first/real names (and partials), character names, guild names; display
 * names and aliases only when opts.allowDisplayNames === false. Short first names (4 letters
 * or fewer) match at word boundaries only, so "Brennan's Tavern" does not flag "Bren".
 * Roster = same object as for the guard; first names are whatever the caller put in it
 * (injectable, never read from the repo).
 */
export function replyLeaksIdentity(text, roster, opts = {}) {
  const R = parseRoster(roster);
  if (typeof text !== "string" || !text) return false;
  const kinds = new Set(["first", "character", "guild"]);
  if (opts.allowDisplayNames === false) { kinds.add("display"); kinds.add("alias"); }
  const out = [];
  scanText(text, R, { kinds, blockScripts: false }, out, 0);
  return out.some((l) => l.kind === "name" || l.kind === "partial" || l.kind === "id" || l.kind === "mention" || l.kind === "everyone" || l.kind === "invite");
}

// ---------- search queries ----------
/** A search query may carry no roster key, no partial of one, no id, and no token. Else null. */
export function scrubSearchQuery(q, roster, opts = {}) {
  const R = parseRoster(roster, opts);
  void R;
  if (typeof q !== "string") return null;
  if (/\{\s{0,3}(?:p\s{0,3}\d|id\b|all\b|invite\b|guild\b)/i.test(q) || TOKEN_TEST_RE.test(q)) return null;
  if (scanUserText([q], roster, opts).length) return null;
  const clean = q.replace(/\s+/g, " ").trim();
  return clean || null;
}
