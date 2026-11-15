// Property and attack tests for the outbound-privacy modules (tokenise.js, outbound-guard.js,
// skeleton.js). Pure and offline. Fixtures are fictional; the live roster is used only at
// runtime and only counts and class names are ever printed.
// Run: node --test tests/unit/privacy-tokenise.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildNameMap, tokenise, detokenise } from "../../infrastructure/worker/privacy/tokenise.js";
import {
  guardUserText,
  scanUserText,
  guardBody,
  scanBody,
  replyLeaksIdentity,
  scrubSearchQuery,
  parseRoster,
  CANARY,
} from "../../infrastructure/worker/privacy/outbound-guard.js";
import { skeleton } from "../../infrastructure/worker/privacy/skeleton.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";

const PRIV = fileURLToPath(new URL("../../infrastructure/worker/privacy/", import.meta.url));

// ---------- seeded RNG ----------
function rngFrom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    digits: (n) => {
      let s = String(1 + Math.floor(next() * 9));
      for (let i = 1; i < n; i++) s += Math.floor(next() * 10);
      return s;
    },
  };
}

// ---------- fictional fixtures ----------
const FIC = [
  { display: "Thornwick", aliases: ["Thorn", "Big T"], firstNames: ["Alderic"], discordIds: ["112233445566778899"], characterNames: ["Zorrin Quillfeather"], guild: "Examplehold Raiders" },
  { display: "Mossbeard", aliases: ["Tank", "Captain"], firstNames: ["Brenna"], discordIds: ["223344556677889900"], characterNames: ["Pyrelle"], guild: "" },
  { display: "Bjørn", aliases: ["Jess"], firstNames: ["Corwin"], discordIds: [], characterNames: [], guild: "" },
];
const FIC_GENERIC = ["tank", "captain"];
const ROSTER = { members: FIC, genericAliases: FIC_GENERIC };
const NONCE = "k7f2";
const mapFor = (asker) => buildNameMap(FIC, asker ?? null, { genericAliases: FIC_GENERIC, nonce: NONCE });
const FMAP = mapFor();
const allNames = (members, generic) =>
  members.flatMap((m) => [m.display, ...m.aliases, ...(m.firstNames ?? []), ...(m.characterNames ?? [])]).filter((n) => n && !generic.includes(skeleton(n)));
const LONG_POOL = allNames(FIC, FIC_GENERIC).filter((n) => skeleton(n).length >= 5);
const SHORT_POOL = allNames(FIC, FIC_GENERIC).filter((n) => skeleton(n).length <= 4);

// ---------- mutation classes (the attack table) ----------
const CYR = { a: "а", e: "е", o: "о", p: "р", c: "с", y: "у", x: "х", i: "і", s: "ѕ", h: "һ", k: "к", m: "м", t: "т" };
const CYR_UNMAPPED = { r: "г", n: "п", b: "ь", w: "ԝ", q: "ԛ", v: "ѵ", u: "и", g: "ԍ" };
const GRK_UNMAPPED = { e: "ε", n: "η", y: "γ", w: "ω", u: "μ", b: "β", s: "ς", r: "г" };
const SMALLCAP = { a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", r: "ʀ", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", y: "ʏ", z: "ᴢ" };
const LISU = { a: "ꓮ", c: "ꓚ", h: "ꓧ", t: "ꓔ", o: "ꓫ", n: "ꓠ", e: "ꓱ" };
const CHEROKEE = { a: "Ꭺ", b: "Ᏼ", c: "Ꮯ", d: "Ꭰ", e: "Ꭼ", h: "Ꮋ", l: "Ꮮ", m: "Ꮇ", o: "Ꭴ", p: "Ꮲ", r: "Ꭱ", s: "Ꮪ", t: "Ꭲ", z: "Ꮓ" };
const COPTIC = { o: "ⲟ", a: "ⲁ", e: "ⲍ", i: "ⲣ", s: "ⲏ", c: "ⲥ", x: "ⲭ" };
const IPA = { a: "ɑ", e: "ɛ", o: "ɔ", g: "ɡ", i: "ɨ", u: "ʊ", b: "ɓ", d: "ɗ", n: "ɲ", r: "ɾ" };
const LEET = { o: "0", e: "3", i: "1", a: "4", s: "5", t: "7" };
const sub = (n, tbl, max = 99) => { let c = 0; return [...n].map((ch) => (tbl[ch.toLowerCase()] && c++ < max ? tbl[ch.toLowerCase()] : ch)).join(""); };
const mid = (n, ins) => { const a = [...n]; const k = Math.max(1, Math.floor(a.length / 2)); return a.slice(0, k).join("") + ins + a.slice(k).join(""); };
const fullw = (n) => [...n].map((c) => (/[!-~]/.test(c) ? String.fromCodePoint(c.codePointAt(0) + 0xfee0) : c)).join("");
const negsq = (n) => [...n].map((c) => (/[a-z]/i.test(c) ? String.fromCodePoint(0x1f170 + c.toLowerCase().charCodeAt(0) - 97) : c)).join("");
const mathBold = (n) => [...n].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(0x1d41a + c.charCodeAt(0) - 97) : /[A-Z]/.test(c) ? String.fromCodePoint(0x1d400 + c.charCodeAt(0) - 65) : c)).join("");
const lettersOnly = (n) => n.replace(/ /g, "");
const b64 = (s) => Buffer.from(s).toString("base64");
const GLUED = new Set(["glued letters after", "glued letters before", "glued digit after", "custom emoji :namelol:", "underscore join"]);
const CLASSES = {
  plain: (n) => n, upper: (n) => n.toUpperCase(), lower: (n) => n.toLowerCase(),
  "possessive 's": (n) => n + "'s", "curly possessive": (n) => n + "’s", "plural s": (n) => n + "s", "s' form": (n) => n + "s'",
  "plural -es": (n) => n + "es", "diminutive -y/-ie": (n) => n + "y",
  "glued letters after": (n) => n + "main", "glued letters before": (n) => "heal" + n, "glued digit after": (n) => n + "2",
  "custom emoji :namelol:": (n) => ":" + n + "lol:", "underscore join": (n) => n + "_alt",
  "zero-width mid": (n) => mid(n, "​"), "soft hyphen mid": (n) => mid(n, "­"),
  "NBSP for spaces": (n) => n.replace(/ /g, " "), "hyphen for spaces": (n) => n.replace(/ /g, "-"),
  "hyphen mid-word": (n) => mid(lettersOnly(n), "-"), "space mid-word": (n) => mid(lettersOnly(n), " "),
  "dots between letters": (n) => [...lettersOnly(n)].join("."), "spaces between letters": (n) => [...lettersOnly(n)].join(" "),
  "markdown mid (**)": (n) => mid(n, "**"), "slash/comma mid": (n) => mid(n, "/"),
  fullwidth: fullw, "cyrillic (table-covered)": (n) => sub(n, CYR), "cyrillic (uncovered letters)": (n) => sub(n, CYR_UNMAPPED),
  "greek (uncovered letters)": (n) => sub(n, GRK_UNMAPPED), "latin small caps (blocked script)": (n) => sub(n, SMALLCAP),
  "negative-squared letters": negsq, "math bold": mathBold, "zalgo combining marks": (n) => [...n].map((c) => c + "̶́").join(""),
  "braille blank mid": (n) => mid(n, "⠀"), "Cf not in strip list (U+1D173)": (n) => mid(n, "\u{1D173}"),
  "interlinear Cf (U+FFF9)": (n) => mid(n, "￹"), "hangul filler mid": (n) => mid(n, "ㅤ"),
  "leet one char": (n) => sub(n, LEET, 1), "leet all": (n) => sub(n, LEET), "repeated letter": (n) => mid(n, [...n][Math.floor([...n].length / 2) - 1] || ""),
  "url-encoded": (n) => [...n].map((c) => "%" + c.charCodeAt(0).toString(16)).join(""),
  "url-encoded utf8": (n) => encodeURIComponent(n).replace(/[A-Za-z]/g, (c) => "%" + c.charCodeAt(0).toString(16)),
  base64: (n) => b64(n), "base64 unpadded": (n) => b64(n).replace(/=+$/, ""), "base64 url-safe": (n) => b64(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  "base64 double": (n) => b64(b64(n)), hex: (n) => Buffer.from(n).toString("hex"),
  "html entity mid": (n) => mid(n, "&#8203;"), "html entity letters": (n) => [...n].map((c) => `&#${c.codePointAt(0)};`).join(""),
  "html entity wide hex": (n) => [...n].map((c) => `&#x${c.codePointAt(0).toString(16).padStart(8, "0")};`).join(""),
  "literal \\u escape": (n) => [...n].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join(""),
  "literal \\u{} escape": (n) => [...n].map((c) => `\\u{${c.codePointAt(0).toString(16)}}`).join(""),
  "stroke letters folded to ascii": (n) => n.replace(/ø/g, "o"),
  "lisu lookalikes (blocked script)": (n) => sub(n, LISU, 2), "cherokee lookalikes (blocked script)": (n) => sub(n, CHEROKEE, 2),
  "coptic lookalikes (blocked script)": (n) => sub(n, COPTIC, 2), "ipa lookalikes (blocked script)": (n) => sub(n, IPA, 2),
  "phonetic ligature (blocked script)": (n) => mid(n, "ᵺ"), "RLO reversed": (n) => "‮" + [...n].reverse().join(""),
  "reversed plain": (n) => [...n].reverse().join(""),
  "unicode tag chars": (n) => [...n].map((c) => c + String.fromCodePoint(0xe0000 + 0x41)).join(""),
  "partial first 5": (n) => [...lettersOnly(n)].slice(0, 5).join("") + "x", "partial last 5": (n) => "x" + [...lettersOnly(n)].slice(-5).join(""),
};
// partial classes only apply to keys of 7+ letters
const PARTIAL = new Set(["partial first 5", "partial last 5"]);
// classes a 4-letter-or-shorter key (whole-word matching only) must still catch
const SHORT_OK = new Set(["plain", "upper", "lower", "possessive 's", "curly possessive", "plural s", "s' form", "plural -es", "diminutive -y/-ie", "NBSP for spaces", "hyphen for spaces", "underscore join", "base64", "base64 unpadded", "hex", "literal \\u escape"]);
const TEMPLATES = ["did § log on", "ok so § pulled early again lol", "§", "(§)", "tell §, please", "\n§\n", "is it true that §?", "§: where r u", "no way §... really", "\"§\" wrote that"];

const TOKEN = /\{(?:P\d+|ID|ALL|INVITE|GUILD)\.[a-z0-9]+\}/;
const flagged = (text, roster, opts) => scanUserText([text], roster, opts).length > 0;

function eligible(cls, pool, shortPool) {
  if (PARTIAL.has(cls)) return pool.filter((n) => skeleton(n).length >= 7);
  return SHORT_OK.has(cls) ? [...pool, ...shortPool] : pool;
}

// Returns per class: n, rawSilent (guard missed a raw leak), missed (tokeniser made no token),
// silentMiss (tokeniser missed AND guard silent on the outbound text).
function runClasses({ pool, shortPool, roster, map, perClass, seed, classNames }) {
  const rng = rngFrom(seed);
  const res = {};
  for (const cls of classNames ?? Object.keys(CLASSES)) {
    const fn = CLASSES[cls];
    const r = (res[cls] = { n: 0, missed: 0, silentMiss: 0, rawSilent: 0 });
    const names = eligible(cls, pool, shortPool);
    if (!names.length) continue;
    for (let i = 0; i < perClass; i++) {
      const name = names[rng.int(names.length)];
      const mutated = fn(name);
      if (mutated === name && cls !== "plain") continue;
      const text = TEMPLATES[rng.int(TEMPLATES.length)].replace("§", mutated);
      const out = tokenise(text, map);
      const missed = !TOKEN.test(out);
      r.n++;
      if (missed) r.missed++;
      if (missed && !flagged(out, roster)) r.silentMiss++;
      if (!flagged(text, roster)) r.rawSilent++;
    }
  }
  return res;
}
const summarize = (res, keys) => Object.entries(res).filter(([, r]) => keys.some((k) => r[k] > 0)).map(([c, r]) => `${c}: ${keys.map((k) => `${k}=${r[k]}`).join(" ")}`);

// ---------- 1. fail closed on a bad roster ----------
test("guards throw (fail closed) on a missing, empty or mistyped roster or a member with no key", () => {
  const bad = [undefined, null, {}, [], { members: [] }, { members: "x" }, [{}], [{ display: "" }], [{ display: "Okname" }, { aliases: [] }], [{ display: "Okname", aliases: "x" }], [{ display: 5 }], [{ display: "Okname" }, null], [{ display: "A" }], [{ display: "Okname", discordIds: "1" }], { members: FIC, genericAliases: "tank" }, { members: FIC, genericAliases: ["Tank"] }, [{ display: "Tank", aliases: [] }].concat([]).slice(1)];
  for (const r of bad) {
    for (const fn of [(x) => guardUserText(["hello"], x), (x) => scanUserText(["hello"], x), (x) => guardBody({ a: "hello" }, x), (x) => scanBody({ a: "hello" }, x), (x) => replyLeaksIdentity("hello", x), (x) => scrubSearchQuery("hello", x), (x) => parseRoster(x)]) {
      assert.throws(() => fn(r), (e) => e.code === "OUTBOUND_GUARD_CONFIG" && !/hello/.test(e.message), JSON.stringify(r)?.slice(0, 40));
    }
  }
  // a member whose only name is a generic alias yields no key either
  assert.throws(() => parseRoster({ members: [{ display: "", aliases: ["tank"] }], genericAliases: ["tank"] }), /no key/);
  assert.doesNotThrow(() => parseRoster(ROSTER));
});

// ---------- 2. attack table, raw text, guard alone (independent of the tokeniser) ----------
test("guardUserText flags every attack class on raw text (fictional roster)", () => {
  const res = runClasses({ pool: LONG_POOL, shortPool: SHORT_POOL, roster: ROSTER, map: FMAP, perClass: 14, seed: 1234567 });
  assert.deepEqual(summarize(res, ["rawSilent"]), []);
  const total = Object.values(res).reduce((a, r) => a + r.n, 0);
  assert.ok(total >= 700, `prompts run: ${total}`);
});

test("pipeline: tokenise then guard leaves no silent miss (fictional roster)", () => {
  const res = runClasses({ pool: LONG_POOL, shortPool: SHORT_POOL, roster: ROSTER, map: FMAP, perClass: 14, seed: 77 });
  assert.deepEqual(summarize(res, ["silentMiss"]), []);
  for (const cls of ["plain", "upper", "possessive 's", "plural s", "zero-width mid", "soft hyphen mid", "NBSP for spaces", "hyphen for spaces", "fullwidth", "cyrillic (table-covered)", "cyrillic (uncovered letters)", "greek (uncovered letters)", "math bold", "zalgo combining marks", "braille blank mid", "Cf not in strip list (U+1D173)", "interlinear Cf (U+FFF9)", "hangul filler mid", "plural -es", "diminutive -y/-ie", "dots between letters", "spaces between letters", "markdown mid (**)", "url-encoded", "html entity mid", "html entity letters", "html entity wide hex", "literal \\u escape", "repeated letter"]) {
    assert.equal(res[cls].missed, 0, `tokeniser missed class "${cls}" ${res[cls].missed}/${res[cls].n}`);
  }
});

test("attack table, live roster (runtime-derived, counts only): 742+ prompts, 0 guard-silent leaks", () => {
  const members = ROSTER_DATA.map((r) => ({ display: r.display, aliases: r.aliases, firstNames: [], discordIds: [], characterNames: [] }));
  // generic = single-word aliases of up to 5 letters that are not the member's own display key
  const genericAliases = ROSTER_DATA.flatMap((r) => r.aliases.filter((a) => !/\s/.test(a) && a.length <= 5 && skeleton(a) !== skeleton(r.display))).map((a) => a.toLowerCase());
  const roster = { members, genericAliases };
  const map = buildNameMap(members, null, { genericAliases, nonce: NONCE });
  const gKeys = genericAliases.map(skeleton);
  const pool = allNames(members, gKeys);
  const long = pool.filter((n) => skeleton(n).length >= 5);
  const short = pool.filter((n) => skeleton(n).length <= 4);
  const raw = runClasses({ pool: long, shortPool: short, roster, map, perClass: 16, seed: 987654 });
  const pipe = runClasses({ pool: long, shortPool: short, roster, map, perClass: 16, seed: 31 });
  assert.deepEqual(summarize(raw, ["rawSilent"]), []);
  assert.deepEqual(summarize(pipe, ["silentMiss"]), []);
  const total = Object.values(raw).reduce((a, r) => a + r.n, 0);
  assert.ok(total >= 742, `prompts run: ${total}`);
});

test("names split across segments are caught (joined scan)", () => {
  assert.throws(() => guardUserText(["Alde", "ric"], ROSTER), /leak/);
  assert.throws(() => guardUserText(["hello", "Zor", "rin"], ROSTER), /leak/);
  assert.throws(() => scanUserText(["a"], ROSTER) && guardUserText(["Thorn", "wick"], ROSTER));
});

test("partial names block (first 5 / last 5 letters of 7+ letter keys)", () => {
  for (const t of ["Zorrin did it", "Alderi said", "ask Quillfeather", "Pyrel and Mossb", "thornw"]) assert.ok(flagged(t, ROSTER), t);
});

// ---------- 3. short words, askers and over-blocking ----------
test("4-letter-or-shorter names match whole words only; unknown short askers do not block name-free text", () => {
  const innocent = "Alabama alloys, Ianthe and the Samurai joking about the annual plans; Jonas said hello. Also all of Annapolis.";
  for (const asker of ["Ann", "Al", "Ian", "Sam", "Jo"]) {
    assert.deepEqual(scanUserText([innocent], ROSTER, { asker }), [], asker);
    assert.ok(flagged(`so ${asker} said hi`, ROSTER, { asker }), asker);
    assert.ok(flagged(`so ${asker}'s plan`, ROSTER, { asker }), asker);
    const m = mapFor(asker);
    assert.equal(detokenise(m.askerToken, m), "someone");
    assert.equal(tokenise(innocent, m), innocent);
    assert.equal(tokenise(`so ${asker} said hi`, m), `so ${m.askerToken} said hi`);
  }
  assert.ok(flagged("Jess is here", ROSTER) && !flagged("Jessica is here", ROSTER));
  assert.ok(flagged("is that Big T?", ROSTER) && !flagged("a big tank", ROSTER));
});

test("number lists are left intact; 15+ digit single tokens are ids", () => {
  for (const t of ["120 180 300 600 900 1200", "6, 12, 22, 32, 42, 52, 60; 20", "levels 10-20, 21-30 and 1,000,000,000 gold"]) {
    assert.equal(tokenise(t, FMAP), t);
    assert.deepEqual(scanUserText([t], ROSTER), [], t);
    assert.deepEqual(scanBody({ a: t }, ROSTER), [], t);
  }
  assert.equal(tokenise("friend 998877665544332211 and 112233445566778899", FMAP), `friend ${FMAP.special.ID} and {P1.${NONCE}}`);
  assert.ok(flagged("friend 998877665544332211", ROSTER));
  assert.ok(flagged("id 112 233 445 566 778 899", ROSTER), "a known id is caught even when spaced out");
  assert.ok(scanBody({ a: "998877665544332211" }, ROSTER).length > 0);
});

// ---------- 4. generic aliases ----------
test("generic aliases are never tokenised or restored (no corrupted prompts or replies)", () => {
  const members = [{ display: "Mossbeard", aliases: ["Paladin", "Tank"] }, { display: "Thornwick", aliases: [] }];
  const m = buildNameMap(members, null, { genericAliases: ["paladin", "tank"], nonce: NONCE });
  for (const t of ["we need a tank for the class paladin", "Protection Paladins are strong", "the tank's cooldowns"]) assert.equal(tokenise(t, m), t);
  assert.equal(detokenise("Protection Paladins and the tank", m), "Protection Paladins and the tank");
  assert.equal(tokenise("Mossbeard asks", m), `{P1.${NONCE}} asks`);
  // without the allowlist the same alias is a key
  const strict = buildNameMap(members, null, { nonce: NONCE });
  assert.equal(tokenise("class paladin", strict), `class {P1.${NONCE}}`);
  // guard: generic words are plain words, display names are not
  assert.deepEqual(scanUserText(["the paladin tank class", "rather weather"], { members, genericAliases: ["paladin", "tank"] }), []);
  assert.ok(flagged("ask Mossbeard", { members, genericAliases: ["paladin", "tank"] }));
});

// ---------- 5. tokeniser ----------
test("tokeniser: partial hits, glue, separators, encodings, leet, doubled letters", () => {
  const m = () => mapFor();
  const T = (s) => `{P1.${NONCE}}`.replace("P1", s);
  assert.equal(tokenise("Thorn-wick", m()), T("P1"));
  assert.equal(tokenise("Thorn wick and Thorn.wick", m()), `${T("P1")} and ${T("P1")}`);
  assert.equal(tokenise("healCorwin", m()), `heal${T("P3")}`);
  assert.equal(tokenise("&#84;hornwick %54hornwick Thorn&#8203;wick", m()), `${T("P1")} ${T("P1")} ${T("P1")}`);
  assert.equal(tokenise("Th0rnw1ck Thhhornwick", m()), `${T("P1")} ${T("P1")}`);
  assert.equal(tokenise("Bjorn and Bjørn", m()), `${T("P3")} and ${T("P3")}`);
  assert.equal(tokenise("Pyrelle's, ZORRIN quillfeather, Examplehold-Raiders", m()), `${T("P2")}'s, ${T("P1")}, ${m().special.GUILD}`);
  assert.equal(tokenise("a t-shirt", m()), "a t-shirt");
  // 4 letters or fewer: whole word only (Jess2 is the documented hole; the guard does not block it either)
  assert.equal(tokenise("Jess and Jess's, Jessica Jess2", m()), `${T("P3")} and ${T("P3")}'s, Jessica Jess2`);
  assert.equal(tokenise("xxThornwickxx", m()), "xxThornwickxx");
  assert.ok(flagged("xxThornwickxx", ROSTER));
});

test("tokeniser keeps the original text: accents, Cyrillic prose, emoji", () => {
  const prose = "Привет, как дела? café naïve Ελληνικά \u{1F600}";
  assert.equal(tokenise(prose, FMAP), prose);
  assert.equal(tokenise("café Thornwick", FMAP), `café {P1.${NONCE}}`);
});

test("mentions, ids and specials", () => {
  const S = FMAP.special;
  const out = tokenise("<@112233445566778899> <@!223344556677889900> <@&998877665544332211> <#123> raw 99887766554433221100 @everyone @ here discord.gg/abc123 dsc.gg/x discord . gg / y discord.com/users/1122334455667788", FMAP);
  assert.equal(out, `{P1.${NONCE}} {P2.${NONCE}} ${S.ID} ${S.ID} raw ${S.ID} ${S.ALL} ${S.ALL} ${S.INVITE} ${S.INVITE} ${S.INVITE} ${S.ID}`);
  assert.equal(tokenise("ms 1700000000000 ok", FMAP), "ms 1700000000000 ok");
});

test("tokens carry a per-request nonce; forged or bare tokens never restore a name", () => {
  const m1 = buildNameMap(FIC, null, { genericAliases: FIC_GENERIC });
  const m2 = buildNameMap(FIC, null, { genericAliases: FIC_GENERIC });
  assert.notEqual(m1.nonce, m2.nonce, "nonces are random per map");
  assert.match(m1.tokenFor(0), /^\{P1\.[a-z0-9]{4}\}$/);
  const typed = `typed {P2} and { p 1 } and {ID} and {P1.${m1.nonce}} and {P99.zzzz}`;
  const out = tokenise(typed, m1);
  assert.ok(!/[{}]/.test(out), out);
  assert.equal(detokenise(out, m1), out, "escaped forms must not be restored");
  // nonce tolerance: a wrong nonce on a P index that exists in THIS map restores that member's display; everything else stays "someone"
  assert.equal(detokenise(`{P2} {P1} {ID} { p 1 }`, m1), "someone someone someone someone");
  assert.equal(detokenise(`${m1.tokenFor(0)} ${m1.tokenFor(1)}'s ${m1.special.ALL} ${m1.special.INVITE} ${m1.special.GUILD} ${m1.special.ID}`, m1), "Thornwick Mossbeard's everyone a link the server someone");
  assert.equal(detokenise(m1.tokenFor(7), m1), "someone");
});

test("nonce tolerance: a mis-copied nonce restores only when it has the shape of a real nonce (4 chars, digit 0-7 first and third) and the index is in THIS map", () => {
  const m = buildNameMap(FIC, null, { genericAliases: FIC_GENERIC, nonce: NONCE });
  const wrong = (n, nonce) => `{P${n}.${nonce}}`;
  assert.equal(detokenise(wrong(1, "702f"), m), "Thornwick", "wrong nonce, real shape, valid index");
  assert.equal(detokenise(wrong(2, "1n70"), m), "Mossbeard");
  assert.equal(detokenise(wrong(1, "702F"), m), "Thornwick", "case does not matter");
  assert.equal(detokenise(wrong(1, NONCE), m), "Thornwick", "the right nonce still works");
  for (const bad of ["a", "5", "702", "702f1", "abcd1234", "abcd", "name", "zzzz", "7a-b", ""]) {
    assert.equal(detokenise(wrong(1, bad), m), "someone", `nonce "${bad}" is not a plausible nonce shape`);
  }
  assert.equal(detokenise(wrong(99, "702f"), m), "someone", "index not in this map");
  assert.equal(detokenise(wrong(0, "702f"), m), "someone");
  assert.equal(detokenise("{P1} { P1.702f } {P1 .702f} {p1.702f} {ID.702f} {ALL.702f}", m), "someone someone someone someone someone someone", "bare, spaced, lowercase and non-P kinds with a wrong nonce stay someone");
  assert.equal(detokenise(`${wrong(1, "702f")} and ${wrong(2, "7a1b")} but ${wrong(50, "7a1b")}`, m), "Thornwick and Mossbeard but someone");
  const other = buildNameMap(FIC, null, { genericAliases: FIC_GENERIC });
  assert.equal(detokenise(other.tokenFor(0), m), "Thornwick", "another request's token resolves by index only, never to anything outside this map");
  assert.equal(detokenise("Wait for {P2.5} of the patch and use {P1.name} as a placeholder.", m), "Wait for someone of the patch and use someone as a placeholder.", "ordinary brace text is not restored (as before this change)");
});

test("nonce tolerance: generated nonces always have the shape the tolerance accepts", () => {
  for (let i = 0; i < 3000; i++) assert.match(buildNameMap(FIC, null, { genericAliases: FIC_GENERIC }).nonce, /^[0-7][0-9a-z][0-7][0-9a-z]$/);
});

test("nonce tolerance: a shifted dot never matches a higher index ({P13.h4a} is not {P1.3h4a})", () => {
  const members = Array.from({ length: 14 }, (_, i) => ({ display: `Zorbian${"abcdefghijklmn"[i]}${"qrstuvwxyzabcd"[i]}`, aliases: [], firstNames: [], discordIds: [], characterNames: [] }));
  const m = buildNameMap(members, null, { nonce: "3h4a" });
  assert.equal(m.tokenFor(0), "{P1.3h4a}");
  assert.equal(detokenise("{P13.h4a}", m), "someone", "3-char nonce");
  assert.equal(detokenise("{P13.h4a1}", m), "someone", "5-char nonce");
  assert.equal(detokenise("{P1.3h4a}", m), members[0].display);
  assert.equal(detokenise("{P13.3h4a}", m), members[12].display, "the exact token for index 13");
});

test("nonce tolerance: a user-typed token is escaped before tokenising, and its nonce is never restored when a model relays it", () => {
  const m = buildNameMap(FIC, null, { genericAliases: FIC_GENERIC, nonce: NONCE });
  const out = tokenise("who is {P1.abcd} and {P2.k7f2} and { P1 . wxyz } and {P2.7a1b} and {P3.7A1B}?", m);
  assert.ok(!/[{}]/.test(out), out);
  assert.ok(out.includes("[P1.ABCD]") && out.includes("[P2.7A1B]"), out);
  assert.equal(detokenise(out, m), out, "escaped text has no brace form to restore");
  // a model relaying what the user typed, as braces, in any index or case
  assert.equal(detokenise("{P2.7a1b}", m), "someone", "crafted nonce, same index");
  assert.equal(detokenise("{P3.7A1B}", m), "someone", "crafted nonce, other case");
  assert.equal(detokenise("{P1.7a1b}", m), "someone", "crafted nonce, other index");
  assert.equal(detokenise("{P1.7a1c}", m), "Thornwick", "a plausible mis-copy the user did not type still restores");
});

test("unknown asker gets a token and the neutral display, never the raw string", () => {
  const m = mapFor("Zzyzx Guest");
  assert.equal(m.askerToken, `{P4.${NONCE}}`);
  assert.equal(tokenise("Zzyzx Guest asks", m), `${m.askerToken} asks`);
  assert.equal(detokenise(m.askerToken, m), "someone");
  const byId = mapFor("998877665544332211");
  assert.equal(tokenise("<@998877665544332211>", byId), byId.askerToken);
  assert.equal(detokenise(byId.askerToken, byId), "someone");
  assert.equal(mapFor("jess").byToken.size, 3);
  assert.equal(mapFor("jess").askerToken, `{P3.${NONCE}}`);
});

test("map build throws on one-character, reserved and duplicate names, without echoing values", () => {
  for (const bad of ["X", "龍", "All", "Guild", "Id", "Invite", "P1", "p12"]) {
    assert.throws(() => buildNameMap([{ display: "Okname", aliases: [bad] }]), (e) => /privacy:/.test(e.message) && !e.message.includes(bad));
  }
  assert.throws(() => buildNameMap([{ display: "Alike" }, { display: "Other", aliases: ["alike"] }]), (e) => /duplicate/.test(e.message) && !/alike/i.test(e.message));
  assert.doesNotThrow(() => buildNameMap([{ display: "Same", aliases: ["same", "SAME"] }]));
  assert.doesNotThrow(() => buildNameMap(ROSTER_DATA.map((r) => ({ display: r.display, aliases: r.aliases }))));
});

// ---------- 6. guardBody ----------
test("guardBody: cheap whole-body checks", () => {
  const ok = { model: "claude-x", max_tokens: 700, system: [{ type: "text", text: `You help {P1.${NONCE}} and {P2.${NONCE}} rather than guess. Weather is fine.`, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "what is the best tank for the Deadmines, level 18, 120 180 300 600" }] }], metadata: { user_id: "u_3f9a" } };
  assert.deepEqual(scanBody(ok, ROSTER), []);
  assert.equal(guardBody(ok, ROSTER).ok, true);
  const cases = {
    "multi-word display": { a: "x Handsome Pumpkin y" }, "character name": { a: "met zorrin  quillfeather" }, "first name": { a: "said ALDERIC." },
    "first name possessive": { a: "Brenna's gear" }, "display 5+": { a: "ask mossbeard" }, "id": { a: "id 112233445566778899" }, "id as number": { n: 112233445566778899 },
    "mention": { a: "<@!123>" }, "everyone": { a: "@everyone" }, "invite": { a: "dsc.gg/abc" }, "canary": { a: `x ${CANARY.toLowerCase()}` }, "guild": { a: "Examplehold Raiders" },
    "Buffer": Buffer.from("x"), "Map": { m: new Map() }, "Date": { d: new Date(0) }, "fn": { f: () => 1 }, "bigint": { n: 1n },
    "document block": { m: [{ type: "document", source: { type: "base64", data: "AAAA" } }] }, "name as key": { Thornwick: 1 },
  };
  const members = [{ ...FIC[0], display: "Handsome Pumpkin" }, FIC[1], FIC[2]];
  const missed = Object.entries(cases).filter(([, b]) => scanBody(b, { members, genericAliases: FIC_GENERIC }).length === 0).map(([k]) => k);
  // "name as key" uses a display that is not in this roster variant; everything else must be flagged
  assert.deepEqual(missed.filter((k) => k !== "name as key"), []);
  const img = { m: [{ type: "image", source: { type: "base64", data: "AAAA" } }] };
  assert.throws(() => guardBody(img, ROSTER), /binary-block/);
  assert.equal(guardBody(img, ROSTER, { allowBlockTypes: ["image"] }).ok, true);
  const cyc = { a: 1 }; cyc.self = cyc;
  assert.doesNotThrow(() => guardBody(cyc, ROSTER));
  try { guardBody({ x: "a Thornwick b" }, ROSTER); assert.fail("must throw"); } catch (e) {
    assert.ok(!/thornwick/i.test(e.message), "message must not echo the value");
    assert.equal(e.code, "OUTBOUND_IDENTIFIER_LEAK");
  }
});

// ---------- 7. reply policy ----------
test("replyLeaksIdentity: policy by kind; short first names at word boundaries", () => {
  assert.equal(replyLeaksIdentity("Thornwick and Mossbeard agree, {P1.x} too", ROSTER), false, "display names are fine by default");
  assert.equal(replyLeaksIdentity("Thornwick and Mossbeard agree", ROSTER, { allowDisplayNames: false }), true);
  for (const cls of ["plain", "upper", "possessive 's", "zero-width mid", "cyrillic (table-covered)", "dots between letters", "glued letters after", "leet one char", "repeated letter", "base64"]) {
    for (const fn of ["Alderic", "Brenna", "Corwin"]) assert.equal(replyLeaksIdentity(`Looks good, ${CLASSES[cls](fn)}. Carry on.`, ROSTER), true, `${cls}/${fn}`);
  }
  assert.equal(replyLeaksIdentity("Pyrelle did it", ROSTER), true);
  assert.equal(replyLeaksIdentity("at Examplehold Raiders tonight", ROSTER), true);
  assert.equal(replyLeaksIdentity("the tank goes first", ROSTER), false);
  assert.equal(replyLeaksIdentity("", ROSTER), false);
  const short = { members: [{ display: "Okname", firstNames: ["Bren"] }] };
  assert.equal(replyLeaksIdentity("Brennan's Tavern is open", short), false);
  assert.equal(replyLeaksIdentity("Bren said so", short), true);
  assert.equal(replyLeaksIdentity("Bren's plan", short), true);
  // first names come from the injected roster, not the repo
  assert.equal(replyLeaksIdentity("ok Zebediah", { members: [{ display: "Okname", firstNames: ["Zebediah"] }] }), true);
  assert.equal(replyLeaksIdentity("ok Zebediah", { members: [{ display: "Okname" }] }), false);
});

// ---------- 8. search queries ----------
test("scrubSearchQuery refuses roster keys, partials and tokens", () => {
  for (const q of ["Quillfeather armory", "zorrin gear", "Thornwick dps rotation", "who is Bjorn", "{P9} gear", `${FMAP.tokenFor(0)} gear`, "<@112233445566778899> gear", "alderi build", "   ", "", "Thorn wick spec"]) {
    assert.equal(scrubSearchQuery(q, ROSTER), null, q);
  }
  assert.equal(scrubSearchQuery("fire spell rotation for raid bosses", ROSTER), "fire spell rotation for raid bosses");
  assert.equal(scrubSearchQuery("best tank spec", ROSTER), "best tank spec");
});

// ---------- 9. generator property: 500 seeded prompts ----------
const FILLER = [
  "Instead of guessing, check the gear list and the long thread.",
  "Can we clear the boss tonight and ask about loot rules afterwards?",
  "The fire phase lines up with the third cooldown, honestly.",
];
function genPrompt(rng) {
  const cls = ["plain", "upper", "lower", "possessive 's", "plural s", "zero-width mid", "NBSP for spaces", "hyphen for spaces", "fullwidth", "cyrillic (table-covered)", "math bold"];
  const nm = () => CLASSES[rng.pick(cls)](rng.pick(LONG_POOL));
  const ref = () => rng.pick(["<@112233445566778899>", `<@!${rng.digits(18)}>`, rng.digits(17 + rng.int(4)), "@everyone", "discord.gg/abc123"]);
  const lines = [`Asker: ${nm()}`];
  for (let i = 0; i < 3 + rng.int(5); i++) {
    const t = rng.int(4);
    lines.push(t === 0 ? `${nm()} said ping ${ref()} about ${nm()}` : t === 1 ? rng.pick(FILLER) : t === 2 ? `[12:0${i}] ${nm()}: ${rng.pick(FILLER)} ${ref()}` : `Is ${nm()} ready? (id ${rng.digits(17)}) ​`);
  }
  return lines.join("\n");
}

test("500 seeded prompts: tokenised user text passes the guards; raw text is flagged", () => {
  const rng = rngFrom(20261114);
  let rawFlagged = 0;
  for (let i = 0; i < 500; i++) {
    const prompt = genPrompt(rng);
    const out = tokenise(prompt, FMAP);
    const body = { model: "m", max_tokens: 512, system: `You help ${FMAP.tokenFor(0)} and ${FMAP.tokenFor(1)}.`, messages: [{ role: "user", content: out }] };
    try { guardUserText([out], ROSTER); guardBody(body, ROSTER); } catch (e) { throw new Error(e.message + " | prompt=" + JSON.stringify(prompt) + " | out=" + JSON.stringify(out)); }
    if (flagged(prompt, ROSTER)) rawFlagged++;
    assert.ok(!/\d{15,}/.test(detokenise(out, FMAP)));
    assert.equal(replyLeaksIdentity(detokenise(out, FMAP), ROSTER), false);
  }
  assert.equal(rawFlagged, 500);
});

// ---------- 10. measured over-blocking and cost ----------
const NAME_FREE = [
  "how do I tank as a paladin", "what is the best spec for a frost mage", "when does the next raid start", "which professions make the most gold", "how hard is the Deadmines for a level 18 group",
  "what should a druid healer do on trash pulls", "is hunter a good class for a beginner", "what changed in the latest beta build", "how do talents work in Forever", "who should main tank tonight",
  "what does threat mean", "how many healers do we need for a five man", "what race is best for a warrior", "is blacksmithing worth it at level 20", "where do I train mining",
  "can a rogue tank a dungeon", "what is the level cap", "explain the glossary term kiting", "what are the pvp rewards", "how does the honor system work",
  "what should I do first at level 10", "what is a good leveling route for horde", "do warlocks get a free mount", "is alchemy good for raiding", "how do I get to Ragefire Chasm",
  "does the weather change in the barrens", "I would rather play a priest than a rogue", "my father wants to join the guild", "what does the big boss in Deadmines drop", "how do I respec and what does it cost",
  "which race has the best racials for pve", "what is the fastest way to 40", "should the mage sheep the skull or the x", "what do the raid markers mean", "any better answers to my previous question",
  "what time is raid, 20:00 or 20:30 on 2026-11-14?", "levels 6, 12, 22, 32, 42, 52, 60; 20 and 120 180 300 600 900 1200", "thanks, that was helpful", "tell me a joke about kobolds", "what is the best pizza topping",
  "how do I gather herbs faster", "is there a together mode for dungeons", "which weapon should a hunter use", "what is a good gathering route", "can I trade the quest reward",
  "how does the auction house work", "what are the best bags", "where is the flight master", "how do I join a party", "what does the glossary say about aggro",
];
test("measured: false-block rate of the strict guard on 200 realistic name-free questions (fictional roster)", (t) => {
  const qs = [];
  for (let i = 0; i < 200; i++) qs.push(NAME_FREE[i % NAME_FREE.length] + (i < 50 ? "" : i < 100 ? " please" : i < 150 ? "?" : ", thanks"));
  const blocked = qs.filter((q) => flagged(q, ROSTER));
  const reasons = new Set(blocked.map((q) => scanUserText([q], ROSTER).map((l) => l.kind).join("+")));
  t.diagnostic(`false-block rate ${blocked.length}/200 (${(blocked.length / 2).toFixed(1)}%) kinds=${[...reasons].join(",")}`);
  assert.ok(blocked.length / 200 <= 0.15, `rate ${blocked.length}/200`);
});

test("measured: guard cost per call", (t) => {
  const text = (NAME_FREE.join(". ") + ". ").repeat(9).slice(0, 9000);
  const q2 = text.slice(0, 2000);
  const body9 = { model: "claude-x", max_tokens: 700, system: [{ type: "text", text: text.slice(0, 7000) }], messages: [{ role: "user", content: text.slice(0, 2000) }] };
  const time = (fn, n = 300) => { for (let i = 0; i < 30; i++) fn(); const s = []; for (let i = 0; i < n; i++) { const a = performance.now(); fn(); s.push(performance.now() - a); } s.sort((x, y) => x - y); return s[Math.floor(n / 2)]; };
  const a = time(() => scanUserText([q2], ROSTER));
  const b = time(() => scanBody(body9, ROSTER));
  t.diagnostic(`guardUserText 2000 chars median ${a.toFixed(3)} ms; guardBody ${JSON.stringify(body9).length} chars median ${b.toFixed(3)} ms`);
  assert.ok(a < 3, `guardUserText ${a}ms`);
  assert.ok(b < 2, `guardBody ${b}ms`);
});

test("no blowup on 200k-char hostile inputs (tokeniser fast; oversize segments fail closed in the guard)", () => {
  const hostile = [
    "a ".repeat(100000), "Thornwick".repeat(22000), "Handsome-".repeat(22000) + "x", "Zorrin" + " ".repeat(199000) + "x",
    ("​".repeat(50) + "Thorn wick ").repeat(3000), "9".repeat(200000), "<@ ".repeat(60000), "https://www.discord.gg/".repeat(8000),
    "á̶".repeat(60000), "ﷺ".repeat(20000), "Thorn" + " -_.'".repeat(40000) + "!", "Thorn".repeat(40000),
    ("Thorn" + " ".repeat(40)).repeat(4000), "&#8203;".repeat(25000), "%41".repeat(60000), "\\u0041".repeat(30000),
  ];
  for (const h of hostile) {
    const t0 = performance.now();
    const out = tokenise(h, FMAP);
    assert.ok(performance.now() - t0 < 1500, `tokenise took ${(performance.now() - t0).toFixed(0)}ms on a ${h.length}-char input`);
    const t1 = performance.now();
    const leaks = scanUserText([out], ROSTER);
    assert.ok(performance.now() - t1 < 1500, `guard took ${(performance.now() - t1).toFixed(0)}ms`);
    if (out.length > 20000) assert.ok(leaks.some((l) => l.kind === "toolong"), "oversize segment must fail closed");
  }
});

// ---------- 11. independence + mutation checks ----------
test("independence: the guard imports nothing", () => {
  const src = readFileSync(join(PRIV, "outbound-guard.js"), "utf8");
  assert.equal(/^\s*import\s/m.test(src) || /\bimport\s*\(/.test(src) || /\brequire\s*\(/.test(src), false);
});

function mutatedGuard(label, edits) {
  const dir = mkdtempSync(join(tmpdir(), `privmut-${label}-`));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const f of ["skeleton.js", "tokenise.js", "outbound-guard.js"]) {
    let src = readFileSync(join(PRIV, f), "utf8");
    for (const [file, from, to] of edits) {
      if (file !== f) continue;
      const edited = src.split(from).join(to);
      assert.notEqual(edited, src, `mutation "${label}" did not apply to ${f}`);
      src = edited;
    }
    writeFileSync(join(dir, f), src);
  }
  return import(pathToFileURL(join(dir, "outbound-guard.js")).href);
}

function rawMisses(G, classNames) {
  const rng = rngFrom(4242);
  let misses = 0;
  for (const cls of classNames) for (let i = 0; i < 12; i++) {
    const pool = eligible(cls, LONG_POOL, SHORT_POOL);
    const text = `did ${CLASSES[cls](rng.pick(pool))} log on`;
    if (G.scanUserText([text], ROSTER).length === 0) misses++;
  }
  return misses;
}

const FOLD_CLS = ["cyrillic (uncovered letters)", "greek (uncovered letters)", "cyrillic (table-covered)"];
const INVIS_CLS = ["hangul filler mid"];
const LEET_CLS = ["leet one char", "leet all"];
const SCRIPT_CLS = ["lisu lookalikes (blocked script)", "cherokee lookalikes (blocked script)", "coptic lookalikes (blocked script)", "ipa lookalikes (blocked script)", "phonetic ligature (blocked script)", "latin small caps (blocked script)", "RLO reversed", "unicode tag chars"];
const DECODE_CLS = ["base64", "base64 unpadded", "base64 url-safe", "base64 double", "hex", "html entity letters", "html entity wide hex", "url-encoded", "literal \\u escape", "literal \\u{} escape"];
const ALL_GUARD_CLS = [...FOLD_CLS, ...INVIS_CLS, ...LEET_CLS, ...SCRIPT_CLS, ...DECODE_CLS, "repeated letter", "partial first 5", "partial last 5", "reversed plain"];

test("mutation: breaking skeleton.js and tokenise.js does not blind the guard (it shares nothing with them)", async () => {
  const G = await mutatedGuard("broken-tokeniser", [
    ["skeleton.js", "export function elementsOf(text) {", "export function elementsOf(text) { return { c: \"\", s: [], e: [], sp: [], sf: [], n: 0 };\n"],
    ["tokenise.js", "export function tokenise(text, map) {", "export function tokenise(text, map) { return String(text);\n"],
  ]);
  assert.equal(rawMisses(G, ALL_GUARD_CLS), 0);
  const base = await mutatedGuard("identity", []);
  assert.equal(rawMisses(base, ALL_GUARD_CLS), 0, "unmutated guard misses nothing");
});

test("mutation: removing any of the guard's own defences turns it red", async () => {
  const cases = [
    ["fold", [["outbound-guard.js", "FOLD.set(c, to);", "void c;"]], FOLD_CLS],
    ["invisible", [["outbound-guard.js", '.replace(INVISIBLE_RE, "")', ""]], INVIS_CLS],
    ["leet", [["outbound-guard.js", "s.replace(/[013457]/g, (d) => m[d])", "s"]], LEET_CLS],
    ["collapse", [["outbound-guard.js", 's.replace(/(.)\\1+/gs, "$1")', "s"]], ["repeated letter"]],
    ["scripts", [["outbound-guard.js", "BLOCK_RE.test(c)", "false"]], SCRIPT_CLS.filter((c) => c !== "RLO reversed" && !c.startsWith("latin small") && c !== "unicode tag chars").concat(["phonetic ligature (blocked script)"])],
    ["decode", [["outbound-guard.js", "const d = decodeEscapes(t);", "const d = t;"], ["outbound-guard.js", "decodeBinaryish(t, next);", ""]], DECODE_CLS],
    ["partials", [["outbound-guard.js", "if (key.length >= 7) e.partial =", "if (false) e.partial ="]], ["partial first 5", "partial last 5"]],
  ];
  for (const [label, edits, classes] of cases) {
    const G = await mutatedGuard(label, edits);
    assert.ok(rawMisses(G, classes) > 0, `guard stayed green with "${label}" removed`);
  }
});

// ---------- 12. scan: no live roster values in the new files ----------
test("scan: new files and tests contain no values from the live roster", () => {
  const allow = new Set(["mage", "tank"]);
  const values = new Set();
  for (const r of ROSTER_DATA) for (const v of [r.display, ...r.aliases]) if (!allow.has(v.toLowerCase())) values.add(v.toLowerCase());
  for (const f of ["tokenise.js", "outbound-guard.js", "skeleton.js", "../../../tests/unit/privacy-tokenise.test.mjs"]) {
    const src = readFileSync(join(PRIV, f), "utf8").toLowerCase();
    for (const v of values) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      assert.ok(!re.test(src), `${f} contains a roster value (length ${v.length})`);
    }
  }
});

test("detokenise is a single pass: a restored display is never re-resolved", () => {
  const members = [{ display: "{P2.7a1b}", aliases: [], firstNames: [], discordIds: [], characterNames: [] }, { display: "Mossbeard", aliases: [], firstNames: [], discordIds: [], characterNames: [] }];
  const m = buildNameMap(members, null, { nonce: NONCE });
  assert.equal(detokenise(`{P1.${NONCE}}`, m), "{P2.7a1b}", "a display that looks like a token stays as the display");
  assert.equal(detokenise("{P1.702f}", m), "{P2.7a1b}", "same for a mis-copied nonce");
  const f = buildNameMap(FIC, null, { genericAliases: FIC_GENERIC, nonce: NONCE });
  assert.equal(detokenise("{{P1.702f}}", f), "{Thornwick}", "nested braces: the inner group restores once, the outer braces stay");
});
