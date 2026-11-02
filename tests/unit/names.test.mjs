// Pure unit tests for the config-driven name handling. Made-up names only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { repairHouseVoice } from "../../infrastructure/worker/ai-models.js";
import { slugFromDisplayName } from "../../infrastructure/worker/discord.js";
import { validateConfigValue } from "../../infrastructure/worker/config.js";

const members = [
  { slug: "red-fox", name: "Red Fox", match: ["fox", "alex"] },
  { slug: "blue-owl", name: "Blue Owl", match: ["owl", "sam"] },
];

test("repairHouseVoice replaces names from a supplied map", () => {
  const out = repairHouseVoice("Alex and Sam bring the snacks to the run.", { nameMap: { Alex: "Red Fox", Sam: "Blue Owl" } });
  assert.match(out, /^Red Fox and Blue Owl bring/);
});

test("repairHouseVoice leaves text unchanged with an empty or missing map", () => {
  const text = "Alex and Sam bring the snacks to the run.";
  assert.equal(repairHouseVoice(text, { nameMap: {} }), text);
  assert.equal(repairHouseVoice(text), text);
});

test("slugFromDisplayName matches by tokens, case-insensitively", () => {
  assert.deepEqual(slugFromDisplayName("Alex the Brave", members), { slug: "red-fox", name: "Red Fox" });
  assert.deepEqual(slugFromDisplayName("NightOWL", members), { slug: "blue-owl", name: "Blue Owl" });
});

test("slugFromDisplayName returns null for no match or no members", () => {
  assert.equal(slugFromDisplayName("Stranger", members), null);
  assert.equal(slugFromDisplayName("Alex", null), null);
  assert.equal(slugFromDisplayName("Alex", []), null);
  assert.equal(slugFromDisplayName("Alex"), null);
});

test("validateConfigValue accepts well-formed rows and rejects bad ones", () => {
  assert.equal(validateConfigValue("name_map", { Alex: "Red Fox" }), null);
  assert.equal(validateConfigValue("discord_members", members), null);
  assert.ok(validateConfigValue("name_map", []));
  assert.ok(validateConfigValue("name_map", { Alex: 5 }));
  assert.ok(validateConfigValue("discord_members", [{ slug: "a", name: "A", match: ["Upper"] }]));
  assert.ok(validateConfigValue("other", {}));
});
