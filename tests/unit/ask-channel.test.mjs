// ask_turns.channel: the Discord channel an /ask came from is stored in the same insert/batch as the row, or NULL. Real SQLite, made-up ids.
// Run: node --test tests/unit/ask-channel.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { insertAskTurn, askChannel } from "../../infrastructure/worker/answer-ux.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const MIGRATION = readFileSync(new URL("../../infrastructure/migrations/0012_ask_turns_channel.sql", import.meta.url), "utf8");
const USER_SALT = "user-salt-for-tests-0123456789";
const ME = "100000000000000001";
const CH = "200000000000000002";
const ROW = (id, channel) => ({ id, byName: "Red Fox", question: "q", provider: "p", share: true, createdAt: "2026-11-01T00:00:00.000Z", ...(channel === undefined ? {} : { channel }) });
// The state after deploy: schema.sql, then migration 0012.
const migratedDb = () => { const d = schemaDb(); d.raw.exec(MIGRATION); return d; };
const chan = (db, id) => db.raw.prepare("SELECT channel FROM ask_turns WHERE id = ?").get(id).channel;
const askers = (db, id) => Number(db.raw.prepare("SELECT COUNT(*) AS c FROM ask_turn_askers WHERE intent_id = ?").get(id).c);

test("a Discord channel ask stores the channel id, with its asker rows, in one batch", async () => {
  const db = migratedDb(), env = { DB: db, USER_SALT };
  await insertAskTurn(env, ROW("q1", CH), { discordId: ME });
  assert.equal(chan(db, "q1"), CH);
  assert.equal(askers(db, "q1"), 1);
});

test("a channel ask with no asker hash (single insert) stores the channel too", async () => {
  const db = migratedDb();
  await insertAskTurn({ DB: db, USER_SALT }, ROW("q2", CH), {});
  assert.equal(chan(db, "q2"), CH);
});

test("a DM or web ask (no channel) stores NULL", async () => {
  const db = migratedDb(), env = { DB: db, USER_SALT };
  await insertAskTurn(env, ROW("q-dm", null), { discordId: ME });
  await insertAskTurn(env, ROW("q-web"), {});
  assert.equal(chan(db, "q-dm"), null);
  assert.equal(chan(db, "q-web"), null);
});

test("a malformed channel id stores NULL", async () => {
  const db = migratedDb(), env = { DB: db, USER_SALT };
  const bad = ["12", "abc123456", "1234 5678", "1".repeat(26), "<#200000000000000002>", "200000000000000002; DROP TABLE ask_turns", "", 200000000000000002, {}];
  for (const [i, v] of bad.entries()) {
    await insertAskTurn(env, ROW(`q-bad${i}`, v), { discordId: ME });
    assert.equal(chan(db, `q-bad${i}`), null, JSON.stringify(v));
  }
  assert.equal(askChannel("12345"), "12345");
  assert.equal(askChannel("1".repeat(25)), "1".repeat(25));
});

test("the batch stays atomic: a failing asker insert leaves neither the row nor the channel", async () => {
  const db = migratedDb(), env = { DB: db, USER_SALT };
  db.raw.exec("CREATE TRIGGER boom BEFORE INSERT ON ask_turn_askers BEGIN SELECT RAISE(ABORT, 'asker write failed'); END");
  await assert.rejects(insertAskTurn(env, ROW("q-atomic", CH), { discordId: ME }));
  assert.equal(Number(db.raw.prepare("SELECT COUNT(*) AS c FROM ask_turns").get().c), 0);
});

test("before migration 0012 (no column) a channel ask still lands, without the channel, and the askers land with it", async () => {
  const db = schemaDb(), env = { DB: db, USER_SALT };
  await insertAskTurn(env, ROW("q-old", CH), { discordId: ME });
  assert.equal(Number(db.raw.prepare("SELECT COUNT(*) AS c FROM ask_turns WHERE id = 'q-old'").get().c), 1);
  assert.equal(askers(db, "q-old"), 1);
  assert.ok(!db.raw.prepare("PRAGMA table_info(ask_turns)").all().some((c) => c.name === "channel"), "schema.sql must not carry the column");
});

test("migration 0012 applies on top of schema.sql, as CI does, and the column is nullable", () => {
  const db = schemaDb();
  db.raw.exec(MIGRATION);
  const col = db.raw.prepare("PRAGMA table_info(ask_turns)").all().find((c) => c.name === "channel");
  assert.ok(col);
  assert.equal(col.notnull, 0);
});

test("both Discord ask sites pass the origin channel, and no read path selects it yet", () => {
  const src = readFileSync(new URL("../../infrastructure/worker/discord.js", import.meta.url), "utf8");
  assert.equal((src.match(/channel: askOriginChannel\(interaction\)/g) || []).length, 2);
  for (const f of ["data-rights.js", "ai-models.js", "feed.js", "ask-answer.js", "export.js"]) {
    assert.doesNotMatch(readFileSync(new URL(`../../infrastructure/worker/${f}`, import.meta.url), "utf8"), /ask_turns[^;]*\bchannel\b|\bt\.channel\b/i, f);
  }
});
