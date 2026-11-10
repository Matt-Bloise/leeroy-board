import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as A from "../../js/addon-import.js";

const NOW = 1794000000 + 3600;
const base = { v: 1, iface: 16001, t: 1794000000, class: "PALADIN", race: "Human", level: 40 };
const vocab = { race: ["dwarf", "gnome", "human", "night-elf", "orc", "tauren", "troll", "undead"], class: ["druid", "hunter", "mage", "paladin", "priest", "rogue", "shaman", "warlock", "warrior"], professions: ["alchemy", "blacksmithing", "enchanting", "engineering", "herbalism", "leatherworking", "mining", "skinning", "tailoring"], levelMax: 60 };
const file = JSON.parse(fs.readFileSync(new URL("../../addon/vectors.json", import.meta.url), "utf8")).vectors;
const FULL = { name: "full", ...A.encode({ ...base, name: "Zoé|x%", prof: "164:300,186:275", talents: "31,20,0", zone: "Elwynn Forest" }) };
/* index 0: the file's basic vector; 1: escapes; 2: a full-field string built here */
const vectors = [{ payload: file[0].payload, check: file[0].check, full: file[0].string }, { ...A.encode({ ...base, name: file[1].value }) }, FULL];
/* independent reference for the check: the textbook bitwise-free form, written separately from the module */
const ref = (s) => { let a = 1, b = 0; for (const c of Buffer.from(s, "utf8")) { a = (a + c) % 65521; b = (b + a) % 65521; } return (b * 65536 + a).toString(16).padStart(8, "0"); };
const mk = (o) => A.encode({ ...base, ...o }).full;

test("golden vectors: payload, check and full string match, and zlib's Adler-32 value for the first two is as published", () => {
  assert.equal(file[1].escaped, "A%3Bb%3Dc");
  assert.equal(A.escapeValue(file[1].value), file[1].escaped);
  assert.equal(A.unescapeValue(file[1].escaped), file[1].value);
  for (const v of vectors) {
    assert.equal(v.full, `LEEROY1|${v.payload}|${v.check}`);
    assert.equal(v.check, ref(v.payload));
    assert.match(v.check, /^[0-9a-f]{8}$/);
    assert.equal(A.parse(v.full, NOW).ok, true, v.id);
  }
  assert.equal(vectors[0].payload, "v=1;iface=16001;t=1794000000;class=PALADIN;race=Human;level=40");
  assert.equal(vectors[0].check, "31f812b5"); /* cross-checked with python zlib.adler32 */
  assert.equal(vectors[1].check, "55a2170a");
  assert.equal(file[0].check, A.hex8(A.adler32(A.utf8(file[0].payload))));
});

test("adler32 known answer: 'Wikipedia' is 0x11E60398", () => {
  assert.equal(A.hex8(A.adler32(A.utf8("Wikipedia"))), "11e60398");
});

test("round trip: every field survives encode then parse", () => {
  const s = mk({ name: "Thrall", zone: "Orgrimmar", prof: "164:300,186:275", talents: "31,20,0" });
  const r = A.parse(s, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { v: 1, iface: 16001, t: 1794000000, class: "PALADIN", race: "Human", level: 40, name: "Thrall", zone: "Orgrimmar", prof: [{ id: 164, rank: 300 }, { id: 186, rank: 275 }], talents: [31, 20, 0] });
  assert.deepEqual(r.warnings, []);
});

test("escaping: A%3Bb%3Dc is A;b=c, and ; = | % newline and non-ASCII all round trip", () => {
  assert.equal(A.parse(vectors[1].full, NOW).data.name, "A;b=c");
  const name = "a;b=c|d%e\nfé中";
  const wire = mk({ name });
  assert.match(wire.split("|")[1], /^[\x20-\x7e]*$/);
  assert.ok(!wire.split("|")[1].includes("\n"));
  assert.match(wire, /%0A/);
  assert.match(wire, /%C3%A9/);
  assert.equal(A.parse(wire, NOW).data.name, name);
});

test("tamper: one changed character in the payload fails the check; so does a changed check", () => {
  const s = vectors[0].full;
  const t = s.replace("level=40", "level=41");
  const r = A.parse(t, NOW);
  assert.equal(r.ok, false);
  assert.match(r.why, /check does not match/);
  const r2 = A.parse(s.slice(0, -1) + (s.endsWith("5") ? "6" : "5"), NOW);
  assert.equal(r2.ok, false);
  assert.match(r2.why, /check does not match/);
  assert.equal(A.parse(s.slice(0, -2), NOW).ok, false);
});

test("missing required keys are named in plain language", () => {
  for (const k of ["v", "iface", "t", "class", "race", "level"]) {
    const f = { ...base }; delete f[k];
    const r = A.parse(A.encode(f).full, NOW);
    assert.equal(r.ok, false, k);
    assert.match(r.why, new RegExp(`missing the required field ${k}`));
  }
});

test("level outside 1..60 or not a whole number is rejected", () => {
  for (const lv of [0, 61, 100, -1, "4x", "", "40.5"]) {
    const r = A.parse(mk({ level: lv }), NOW);
    assert.equal(r.ok, false, String(lv));
  }
  assert.equal(A.parse(mk({ level: 61 }), NOW).why, "Level 61 is above the 60 the board supports.");
  assert.equal(A.parse(mk({ level: 255 }), NOW).why, "Level 255 is above the 60 the board supports.");
  assert.equal(A.parse(mk({ level: 0 }), NOW).why, "Level 0 is below 1.");
  assert.equal(A.parse(mk({ level: 1 }), NOW).ok, true);
  assert.equal(A.parse(mk({ level: 60 }), NOW).ok, true);
});

test("iface and t must be integers; v must be 1", () => {
  assert.equal(A.parse(mk({ iface: "16x" }), NOW).ok, false);
  assert.equal(A.parse(mk({ t: "abc" }), NOW).ok, false);
  assert.match(A.parse(mk({ v: 2 }), NOW).why, /version 2/);
});

test("unknown tag and non-export text are rejected", () => {
  const r = A.parse(vectors[0].full.replace("LEEROY1", "LEEROY2"), NOW);
  assert.equal(r.ok, false);
  assert.match(r.why, /not a Leeroy export/);
  assert.match(A.parse("hello there", NOW).why, /not a Leeroy export/);
  assert.match(A.parse("   ", NOW).why, /Nothing to read/);
  assert.equal(A.parse("LEEROY1|only-one-part", NOW).ok, false);
});

test("too long is rejected", () => {
  const long = A.encode({ ...base, name: "x".repeat(2100) }).full;
  assert.match(A.parse(long, NOW).why, /Too long/);
});

test("whitespace and line breaks around and inside the string are tolerated", () => {
  const s = vectors[0].full;
  const wrapped = "  \n" + s.slice(0, 20) + "\r\n" + s.slice(20, 41) + " \n\t" + s.slice(41) + "\n\n";
  const r = A.parse(wrapped, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.data.level, 40);
  const spaced = s.replace(/;/g, "; ");
  assert.equal(A.parse(spaced, NOW).ok, true);
});

test("a zone name with a real space still verifies, and a chat-added space does not break the string", () => {
  const full = vectors[2].full;
  const r = A.parse(full, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.data.zone, "Elwynn Forest");
  const wrapped = full.replace("class=PALADIN", "class= PALADIN").replace("Forest", "Forest\n");
  assert.equal(A.parse(wrapped, NOW).ok, false);
});

test("a whole SavedVariables file: the export is found inside Lua text, quotes and all", () => {
  const s = vectors[2].full;
  const lua = `LeeroyDB = {\n\t["version"] = 1,\n\t["export"] = "${s}",\n\t["options"] = {\n\t\t["name"] = false,\n\t},\n}\n`;
  const r = A.parse(lua, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.data.class, "PALADIN");
  assert.equal(r.data.zone, "Elwynn Forest");
  const luaWrapped = `LeeroyDB = {\r\n["export"] = "${s.slice(0, 30)}"\r\n.. "${s.slice(30)}",\r\n}`;
  assert.equal(A.parse(luaWrapped, NOW).ok, false); /* a Lua concatenation is not text the add-on writes: refuse rather than guess */
  const chat = `here you go: ${vectors[0].full} thanks!`;
  assert.equal(A.parse(chat, NOW).ok, true);
});

test("stale and future exports warn but still parse", () => {
  const old = A.parse(vectors[0].full, 1794000000 + 45 * 86400);
  assert.equal(old.ok, true);
  assert.match(old.warnings[0], /45 days old/);
  const fut = A.parse(vectors[0].full, 1794000000 - 5 * 86400);
  assert.match(fut.warnings[0], /future/);
});

test("unknown extra keys are ignored with a note, not trusted", () => {
  const payload = vectors[0].payload + ";zzz=1";
  const s = `LEEROY1|${payload}|${A.hex8(A.adler32(A.utf8(payload)))}`;
  const r = A.parse(s, NOW);
  assert.equal(r.ok, true);
  assert.ok(!("zzz" in r.data));
  assert.match(r.warnings[0], /zzz/);
});

test("duplicate keys and bad prof lists are rejected", () => {
  const dup = vectors[0].payload + ";level=41";
  assert.equal(A.parse(`LEEROY1|${dup}|${A.hex8(A.adler32(A.utf8(dup)))}`, NOW).ok, false);
  assert.equal(A.parse(mk({ prof: "164:300,186:275,171:1" }), NOW).ok, false);
  assert.equal(A.parse(mk({ prof: "abc" }), NOW).ok, false);
});

test("vocabulary mapping: class, race, level and professions land on the board's slugs", () => {
  const d = A.parse(mk({ class: "DRUID", race: "NightElf", level: 22, prof: "182:150,171:75" }), NOW).data;
  const m = A.mapToBoard(d, vocab);
  assert.deepEqual(m.fields, { class: "druid", race: "night-elf", level: 22, professions: ["herbalism", "alchemy"] });
  assert.deepEqual(m.skipped, []);
  assert.equal(A.mapToBoard(A.parse(mk({ race: "Scourge" }), NOW).data, vocab).fields.race, "undead");
});

test("unmapped values are reported, never guessed", () => {
  const d = A.parse(mk({ class: "DEATHKNIGHT", race: "BloodElf", prof: "999:10,164:50" }), NOW).data;
  const m = A.mapToBoard(d, vocab);
  assert.equal(m.fields.class, undefined);
  assert.equal(m.fields.race, undefined);
  assert.deepEqual(m.fields.professions, ["blacksmithing"]);
  assert.deepEqual(m.skipped.map(A.skippedLine), [
    "Class DEATHKNIGHT: not on the board's list, skipped.",
    "Race BloodElf: not on the board's list, skipped.",
    "Profession skill 999: not on the board's list, skipped.",
  ]);
  assert.deepEqual(A.mapToBoard(A.parse(mk({ prof: "185:100" }), NOW).data, vocab).skipped.map(A.skippedLine), ["Profession skill 185: not on the board's list, skipped."]);
  const none = A.mapToBoard(d, {});
  assert.deepEqual(none.fields.level, 40);
  assert.equal(none.fields.professions, undefined);
  assert.equal(A.mapToBoard(A.parse(mk({ level: 55 }), NOW).data, { ...vocab, levelMax: 40 }).fields.level, undefined);
});

test("plan: shows before and after and flags only real changes", () => {
  const m = A.mapToBoard(A.parse(mk({ prof: "164:300,186:275" }), NOW).data, vocab);
  const p = A.plan(m, { race: "human", class: "warrior", level: 40, professions: null });
  assert.deepEqual(p.map((x) => [x.field, x.before, x.after, x.change]), [
    ["race", "human", "human", false], ["class", "warrior", "paladin", true], ["level", 40, 40, false], ["professions", null, ["blacksmithing", "mining"], true],
  ]);
});

test("the name never appears in the mapped fields", () => {
  const d = A.parse(mk({ name: "Secretname", zone: "Elwynn Forest" }), NOW).data;
  assert.equal(d.name, "Secretname");
  assert.ok(!JSON.stringify(A.mapToBoard(d, vocab)).includes("Secretname"));
});

test("unescape decodes any %XX, upper or lower case, and rejects malformed escapes plainly", () => {
  assert.equal(A.unescapeValue("a%01b%1fc%7e%7E"), "abc~~");
  assert.equal(A.unescapeValue("%c3%a9"), "é");
  assert.equal(A.parse(mk({ name: "t	" }), NOW).data.name, "t	");
  for (const badName of ["%", "%4", "%zz", "50%", "%C3"]) {
    const payload = vectors[0].payload + ";name=" + badName;
    const r = A.parse(`LEEROY1|${payload}|${A.hex8(A.adler32(A.utf8(payload)))}`, NOW);
    assert.equal(r.ok, false, badName);
    assert.equal(r.why, "The field name has text that is not a valid escape (%XX) or not valid text.", badName);
  }
});
