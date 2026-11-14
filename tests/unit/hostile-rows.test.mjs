// Hostile rows and hostile spellings: the sign-up helpers that run on a stored document must survive a row that is not an object and a name
// that is not what a member would type. Fictional data only. No network, no D1, no AI.
// What this pins is what holds today. Known gaps (applySignupChange and diffRsvp throw on a null row; renderSignupCard throws on an rsvp
// of "constructor"; a malformed `updated` wins a duplicate-row merge) are listed in docs/review-classes.md as follow-ups, not asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import { upsertSignupEntry, nameKey, pickSignupPatch } from "../../infrastructure/worker/limits.js";
import { cardMembers, memberFor, claimEntries } from "../../infrastructure/worker/card-members.js";
import { applySignupChange } from "../../infrastructure/worker/cards.js";
import { slugify } from "../../infrastructure/worker/member-model.js";

const JUNK = [null, undefined, 5, "text", true, [], [1, 2]];

test("upsertSignupEntry: rows that are not objects are skipped, left in place, and never matched", () => {
  const doc = { entries: [...JUNK, { slug: "ada", name: "Ada", rsvp: "in" }] };
  const hit = upsertSignupEntry(doc, { slug: "ada", name: "Ada" });
  assert.equal(hit.rsvp, "in");
  assert.equal(doc.entries.length, JUNK.length + 1, "no junk row is folded away or duplicated");
  const fresh = upsertSignupEntry(doc, { slug: "bo", name: "Bo" });
  assert.deepEqual(fresh, { slug: "bo", name: "Bo" });
});

test("upsertSignupEntry: a document with no entries array gets one; an entries value that is not an array is replaced", () => {
  const a = {};
  upsertSignupEntry(a, { slug: "ada", name: "Ada" });
  assert.equal(a.entries.length, 1);
  const b = { entries: { ada: 1 } };
  upsertSignupEntry(b, { slug: "ada", name: "Ada" });
  assert.ok(Array.isArray(b.entries));
});

test("memberFor and claimEntries: a null, numeric or nameless entry claims nobody and does not throw", () => {
  const members = [{ slug: "ada", name: "Ada" }];
  for (const e of JUNK) assert.equal(memberFor(members, e), null, String(e));
  assert.equal(memberFor(members, {}), null);
  assert.equal(memberFor(members, { name: {} }), null);
  const { byMember } = claimEntries(members, [...JUNK, { name: "Ada" }]);
  assert.equal(byMember.size, 1);
  assert.equal(claimEntries(members, "not a list").byMember.size, 0);
  assert.equal(claimEntries(null, [{ name: "Ada" }]).byMember.size, 0);
});

test("cardMembers: non-object members, nameless members and non-string names are skipped; the printed name carries no mention or link syntax", () => {
  const out = cardMembers({ members: [...JUNK, { name: 7 }, { name: "" }, { name: "@everyone <@&123456789012345678> [x](https://e.test) ‮", class: "Frost Mage" }] });
  assert.equal(out.length, 1);
  assert.ok(out[0].slug && out[0].name);
  assert.ok(!/[<>@\[\]()‮]/.test(out[0].name + out[0].classLabel), out[0].name);
  assert.deepEqual(cardMembers(null), []);
  assert.deepEqual(cardMembers({ members: "x" }), []);
});

test("nameKey and slugify: width forms, zero-width characters and decoration do not make a different person", () => {
  const same = ["Ada", "ADA", "=Ada=", "Ａda", "A​da", "A⁠da", " a-d-a "];
  for (const s of same) assert.equal(nameKey(s), "ada", JSON.stringify(s));
  assert.notEqual(nameKey("Ada"), nameKey("Adam"));
  assert.notEqual(nameKey("José"), nameKey("Jose"), "an accent is a different name");
  assert.equal(nameKey(""), "");
  assert.equal(nameKey(null), "");
  assert.equal(slugify("Ａda ​"), "ada");
  assert.equal(slugify("!!!"), "");
});

test("pickSignupPatch: anything that is not a plain patch is empty or refused, and no key outside the list is copied", () => {
  for (const bad of [null, undefined, "x", 5, [1]]) {
    const r = pickSignupPatch(bad);
    assert.ok(r.error || Object.keys(r.patch).length === 0, `${String(bad)}: no field is taken`);
  }
  const hostile = JSON.parse('{"rsvp":"in","slug":"red-fox","__proto__":{"evil":1},"constructor":{"x":1},"updated":"2999-01-01T00:00:00Z"}');
  const r = pickSignupPatch(hostile);
  assert.deepEqual(r.patch, { rsvp: "in" }, "slug, updated and prototype keys are never taken from the caller");
  assert.equal(Object.getPrototypeOf(r.patch), Object.prototype);
  assert.equal({}.evil, undefined);
  for (const key of ["pack", "meet", "when", "rsvp"]) {
    assert.ok(pickSignupPatch({ [key]: "a".repeat(500) }).error, `${key}: over the length limit`);
    assert.ok(pickSignupPatch({ [key]: { a: 1 } }).error, `${key}: an object`);
    assert.ok(pickSignupPatch({ [key]: ["x"] }).error, `${key}: an array`);
  }
});

test("applySignupChange: a name that is an object-property word makes an ordinary own row and does not touch Object.prototype", () => {
  const NOW = Date.UTC(2026, 10, 3, 12);
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const r = applySignupChange({ entries: [] }, { name, field: "rsvp", value: "in", now: NOW });
    assert.equal(r.ok, true, name);
    assert.equal(r.doc.entries.length, 1);
    assert.equal(r.doc.entries[0].rsvp, "in");
    assert.equal(r.doc.entries[0].updated, "2026-11-03T12:00:00.000Z");
  }
  assert.equal({}.rsvp, undefined);
});
