// Outbound privacy: replace people's names with stable per-request tokens before any text
// leaves the Worker for a model provider, and restore DISPLAY names in the reply.
//
// Pure and dependency-free. No I/O. The tokeniser is best-effort; outbound-guard.js is the
// independent fail-closed net behind it.
//
// Tokens
//   {P1}..{Pn}  a member (position in the members array; an asker not in the roster is appended)
//   {ID}        any Discord id, channel/role mention, profile link we cannot attribute
//   {ALL}       @everyone / @here
//   {INVITE}    Discord invite links
//   {GUILD}     a guild (server) name
//
// Output: the input after NFKC and removal of invisible format characters, with the matched
// spans replaced. Everything else (accents, Cyrillic prose, emoji) is kept as typed.
//
// Matching (per key, on the skeleton of the text, mapped back to original offsets):
//  - separators (space, hyphen, dot, markdown, ...) tolerated between letters, up to 3 in a row
//  - invisible/combining characters ignored; lookalike letters folded; HTML entities, %-escapes
//    and literal \u escapes decoded first; leet digits and doubled letters tolerated (keys of
//    5+ and 4+ letters respectively)
//  - names of 7+ letters match anywhere unless glued to letters on BOTH sides
//  - names of 4-6 letters match anywhere (Jess2, healCorwin)
//  - names of 2-3 letters match only as a whole word (with 's, s, es, y, ie, ies suffixes)
//  - generic-word aliases (opts.genericWords) match only as whole words and are restored as typed
//  - a name whose last word is one letter ("Big T") does not match inside a compound ("t-shirt")

import { elementsOf, skeleton, textVariants, collapse, collapseWithMap, decodeWithMap, ndValue } from "./skeleton.js";

export const LONG_NAME_MIN = 7;

const RESERVED = new Set(["id", "all", "guild", "invite", "everyone", "here", "someone"]);
const SUFFIXES = new Set(["", "s", "es", "y", "ie", "ies"]);
const TOKEN_SPLIT_RE = /(\{(?:P\d+|ID|ALL|INVITE|GUILD)\})/;
const USER_TOKEN_RE = /\{\s{0,3}(p\s{0,3}\d{1,4}|id|all|invite|guild)\s{0,3}\}/gi;

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\s{0,3}\.\s{0,3}gg|dsc\s{0,3}\.\s{0,3}gg|discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}invites?|discord\s{0,3}\.\s{0,3}me)\s{0,3}\/\s{0,3}[\w-]+/gi;
const USER_URL_RE = /(?:https?:\/\/)?(?:www\.)?discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}(?:users|channels)\s{0,3}\/\s{0,3}[\d\/ ]+/gi;
const MENTION_RE = /<\s{0,3}(@\s{0,3}[!&]?|#)\s{0,3}(\d[\d ]{0,30})\s{0,3}>/g;
const RAW_ID_RE = /\d(?:[ ,._\-]?\d){14,}/g;
const EVERYONE_RE = /@\s{0,3}(?:every\s{0,3}one|here)(?![a-z])/gi;

function baseNormalise(text) {
  let s = String(text ?? "").normalize("NFKC");
  if (/[^\x00-\x7f]/.test(s)) {
    s = s.replace(/\p{Cf}/gu, "").replace(/\p{Nd}/gu, (ch) => {
      const d = ndValue(ch.codePointAt(0));
      return d >= 0 ? String(d) : ch;
    });
  }
  return s;
}

function escapeUserTokens(s) {
  return s.replace(USER_TOKEN_RE, (_m, inner) => `[${inner.replace(/\s+/g, "").toUpperCase()}]`);
}

function structural(s, map) {
  s = s.replace(INVITE_RE, "{INVITE}");
  s = s.replace(USER_URL_RE, "{ID}");
  s = s.replace(MENTION_RE, (_m, kind, id) => {
    const digits = id.replace(/\D/g, "");
    const k = kind.replace(/\s+/g, "");
    return k === "@" || k === "@!" ? map.ids.get(digits) ?? "{ID}" : "{ID}";
  });
  s = s.replace(RAW_ID_RE, (m) => map.ids.get(m.replace(/\D/g, "")) ?? "{ID}");
  s = s.replace(EVERYONE_RE, "{ALL}");
  return s;
}

function lastWordLen(raw) {
  const el = elementsOf(raw);
  let n = 0;
  for (let i = el.n - 1; i >= 0; i--) {
    n++;
    if (el.sp[i] > 0) break;
  }
  return n;
}

/**
 * members: [{display, aliases[], firstNames[], discordIds[], characterNames[], guild?}]
 * asker:   optional string (display, alias, first name or discord id) or member object.
 * opts:    { genericWords: string[]   common-word aliases (see header),
 *            firstNameSource: (member, index) => string[]   injectable first/real names }
 *
 * Returns { entries, names: Map key->token, byToken: Map token->{display}, ids: Map id->token,
 * surface: Map token->{generic,text}, generic: Set }. Throws (no values in the message) on
 * one-character or reserved names and on duplicate keys across members. An asker not in the
 * roster gets a token and the neutral display "someone", never the raw string.
 */
export function buildNameMap(members, asker, opts = {}) {
  const generic = new Set((opts.genericWords ?? []).map((w) => skeleton(String(w))).filter(Boolean));
  const list = (Array.isArray(members) ? members : []).map((m, i) => ({
    display: m?.display ?? "",
    aliases: m?.aliases ?? [],
    firstNames: opts.firstNameSource ? opts.firstNameSource(m, i) ?? [] : m?.firstNames ?? [],
    discordIds: (m?.discordIds ?? []).map(String),
    characterNames: m?.characterNames ?? [],
    guild: m?.guild ?? "",
    askerName: "",
    neutral: false,
  }));

  if (asker != null && asker !== "") {
    const a = typeof asker === "object" ? asker : null;
    const raw = a ? "" : String(asker).trim();
    const askerKey = a ? "" : skeleton(raw);
    const isId = /^\d{15,25}$/.test(raw);
    const known = list.some((m) =>
      a
        ? (a.discordIds ?? []).some((id) => m.discordIds.includes(String(id))) || (a.display && skeleton(a.display) === skeleton(m.display))
        : (isId && m.discordIds.includes(raw)) ||
          (!isId && askerKey && [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames].some((n) => skeleton(String(n)) === askerKey))
    );
    if (!known) {
      list.push({
        display: a ? a.display ?? "" : "",
        aliases: a?.aliases ?? [],
        firstNames: a?.firstNames ?? [],
        discordIds: a ? (a.discordIds ?? []).map(String) : isId ? [raw] : [],
        characterNames: a?.characterNames ?? [],
        guild: "",
        askerName: a || isId ? "" : raw,
        neutral: !a,
      });
    }
  }

  const entries = [];
  const names = new Map();
  const byToken = new Map();
  const ids = new Map();
  const owner = new Map(); // key -> {member, kind}

  const addName = (raw, kind, token, member) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const key = skeleton(raw);
    if (!key) return;
    const len = [...key].length;
    if (kind === "asker" && (len < 2 || RESERVED.has(key) || /^p\d+$/.test(key))) return;
    if (len < 2) throw new Error(`privacy: one-character name key (member ${member}, ${kind})`);
    if (RESERVED.has(key) || /^p\d+$/.test(key)) throw new Error(`privacy: reserved name key (member ${member}, ${kind})`);
    const prev = owner.get(key);
    if (prev && prev.member !== member) throw new Error(`privacy: duplicate name key across members ${prev.member} and ${member} (${prev.kind}, ${kind})`);
    if (prev) return;
    owner.set(key, { member, kind });
    entries.push({
      raw, key, kind, token, member,
      generic: generic.has(key) && (kind === "display" || kind === "alias" || kind === "asker"),
      lastWordLen: lastWordLen(raw),
    });
    names.set(key, token);
  };

  list.forEach((m, i) => {
    const token = `{P${i + 1}}`;
    byToken.set(token, { display: m.neutral || (!m.display && !m.aliases.length) ? "someone" : m.display || m.aliases[0] || "someone" });
    for (const id of m.discordIds) if (/^\d{15,25}$/.test(id) && !ids.has(id)) ids.set(id, token);
    addName(m.display, "display", token, i);
    for (const n of m.aliases) addName(n, "alias", token, i);
    for (const n of m.firstNames) addName(n, "first", token, i);
    for (const n of m.characterNames) addName(n, "character", token, i);
    addName(m.askerName, "asker", token, i);
  });
  list.forEach((m, i) => {
    if (!m.guild) return;
    const key = skeleton(m.guild);
    if (!key) return;
    if ([...key].length < 2) throw new Error(`privacy: one-character name key (guild of member ${i})`);
    const prev = owner.get(key);
    if (prev && prev.kind !== "guild") throw new Error(`privacy: duplicate name key between guild and member ${prev.member}`);
    if (prev) return;
    owner.set(key, { member: -1, kind: "guild" });
    entries.push({ raw: m.guild, key, kind: "guild", token: "{GUILD}", member: -1, generic: false, lastWordLen: lastWordLen(m.guild) });
    names.set(key, "{GUILD}");
  });

  return { entries, names, byToken, ids, surface: new Map(), generic };
}

// ---- matching ----

function restOfWord(el, b) {
  let j = b + 1;
  let rest = "";
  while (j < el.n && el.sp[j] === 0 && rest.length < 12) rest += el.c[j++];
  if (j < el.n && el.sp[j] === 0) return "#";
  if (rest === "" && j < el.n && el.sp[j] === 1 && (el.sf[j] === 39 || el.sf[j] === 8217) && el.c[j] === "s" && (j + 1 >= el.n || el.sp[j + 1] > 0)) return "";
  return rest;
}

function accept(entry, a, b, el, leetMatch) {
  let hasSep = false;
  for (let j = a + 1; j <= b; j++) {
    if (el.sp[j] > 3) return false;
    if (el.sp[j] > 0) hasSep = true;
  }
  const leftGlued = a > 0 && el.sp[a] === 0;
  const rightGlued = b + 1 < el.n && el.sp[b + 1] === 0;
  const rest = restOfWord(el, b);
  const restOk = SUFFIXES.has(rest);
  const len = entry.key.length;
  if (!entry.generic && entry.lastWordLen <= 1 && b + 1 < el.n && el.sp[b + 1] === 1 && (el.sf[b + 1] === 45 || el.sf[b + 1] === 95)) return false;
  if (leetMatch && (leftGlued || !restOk)) return false;
  if (hasSep) return len >= LONG_NAME_MIN && !entry.generic ? !leftGlued || restOk : !leftGlued && restOk;
  if (entry.generic) return !leftGlued && restOk;
  if (len >= LONG_NAME_MIN) return !leftGlued || restOk;
  if (len >= 4) return true;
  return !leftGlued && restOk;
}

function findMatches(seg, map) {
  const dec = decodeWithMap(seg);
  const el = elementsOf(dec.text);
  if (!el.n) return [];
  const v = textVariants(el.c);
  const plainVars = v.plain.map((str, idx) => ({ str, leet: idx > 0 }));
  const collVars = plainVars.map((p) => ({ ...collapseWithMap(p.str, el.sp), leet: p.leet }));
  const found = [];
  const diff = new Int32Array(el.n + 2);
  for (const entry of map.entries) {
    const key = entry.key;
    const L = key.length;
    const canLeet = entry.generic ? L >= 3 : L >= 5;
    const canCollapse = entry.generic ? L >= 3 : L >= 4;
    const run = (hay, needle, leet, first, last) => {
      let from = 0;
      let count = 0;
      for (;;) {
        const i = hay.indexOf(needle, from);
        if (i < 0 || count++ > 20000) break;
        from = i + 1;
        const a = first ? first[i] : i;
        const b = last ? last[i + needle.length - 1] : i + needle.length - 1;
        if (accept(entry, a, b, el, leet)) found.push({ a, b, entry });
        else if (L >= LONG_NAME_MIN && !leet && !first) {
          // A long name is present but rejected (glued both sides): shorter keys inside it must not
          // produce a partial replacement ("xx{P1}wickxx"); the guard blocks the whole thing.
          diff[a]++;
          diff[b + 1]--;
        }
      }
    };
    for (const pv of plainVars) if (!pv.leet || canLeet) run(pv.str, key, pv.leet, null, null);
    if (canCollapse) {
      const ck = collapse(key);
      for (const cv of collVars) if (!cv.leet || canLeet) run(cv.str, ck, cv.leet, cv.first, cv.last);
    }
  }
  if (!found.length) return [];
  // prefix counts of elements covered by a rejected long-name occurrence
  const covered = new Int32Array(el.n + 1);
  let run = 0;
  for (let i = 0; i < el.n; i++) {
    run += diff[i];
    covered[i + 1] = covered[i] + (run > 0 ? 1 : 0);
  }
  found.sort((x, y) => x.a - y.a || y.b - x.b);
  const out = [];
  let lastB = -1;
  for (const f of found) {
    if (f.a <= lastB) continue;
    if (covered[f.b + 1] - covered[f.a] === f.b - f.a + 1) continue;
    lastB = f.b;
    const startDec = el.s[f.a];
    const endDec = el.e[f.b];
    const start = dec.identity ? startDec : dec.os[startDec];
    const end = dec.identity ? endDec : dec.oe[endDec - 1];
    out.push({ start, end, entry: f.entry });
  }
  return out;
}

function recordSurface(map, entry, surface) {
  if (entry.token === "{GUILD}") return;
  const info = map.surface.get(entry.token);
  if (!entry.generic) {
    if (info) info.generic = false;
    else map.surface.set(entry.token, { generic: false, text: "" });
  } else if (!info) map.surface.set(entry.token, { generic: true, text: surface });
}

export function tokenise(text, map) {
  if (text == null) return "";
  const m = map && map.entries ? map : buildNameMap([]);
  let s = escapeUserTokens(baseNormalise(text));
  s = structural(s, m);
  const parts = s.split(TOKEN_SPLIT_RE);
  for (let p = 0; p < parts.length; p += 2) {
    const seg = parts[p];
    if (!seg) continue;
    const matches = findMatches(seg, m);
    if (!matches.length) continue;
    let out = "";
    let at = 0;
    for (const x of matches) {
      out += seg.slice(at, x.start) + x.entry.token;
      recordSurface(m, x.entry, seg.slice(x.start, x.end));
      at = x.end;
    }
    parts[p] = out + seg.slice(at);
  }
  return parts.join("");
}

/** Restore DISPLAY names (never first/real names) for tokens issued by this map; neutral word otherwise. */
export function detokenise(text, map) {
  if (text == null) return "";
  const m = map && map.byToken ? map : buildNameMap([]);
  return String(text)
    .replace(/\{P(\d+)\}/g, (tok) => {
      const info = m.surface?.get(tok);
      if (info && info.generic) return info.text;
      return m.byToken.get(tok)?.display ?? "someone";
    })
    .replace(/\{ID\}/g, "someone")
    .replace(/\{ALL\}/g, "everyone")
    .replace(/\{INVITE\}/g, "a link")
    .replace(/\{GUILD\}/g, "the server")
    .replace(USER_TOKEN_RE, "someone");
}
