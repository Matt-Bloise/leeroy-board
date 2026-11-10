/* Import from game: reads the Leeroy add-on export string (format v1, notes/addon-format-v1.md in leeroy-ops) and maps it to the board's own lists.
   Pure and dependency free: no DOM, no network, no storage. The caller decides what to send. Everything here treats the string as typed input: it is checked, never trusted. */
export const TAG = "LEEROY1", MAX_LEN = 2048, STALE_DAYS = 30;
const ORDER = ["v", "iface", "t", "name", "class", "race", "level", "prof", "talents", "zone"];
const REQUIRED = ["v", "iface", "t", "class", "race", "level"];
const bad = (why) => ({ ok: false, why });

/* Adler-32 by arithmetic only (the same steps as the Lua side). bytes: array of numbers. */
export function adler32(bytes) {
  let a = 1, b = 0;
  for (const c of bytes) { a = (a + c) % 65521; b = (b + a) % 65521; }
  return b * 65536 + a;
}
export const hex8 = (n) => n.toString(16).padStart(8, "0");
export function utf8(str) { return Array.from(new TextEncoder().encode(String(str))); }

/* Escaping, as the format says: % ; = | newline, and every byte above 126 as %XX of its UTF-8 bytes (uppercase hex), plus space, quote, apostrophe, backslash and the other control bytes, so the wire holds no raw space or quote. */
export function escapeValue(s) {
  let out = "";
  for (const c of utf8(s)) {
    const ch = String.fromCharCode(c);
    if (c > 126 || c <= 32 || ch === "\\" || ch === "\"" || ch === "'" || ch === "%" || ch === ";" || ch === "=" || ch === "|") out += "%" + c.toString(16).toUpperCase().padStart(2, "0");
    else out += ch;
  }
  return out;
}
export function unescapeValue(s) {
  if (/%(?![0-9A-Fa-f]{2})/.test(s)) return null;
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%") { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(s.charCodeAt(i));
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return null; }
}

/* Builder, used by the tests and the golden vectors. fields: an object keyed by the format's keys. */
export function encode(fields) {
  const payload = ORDER.filter((k) => fields[k] !== undefined && fields[k] !== null).map((k) => `${k}=${escapeValue(String(fields[k]))}`).join(";");
  const check = hex8(adler32(utf8(payload)));
  return { payload, check, full: `${TAG}|${payload}|${check}` };
}

/* Finds the export string in whatever was pasted or dropped: the bare string, a chat message around it, or a whole SavedVariables file.
   All whitespace is stripped first (the wire never holds a raw space: spaces are %20). Then: the tag and |, the payload up to the next |, and exactly 8 hex digits of check.
   Nothing depends on quote characters, so a surrounding Lua quote or any text after the check is simply left behind. */
export function extract(text) {
  const t = String(text == null ? "" : text).replace(/[\s​﻿]+/g, "");
  const m = /LEEROY1\|([^|]*)\|([0-9A-Fa-f]{8})/.exec(t);
  return m ? m[0] : null;
}

function parseOne(s) {
  if (s.length > MAX_LEN) return bad(`Too long: an export is at most ${MAX_LEN} characters and this is ${s.length}.`);
  const parts = s.split("|");
  if (parts[0] !== TAG) return bad("This is not a Leeroy export. It should begin with LEEROY1|.");
  if (parts.length !== 3) return bad("The export is damaged: it should have three parts, the tag, the data and the check, split by |.");
  const [, payload, check] = parts;
  if (!/^[0-9A-Fa-f]{8}$/.test(check)) return bad("The check at the end is not 8 hex digits, so part of the export is missing or changed.");
  if (/[^\x20-\x7e]/.test(payload)) return bad("The export has characters the add-on never writes. Copy it again from the game.");
  if (hex8(adler32(utf8(payload))) !== check.toLowerCase()) return { ok: false, check: true, why: "The check does not match: the text was changed or cut when it was copied. Copy it again from the game." };
  const raw = Object.create(null);
  for (const pair of payload.split(";")) {
    const i = pair.indexOf("=");
    if (i < 1) return bad("The export is damaged: a field has no name or no value.");
    const k = pair.slice(0, i);
    if (k in raw) return bad(`The field ${k.slice(0, 12)} appears twice.`);
    const v = unescapeValue(pair.slice(i + 1));
    if (v === null) return bad(`The field ${k.slice(0, 12)} has text that is not a valid escape (%XX) or not valid text.`);
    raw[k] = v;
  }
  for (const k of REQUIRED) if (!(k in raw)) return bad(`The export is missing the required field ${k}.`);
  if (raw.v !== "1") return bad(`This export is format version ${raw.v.slice(0, 8)}; this board reads version 1.`);
  if (!/^\d{1,9}$/.test(raw.iface)) return bad("The game build number (iface) is not a whole number.");
  if (!/^\d{10,12}$/.test(raw.t)) return bad("The export time (t) is not a valid time.");
  if (!/^-?\d{1,9}$/.test(raw.level)) return bad("The level is not a whole number.");
  const level = Number(raw.level);
  if (level > 60) return bad(`Level ${level} is above the 60 the board supports.`);
  if (level < 1) return bad(`Level ${level} is below 1.`);
  if (!/^[A-Z]{3,16}$/.test(raw.class)) return bad("The class is not a class token such as PALADIN.");
  if (!/^[A-Za-z]{3,16}$/.test(raw.race)) return bad("The race is not a race token such as NightElf.");
  const out = { v: 1, iface: Number(raw.iface), t: Number(raw.t), class: raw.class, race: raw.race, level };
  if ("name" in raw) out.name = raw.name.slice(0, 64);
  if ("zone" in raw) out.zone = raw.zone.slice(0, 64);
  if ("prof" in raw) {
    const pairs = raw.prof === "" ? [] : raw.prof.split(",");
    if (pairs.length > 2 || !pairs.every((p) => /^\d{1,6}:\d{1,4}$/.test(p))) return bad("The professions field should be at most two id:rank pairs.");
    out.prof = pairs.map((p) => { const [id, rank] = p.split(":").map(Number); return { id, rank }; });
  }
  if ("talents" in raw) {
    const pts = raw.talents === "" ? [] : raw.talents.split(",");
    if (pts.length > 4 || !pts.every((p) => /^\d{1,2}$/.test(p))) return bad("The talents field should be up to four point counts.");
    out.talents = pts.map(Number);
  }
  return { ok: true, data: out, ignored: Object.keys(raw).filter((k) => !ORDER.includes(k)) };
}

/* parse(text, nowSeconds): text is the bare string, a chat message, or a whole SavedVariables file. */
export function parse(text, now) {
  if (String(text == null ? "" : text).trim() === "") return bad("Nothing to read yet. Paste the export string from the add-on.");
  const found = extract(text);
  if (!found) return bad(/LEEROY1\s*\|/.test(String(text)) ? "The export is damaged: it needs the data and then a check of 8 hex digits, split by |. Copy it again from the game." : "This is not a Leeroy export. It should begin with LEEROY1|.");
  const r = parseOne(found);
  if (!r.ok) return bad(r.why);
  const nowS = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  const age = (nowS - r.data.t) / 86400, warnings = [];
  if (age > STALE_DAYS) warnings.push(`This export is ${Math.floor(age)} days old. Export again in the game for current values.`);
  if (age < -1) warnings.push("The export time is in the future. Check the clock on the game computer.");
  if (r.ignored.length) warnings.push(`Ignored fields this board does not read: ${r.ignored.slice(0, 5).map((k) => k.slice(0, 12)).join(", ")}.`);
  return { ok: true, data: r.data, ageDays: age, warnings };
}

/* Mapping to the board's vocabulary. vocab: { race: [slug], class: [slug], professions: [slug], levelMax }, the same lists brain.js validates against (sheetVocab). */
export const CLASS_SLUGS = { WARRIOR: ["warrior"], PALADIN: ["paladin"], HUNTER: ["hunter"], ROGUE: ["rogue"], PRIEST: ["priest"], SHAMAN: ["shaman"], MAGE: ["mage"], WARLOCK: ["warlock"], DRUID: ["druid"], DEATHKNIGHT: ["death-knight", "deathknight"] };
export const RACE_SLUGS = { Human: ["human"], Dwarf: ["dwarf"], NightElf: ["night-elf", "nightelf"], Gnome: ["gnome"], Draenei: ["draenei"], Orc: ["orc"], Scourge: ["undead", "forsaken"], Tauren: ["tauren"], Troll: ["troll"], BloodElf: ["blood-elf", "bloodelf"] };
/* Profession skillLine ids. The repo holds names only, no ids, so these come from the client's public SkillLine table as commonly documented. They are NOT proven from the repo and are unconfirmed on the Forever client. A mapped id still has to name a slug the board lists. Secondary skills (cooking, fishing, first aid) are not on the board's list and are not mapped. */
export const PROF_SLUGS = { 171: "alchemy", 164: "blacksmithing", 333: "enchanting", 202: "engineering", 182: "herbalism", 165: "leatherworking", 186: "mining", 393: "skinning", 197: "tailoring" };
const pick = (cands, list) => (Array.isArray(list) ? (cands || []).find((c) => list.includes(c)) || null : null);

export function mapToBoard(data, vocab) {
  const v = vocab || {}, fields = {}, skipped = [];
  const cls = pick(CLASS_SLUGS[data.class], v.class); if (cls) fields.class = cls; else skipped.push({ what: "Class", from: data.class });
  const race = pick(RACE_SLUGS[data.race], v.race); if (race) fields.race = race; else skipped.push({ what: "Race", from: data.race });
  const max = Number.isInteger(v.levelMax) && v.levelMax > 0 && v.levelMax <= 60 ? v.levelMax : 60;
  if (data.level >= 1 && data.level <= max) fields.level = data.level; else skipped.push({ what: "Level", from: String(data.level) });
  if (data.prof) {
    const slugs = [];
    for (const p of data.prof) {
      const s = PROF_SLUGS[p.id] ? pick([PROF_SLUGS[p.id]], v.professions) : null;
      if (s) { if (!slugs.includes(s)) slugs.push(s); } else skipped.push({ what: "Profession", from: `skill ${p.id}` });
    }
    if (slugs.length) fields.professions = slugs;
  }
  return { fields, skipped };
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
/* current: { field: value|null } as the sheet shows now. Returns [{field, before, after, change}] in a fixed order. */
export function plan(mapped, current) {
  const cur = current || {};
  return ["race", "class", "level", "professions"].filter((f) => f in mapped.fields).map((f) => {
    const before = cur[f] === undefined ? null : cur[f], after = mapped.fields[f];
    return { field: f, before, after, change: !same(before, after) };
  });
}
export const skippedLine = (s) => `${s.what} ${s.from}: not on the board's list, skipped.`;
