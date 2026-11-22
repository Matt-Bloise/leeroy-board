// data/sample/* is the fictional guild the board shows a visitor with no sheet, and it ships in the Pages bundle. No sample member may carry the build of a real member of the
// party (data/party.json, read here at run time, never written in this file): not the whole build (race, class, spec, role, start zone, professions), and not the pair that
// identifies a person at a small table, class plus professions. Fictional names alone would still say which real person plays what.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
const profs = (m) => (m.professions || []).map((p) => norm(typeof p === "string" ? p : p && p.name)).sort().join("+");
const full = (m) => JSON.stringify([m.race, m.class_key, m.spec, m.role, m.start_zone, profs(m)].map(norm));
const pair = (m) => `${norm(m.class_key)}|${profs(m)}`;

const real = load("data/party.json").members;
const sampleParty = load("data/sample/party.json").members;
const sampleBuilds = load("data/sample/builds.json").builds;

test("no sample party member has the full build of a real member", () => {
  const real5 = new Set(real.map(full));
  for (const m of sampleParty) assert.ok(!real5.has(full(m)), `a sample member's whole build (race, class, spec, role, start zone, professions) equals a real member's`);
});

test("no sample member, in the party or the builds file, has a real member's class and professions", () => {
  const realPairs = new Set(real.map(pair));
  for (const m of sampleParty) assert.ok(!realPairs.has(pair(m)), `sample party: a member has a real member's class and professions (${m.class_key})`);
  for (const m of sampleBuilds) assert.ok(!realPairs.has(pair(m)), `sample builds: a member has a real member's class and professions (${m.class_key})`);
});

test("the sample party and the sample builds agree on each member's class and professions", () => {
  const byName = new Map(sampleBuilds.map((b) => [norm(b.name), b]));
  for (const m of sampleParty) {
    const b = byName.get(norm(m.name));
    assert.ok(b, `sample builds has no entry for ${m.name}`);
    assert.equal(pair(b), pair(m), `${m.name}: party and builds differ`);
  }
});
