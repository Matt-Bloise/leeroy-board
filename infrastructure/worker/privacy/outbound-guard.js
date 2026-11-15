// Outbound guard: the fail-closed safety net in front of any external model or search call.
//
// It is deliberately INDEPENDENT of the tokeniser's matching: it works on a skeleton of the
// text (see skeleton.js) with plain substring search, recomputes every key from the raw
// roster strings, and blocks on any hit. If it finds an identifier the caller must not send
// the body to the outside API (degrade to the on-platform model instead).
//
// What it flags (kind): name, canary, id, mention, everyone, invite, nonplain, binary-block,
// unserialisable. Reports never echo the leaked value (kind, path, member token only).
//
// Generic-word allowlist (documented mechanism): roster aliases listed in
// buildNameMap(..., {genericWords}) are common words ("tank"). Substring search would block
// every "rather"/"tanker", so for those keys ONLY the guard checks a word-boundary occurrence
// (with possessive/plural/-es/-y suffixes and separator tolerance). The tokeniser replaces
// every such occurrence, so a standalone generic word reaching the guard means the tokeniser
// missed a real use: block. A generic word glued to other letters is allowed (blind spot).

import {
  elementsOf,
  collapse,
  leet,
  hasLeetDigit,
  textVariants,
  keyNeedles,
  decodeText,
} from "./skeleton.js";
import { tokenise } from "./tokenise.js";

export const CANARY = "LEEROY-CANARY-7f3a91c2";

const TOKEN_RE = /\{(?:P\d+|ID|ALL|INVITE|GUILD)\}/g;
const MENTION_RE = /<\s{0,3}(?:@\s{0,3}[!&]?|#)\s{0,3}\d/;
const USER_URL_RE = /discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}(?:users|channels)\s{0,3}\/\s{0,3}\d/i;
const EVERYONE_RE = /@\s{0,3}(?:every\s{0,3}one|here)(?![a-z])/i;
const INVITE_RE = /(?:discord\s{0,3}\.\s{0,3}gg|dsc\s{0,3}\.\s{0,3}gg|discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}invites?|discord\s{0,3}\.\s{0,3}me)\s{0,3}\/\s{0,3}[\w-]/i;
const INVITE_SKELETON_RE = /discordgg|dscgg|discordcominvite|discordappcominvite|discordme[a-z0-9]/;
const LONG_DIGITS_RE = /\d{15,}/;
const USER_TOKEN_LIKE_RE = /\{\s{0,3}(?:p\s{0,3}\d|id\b|all\b|invite\b|guild\b)/i;

const keyCache = new WeakMap();
function prepared(entry) {
  let p = keyCache.get(entry);
  if (!p) {
    const el = elementsOf(entry.raw);
    const key = el.c;
    p = { key, needles: keyNeedles(key), genericRx: null, genericRxC: null };
    if (entry.generic) {
      const mk = (k) => {
        const pat = Array.from(k).map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(" ?");
        return new RegExp(`(?<![\\p{L}\\p{N}])${pat}(?: ?(?:s|es|y|ie|ies))?(?![\\p{L}\\p{N}])`, "u");
      };
      p.genericRx = mk(key);
      p.genericRxC = mk(collapse(key));
    }
    keyCache.set(entry, p);
  }
  return p;
}

function spaced(el) {
  let out = "";
  for (let i = 0; i < el.n; i++) {
    if (i > 0 && el.sp[i] > 0) out += " ";
    out += el.c[i];
  }
  return out;
}

/**
 * Skeleton name scan over already-prepared text. `entries` are map entries; `opts.skipGeneric`
 * ignores generic-word entries entirely (reply checks and search queries).
 * Returns [{kind, ref}].
 */
export function scanNames(text, entries, opts = {}, preEl = null) {
  const hits = [];
  if (!entries || !entries.length) return hits;
  const el = preEl ?? elementsOf(text);
  if (!el.n) return hits;
  const v = textVariants(el.c);
  let gv = null;
  for (const entry of entries) {
    const p = prepared(entry);
    if (p.key.length < 1) continue;
    if (entry.generic) {
      if (opts.skipGeneric) continue;
      if (!gv) {
        const sp = spaced(el);
        const plain = [sp];
        if (hasLeetDigit(sp)) plain.push(leet(sp, "i"), leet(sp, "l"));
        gv = { plain, coll: plain.map(collapse) };
      }
      if (gv.plain.some((t) => p.genericRx.test(t)) || gv.coll.some((t) => p.genericRxC.test(t))) hits.push({ kind: entry.kind === "canary" ? "canary" : "name", ref: entry.token });
      continue;
    }
    let hit = false;
    for (const needle of p.needles.plain) {
      for (const t of v.plain) if (t.includes(needle)) { hit = true; break; }
      if (hit) break;
    }
    if (!hit) {
      for (const needle of p.needles.collapsed) {
        for (const t of v.collapsed) if (t.includes(needle)) { hit = true; break; }
        if (hit) break;
      }
    }
    if (hit) hits.push({ kind: entry.kind === "canary" ? "canary" : "name", ref: entry.token });
  }
  return hits;
}

const canaryEntries = new Map();
function canaryEntry(canary) {
  if (!canaryEntries.has(canary)) canaryEntries.set(canary, { raw: canary, kind: "canary", token: "canary", generic: false });
  return canaryEntries.get(canary);
}

// Strip exactly-issued tokens (replaced with a space so neighbours stay apart).
const stripTokens = (s) => s.replace(TOKEN_RE, " ");

const B64_WORD_RE = /[A-Za-z0-9+/]{4,}={0,2}/g;
// Decode a base64-looking word; only returned when the bytes are overwhelmingly printable text
// (ordinary words decode to binary noise and are ignored).
function b64Decode(word) {
  try {
    const core = word.replace(/=+$/, "");
    const bin = atob(core.padEnd(Math.ceil(core.length / 4) * 4, "="));
    if (bin.length < 3) return null;
    let printable = 0;
    for (let i = 0; i < bin.length; i++) {
      const c = bin.charCodeAt(i);
      if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9 || c >= 0x80) printable++;
    }
    if (printable / bin.length < 0.95) return null;
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function checkVariant(raw, path, ctx, out) {
  const text = stripTokens(raw);
  const el = elementsOf(text);
  // names + canary
  for (const h of scanNames(text, ctx.entries, ctx.scanOpts, el)) out.push({ kind: h.kind, path, ref: h.ref });
  if (ctx.canary && scanNames(text, [canaryEntry(ctx.canary)], {}, el).length) out.push({ kind: "canary", path });
  // ids: 15+ contiguous digits in the skeleton tolerates spaces, commas, dots and non-ASCII digits
  if (LONG_DIGITS_RE.test(el.c)) out.push({ kind: "id", path });
  // structural forms
  const base = text.normalize("NFKC").replace(/[\p{Cf}\p{Mn}]/gu, "");
  if (MENTION_RE.test(base) || USER_URL_RE.test(base)) out.push({ kind: "mention", path });
  if (EVERYONE_RE.test(base)) out.push({ kind: "everyone", path });
  if (INVITE_RE.test(base) || INVITE_SKELETON_RE.test(el.c)) out.push({ kind: "invite", path });
}

function scanText(str, path, ctx, out, depth) {
  if (!str) return;
  ctx.joined.push(str);
  const variants = [str];
  const d1 = decodeText(str);
  if (d1 !== str) {
    variants.push(d1);
    const d2 = decodeText(d1);
    if (d2 !== d1) variants.push(d2);
  }
  for (const v of variants) checkVariant(v, path, ctx, out);
  // base64-looking words
  if (str.length >= 4) {
    let m;
    B64_WORD_RE.lastIndex = 0;
    let budget = 50;
    while (budget-- > 0 && (m = B64_WORD_RE.exec(str))) {
      if (m[0].length < 4 || m[0].length % 4 !== 0) continue; // btoa output is padded to a multiple of 4
      const dec = b64Decode(m[0]);
      if (dec) checkVariant(dec, `${path}~b64`, ctx, out);
    }
  }
  // strings that are themselves JSON
  if (depth < 4) {
    const t = str.trim();
    if (t.length > 1 && (t[0] === "{" || t[0] === "[") ) {
      try {
        walk(JSON.parse(t), `${path}~json`, ctx, out, depth + 1);
      } catch { /* not JSON */ }
    }
  }
}

const isPlainObject = (v) => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

function walk(value, path, ctx, out, depth = 0) {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === "string") return scanText(value, path, ctx, out, depth);
  if (t === "number" || t === "boolean") return scanText(String(value), path, ctx, out, depth);
  if (t !== "object") {
    out.push({ kind: "nonplain", path });
    return;
  }
  if (ctx.seen.has(value)) return;
  ctx.seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, ctx, out, depth));
    return;
  }
  if (!isPlainObject(value)) {
    out.push({ kind: "nonplain", path });
    return;
  }
  const type = value.type;
  if ((type === "image" || type === "document" || type === "file") && value.source && typeof value.source === "object") {
    const s = value.source;
    if ((s.type === "base64" || typeof s.data === "string") && !ctx.allowBlocks.has(type)) {
      out.push({ kind: "binary-block", path });
      return;
    }
  }
  for (const [k, v] of Object.entries(value)) {
    scanText(k, `${path}.<key>`, ctx, out, depth);
    walk(v, path ? `${path}.${k}` : k, ctx, out, depth);
  }
}

/**
 * Scan a request body. `canary` defaults to CANARY (pass null to disable).
 * opts: { allowBlockTypes: ["image"], skipGeneric: bool }
 */
export function findIdentifiers(body, map, canary = CANARY, opts = {}) {
  const ctx = {
    entries: (map && map.entries) || [],
    canary,
    seen: new WeakSet(),
    joined: [],
    allowBlocks: new Set(opts.allowBlockTypes || []),
    scanOpts: { skipGeneric: !!opts.skipGeneric },
  };
  const out = [];
  walk(body, "", ctx, out);
  // Names split across adjacent fields: scan the strings joined with no separator.
  if (ctx.joined.length > 1) {
    const extra = [];
    checkVariant(ctx.joined.join(""), "$joined", ctx, extra);
    for (const e of extra) if (!out.some((o) => o.kind === e.kind)) out.push(e);
  }
  // Whole serialised body (undoes JSON escapes so \n, \t, ø do not hide names).
  let flat;
  try {
    flat = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    out.push({ kind: "unserialisable", path: "$" });
    return out;
  }
  if (typeof flat === "string") {
    const extra = [];
    checkVariant(flat.replace(/\\[ntrbf"\\/]/g, " "), "$", ctx, extra);
    for (const e of extra) if (!out.some((o) => o.kind === e.kind)) out.push(e);
  }
  return out;
}

export function assertNoIdentifiers(body, map, canary = CANARY, opts = {}) {
  const leaks = findIdentifiers(body, map, canary, opts);
  if (leaks.length) {
    const summary = leaks
      .slice(0, 8)
      .map((l) => `${l.kind}${l.ref ? `(${l.ref})` : ""}@${l.path || "$"}`)
      .join(", ");
    const err = new Error(`outbound guard: ${leaks.length} identifier leak(s): ${summary}`);
    err.code = "OUTBOUND_IDENTIFIER_LEAK";
    err.leaks = leaks;
    throw err;
  }
  return { ok: true, leaks: [] };
}

/**
 * Reply policy check, run on the RAW model reply (before detokenise). Returns true when the
 * reply names a member in a way that is not allowed: any first/real name, character name,
 * guild name, and (unless opts.allowDisplayNames) any display name or alias. Skeleton based,
 * like the guard. Generic-word aliases are ignored here (they are ordinary words in replies).
 * First names come from the map, which the caller builds from an injectable source.
 */
export function replyLeaksIdentity(text, map, opts = {}) {
  if (typeof text !== "string" || !text || !map || !map.entries) return false;
  const entries = map.entries.filter(
    (e) => !e.generic && (opts.allowDisplayNames ? e.kind !== "display" && e.kind !== "alias" && e.kind !== "asker" : true)
  );
  const variants = [text];
  const d1 = decodeText(text);
  if (d1 !== text) variants.push(d1);
  for (const v of variants) {
    const clean = stripTokens(v);
    if (scanNames(clean, entries, { skipGeneric: true }).length) return true;
    if (LONG_DIGITS_RE.test(elementsOf(clean).c)) return true;
    const base = clean.normalize("NFKC").replace(/[\p{Cf}\p{Mn}]/gu, "");
    if (MENTION_RE.test(base) || EVERYONE_RE.test(base) || INVITE_RE.test(base)) return true;
  }
  return false;
}

/**
 * Tokenise a web-search query. Returns null when a person, id or invite would remain (or the
 * guard still flags it). A generic-word alias ("tank") is not a person: it is restored as
 * typed, and the guard re-checks with generic words skipped.
 */
export function scrubSearchQuery(q, map) {
  if (typeof q !== "string" || USER_TOKEN_LIKE_RE.test(q)) return null;
  let t = tokenise(q, map);
  for (const tok of t.match(TOKEN_RE) || []) {
    const info = /^\{P\d+\}$/.test(tok) && map && map.surface ? map.surface.get(tok) : null;
    if (!info || !info.generic) return null;
  }
  t = t.replace(/\{P\d+\}/g, (tok) => map.surface.get(tok).text);
  if (findIdentifiers({ q: t }, map, CANARY, { skipGeneric: true }).length) return null;
  const clean = t.replace(/\s+/g, " ").trim();
  return clean || null;
}
