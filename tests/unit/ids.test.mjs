// Unit tests for the config-driven Discord ids. Made-up numeric ids only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigKey, invalidateConfigCache, validateConfigValue, libraryShelfLine, buildThreadMention, CONFIG_KEYS } from "../../infrastructure/worker/config.js";

const roster = {
  guildId: "111111111111111111",
  buildThreads: { "Red Fox": "222222222222222222" },
  libraryThreads: { "Pop Quiz": "333333333333333333" },
};

function envWith(row) {
  return { DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) } };
}

test("discord_roster is an allow-listed config key", () => {
  assert.ok(CONFIG_KEYS.includes("discord_roster"));
});

test("loadConfigKey returns null when the row is missing, the DB throws, or the key is unknown", async () => {
  invalidateConfigCache();
  assert.equal(await loadConfigKey(envWith(null), "discord_roster"), null);
  invalidateConfigCache();
  assert.equal(await loadConfigKey({ DB: { prepare: () => { throw new Error("down"); } } }, "discord_roster"), null);
  assert.equal(await loadConfigKey(envWith({ json: "{}" }), "not_a_key"), null);
  invalidateConfigCache();
});

test("loadConfigKey returns the stored roster", async () => {
  invalidateConfigCache();
  assert.deepEqual(await loadConfigKey(envWith({ json: JSON.stringify(roster) }), "discord_roster"), roster);
  invalidateConfigCache();
});

test("validateConfigValue accepts a good roster and rejects bad shapes", () => {
  assert.equal(validateConfigValue("discord_roster", roster), null);
  assert.equal(validateConfigValue("discord_roster", {}), null);
  assert.ok(validateConfigValue("discord_roster", []));
  assert.ok(validateConfigValue("discord_roster", { guildId: 5 }));
  assert.ok(validateConfigValue("discord_roster", { buildThreads: { "Red Fox": "abc" } }));
  assert.ok(validateConfigValue("discord_roster", { libraryThreads: [] }));
});

test("libraryShelfLine links when configured and falls back to plain text without throwing", () => {
  const post = { title: "Pop Quiz", short: "Quiz" };
  assert.match(libraryShelfLine(post, roster), /\[Pop Quiz\]\(https:\/\/discord\.com\/channels\/111111111111111111\/333333333333333333\) \(Quiz\)/);
  for (const missing of [null, undefined, {}, { guildId: "111111111111111111" }, { libraryThreads: { "Pop Quiz": "333333333333333333" } }]) {
    const line = libraryShelfLine(post, missing);
    assert.ok(line.includes("Pop Quiz (Quiz)") && !line.includes("http"), line);
  }
});

test("buildThreadMention returns a mention when configured and null otherwise", () => {
  assert.equal(buildThreadMention({ display: "Red Fox" }, roster), "<#222222222222222222>");
  assert.equal(buildThreadMention({ display: "Blue Owl" }, roster), null);
  assert.equal(buildThreadMention({ display: "Red Fox" }, null), null);
  assert.equal(buildThreadMention({ display: "Red Fox" }, {}), null);
});

// Source scan: no 17 to 20 digit number may live under infrastructure/worker.
// The only allowed one is the product's own public Discord application id (index.js fallback for env.DISCORD_CLIENT_ID).
const ALLOWED_APP_ID = "1561857940174938114";
const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../infrastructure/worker");

test("no Discord id literals remain in infrastructure/worker (except the application id)", () => {
  const hits = [];
  for (const f of fs.readdirSync(workerDir).filter((n) => n.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(workerDir, f), "utf8");
    for (const m of text.matchAll(/\b[0-9]{17,20}\b/g)) {
      if (m[0] !== ALLOWED_APP_ID) hits.push(`${f}:${m.index}`);
    }
  }
  assert.deepEqual(hits, []);
});
