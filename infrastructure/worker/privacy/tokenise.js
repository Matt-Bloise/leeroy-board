// Outbound privacy: replace people's names with stable tokens before any text leaves the
// Worker for a model provider, and restore display names in the reply.
//
// Pure and dependency-free. No I/O. Safe to import anywhere.
//
// Token vocabulary
//   {P1}..{Pn}  a member (n = position in the members array, asker appended when absent)
//   {ID}        any Discord id / channel or role mention we cannot attribute
//   {ALL}       @everyone / @here
//   {INVITE}    discord.gg / discord.com/invite links
//   {GUILD}     a guild (server) name
//
// Matching rules (see normalise): NFKC, zero-width and soft-hyphen stripped, diacritics
// stripped, Cyrillic/Greek lookalikes folded to Latin, case-insensitive. Names of 7 or more
// letters match as substrings (so "glued" forms are caught); shorter names match on word
// boundaries with an optional possessive/plural suffix, so a short name that is also a common
// word does not mangle longer words that merely contain it.

export const LONG_NAME_MIN = 7;

// Zero-width, bidi controls, soft hyphen, variation selectors, hangul fillers, tag characters.
const ZW_RE =
  /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|\uDB40[\uDC00-\uDDEF]/g;

// Cyrillic and Greek characters that render like Latin letters.
const CONFUSABLES = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H",
  "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
  "І": "I", "Ј": "J", "Ѕ": "S",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y",
  "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h",
  "ӏ": "l", "к": "k", "м": "m", "н": "h", "т": "t",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I",
  "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T",
  "Υ": "Y", "Χ": "X",
  "α": "a", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p",
  "τ": "t", "υ": "u", "χ": "x",
};

export function normalise(input) {
  let s = String(input ?? "");
  s = s.replace(ZW_RE, "");
  s = s.normalize("NFKC");
  s = s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  s = s.replace(ZW_RE, "");
  s = s.replace(/[Α-ωЀ-ӏԀ-ԁ]/g, (c) => CONFUSABLES[c] ?? c);
  s = s.replace(/[‘’‛ʼʹ′]/g, "'");
  return s;
}

const SEP = "[\\s\\-_.'\\u2010-\\u2015\\u2212\\u00b7]*";
const NOT_ALNUM = /[^\p{L}\p{N}]+/u;
const RESERVED = new Set(["id", "all", "invite", "guild"]);
const SPECIAL_RE = /\{(?:P\d+|ID|ALL|INVITE|GUILD)\}/i;

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/gi;
const MENTION_RE = /<(@[!&]?|#)\s*(\d{1,25})\s*>/g;
const RAW_ID_RE = /\d{17,}/g;
const EVERYONE_RE = /@(?:everyone|here)\b/gi;

export function compactKey(text) {
  return normalise(text).toLowerCase().split(NOT_ALNUM).filter(Boolean).join("");
}

function parseName(raw) {
  if (typeof raw !== "string") return null;
  const words = normalise(raw).toLowerCase().split(NOT_ALNUM).filter(Boolean);
  const key = words.join("");
  if (key.length < 2) return null;
  if (/^p\d+$/.test(key) || RESERVED.has(key)) return null;
  return { key, words, long: key.length >= LONG_NAME_MIN };
}

// Build { long, short } global regexes from parsed names. Longest name first so that
// "handsome pumpkin" wins over "pumpkin".
export function buildMatcher(parsed) {
  const seen = new Set();
  const uniq = [];
  for (const p of parsed) {
    if (!p || seen.has(p.key)) continue;
    seen.add(p.key);
    uniq.push(p);
  }
  uniq.sort((a, b) => b.key.length - a.key.length);
  const alt = (list) => list.map((p) => p.words.join(SEP)).join("|");
  const longs = uniq.filter((p) => p.long);
  const shorts = uniq.filter((p) => !p.long);
  return {
    long: longs.length ? new RegExp(`(${alt(longs)})`, "giu") : null,
    short: shorts.length
      ? new RegExp(
          `(?<![\\p{L}\\p{N}])(${alt(shorts)})(?=(?:'s|s'|s)?(?![\\p{L}\\p{N}]))`,
          "giu"
        )
      : null,
  };
}

export function matcherTest(matcher, normalisedText) {
  for (const rx of [matcher.long, matcher.short]) {
    if (!rx) continue;
    rx.lastIndex = 0;
    const m = rx.exec(normalisedText);
    if (m) return compactKey(m[1]);
  }
  return null;
}

function emptyMap() {
  return buildNameMap([]);
}

/**
 * members: [{display, aliases[], firstNames[], discordIds[], characterNames[], guild?}]
 * asker: optional string (display, alias, first name or discord id) or a member object.
 * Returns a map object:
 *   names:    Map compactName -> token   (display, aliases, first names, character names, guilds)
 *   byToken:  Map token -> { display, firstNames[] }
 *   ids:      Map discordId -> token
 * Tokens are assigned by member order; an asker not in the roster is appended last.
 */
export function buildNameMap(members, asker) {
  const list = (Array.isArray(members) ? members : []).map((m) => ({
    display: m?.display ?? "",
    aliases: m?.aliases ?? [],
    firstNames: m?.firstNames ?? [],
    discordIds: (m?.discordIds ?? []).map(String),
    characterNames: m?.characterNames ?? [],
    guild: m?.guild ?? "",
  }));

  if (asker != null && asker !== "") {
    const a = typeof asker === "object" ? asker : null;
    const needle = a ? null : compactKey(String(asker));
    const idNeedle = a ? null : String(asker).trim();
    const known = list.some((m) =>
      a
        ? (a.discordIds ?? []).some((id) => m.discordIds.includes(String(id))) ||
          (a.display && compactKey(a.display) === compactKey(m.display))
        : m.discordIds.includes(idNeedle) ||
          [m.display, ...m.aliases, ...m.firstNames].some((n) => compactKey(n) === needle)
    );
    if (!known) {
      if (a) {
        list.push({
          display: a.display ?? "", aliases: a.aliases ?? [], firstNames: a.firstNames ?? [],
          discordIds: (a.discordIds ?? []).map(String), characterNames: a.characterNames ?? [], guild: a.guild ?? "",
        });
      } else if (/^\d{17,20}$/.test(idNeedle)) {
        list.push({ display: "", aliases: [], firstNames: [], discordIds: [idNeedle], characterNames: [], guild: "" });
      } else {
        list.push({ display: String(asker), aliases: [], firstNames: [], discordIds: [], characterNames: [], guild: "" });
      }
    }
  }

  const names = new Map();
  const byToken = new Map();
  const ids = new Map();
  const parsedAll = [];
  const parsedFirst = [];
  const displayKeys = new Set();
  const guildNames = [];

  list.forEach((m, i) => {
    const token = `{P${i + 1}}`;
    const display = m.display || m.aliases[0] || m.characterNames[0] || "someone";
    byToken.set(token, { display, firstNames: m.firstNames.slice() });
    for (const id of m.discordIds) if (/^\d{17,20}$/.test(id) && !ids.has(id)) ids.set(id, token);
    for (const n of [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames]) {
      const p = parseName(n);
      if (!p) continue;
      if (!names.has(p.key)) names.set(p.key, token);
      parsedAll.push(p);
    }
    const dp = parseName(m.display);
    if (dp) displayKeys.add(dp.key);
    for (const n of m.aliases) {
      const ap = parseName(n);
      if (ap) displayKeys.add(ap.key);
    }
    for (const n of m.firstNames) {
      const p = parseName(n);
      if (p) parsedFirst.push(p);
    }
    const g = parseName(m.guild);
    if (g) guildNames.push(g);
  });

  for (const g of guildNames) {
    if (!names.has(g.key)) names.set(g.key, "{GUILD}");
    parsedAll.push(g);
  }

  const map = {
    names,
    byToken,
    ids,
    matcher: buildMatcher(parsedAll),
    // First names that are also someone's display/alias are display-safe; do not treat them as a leak.
    firstMatcher: buildMatcher(parsedFirst.filter((p) => !displayKeys.has(p.key))),
  };
  Object.defineProperty(map, "matcher", { enumerable: false });
  Object.defineProperty(map, "firstMatcher", { enumerable: false });
  return map;
}

export function tokenise(text, map) {
  if (text == null) return "";
  const m = map && map.names ? map : emptyMap();
  let s = normalise(text);
  s = s.replace(INVITE_RE, "{INVITE}");
  s = s.replace(MENTION_RE, (_all, kind, id) => (kind === "@" || kind === "@!" ? m.ids.get(id) ?? "{ID}" : "{ID}"));
  s = s.replace(RAW_ID_RE, (id) => m.ids.get(id) ?? "{ID}");
  s = s.replace(EVERYONE_RE, "{ALL}");
  for (const rx of [m.matcher.long, m.matcher.short]) {
    if (!rx) continue;
    rx.lastIndex = 0;
    s = s.replace(rx, (_all, name) => m.names.get(compactKey(name)) ?? "{ID}");
  }
  return s;
}

export function detokenise(text, map) {
  if (text == null) return "";
  const m = map && map.byToken ? map : emptyMap();
  return String(text)
    .replace(/\{\s*P\s*(\d+)\s*\}/gi, (_all, n) => m.byToken.get(`{P${Number(n)}}`)?.display ?? "someone")
    .replace(/\{\s*ID\s*\}/gi, "someone")
    .replace(/\{\s*ALL\s*\}/gi, "everyone")
    .replace(/\{\s*INVITE\s*\}/gi, "a link")
    .replace(/\{\s*GUILD\s*\}/gi, "the server");
}

export function carriesFirstName(text, map) {
  if (!text || !map || !map.firstMatcher) return false;
  return matcherTest(map.firstMatcher, normalise(text)) !== null;
}

export function hasSpecialToken(text) {
  return SPECIAL_RE.test(String(text ?? ""));
}
