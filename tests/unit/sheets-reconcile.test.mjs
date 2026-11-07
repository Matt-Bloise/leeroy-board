// A person in the party document but not in the stored party_sheets row (added later by an admin or /join) must appear in the sheets
// the board reads. Fictional members only. Run: node --test tests/unit/sheets-reconcile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSheetsWithDoc } from "../../infrastructure/worker/party-source.js";
import { buildPartySheetsFromD1 } from "../../infrastructure/worker/index.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const f = (value) => ({ value, visible: true, source: "board", at: "2026-10-30T00:00:00.000Z" });
const STORED = [{ slug: "red-fox", name: "Red Fox", fields: { class: f("paladin") }, updated: "x" }];
const DOC = { members: [{ name: "Red Fox", class_key: "paladin", race: "Human" }, { name: "Blue Owl", class_key: "mage", class: "Mage", race: "Gnome", start_zone: "Dun Morogh" }] };

test("a document member without a sheet gets one; the stored sheet is untouched", () => {
  const out = reconcileSheetsWithDoc(STORED, DOC);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], STORED[0]);
  const owl = out.find((s) => s.slug === "blue-owl");
  assert.equal(owl.name, "Blue Owl");
  assert.equal(owl.fields.class.value, "mage");
  assert.equal(owl.fields.race.value, "gnome");
  assert.equal(owl.fields.plan_zone.value, "dun-morogh");
});
test("nothing missing returns the same array; no document, junk and name clashes change nothing", () => {
  assert.equal(reconcileSheetsWithDoc(STORED, { members: [{ name: "red fox" }] }), STORED);
  assert.equal(reconcileSheetsWithDoc(STORED, null), STORED);
  assert.equal(reconcileSheetsWithDoc(STORED, { members: [null, {}, { name: 5 }] }), STORED);
  assert.deepEqual(reconcileSheetsWithDoc(null, null), []);
});
test("buildPartySheetsFromD1 reads the reconciled list, writes nothing, and never adds the built-in five", async () => {
  const DB = schemaDb();
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  put("party_sheets", STORED);
  put("party", DOC);
  const { party } = await buildPartySheetsFromD1({ DB });
  assert.deepEqual(party.map((p) => p.slug).sort(), ["blue-owl", "red-fox"]);
  assert.equal(JSON.parse(DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json).length, 1, "the stored row is not rewritten by a read");
});
test("without a party document the stored sheets come back as they are", async () => {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, 'x')").run(JSON.stringify(STORED));
  assert.deepEqual((await buildPartySheetsFromD1({ DB })).party, STORED);
});
