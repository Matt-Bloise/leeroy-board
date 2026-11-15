// Review catalogue F-12: a party write purged /api/data/party.json, but the site fetches /api/data/party (js/board.js apiFetch drops the
// ".json"), so friends saw the old party until the 60 s cache expired. A party write must purge every URL the party document is served from:
// the site's /api/data/party, the public API's /api/data/party.json, and /api/state and /api/bootstrap, which embed it.
// The Discord /build path (discord.js, BUILD_PROJECT) is covered in join-flow.test.mjs. Real Worker over in-memory SQLite D1; fictional data; no network.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { PARTY_CACHE_PATHS } from "../../infrastructure/worker/index.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const KEY = "member-key-for-tests-party-cache-01";
const SALT = "salt-for-tests-0123456789";
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const room = { fetch: async () => new Response("ok") };

// The URLs the party document is read from. /api/data/party is what js/board.js requests; the rest are the public API's names for it.
const PARTY_URLS = ["/api/data/party", "/api/data/party.json", "/api/state", "/api/bootstrap"];

// A caches.default that really stores and deletes, keyed by URL, and records every delete.
function fakeEdgeCache() {
  const store = new Map(), deleted = [];
  const key = (r) => (typeof r === "string" ? r : r.url);
  return {
    deleted,
    default: {
      match: async (r) => { const hit = store.get(key(r)); return hit ? hit.clone() : undefined; },
      put: async (r, resp) => { store.set(key(r), resp.clone()); },
      delete: async (r) => { deleted.push(new URL(key(r)).pathname); return store.delete(key(r)); },
    },
  };
}

async function makeEnv() {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('quill', ?, '2026-11-01T00:00:00Z')").run(await sha256Hex(`${SALT}:${KEY}`));
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES ('party', ?, '2026-11-01T00:00:00Z')")
    .run(JSON.stringify({ party: "Test Party", members: [{ name: "Quill", race: "Human", class: "Mage", spec: "Frost" }] }));
  return { DB, KEY_SALT: SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
async function call(env, method, path, body) {
  const init = { method, headers: { Authorization: `Board ${KEY}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const silence = console.error; console.error = () => {};
  try { return await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx); } finally { console.error = silence; }
}
const raceIn = (text) => JSON.stringify(JSON.parse(text)).match(/"race":"(\w+)"/)?.[1];

test("F-12: PARTY_CACHE_PATHS names every URL the party document is served from", () => {
  for (const p of PARTY_URLS) assert.ok(PARTY_CACHE_PATHS.includes(p), `${p} is not purged after a party write`);
});

test("F-12: a sheet write purges every party URL, and the next read of each (primed beforehand) is fresh", async () => {
  const env = await makeEnv();
  const realCaches = globalThis.caches;
  const edge = fakeEdgeCache();
  globalThis.caches = edge;
  const READ_URLS = [...PARTY_URLS, "/data/party", "/data/party.json"];
  try {
    // prime every cached URL with the old party; each read must show the stored race
    for (const p of READ_URLS) {
      const r = await call(env, "GET", p);
      assert.equal(r.status, 200, `${p} answers`);
      assert.equal(raceIn(await r.text()), "Human", `${p} starts with the stored race`);
    }
    edge.deleted.length = 0;
    const w = await call(env, "POST", "/api/sheet", { field: "race", value: "Gnome", visible: true });
    assert.equal(w.status, 200, "the sheet write is accepted");
    for (const p of PARTY_URLS) assert.ok(edge.deleted.includes(p), `${p} was not purged; purged: ${edge.deleted.join(", ")}`);
    // after the write each URL answers with the new party at once, not after the cache expires
    for (const p of READ_URLS) {
      const r = await call(env, "GET", p);
      assert.equal(r.status, 200, `${p} answers after the write`);
      assert.equal(raceIn(await r.text()), "Gnome", `${p} still serves the old party`);
    }
  } finally {
    globalThis.caches = realCaches;
  }
});
