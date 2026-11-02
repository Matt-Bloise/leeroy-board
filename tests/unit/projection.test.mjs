// Unit tests for infrastructure/worker/projection.js. Made-up ids and handles only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planProjection } from "../../infrastructure/worker/projection.js";
import { slugify } from "../../infrastructure/worker/member-model.js";
import { validateMemberEntry } from "../../infrastructure/worker/members.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const party = () => JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "six-members", "party.json"), "utf8"));
const ID = "100000000000000007", OTHER = "100000000000000008";
const BUILD = { class: "Shaman", race: "Tauren", faction: "Horde", ruleset: "Normal", role: "DPS", notes: "" };
const plan = (o = {}) => planProjection({ handle: "Wick Marrowbone", build: BUILD, discordUserId: ID, partyDoc: party(), roster: [], ...o });
const apply = (p, doc, roster) => ({ partyDoc: { ...doc, members: [...doc.members.filter((m) => m.name.toLowerCase() !== p.partyEntry.name.toLowerCase()), p.partyEntry] }, roster: [...roster.filter((r) => r.id !== p.rosterEntry.id), p.rosterEntry] });

test("a new member gets a party entry and a roster entry the Worker accepts", () => {
  const p = plan();
  assert.equal(p.ok, true, p.error);
  assert.equal(p.duplicate, false);
  assert.equal(p.slug, "wick-marrowbone");
  assert.equal(p.partyEntry.board_line, "Tauren Shaman");
  assert.equal(p.partyEntry.role, "damage");
  assert.deepEqual(p.rosterEntry, { slug: "wick-marrowbone", name: "Wick Marrowbone", match: ["wick marrowbone"], id: ID });
  assert.equal(validateMemberEntry(p.rosterEntry), null);
});

test("roles and multi-word races map to the board's keys", () => {
  assert.equal(plan({ build: { ...BUILD, class: "Priest", race: "Night Elf", role: "Healer" } }).partyEntry.race, "Night Elf");
  assert.equal(plan({ build: { ...BUILD, role: "Tank" } }).partyEntry.role, "tank");
});

test("a name clash with another member is refused, case-insensitively, and never suffixed", () => {
  const doc = party(), taken = doc.members[0].name;
  for (const h of [taken, taken.toUpperCase()]) {
    const p = plan({ handle: h });
    assert.equal(p.ok, false);
    assert.match(p.error, /taken/);
  }
  const roster = [{ slug: slugify(taken), name: taken, match: [taken.toLowerCase()], id: OTHER }];
  assert.equal(plan({ handle: taken, roster }).ok, false);
});

test("a roster entry holding the slug under another id is refused", () => {
  const roster = [{ slug: "wick-marrowbone", name: "Wick Marrowbone", match: ["wick marrowbone"], id: OTHER }];
  const p = plan({ roster });
  assert.equal(p.ok, false);
  assert.equal(p.slug, undefined);
});

test("resubmit with the same id and handle updates in place and keeps a chosen spec", () => {
  const first = plan();
  const doc = party();
  doc.members.push({ ...first.partyEntry, spec: "Elemental", spec_status: { status: "declared", source: "board" }, board_line: "Tauren Elemental Shaman" });
  const p = plan({ partyDoc: doc, roster: [first.rosterEntry] });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.duplicate, true);
  assert.equal(p.partyEntry.spec, "Elemental");
  assert.equal(p.slug, first.slug);
});

test("resubmit with a changed class replaces the build fields", () => {
  const first = plan();
  const doc = party(); doc.members.push(first.partyEntry);
  const p = plan({ partyDoc: doc, roster: [first.rosterEntry], build: { ...BUILD, class: "Mage", race: "Undead" } });
  assert.equal(p.ok, true);
  assert.equal(p.partyEntry.class_key, "mage");
  assert.equal(p.partyEntry.spec, "Not chosen yet");
});

test("a different handle for an id already on the roster is refused", () => {
  const first = plan();
  const p = plan({ handle: "Wick Bonemarrow", roster: [first.rosterEntry] });
  assert.deepEqual(p, { ok: false, error: "ask an admin" });
});

test("bad handles are refused", () => {
  for (const h of ["", "   ", "x".repeat(41), "Wick@example.com", "Blizzard Wick", "https://x.y", "a/b", "!!!", undefined, 5]) assert.equal(plan({ handle: h }).ok, false, String(h));
});

test("bad ids are refused", () => {
  for (const i of ["123", "", undefined, "10000000000000000a", "1".repeat(21)]) assert.equal(plan({ discordUserId: i }).ok, false, String(i));
});

test("a build outside the tables is refused", () => {
  assert.equal(plan({ build: { ...BUILD, class: "Bard" } }).ok, false);
  assert.equal(plan({ build: { ...BUILD, race: "Pandaren" } }).ok, false);
  assert.equal(plan({ build: { ...BUILD, role: "Bard" } }).ok, false);
  assert.equal(plan({ build: undefined }).ok, false);
});

test("the slug equals slugify(handle) for every accepted handle", () => {
  for (const h of ["Wick Marrowbone", "  Wick   Marrowbone ", "Ünder Thorn", "Wick-7", "A"]) {
    const p = plan({ handle: h });
    assert.equal(p.ok, true, h);
    assert.equal(p.slug, slugify(h.trim().replace(/\s+/g, " ")));
    assert.equal(p.rosterEntry.slug, p.slug);
  }
});

test("planning the output again changes nothing", () => {
  const p1 = plan();
  const { partyDoc, roster } = apply(p1, party(), []);
  const p2 = plan({ partyDoc, roster });
  assert.equal(p2.ok, true, p2.error);
  assert.equal(p2.duplicate, true);
  assert.deepEqual(p2.partyEntry, p1.partyEntry);
  assert.deepEqual(p2.rosterEntry, p1.rosterEntry);
  const again = apply(p2, partyDoc, roster);
  assert.deepEqual(again, { partyDoc, roster });
});

test("planning does not mutate its inputs", () => {
  const doc = party(), roster = [], a = JSON.stringify(doc);
  planProjection({ handle: "Wick", build: BUILD, discordUserId: ID, partyDoc: doc, roster });
  assert.equal(JSON.stringify(doc), a);
  assert.deepEqual(roster, []);
});
