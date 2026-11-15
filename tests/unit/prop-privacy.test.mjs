// Property and fuzz tests: the tokeniser (privacy/tokenise.js) and the outbound name guard (privacy/outbound-guard.js).
// Fictional roster A..E only. Pure, offline, zero dependencies. Seed printed on failure; replay with PROP_SEED=<n>.
// Run: node --test tests/unit/prop-privacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildNameMap, tokenise, detokenise } from "../../infrastructure/worker/privacy/tokenise.js";
import { guardUserText, scanUserText, guardBody, scanBody } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { skeleton } from "../../infrastructure/worker/privacy/skeleton.js";
import { property, rngFrom, BASE_SEED, nastyString } from "../helpers/prop.mjs";

// Five made-up members A..E (display, a long first name and a character name each; all 5+ letters, so they are matched anywhere).
const MEMBERS = [
  { display: "Aldermere", aliases: [], firstNames: ["Alwenna"], discordIds: ["110000000000000001"], characterNames: ["Aurelith"], guild: "" },
  { display: "Brindlewick", aliases: [], firstNames: ["Berrowyn"], discordIds: ["110000000000000002"], characterNames: ["Brannock"], guild: "" },
  { display: "Corvanelle", aliases: [], firstNames: ["Cosmerin"], discordIds: ["110000000000000003"], characterNames: ["Cindralor"], guild: "" },
  { display: "Dunmorrow", aliases: [], firstNames: ["Dagnolia"], discordIds: ["110000000000000004"], characterNames: ["Durnhelm"], guild: "" },
  { display: "Eskarrion", aliases: [], firstNames: ["Edrimund"], discordIds: ["110000000000000005"], characterNames: ["Elowmere"], guild: "Examplehold" },
];
const ROSTER = { members: MEMBERS, genericAliases: [] };
const NAMES = MEMBERS.flatMap((m) => [m.display, ...m.firstNames, ...m.characterNames]);
const NONCE = "k7f2";
const mkMap = () => buildNameMap(MEMBERS, null, { genericAliases: [], nonce: NONCE });
const FILLER = ["so", "did", "anyone", "see", "the", "boss", "drop", "gold", "today", "what", "level", "zone", "is", "good", "for", "mounts", "thanks", "ok", "lol", "raid", "tonight", "maybe", "later"];

// ---- variants of one name: exact, spaced, leet, reversed, mixed case, zero-width, homoglyphs (and combinations) ----
const ZW = ["​", "‌", "‍", "⁠", "﻿", "­"];
const CYR = { a: "а", e: "е", o: "о", p: "р", c: "с", y: "у", x: "х", i: "і", s: "ѕ", k: "к", m: "м", t: "т", h: "һ" };
const LEET = { o: "0", e: "3", i: "1", a: "4", s: "5", t: "7" };
const letters = (n) => [...n];
const VARIANTS = {
  exact: (n) => n,
  lower: (n) => n.toLowerCase(),
  upper: (n) => n.toUpperCase(),
  mixedCase: (n, r) => letters(n).map((c) => (r.bool() ? c.toUpperCase() : c.toLowerCase())).join(""),
  spaced: (n, r) => letters(n).join(r.pick([" ", ".", "-", "_", "  ", " . "])),
  leet: (n, r) => letters(n).map((c) => (LEET[c.toLowerCase()] && r.bool(0.7) ? LEET[c.toLowerCase()] : c)).join(""),
  reversed: (n) => letters(n).reverse().join(""),
  zeroWidth: (n, r) => letters(n).map((c) => c + (r.bool(0.5) ? r.pick(ZW) : "")).join("") + (r.bool() ? "​" : ""),
  homoglyph: (n, r) => letters(n).map((c) => (CYR[c.toLowerCase()] && r.bool(0.7) ? CYR[c.toLowerCase()] : c)).join(""),
};
const COMBINE = ["mixedCase", "zeroWidth", "homoglyph", "leet", "spaced"];
const variantOf = (n, r, kind) => {
  if (kind === "combo") { let s = n; for (const k of r.shuffle(COMBINE).slice(0, r.range(2, 3))) s = VARIANTS[k](s, r); return r.bool(0.3) ? VARIANTS.reversed(s) : s; }
  return VARIANTS[kind](n, r);
};
const KINDS = [...Object.keys(VARIANTS), "combo"];
const embed = (r, v) => { const w = () => Array.from({ length: r.range(0, 4) }, () => r.pick(FILLER)).join(" "); return `${w()} ${v} ${w()}`.trim(); };

for (const kind of KINDS) {
  property(`guard catches every "${kind}" variant of a fictional name`, (r) => { const name = r.pick(NAMES); return { name, kind, text: embed(r, variantOf(name, r, kind)) }; }, ({ text }) => {
    assert.ok(scanUserText([text], ROSTER).length > 0, "guard missed it");
    assert.throws(() => guardUserText([text], ROSTER), (e) => e.code === "OUTBOUND_IDENTIFIER_LEAK");
  }, { runs: 150 });
}

property("tokenise then guard: a variant never gets through (tokenised, or the guard still blocks it)", (r) => { const name = r.pick(NAMES); const kind = r.pick(KINDS); return { name, kind, text: embed(r, variantOf(name, r, kind)) }; }, ({ name, text }) => {
  const out = tokenise(text, mkMap());
  let blocked = false;
  try { guardUserText([out], ROSTER); } catch (e) { blocked = e.code === "OUTBOUND_IDENTIFIER_LEAK"; }
  if (!blocked) assert.ok(!skeleton(out).includes(skeleton(name)), `name survived tokenise and passed the guard: ${JSON.stringify(out)}`);
}, { runs: 400 });

property("guard stays quiet on name-free filler text (no false positives)", (r) => ({ text: Array.from({ length: r.range(1, 20) }, () => r.pick(FILLER)).join(" ") }), ({ text }) => {
  assert.deepEqual(scanUserText([text], ROSTER), []);
  assert.deepEqual(scanBody({ messages: [{ role: "user", content: text }] }, ROSTER), []);
});

property("guard and tokeniser never throw on junk text (they return, or throw only the guard's own leak error)", (r) => ({ s: nastyString(r, 20) }), ({ s }) => {
  tokenise(s, mkMap());
  detokenise(s, mkMap());
  try { guardUserText([s], ROSTER); } catch (e) { assert.equal(e.code, "OUTBOUND_IDENTIFIER_LEAK"); }
  try { guardBody({ a: s }, ROSTER); } catch (e) { assert.equal(e.code, "OUTBOUND_IDENTIFIER_LEAK"); }
}, { runs: 400 });

// ---- round trip ----
const SAFE_PUNCT = [".", ",", "!", "?", ":", ";", "-", "'", "(", ")", "\n"];
const genPlain = (r) => { let s = ""; for (let i = r.range(0, 14); i > 0; i--) s += r.pick(FILLER) + (r.bool(0.25) ? r.pick(SAFE_PUNCT) : "") + " "; return s.trim(); };

property("tokenise is the identity on text without names (and so is tokenise then detokenise)", (r) => ({ text: genPlain(r) }), ({ text }) => {
  const m = mkMap();
  assert.equal(tokenise(text, m), text);
  assert.equal(detokenise(tokenise(text, m), m), text);
}, { runs: 400 });

property("tokenise then detokenise restores a display name exactly as it was typed", (r) => { const m = r.pick(MEMBERS); return { text: `${genPlain(r)} ${m.display} ${genPlain(r)}`.trim(), display: m.display }; }, ({ text, display }) => {
  const m = mkMap();
  const tok = tokenise(text, m);
  assert.ok(!tok.includes(display), "display name left in the tokenised text");
  assert.ok(/\{P\d\.k7f2\}/.test(tok), "no token");
  assert.equal(detokenise(tok, m), text);
}, { runs: 300 });

property("a first or character name is tokenised and comes back as the DISPLAY name, never the real one", (r) => { const i = r.range(0, 4); const raw = r.pick([...MEMBERS[i].firstNames, ...MEMBERS[i].characterNames]); return { i, raw, text: `${genPlain(r)} ${raw} ${genPlain(r)}` }; }, ({ i, raw, text }) => {
  const m = mkMap();
  const back = detokenise(tokenise(text, m), m);
  assert.ok(!back.includes(raw), "a first/character name was restored");
  assert.ok(back.includes(MEMBERS[i].display));
}, { runs: 300 });

property("user-typed token lookalikes are escaped and a foreign nonce is never restored", (r) => ({ tok: r.pick(["{P1.k7f2}", "{P1.zzzz}", "{P2}", "{ P3 }", "{ID.k7f2}", "{ALL.k7f2}", "{GUILD.k7f2}", "{INVITE.k7f2}"]), pre: genPlain(r) }), ({ tok, pre }) => {
  const m = mkMap();
  const out = detokenise(tokenise(`${pre} ${tok}`, m), m);
  for (const d of NAMES) assert.ok(!out.includes(d), `user token restored a name (${tok})`);
  assert.ok(!out.includes("{"), "a token survived as a token");
});

test("tokeniser handles empty, null and huge input", () => {
  const m = mkMap();
  for (const v of ["", null, undefined, " ", "​", "a".repeat(200000), "Aldermere ".repeat(5000)]) assert.doesNotThrow(() => tokenise(v, m));
  assert.equal(tokenise("", m), "");
  assert.equal(tokenise(null, m), "");
  assert.ok(!tokenise("Aldermere ".repeat(500), m).includes("Aldermere"));
});

test("seed is reported (documentation of the replay knob)", () => { assert.ok(Number.isInteger(BASE_SEED)); void rngFrom; });
