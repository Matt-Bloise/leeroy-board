// Unit tests for the roster helpers. Made-up ids and names only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveMember, upsertMember, validateMemberEntry } from "../../infrastructure/worker/members.js";
import { validateConfigValue } from "../../infrastructure/worker/config.js";

const members = [
  { slug: "red-fox", name: "Red Fox", match: ["fox"], id: "100000000000000001" },
  { slug: "blue-owl", name: "Blue Owl", match: ["owl"] },
];

test("id match wins over a conflicting display name", () => {
  assert.deepEqual(resolveMember("100000000000000001", "Blue Owl fan", members), { slug: "red-fox", name: "Red Fox" });
});

test("display-name fallback only applies to callers with no Discord id at all", () => {
  assert.deepEqual(resolveMember(undefined, "owl", members), { slug: "blue-owl", name: "Blue Owl" });
  assert.deepEqual(resolveMember(null, "the OWL", members), { slug: "blue-owl", name: "Blue Owl" });
  assert.deepEqual(resolveMember("", "the OWL", members), { slug: "blue-owl", name: "Blue Owl" });
});

test("a caller with a Discord id is matched by id only: a guest named after a member is not that member", () => {
  assert.equal(resolveMember("100000000000000099", "the OWL", members), null);
  assert.equal(resolveMember("100000000000000099", "Red Fox (not really)", members), null);
  // The real owner still resolves by id, whatever their display name says.
  assert.deepEqual(resolveMember("100000000000000001", "someone else", members), { slug: "red-fox", name: "Red Fox" });
});

test("unknown user resolves to null, including with no config", () => {
  assert.equal(resolveMember("100000000000000099", "stranger", members), null);
  assert.equal(resolveMember("100000000000000099", "stranger", null), null);
});

test("upsert adds a new entry and keeps entries without id working", () => {
  const r = upsertMember(members, { slug: "green-elk", name: "Green Elk", id: "100000000000000002" });
  assert.equal(r.members.length, 3);
  assert.deepEqual(r.members[2], { slug: "green-elk", name: "Green Elk", match: [], id: "100000000000000002" });
  assert.equal(members.length, 2);
});

test("upsert updates by slug and keeps the existing match list and id", () => {
  const r = upsertMember(members, { slug: "red-fox", name: "Fox Renamed" });
  assert.equal(r.members.length, 2);
  assert.deepEqual(r.members[0], { slug: "red-fox", name: "Fox Renamed", match: ["fox"], id: "100000000000000001" });
});

test("upsert rejects an id held by a different slug", () => {
  const r = upsertMember(members, { slug: "green-elk", name: "Green Elk", id: "100000000000000001" });
  assert.match(r.error, /different member/);
});

test("upsert validates slug, name, id and match", () => {
  assert.ok(upsertMember(members, { slug: "Bad Slug", name: "x" }).error);
  assert.ok(upsertMember(members, { slug: "a".repeat(33), name: "x" }).error);
  assert.ok(upsertMember(members, { slug: "ok", name: "n".repeat(41) }).error);
  assert.ok(upsertMember(members, { slug: "ok", name: "x", id: "123" }).error);
  assert.ok(upsertMember(members, { slug: "ok", name: "x", id: "1000000000000000011111" }).error);
  assert.ok(upsertMember(members, { slug: "ok", name: "x", match: ["Upper"] }).error);
  assert.equal(validateMemberEntry({ slug: "ok", name: "x", match: [] }), null);
});

test("discord_members config validator accepts an optional id and rejects a bad one", () => {
  assert.equal(validateConfigValue("discord_members", members), null);
  assert.ok(validateConfigValue("discord_members", [{ slug: "a", name: "A", match: [], id: "12" }]));
});
