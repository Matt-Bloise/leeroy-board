// Property and attack tests for the outbound-privacy modules (tokenise.js, outbound-guard.js,
// skeleton.js). Pure and offline. Fixtures are fictional; the live roster is used only at
// runtime and only counts and class names are ever printed.
// Run: node --test tests/unit/privacy-tokenise.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildNameMap, tokenise, detokenise } from "../../infrastructure/worker/privacy/tokenise.js";
import {
  assertNoIdentifiers,
  findIdentifiers,
  scrubSearchQuery,
  replyLeaksIdentity,
  CANARY,
} from "../../infrastructure/worker/privacy/outbound-guard.js";
import { skeleton } from "../../infrastructure/worker/privacy/skeleton.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";

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
const FMAP = buildNameMap(FIC, null, { genericWords: FIC_GENERIC });
const nonGenericNames = (members, generic) =>
  members.flatMap((m) => [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames]).filter((n) => n && !generic.includes(skeleton(n)));

// ---------- mutation classes (the attack table) ----------
const CYR = { a: "а", e: "е", o: "о", p: "р", c: "с", y: "у", x: "х", i: "і", s: "ѕ", h: "һ", k: "к", m: "м", t: "т" };
const CYR_UNMAPPED = { r: "г", n: "п", b: "ь", w: "ԝ", q: "ԛ", v: "ѵ", u: "и", g: "ԍ" };
const GRK_UNMAPPED = { e: "ε", n: "η", y: "γ", w: "ω", u: "μ", b: "β", s: "ς", r: "г" };
const SMALLCAP = { a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", r: "ʀ", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", y: "ʏ", z: "ᴢ" };
const LEET = { o: "0", e: "3", i: "1", a: "4", s: "5", t: "7" };
const sub = (n, tbl, max = 99) => { let c = 0; return [...n].map((ch) => (tbl[ch.toLowerCase()] && c++ < max ? tbl[ch.toLowerCase()] : ch)).join(""); };
const mid = (n, ins) => { const a = [...n]; const k = Math.max(1, Math.floor(a.length / 2)); return a.slice(0, k).join("") + ins + a.slice(k).join(""); };
const fullw = (n) => [...n].map((c) => (/[!-~]/.test(c) ? String.fromCodePoint(c.codePointAt(0) + 0xfee0) : c)).join("");
const negsq = (n) => [...n].map((c) => (/[a-z]/i.test(c) ? String.fromCodePoint(0x1f170 + c.toLowerCase().charCodeAt(0) - 97) : c)).join("");
const mathBold = (n) => [...n].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(0x1d41a + c.charCodeAt(0) - 97) : /[A-Z]/.test(c) ? String.fromCodePoint(0x1d400 + c.charCodeAt(0) - 65) : c)).join("");
const lettersOnly = (n) => n.replace(/ /g, "");
// glued: classes where a generic (whole-word-only) alias is a documented allowed blind spot
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
  "greek (uncovered letters)": (n) => sub(n, GRK_UNMAPPED), "latin small caps": (n) => sub(n, SMALLCAP),
  "negative-squared letters": negsq, "math bold": mathBold, "zalgo combining marks": (n) => [...n].map((c) => c + "̶́").join(""),
  "braille blank mid": (n) => mid(n, "⠀"), "Cf not in strip list (U+1D173)": (n) => mid(n, "\u{1D173}"),
  "interlinear Cf (U+FFF9)": (n) => mid(n, "￹"), "hangul filler mid": (n) => mid(n, "ㅤ"),
  "leet one char": (n) => sub(n, LEET, 1), "leet all": (n) => sub(n, LEET), "repeated letter": (n) => mid(n, [...n][Math.floor([...n].length / 2) - 1] || ""),
  "url-encoded": (n) => [...n].map((c) => "%" + c.charCodeAt(0).toString(16)).join(""),
  "url-encoded utf8": (n) => encodeURIComponent(n).replace(/[A-Za-z]/g, (c) => "%" + c.charCodeAt(0).toString(16)),
  base64: (n) => Buffer.from(n).toString("base64"),
  "html entity mid": (n) => mid(n, "&#8203;"), "html entity letters": (n) => [...n].map((c) => `&#${c.codePointAt(0)};`).join(""),
  "literal \\u escape": (n) => [...n].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join(""),
  "stroke letters folded to ascii": (n) => n.replace(/ø/g, "o").replace(/ł/g, "l"),
};
const TEMPLATES = ["did § log on", "ok so § pulled early again lol", "§", "(§)", "tell §, please", "\n§\n", "is it true that §?", "§: where r u", "no way §... really", "\"§\" wrote that"];

const hasToken = (s) => /\{(?:P\d+|ID|ALL|INVITE|GUILD)\}/.test(s);
const bodyOf = (text) => ({ model: "m", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text }] }] });

// Returns { n, missed, silentMiss, rawSilent } per class. missed = tokeniser produced no token;
// silentMiss = tokeniser missed AND the guard stayed silent on the outbound body (the dangerous case);
// rawSilent = the guard did not flag the RAW (un-tokenised) text.
function runClasses({ names, map, perClass, seed, classNames }) {
  const rng = rngFrom(seed);
  const res = {};
  for (const cls of classNames ?? Object.keys(CLASSES)) {
    const fn = CLASSES[cls];
    const r = (res[cls] = { n: 0, missed: 0, silentMiss: 0, rawSilent: 0 });
    for (let i = 0; i < perClass; i++) {
      const name = names[rng.int(names.length)];
      const mutated = fn(name);
      if (mutated === name && cls !== "plain") continue;
      const tpl = TEMPLATES[rng.int(TEMPLATES.length)];
      const text = tpl.replace("§", mutated);
      const out = tokenise(text, map);
      const missed = !hasToken(out);
      const flagged = findIdentifiers(bodyOf(out), map).length > 0;
      r.n++;
      if (missed) r.missed++;
      if (missed && !flagged) r.silentMiss++;
      if (findIdentifiers(bodyOf(text), map).length === 0) r.rawSilent++;
    }
  }
  return res;
}

// ---------- 1. attack classes, fictional roster ----------
test("attack table (fictional roster): no guard-silent leak, every raw class flagged, tokeniser handles the common ones", () => {
  const res = runClasses({ names: nonGenericNames(FIC, FIC_GENERIC), map: FMAP, perClass: 20, seed: 1234567 });
  const bad = Object.entries(res).filter(([, r]) => r.silentMiss > 0 || r.rawSilent > 0);
  assert.deepEqual(bad.map(([c, r]) => `${c}: silentMiss=${r.silentMiss} rawSilent=${r.rawSilent}`), []);
  const total = Object.values(res).reduce((a, r) => a + r.n, 0);
  assert.ok(total >= 700, `prompts run: ${total}`);
  // the tokeniser itself (not just the guard) must catch these classes in nearly every prompt
  for (const cls of ["plain", "upper", "possessive 's", "plural s", "zero-width mid", "soft hyphen mid", "NBSP for spaces", "hyphen for spaces", "fullwidth", "cyrillic (table-covered)", "cyrillic (uncovered letters)", "greek (uncovered letters)", "latin small caps", "negative-squared letters", "math bold", "zalgo combining marks", "braille blank mid", "Cf not in strip list (U+1D173)", "interlinear Cf (U+FFF9)", "hangul filler mid", "plural -es", "diminutive -y/-ie", "dots between letters", "spaces between letters", "markdown mid (**)", "url-encoded", "html entity mid", "html entity letters", "literal \\u escape", "repeated letter"]) {
    assert.equal(res[cls].missed, 0, `tokeniser missed class "${cls}" ${res[cls].missed}/${res[cls].n}`);
  }
});

// ---------- 2. attack classes, live roster (counts only) ----------
test("attack table (live roster, runtime-derived): 0 guard-silent leaks over 742+ prompts", () => {
  const members = ROSTER_DATA.map((r) => ({ display: r.display, aliases: r.aliases, firstNames: [], discordIds: [], characterNames: [] }));
  // generic = single-word aliases of up to 5 letters that are not the member's own display key
  const generic = ROSTER_DATA.flatMap((r) => r.aliases.filter((a) => !/\s/.test(a) && a.length <= 5 && skeleton(a) !== skeleton(r.display)));
  const map = buildNameMap(members, null, { genericWords: generic });
  const gKeys = generic.map((g) => skeleton(g));
  const strict = runClasses({ names: nonGenericNames(members, gKeys), map, perClass: 18, seed: 987654 });
  const bad = Object.entries(strict).filter(([, r]) => r.silentMiss > 0 || r.rawSilent > 0);
  assert.deepEqual(bad.map(([c, r]) => `${c}: silentMiss=${r.silentMiss} rawSilent=${r.rawSilent}`), []);
  const total = Object.values(strict).reduce((a, r) => a + r.n, 0);
  assert.ok(total >= 742, `prompts run: ${total}`);
  // generic aliases: whole-word classes must be tokenised or flagged (glued forms are the documented allowed hole)
  const gnames = members.flatMap((m) => m.aliases).filter((a) => gKeys.includes(skeleton(a)));
  const gres = runClasses({ names: gnames, map, perClass: 12, seed: 55, classNames: Object.keys(CLASSES).filter((c) => !GLUED.has(c)) });
  const gbad = Object.entries(gres).filter(([, r]) => r.silentMiss > 0);
  assert.deepEqual(gbad.map(([c, r]) => `${c}: silentMiss=${r.silentMiss}`), []);
});

// ---------- 3. guard shapes ----------
test("guard catches every outbound shape (fictional)", () => {
  const N = "Thornwick", S = "Thorn", ID = "112233445566778899";
  const b64 = Buffer.from("hello " + N).toString("base64");
  const cases = {
    "messages content string": { messages: [{ role: "user", content: `hi ${N}` }] },
    "content blocks": { messages: [{ role: "user", content: [{ type: "text", text: `hi ${S}` }] }] },
    "system blocks": { system: [{ type: "text", text: `${S} is here` }] },
    "tool_use nested": { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: { a: [[{ q: S }]] } }] }] },
    "tool_result blocks": { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: S }] }] }] },
    "metadata raw id": { metadata: { user_id: ID } },
    "metadata prefixed id": { metadata: { user_id: "discord:" + ID } },
    "id as number": { n: 112233445566778899 },
    "id as bigint": { n: 112233445566778899n },
    "name as key": { [S]: 1 },
    "short mention": { t: "<@123>" },
    "id with spaces": { t: ID.replace(/(.{4})/g, "$1 ") },
    "id with commas": { t: "112,233,445,566,778,899" },
    "16-digit id": { t: "1122334455667788" },
    "15-digit id": { t: "112233445566778" },
    "arabic-indic id": { t: [...ID].map((d) => String.fromCharCode(0x660 + +d)).join("") },
    "fullwidth id": { t: [...ID].map((d) => String.fromCharCode(0xff10 + +d)).join("") },
    "base64 of name": { t: b64 },
    "base64 short name": { t: Buffer.from("Jess").toString("base64") },
    "document block": { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "text/plain", data: "AAAA" } }] }] },
    "image block": { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] },
    "url-encoded": { t: "q=%54hornwick" },
    "literal \\u": { t: "\\u0054hornwick" },
    "html entity": { t: "&#84;hornwick" },
    "split across blocks": { messages: [{ role: "user", content: [{ type: "text", text: "Thorn" }, { type: "text", text: "wick" }] }] },
    "split key|value": { Thorn: "wick" },
    "stringified body": JSON.stringify({ messages: [{ role: "user", content: `hi\n${N}` }] }),
    "stringified, short name after \\n": JSON.stringify({ messages: [{ role: "user", content: `hi\n${S} lol` }] }),
    "stringified, after \\t": JSON.stringify({ messages: [{ role: "user", content: `a\t${S}` }] }),
    "stringified, \\u00f8 escape": '{"t":"Bj\\u00f8rn"}',
    "Uint8Array": new TextEncoder().encode(JSON.stringify({ t: N })),
    "Buffer": Buffer.from(JSON.stringify({ t: N })),
    "Map": { m: new Map([["k", N]]) },
    "Set": { m: new Set([N]) },
    "toJSON": { o: { toJSON: () => ({ t: S }) } },
    "Date": { d: new Date(0) },
    "first name": { t: "alderic said" },
    "character name": { t: "zorrin-quillfeather" },
    "guild": { t: "ExampleholdRaiders" },
    "@everyone": { t: "@everyone" }, "@ZW everyone": { t: "@​everyone" }, "@ everyone": { t: "@ everyone" }, "@here": { t: "@here" },
    "dsc.gg": { t: "dsc.gg/abc" }, "discord.gg": { t: "discord.gg/abc" }, "spaced invite": { t: "discord . gg / abc" }, "invite url": { t: "https://discord.com/invite/abc" },
    "users url": { t: "discord.com/users/1122334455667788" }, "channels url": { t: "discord.com/channels/1/2/3" },
    "handle": { t: "@thorn_wick" },
    "ascii stroke name": { t: "Bjorn" },
    "canary": { t: "leeroy canary 7f3a91c2" }, "canary exact": { t: CANARY },
    "json-looking string": { t: JSON.stringify({ inner: [`x ${S}`] }) },
    "leet": { t: "Th0rnw1ck" },
    "doubled": { t: "Thhhornwwick" },
    "emoji separated": { t: "T\u{1F525}h\u{1F525}o\u{1F525}r\u{1F525}n" },
  };
  const missed = [];
  for (const [k, body] of Object.entries(cases)) {
    let leaks;
    try { leaks = findIdentifiers(body, FMAP); } catch { leaks = ["threw"]; }
    if (!leaks.length) missed.push(k);
  }
  assert.deepEqual(missed, []);
  assert.throws(() => assertNoIdentifiers({ x: `a ${N}` }, FMAP), /leak/);
});

test("guard: clean bodies pass; allowBlockTypes opts in; error text never echoes values", () => {
  const scaffold = { model: "claude-sonnet-4-5", max_tokens: 1024, temperature: 1, stream: false, system: [{ type: "text", text: "You are a helpful assistant for a small gaming group. People are {P1}..{Pn}. Never guess names.", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "{P1} asked {P2} about the raid tonight, rather late" }] }, { role: "assistant", content: [{ type: "tool_use", id: "toolu_01A", name: "lookup", input: { query: "raid time" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01A", content: "8pm" }] }], tools: [{ name: "lookup", description: "Look up a fact", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }], metadata: { user_id: "u_3f9a" } };
  assert.equal(assertNoIdentifiers(scaffold, FMAP).ok, true);
  const img = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" } }] }] };
  assert.throws(() => assertNoIdentifiers(img, FMAP), /binary-block/);
  assert.equal(assertNoIdentifiers(img, FMAP, CANARY, { allowBlockTypes: ["image"] }).ok, true);
  try { assertNoIdentifiers({ x: "a Thornwick b" }, FMAP); assert.fail("must throw"); } catch (e) {
    assert.ok(!/thornwick/i.test(e.message), "message must not echo the value");
    assert.equal(e.code, "OUTBOUND_IDENTIFIER_LEAK");
  }
  const cyc = { a: 1 }; cyc.self = cyc;
  assert.ok(findIdentifiers(cyc, FMAP).some((l) => l.kind === "unserialisable"), "unserialisable bodies fail closed");
});

test("generic-word allowlist: guard allows glued/unrelated words, blocks any standalone use", () => {
  assert.equal(findIdentifiers({ t: "rather tanker captaincy recaptained a tankard" }, FMAP).length, 0);
  assert.ok(findIdentifiers({ t: "the tank is here" }, FMAP).length > 0);
  assert.ok(findIdentifiers({ t: "T.a.n.k" }, FMAP).length > 0);
  assert.ok(findIdentifiers({ t: "Tank's turn, tanky, tanks" }, FMAP).length > 0);
  // only the guard applies the allowlist; without it the same alias is a substring key
  const strict = buildNameMap(FIC);
  assert.ok(findIdentifiers({ t: "tanker" }, strict).length > 0);
});

// ---------- 4. tokeniser rules ----------
test("tokeniser: standalone generics restored as typed, glued/compound words survive", () => {
  const t = "we need a tank for the captaincy quest, a big t-shirt and recaptained crew";
  const fm = buildNameMap(FIC, null, { genericWords: FIC_GENERIC });
  const out = tokenise(t, fm);
  assert.equal(out, "we need a {P2} for the captaincy quest, a big t-shirt and recaptained crew");
  assert.equal(detokenise(out, fm), t);
  const fm2 = buildNameMap(FIC, null, { genericWords: FIC_GENERIC });
  assert.equal(detokenise(tokenise("Tank's turn", fm2), fm2), "Tank's turn");
});

test("tokeniser: partial hits, glue, separators, encodings, leet, doubled letters", () => {
  const m = () => buildNameMap(FIC, null, { genericWords: FIC_GENERIC });
  assert.equal(tokenise("Thorn-wick", m()), "{P1}");
  assert.equal(tokenise("Thorn wick and Thorn.wick", m()), "{P1} and {P1}");
  assert.equal(tokenise("Jess2 healCorwin", m()), "{P3}2 heal{P3}");
  assert.equal(tokenise("&#84;hornwick %54hornwick Thorn&#8203;wick", m()), "{P1} {P1} {P1}");
  assert.equal(tokenise("Th0rnw1ck Thhhornwick", m()), "{P1} {P1}");
  assert.equal(tokenise("Bjorn and Bjørn", m()), "{P3} and {P3}");
  assert.equal(tokenise("Pyrelle's, ZORRIN quillfeather, Examplehold-Raiders", m()), "{P2}'s, {P1}, {GUILD}");
  assert.equal(tokenise("a t-shirt", m()), "a t-shirt");
  // long names glued on both sides are not replaced by the tokeniser (the guard blocks them)
  assert.equal(tokenise("xxThornwickxx", m()), "xxThornwickxx");
  assert.ok(findIdentifiers({ t: "xxThornwickxx" }, m()).length > 0);
});

test("tokeniser keeps the original text: accents, Cyrillic prose, emoji", () => {
  const prose = "Привет, как дела? café naïve Ελληνικά \u{1F600}";
  assert.equal(tokenise(prose, FMAP), prose);
  assert.equal(tokenise("café Thornwick", FMAP), "café {P1}");
  assert.equal(findIdentifiers({ t: prose }, FMAP).length, 0);
});

test("mentions, ids and specials", () => {
  const out = tokenise("<@112233445566778899> <@!223344556677889900> <@&998877665544332211> <#123> raw 99887766554433221100 @everyone @ here discord.gg/abc123 dsc.gg/x discord . gg / y discord.com/users/1122334455667788", FMAP);
  assert.equal(out, "{P1} {P2} {ID} {ID} raw {ID} {ALL} {ALL} {INVITE} {INVITE} {INVITE} {ID}");
  assert.equal(tokenise("112 233 445 566 778 899", FMAP), "{P1}");
  assert.equal(tokenise("ms 1700000000000 ok", FMAP), "ms 1700000000000 ok");
});

test("token injection: user-typed tokens are escaped; detokenise accepts exact issued tokens only", () => {
  const out = tokenise("typed {P2} and { p 1 } and {ID} and {ALL} {INVITE} {GUILD} {P99}", FMAP);
  assert.ok(!/[{}]/.test(out), out);
  assert.equal(detokenise(out, FMAP), out, "escaped forms must not be restored");
  assert.equal(detokenise("{P9} {P2} { p 1 } {p1} {ID}", FMAP), "someone Mossbeard someone someone someone");
  assert.equal(detokenise("{P1} {ALL} {INVITE} {GUILD}", FMAP), "Thornwick everyone a link the server");
  assert.equal(detokenise("{P1}", buildNameMap([])), "someone");
});

test("unknown asker gets a token and the neutral display, never the raw string", () => {
  const m = buildNameMap(FIC, "Zzyzx Guest", { genericWords: FIC_GENERIC });
  assert.equal(tokenise("Zzyzx Guest asks", m), "{P4} asks");
  assert.equal(detokenise("{P4}", m), "someone");
  const byId = buildNameMap(FIC, "998877665544332211");
  assert.equal(tokenise("<@998877665544332211>", byId), "{P4}");
  assert.equal(detokenise("{P4}", byId), "someone");
  const known = buildNameMap(FIC, "jess");
  assert.equal(known.byToken.size, 3);
});

test("map build throws on one-character, reserved and duplicate names, without echoing values", () => {
  for (const bad of ["X", "龍", "All", "Guild", "Id", "Invite", "P1", "p12"]) {
    assert.throws(() => buildNameMap([{ display: "Okname", aliases: [bad] }]), (e) => /privacy:/.test(e.message) && !e.message.includes(bad));
  }
  assert.throws(() => buildNameMap([{ display: "Alike" }, { display: "Other", aliases: ["alike"] }]), (e) => /duplicate/.test(e.message) && !/alike/i.test(e.message));
  assert.throws(() => buildNameMap([{ display: "Okname", firstNames: ["A"] }]), /one-character/);
  assert.doesNotThrow(() => buildNameMap([{ display: "Same", aliases: ["same", "SAME"] }]));
  assert.doesNotThrow(() => buildNameMap(ROSTER_DATA.map((r) => ({ display: r.display, aliases: r.aliases }))));
});

test("stable tokens by member order; asker present adds nothing", () => {
  const a = buildNameMap(FIC), b = buildNameMap(JSON.parse(JSON.stringify(FIC)));
  assert.deepEqual([...a.names], [...b.names]);
  assert.equal(tokenise("Thornwick Mossbeard Bjorn", a), "{P1} {P2} {P3}");
});

// ---------- 5. reply policy ----------
test("replyLeaksIdentity: first/real names, characters, guild, display by policy; tokens and generics fine", () => {
  const rng = rngFrom(5);
  for (const fn of ["Alderic", "Brenna", "Corwin"]) {
    for (const cls of ["plain", "upper", "possessive 's", "zero-width mid", "cyrillic (table-covered)", "dots between letters", "glued letters after", "leet one char", "repeated letter"]) {
      const reply = `Looks good, ${CLASSES[cls](fn)}. Carry on.`;
      assert.equal(replyLeaksIdentity(reply, FMAP), true, cls);
    }
  }
  assert.equal(replyLeaksIdentity("Pyrelle did it", FMAP), true);
  assert.equal(replyLeaksIdentity("at Examplehold Raiders tonight", FMAP), true);
  assert.equal(replyLeaksIdentity("{P1} and {P2} should split the loot, the tank goes first", FMAP), false);
  assert.equal(replyLeaksIdentity("", FMAP), false);
  // display names: flagged by default, allowed by policy flag (first names still flagged)
  assert.equal(replyLeaksIdentity("Thornwick and Mossbeard agree", FMAP), true);
  assert.equal(replyLeaksIdentity("Thornwick and Mossbeard agree", FMAP, { allowDisplayNames: true }), false);
  assert.equal(replyLeaksIdentity("Thornwick and Brenna agree", FMAP, { allowDisplayNames: true }), true);
  // first names come from an injectable source, not the members array
  const src = buildNameMap(FIC.map((m) => ({ ...m, firstNames: [] })), null, { firstNameSource: (m) => (m.display === "Thornwick" ? ["Zebediah"] : []) });
  assert.equal(replyLeaksIdentity("ok Zebediah", src), true);
  assert.equal(replyLeaksIdentity("ok Alderic", src), false);
  void rng;
});

test("round trip: detokenise never reintroduces first names or ids (500 seeded prompts)", () => {
  const rng = rngFrom(99);
  const pool = nonGenericNames(FIC, FIC_GENERIC);
  for (let i = 0; i < 500; i++) {
    const names = [rng.pick(pool), rng.pick(pool)].map((n) => CLASSES[rng.pick(["plain", "upper", "possessive 's", "zero-width mid", "fullwidth", "hyphen for spaces"])](n));
    const prompt = `Asker: ${names[0]}\n${names[1]} said ping <@${rng.digits(18)}> and ${rng.digits(17)}\n--- history ---\n[12:00] ${names[0]}: rather biblical`;
    const out = tokenise(prompt, FMAP);
    try { assertNoIdentifiers(bodyOf(out), FMAP); } catch (e) { throw new Error(e.message + " | prompt=" + JSON.stringify(prompt) + " | out=" + JSON.stringify(out)); }
    assert.equal(replyLeaksIdentity(detokenise(out, FMAP), FMAP, { allowDisplayNames: true }) && /\d{15,}/.test(detokenise(out, FMAP)), false);
    assert.ok(!/\d{15,}/.test(detokenise(out, FMAP)));
  }
});

// ---------- 6. scrubSearchQuery ----------
test("scrubSearchQuery: null when a person or id would remain; generic words allowed as typed", () => {
  assert.equal(scrubSearchQuery("Thornwick dps rotation", FMAP), null);
  assert.equal(scrubSearchQuery("zorrin quillfeather gear", FMAP), null);
  assert.equal(scrubSearchQuery("{P9} gear", FMAP), null);
  assert.equal(scrubSearchQuery("<@112233445566778899> gear", FMAP), null);
  assert.equal(scrubSearchQuery("   ", FMAP), null);
  assert.equal(scrubSearchQuery("", FMAP), null);
  assert.equal(scrubSearchQuery("fire spell rotation for raid bosses", FMAP), "fire spell rotation for raid bosses");
  assert.equal(scrubSearchQuery("best tank spec", buildNameMap(FIC, null, { genericWords: FIC_GENERIC })), "best tank spec");
  assert.equal(scrubSearchQuery("who is Bjorn", FMAP), null);
});

// ---------- 7. generator-based 500 prompt property (fictional) ----------
const ZWS = ["​", "‌", "⁠", "﻿"];
const FILLER = [
  "Rather than guess, check the gear list and the biblical-length thread.",
  "Can we clear the boss tonight and ask about loot rules afterwards?",
  "The fire phase lines up with the third cooldown, honestly.",
];
function genPrompt(rng) {
  const pool = nonGenericNames(FIC, FIC_GENERIC);
  const nm = () => CLASSES[rng.pick(["plain", "upper", "lower", "possessive 's", "plural s", "zero-width mid", "NBSP for spaces", "hyphen for spaces", "fullwidth", "cyrillic (table-covered)", "math bold", "hyphen for spaces"])](rng.pick(pool));
  const ref = () => rng.pick([`<@112233445566778899>`, `<@!${rng.digits(18)}>`, rng.digits(17 + rng.int(4)), "@everyone", "discord.gg/abc123"]);
  const lines = [`Asker: ${nm()}`];
  for (let i = 0; i < 3 + rng.int(5); i++) {
    const t = rng.int(4);
    lines.push(t === 0 ? `${nm()} said ping ${ref()} about ${nm()}` : t === 1 ? rng.pick(FILLER) : t === 2 ? `[12:0${i}] ${nm()}: ${rng.pick(FILLER)} ${ref()}` : `Is ${nm()} ready? (id ${rng.digits(17)}) ${rng.pick(ZWS)}`);
  }
  return lines.join("\n");
}

test("500 seeded prompts: tokenised bodies pass the guard in all provider shapes; raw prompts are flagged", () => {
  const rng = rngFrom(20261114);
  let rawFlagged = 0;
  for (let i = 0; i < 500; i++) {
    const prompt = genPrompt(rng);
    const out = tokenise(prompt, FMAP);
    try { assertNoIdentifiers(bodyOf(out), FMAP); } catch (e) { throw new Error(e.message + " | prompt=" + JSON.stringify(prompt) + " | out=" + JSON.stringify(out)); }
    assertNoIdentifiers({ model: "m", max_tokens: 512, system: tokenise("You answer questions for a raid group.", FMAP), messages: [{ role: "user", content: out }, { role: "assistant", content: [{ type: "text", text: out.slice(0, 80) }] }] }, FMAP);
    assertNoIdentifiers({ messages: [{ role: "system", content: "x" }, { role: "user", content: out }] }, FMAP);
    if (findIdentifiers({ messages: [{ role: "user", content: prompt }] }, FMAP).length) rawFlagged++;
    const q = scrubSearchQuery(prompt, FMAP);
    if (q !== null) assert.deepEqual(findIdentifiers({ q }, FMAP, CANARY, { skipGeneric: true }), []);
  }
  assert.equal(rawFlagged, 500);
});

// ---------- 8. performance ----------
test("no regex or scan blowup on 200k-char hostile inputs", () => {
  const hostile = [
    "a ".repeat(100000), "Thornwick".repeat(22000), "Handsome-".repeat(22000) + "x", "Zorrin" + " ".repeat(199000) + "x",
    ("​".repeat(50) + "Thorn wick ").repeat(3000), "9".repeat(200000), "<@ ".repeat(60000), "https://www.discord.gg/".repeat(8000),
    "á̶".repeat(60000), "ﷺ".repeat(20000), "Thorn" + " -_.'".repeat(40000) + "!", "Thorn".repeat(40000),
    ("Thorn" + " ".repeat(40)).repeat(4000), "&#8203;".repeat(25000), "%41".repeat(60000), "\\u0041".repeat(30000),
  ];
  for (const h of hostile) {
    const t0 = performance.now();
    const out = tokenise(h, FMAP);
    findIdentifiers({ messages: [{ role: "user", content: out }] }, FMAP);
    const dt = performance.now() - t0;
    assert.ok(dt < 1500, `took ${dt.toFixed(0)}ms on a ${h.length}-char input`);
  }
});

// ---------- 9. mutation checks: the guard must go red when its defences are removed ----------
function mutatedModules(label, edit) {
  const dir = mkdtempSync(join(tmpdir(), `privmut-${label}-`));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const srcDir = fileURLToPath(new URL("../../infrastructure/worker/privacy/", import.meta.url));
  for (const f of ["skeleton.js", "tokenise.js", "outbound-guard.js"]) {
    let src = readFileSync(srcDir + f, "utf8");
    if (f === "skeleton.js") {
      const edited = edit(src);
      assert.notEqual(edited, src, `mutation "${label}" did not apply`);
      src = edited;
    }
    writeFileSync(join(dir, f), src);
  }
  return Promise.all([import(pathToFileURL(join(dir, "tokenise.js")).href), import(pathToFileURL(join(dir, "outbound-guard.js")).href)]);
}

function rawLeakMisses(G, T, classNames) {
  const map = T.buildNameMap(FIC, null, { genericWords: FIC_GENERIC });
  const rng = rngFrom(4242);
  const names = nonGenericNames(FIC, FIC_GENERIC);
  let misses = 0;
  for (const cls of classNames) for (let i = 0; i < 15; i++) {
    const text = `did ${CLASSES[cls](rng.pick(names))} log on`;
    if (G.findIdentifiers(bodyOf(text), map).length === 0) misses++;
  }
  return misses;
}

test("mutation: unmutated guard misses nothing; removing the skeleton fold or the invisible strip turns it red", async () => {
  const fold = ["cyrillic (uncovered letters)", "greek (uncovered letters)", "latin small caps", "negative-squared letters", "cyrillic (table-covered)"];
  const invis = ["zero-width mid", "soft hyphen mid", "braille blank mid", "Cf not in strip list (U+1D173)", "interlinear Cf (U+FFF9)", "hangul filler mid", "zalgo combining marks"];
  const leetCls = ["leet one char", "leet all"];
  const base = await Promise.all([import("../../infrastructure/worker/privacy/tokenise.js"), import("../../infrastructure/worker/privacy/outbound-guard.js")]);
  assert.equal(rawLeakMisses(base[1], base[0], [...fold, ...invis, ...leetCls]), 0);

  const [tF, gF] = await mutatedModules("nofold", (s) => s.replace("for (const ch of chars) CONF.set(ch.codePointAt(0), target);", "for (const ch of chars) void ch;"));
  assert.ok(rawLeakMisses(gF, tF, fold) > 0, "guard stayed green with the confusables fold removed");

  const [tI, gI] = await mutatedModules("noinvis", (s) => s.replace("if (INVIS_RE.test(ch)) return \"\";", "if (INVIS_RE.test(ch)) return \"#\";"));
  assert.ok(rawLeakMisses(gI, tI, invis) > 0, "guard stayed green with the invisible strip removed");

  const [tL, gL] = await mutatedModules("noleet", (s) => s.replace("return str.replace(/[013457]/g, (d) => m[d] ?? d);", "return str;"));
  assert.ok(rawLeakMisses(gL, tL, leetCls) > 0, "guard stayed green with the leet fold removed");

  const [tC, gC] = await mutatedModules("nocollapse", (s) => s.replace("return str.replace(/(.)\\1+/gs, \"$1\");", "return str;"));
  assert.ok(rawLeakMisses(gC, tC, ["repeated letter"]) > 0, "guard stayed green with the doubled-letter collapse removed");
});

// ---------- 10. scan: no live roster values in the new files ----------
test("scan: new files and tests contain no values from the live roster", () => {
  const allow = new Set(["mage", "tank"]);
  const values = new Set();
  for (const r of ROSTER_DATA) for (const v of [r.display, ...r.aliases]) if (!allow.has(v.toLowerCase())) values.add(v.toLowerCase());
  const files = [
    "../../infrastructure/worker/privacy/tokenise.js",
    "../../infrastructure/worker/privacy/outbound-guard.js",
    "../../infrastructure/worker/privacy/skeleton.js",
    "./privacy-tokenise.test.mjs",
  ];
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").toLowerCase();
    for (const v of values) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      assert.ok(!re.test(src), `${f} contains a roster value (length ${v.length})`);
    }
  }
});
