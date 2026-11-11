// Cinematic slice 6: Buffs and roads, the pure parts (js/roads-buffs-core.js), over the real party and buff data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { glance, hapticFor } from "../../js/roads-buffs-core.js";

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../../data/${f}`, import.meta.url), "utf8"));
const party = read("party.json"), client = read("client.json");
test("glance over the real party: every row has a real giver, buffs, and an audience", () => {
  const rows = glance(client.buffs.list, party.members);
  assert.ok(rows.length >= 1);
  for (const r of rows) { assert.ok(r.buffs.length > 0); assert.ok(r.to.length > 0); assert.ok(party.members.some((m) => m.name === r.giver)); }
  assert.ok(rows.some((r) => r.to === "everyone"));
});

test("glance: a role buff names only those it lands on; the sixth player is opt-in", () => {
  const members = [{ name: "A", class_key: "priest", class: "Priest", role: "healer" }, { name: "B", class_key: "druid", class: "Druid", role: "tank" }, { name: "C", class_key: "mage", class: "Mage", role: "damage" }];
  const list = [{ name: "T", class: "priest", lands: "tank" }, { name: "H", class: "priest", lands: "healer" }, { name: "S", class: "shaman", sixth: true, lands: "all" }, { name: "G", class: "priest", lands: "all" }];
  assert.deepEqual(glance(list, members).map((r) => [r.to, r.buffs]), [["B", ["T"]], ["A", ["H"]], ["everyone", ["G"]]]);
  const one = [{ name: "S", class: "priest", sixth: true, lands: "one" }];
  assert.equal(glance(one, members).length, 0);
  assert.equal(glance(one, members, { sixth: true })[0].to, "one person you pick");
});

test("hapticFor: a tick per step, a tap on a mark, nothing when the level did not change", () => {
  const marks = client.buffs.marks;
  assert.equal(hapticFor(30, 31, marks), "boundary");
  assert.equal(hapticFor(39, 40, marks), "select");
  assert.equal(hapticFor(40, 40, marks), null);
  assert.equal(hapticFor(40, NaN, marks), null);
});
