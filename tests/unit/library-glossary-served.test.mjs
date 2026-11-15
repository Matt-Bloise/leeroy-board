// GET /api/library/glossary.json is never served raw from D1. The stored row is replaced only by the deploy's library seed (continue-on-error), so it can hold entries that
// name the game's vocabulary (a table's own examples). The Worker filters it with the party glossary's drop-at-load rule, caches the filtered body under its own key for 5 minutes,
// and every library write purges that key. Fictional data only. No network. Run: node --test tests/unit/library-glossary-served.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { purgeWorkerCache, LIBRARY_PURGE_PATHS } from "../../infrastructure/worker/index.js";
import { libraryGlossaryBody, LIBRARY_GLOSSARY_CACHE_PATH, servedGlossary, namesVocabulary } from "../../infrastructure/worker/party-glossary.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
const realCaches = globalThis.caches;
test.after(() => { globalThis.fetch = realFetch; globalThis.caches = realCaches; });

function fakeCache() {
  const store = new Map();
  return {
    store,
    default: {
      async put(req, resp) { store.set(req.url, { body: await resp.text(), status: resp.status, headers: [...resp.headers] }); },
      async match(req) { const s = store.get(req.url); return s ? new Response(s.body, { status: s.status, headers: new Headers(s.headers) }) : undefined; },
      async delete(req) { return store.delete(req.url); },
    },
  };
}
const ORIGIN = "https://api.test";
const OLD = { generated: "2026-11-01T22:54:52.063Z", terms: [
  { term: "aggro", forms: ["aggro"], def: "Enemy attention on one character." },
  { term: "troll trouble", forms: ["troll"], def: "A Troll's faster attacks and such as Undead, Troll or Tauren." },
  { term: "kiting", forms: ["kiting"], def: "Moving away while hitting an enemy." },
] };
function makeEnv(blob = OLD, stamp = "s1") {
  const DB = schemaDb();
  DB.raw.prepare("INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('glossary.json', ?, ?, '2026-11-01T00:00:00.000Z')").run(stamp, typeof blob === "string" ? blob : JSON.stringify(blob));
  const room = { fetch: async () => new Response("ok") };
  return { DB, ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}
async function get(env, path = "/library/glossary.json") {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
  const q = console.error; console.error = () => {};
  try {
    const r = await worker.fetch(new Request(`${ORIGIN}/api${path}`, { headers: { "CF-Connecting-IP": "203.0.113.51" } }), env, ctx);
    await Promise.all(waits);
    return r;
  } finally { console.error = q; }
}

test("a stored D1 library glossary with party-shaped text is never served raw", async () => {
  globalThis.caches = fakeCache();
  await purgeWorkerCache(ORIGIN, LIBRARY_PURGE_PATHS);
  const env = makeEnv();
  const res = await get(env);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.terms.map((t) => t.term), ["aggro", "kiting"], "the entry naming vocabulary is dropped, the others stay");
  assert.equal(body.generated, OLD.generated, "other fields pass through");
  assert.ok(!/troll|undead|tauren/i.test(text), "none of the old text appears");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, stale-while-revalidate=0", "a bounded lifetime, not 4 h");
  // a second read (from the isolate or the cache) is the filtered body too
  assert.ok(!/troll|undead|tauren/i.test(await (await get(env)).text()));
});

test("a copy cached under the old key by an earlier deploy (unfiltered) is never read", async () => {
  const cache = fakeCache();
  globalThis.caches = cache;
  await purgeWorkerCache(ORIGIN, LIBRARY_PURGE_PATHS);
  cache.store.set(`${ORIGIN}/api/library/glossary.json`, { body: JSON.stringify(OLD), status: 200, headers: [["content-type", "application/json"], ["cache-control", "public, max-age=3600, s-maxage=14400, stale-while-revalidate=600"]] });
  const text = await (await get(makeEnv())).text();
  assert.ok(!/troll|undead|tauren/i.test(text), "the Worker reads its own key, not the old one");
  assert.ok(cache.store.has(`${ORIGIN}${LIBRARY_GLOSSARY_CACHE_PATH}`), "the filtered body is stored under the new key");
});

test("a library write purges the glossary: after the purge the next read is the changed row, filtered", async () => {
  const cache = fakeCache();
  globalThis.caches = cache;
  await purgeWorkerCache(ORIGIN, LIBRARY_PURGE_PATHS);
  const env = makeEnv();
  await get(env);
  assert.ok(cache.store.has(`${ORIGIN}${LIBRARY_GLOSSARY_CACHE_PATH}`));
  const next = { generated: "2026-11-15T15:00:00.000Z", terms: [{ term: "aggro", forms: ["aggro"], def: "Enemy attention on one character." }, { term: "mana", forms: ["mana"], def: "A bar that spells spend." }, { term: "ret", forms: ["ret"], def: "Short for a spec." }] };
  env.DB.raw.prepare("UPDATE lib_blobs SET json = ?, stamp = 's2' WHERE name = 'glossary.json'").run(JSON.stringify(next));
  await purgeWorkerCache(ORIGIN, LIBRARY_PURGE_PATHS);
  assert.equal(cache.store.has(`${ORIGIN}${LIBRARY_GLOSSARY_CACHE_PATH}`), false, "the purge removed the entry");
  const body = JSON.parse(await (await get(env)).text());
  assert.equal(body.generated, next.generated);
  assert.deepEqual(body.terms.map((t) => t.term), ["aggro", "mana"], "the new row is served, minus the entry that names a spec");
});

test("every library purge in the Worker clears the glossary, and both spellings of its path are in the list", () => {
  assert.ok(LIBRARY_PURGE_PATHS.includes("/api/library/glossary.json") && LIBRARY_PURGE_PATHS.includes(LIBRARY_GLOSSARY_CACHE_PATH));
  const src = readFileSync(new URL("../../infrastructure/worker/index.js", import.meta.url), "latin1");
  const lists = [...src.matchAll(/purgeWorkerCache\(url\.origin, \[([^\]]*?"\/api\/library\/index\.json"[^\]]*?)\]/g)];
  assert.ok(lists.length >= 3, `found ${lists.length} library purge lists`);
  for (const [, body] of lists) assert.ok(body.includes("...LIBRARY_PURGE_PATHS"), "a library purge list without the glossary");
});

test("unusable stored bodies fall back to the bundled glossary; the output never names the vocabulary", () => {
  for (const stored of ["not json", "[]", "null", JSON.stringify({ generated: "x" }), JSON.stringify({ terms: "no" })]) {
    const out = JSON.parse(libraryGlossaryBody(stored));
    assert.deepEqual(out.terms, servedGlossary(), String(stored));
  }
  const clean = JSON.parse(libraryGlossaryBody(JSON.stringify(OLD)));
  for (const t of clean.terms) assert.deepEqual(namesVocabulary(`${t.term} ${t.forms.join(" ")} ${t.def}`), []);
});

test("the library file in the repo passes the rule untouched, and its stamp is the one the post-deploy check expects", () => {
  const file = JSON.parse(readFileSync(new URL("../../data/library/glossary.json", import.meta.url), "utf8"));
  assert.deepEqual(JSON.parse(libraryGlossaryBody(JSON.stringify(file))).terms, file.terms, "nothing in the repo copy is dropped");
  assert.equal(file.generated, "2026-11-15T15:00:00.000Z");
});

// Review follow-ups: a blob name with whitespace or a control character is stripped when the cache key is built, so it used to land on the OLD
// unfiltered key. Such names are now a plain 404 before any cache lookup. The served body is a whitelist projection, and never an empty glossary.
test("a glossary name with trailing whitespace or a control character never reads the old cache key", async () => {
  const cache = fakeCache();
  globalThis.caches = cache;
  await purgeWorkerCache(ORIGIN, LIBRARY_PURGE_PATHS);
  cache.store.set(`${ORIGIN}/api/library/glossary.json`, { body: JSON.stringify(OLD), status: 200, headers: [["content-type", "application/json"], ["cache-control", "public, max-age=3600, s-maxage=14400"]] });
  for (const odd of ["glossary.json%20", "glossary.json%20%20", "glossary.json%00", "glossary.json%01", "glossary.json%09", "glossary.json%0A", "glossary.json%0D", "glossary.json%1F", "glos%09sary.json", "%0Aglossary.json", "glossary%0D.json"]) {
    const res = await get(makeEnv(), `/library/${odd}`);
    assert.equal(res.status, 404, odd);
    assert.ok(!/troll|undead|tauren/i.test(await res.text()), `${odd} serves none of the old text`);
  }
  assert.equal((await get(makeEnv(), "/library/%")).status, 404, "a malformed escape is a 404, not a 500");
});

test("the served glossary keeps only term, forms and def, and an all-dropped list falls back to the bundled glossary", async () => {
  const extra = { generated: "2026-11-15T15:00:00.000Z", note: "x", terms: [{ term: "aggro", forms: ["aggro"], def: "Enemy attention.", extra: "party-shaped", id: 7 }] };
  const env = makeEnv();
  env.DB.raw.prepare("UPDATE lib_blobs SET json = ?, stamp = 's3' WHERE name = 'glossary.json'").run(JSON.stringify(extra));
  const cache = fakeCache(); globalThis.caches = cache;
  await purgeWorkerCache(ORIGIN, LIBRARY_PURGE_PATHS);
  const body = JSON.parse(await (await get(env)).text());
  assert.deepEqual(Object.keys(body).sort(), ["generated", "terms"], "no other top-level field leaves the Worker");
  assert.deepEqual(Object.keys(body.terms[0]).sort(), ["def", "forms", "term"], "no other entry field leaves the Worker");
  const env2 = makeEnv();
  env2.DB.raw.prepare("UPDATE lib_blobs SET json = ?, stamp = 's4' WHERE name = 'glossary.json'").run(JSON.stringify({ generated: "g", terms: [{ term: "troll", forms: ["troll"], def: "A race." }] }));
  await purgeWorkerCache(ORIGIN, LIBRARY_PURGE_PATHS);
  const fb = JSON.parse(await (await get(env2)).text());
  assert.ok(fb.terms.length > 0, "an all-dropped list is replaced by the bundled glossary, never served empty");
});
