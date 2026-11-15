// Outbound privacy: replace people's names with unforgeable per-request tokens before text
// leaves the Worker for a model provider, and restore DISPLAY names in the reply.
//
// Pure and dependency-free (apart from skeleton.js). No I/O. This is the BEST-EFFORT layer:
// outbound-guard.js is the independent fail-closed net behind it and shares no code with this.
//
// Wiring contract: the system prompt, party block and asker label are built with tokens BY
// CONSTRUCTION (map.tokenFor(i), map.askerToken); tokenise() is for the free text a friend
// controls (the question, the previous turn). Then guardUserText(...) on those segments and
// guardBody(...) on the whole body.
//
// Tokens carry a per-request nonce: {P1.k7f2}, {ID.k7f2}, {ALL.k7f2}, {INVITE.k7f2},
// {GUILD.k7f2}. A user cannot forge one, user-typed token-looking text is escaped to [P1], and
// detokenise() restores only this request's tokens (a bare {P1} from a model becomes "someone").
//
// Output of tokenise(): the input after NFKC and removal of invisible format characters, with
// the matched spans replaced. Accents, Cyrillic prose and emoji are kept as typed.
//
// Matching (per key, on the skeleton of the text, mapped back to original offsets):
//  - separators tolerated between letters, up to 3 in a row; invisible/combining characters
//    ignored; lookalike letters folded; HTML entities, %-escapes and \u escapes decoded first;
//    leet digits (5+ letter keys) and doubled letters (4+) tolerated
//  - keys of 7+ letters match anywhere unless glued to letters on BOTH sides
//  - keys of 5-6 letters match anywhere (healCorwin)
//  - keys of 4 letters or fewer match only as whole words (with 's, s, es, y, ie, ies)
//  - generic aliases (opts.genericAliases, explicit lowercase list) are NOT tokenised and never
//    restored: a reply using the plain word stays plain
//  - a name whose last word is one letter ("Big T") does not match inside a compound ("t-shirt")
//  - ids: 15+ digits in ONE token (spaced number lists are left alone)

import { elementsOf, skeleton, textVariants, collapse, collapseWithMap, decodeWithMap, ndValue } from "./skeleton.js";

export const LONG_NAME_MIN = 7;

const RESERVED = new Set(["id", "all", "guild", "invite", "everyone", "here", "someone"]);
const SUFFIXES = new Set(["", "s", "es", "y", "ie", "ies"]);
const USER_TOKEN_RE = /\{\s{0,3}(?:p\s{0,3}\d{1,4}|id|all|invite|guild)[^{}]{0,14}\}/gi;

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\s{0,3}\.\s{0,3}gg|dsc\s{0,3}\.\s{0,3}gg|discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}invites?|discord\s{0,3}\.\s{0,3}me)\s{0,3}\/\s{0,3}[\w-]+/gi;
const USER_URL_RE = /(?:https?:\/\/)?(?:www\.)?discord(?:app)?\s{0,3}\.\s{0,3}com\s{0,3}\/\s{0,3}(?:users|channels)\s{0,3}\/\s{0,3}[\d\/ ]+/gi;
const MENTION_RE = /<\s{0,3}(@\s{0,3}[!&]?|#)\s{0,3}(\d[\d ]{0,30})\s{0,3}>/g;
const RAW_ID_RE = /\d{15,}/g;
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
  return s.replace(USER_TOKEN_RE, (m) => `[${m.slice(1, -1).replace(/\s+/g, "").toUpperCase()}]`);
}

function structural(s, map) {
  const t = map.special;
  s = s.replace(INVITE_RE, t.INVITE);
  s = s.replace(USER_URL_RE, t.ID);
  s = s.replace(MENTION_RE, (_m, kind, id) => {
    const digits = id.replace(/\D/g, "");
    const k = kind.replace(/\s+/g, "");
    return k === "@" || k === "@!" ? map.ids.get(digits) ?? t.ID : t.ID;
  });
  s = s.replace(RAW_ID_RE, (m) => map.ids.get(m) ?? t.ID);
  s = s.replace(EVERYONE_RE, t.ALL);
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

function makeNonce() {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 4);
}

/**
 * members: [{display, aliases[], firstNames[], discordIds[], characterNames[], guild?}]
 * asker:   optional string (display, alias, first name or discord id) or member object.
 * opts:    { genericAliases: string[]   explicit lowercase game-word aliases left untokenised,
 *            firstNameSource: (member, index) => string[]   injectable first/real names,
 *            nonce: string   fixed nonce (tests only) }
 *
 * Returns { entries, names, byToken, ids, nonce, special, tokenFor(i), askerToken }.
 * Throws (no values in the message) on one-character or reserved names and on duplicate keys
 * across members. An asker not in the roster gets a token and the neutral display "someone".
 */
export function buildNameMap(members, asker, opts = {}) {
  const nonce = opts.nonce ?? makeNonce();
  const generic = new Set((opts.genericAliases ?? []).map((w) => skeleton(String(w))).filter(Boolean));
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

  let askerIndex = -1;
  if (asker != null && asker !== "") {
    const a = typeof asker === "object" ? asker : null;
    const raw = a ? "" : String(asker).trim();
    const askerKey = a ? "" : skeleton(raw);
    const isId = /^\d{15,25}$/.test(raw);
    askerIndex = list.findIndex((m) =>
      a
        ? (a.discordIds ?? []).some((id) => m.discordIds.includes(String(id))) || (a.display && skeleton(a.display) === skeleton(m.display))
        : (isId && m.discordIds.includes(raw)) ||
          (!isId && askerKey && [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames].some((n) => skeleton(String(n)) === askerKey))
    );
    if (askerIndex < 0) {
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
      askerIndex = list.length - 1;
    }
  }

  const tok = (name) => `{${name}.${nonce}}`;
  const special = { ID: tok("ID"), ALL: tok("ALL"), INVITE: tok("INVITE"), GUILD: tok("GUILD") };
  const tokenFor = (i) => tok(`P${i + 1}`);

  const entries = [];
  const names = new Map();
  const byToken = new Map();
  const ids = new Map();
  const owner = new Map();

  const addName = (raw, kind, token, member) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const key = skeleton(raw);
    if (!key) return;
    const len = [...key].length;
    if (kind === "asker" && (len < 2 || RESERVED.has(key) || /^p\d+$/.test(key))) return;
    if (kind === "alias" && generic.has(key)) return; // generic word: left alone on purpose
    if (len < 2) throw new Error(`privacy: one-character name key (member ${member}, ${kind})`);
    if (RESERVED.has(key) || /^p\d+$/.test(key)) throw new Error(`privacy: reserved name key (member ${member}, ${kind})`);
    const prev = owner.get(key);
    if (prev && prev.member !== member) throw new Error(`privacy: duplicate name key across members ${prev.member} and ${member} (${prev.kind}, ${kind})`);
    if (prev) return;
    owner.set(key, { member, kind });
    entries.push({ raw, key, kind, token, member, lastWordLen: lastWordLen(raw) });
    names.set(key, token);
  };

  list.forEach((m, i) => {
    const token = tokenFor(i);
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
    entries.push({ raw: m.guild, key, kind: "guild", token: special.GUILD, member: -1, lastWordLen: lastWordLen(m.guild) });
    names.set(key, special.GUILD);
  });

  const esc = nonce.replace(/[^a-z0-9]/gi, "");
  return {
    entries, names, byToken, ids, nonce, special, tokenFor,
    askerToken: askerIndex >= 0 ? tokenFor(askerIndex) : null,
    splitRe: new RegExp(`(\\{(?:P\\d+|ID|ALL|INVITE|GUILD)\\.${esc}\\})`),
    tokRe: new RegExp(`\\{(P\\d+|ID|ALL|INVITE|GUILD)\\.${esc}\\}`, "g"),
  };
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
  void rightGlued;
  const restOk = SUFFIXES.has(restOfWord(el, b));
  const len = entry.key.length;
  if (entry.lastWordLen <= 1 && b + 1 < el.n && el.sp[b + 1] === 1 && (el.sf[b + 1] === 45 || el.sf[b + 1] === 95)) return false;
  if (leetMatch && (leftGlued || !restOk)) return false;
  if (hasSep) return len >= LONG_NAME_MIN ? !leftGlued || restOk : !leftGlued && restOk;
  if (len >= LONG_NAME_MIN) return !leftGlued || restOk;
  if (len >= 5) return true;
  return !leftGlued && restOk; // 4 letters or fewer: whole word only
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
    const canLeet = L >= 5;
    const canCollapse = L >= 4;
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
          // produce a partial replacement; the guard blocks the whole thing.
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
  const covered = new Int32Array(el.n + 1);
  let acc = 0;
  for (let i = 0; i < el.n; i++) {
    acc += diff[i];
    covered[i + 1] = covered[i] + (acc > 0 ? 1 : 0);
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
    out.push({
      start: dec.identity ? startDec : dec.os[startDec],
      end: dec.identity ? endDec : dec.oe[endDec - 1],
      entry: f.entry,
    });
  }
  return out;
}

export function tokenise(text, map) {
  if (text == null) return "";
  const m = map && map.entries ? map : buildNameMap([]);
  let s = escapeUserTokens(baseNormalise(text));
  s = structural(s, m);
  const parts = s.split(m.splitRe);
  for (let p = 0; p < parts.length; p += 2) {
    const seg = parts[p];
    if (!seg) continue;
    const matches = findMatches(seg, m);
    if (!matches.length) continue;
    let out = "";
    let at = 0;
    for (const x of matches) {
      out += seg.slice(at, x.start) + x.entry.token;
      at = x.end;
    }
    parts[p] = out + seg.slice(at);
  }
  return parts.join("");
}

/**
 * Restore DISPLAY names (never first/real names) for tokens issued by THIS map; anything that
 * looks like a token but is not (bare {P1}, wrong nonce, spaced forms) becomes "someone".
 */
export function detokenise(text, map) {
  if (text == null) return "";
  const m = map && map.byToken ? map : buildNameMap([]);
  m.tokRe.lastIndex = 0;
  return String(text)
    .replace(m.tokRe, (tokStr, kind) => {
      if (kind === "ID") return "someone";
      if (kind === "ALL") return "everyone";
      if (kind === "INVITE") return "a link";
      if (kind === "GUILD") return "the server";
      return m.byToken.get(tokStr)?.display ?? "someone";
    })
    .replace(USER_TOKEN_RE, "someone");
}
