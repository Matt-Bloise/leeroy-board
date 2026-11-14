// Public read contract: nothing private leaves through an anonymous read or an anonymous socket.
// Fixture state carries private values (canaries) in every place the Worker keeps them: shared and private /ask turns, stats.recent,
// a hidden sheet field, Discord ids, member key hashes, private kv rows, admin-only library tables, vote ballots. Then:
//   1. every GET or ANY route in the Worker's ROUTES table is listed below as public, auth or capability (a new route fails until it is);
//   2. every GET route is called with no credentials and its body, whatever the status, must hold no canary;
//   3. every public JSON body must use only the key paths in tests/contract/public-read-allowlist.json;
//   4. every payload the Worker sends to the room (admin PUTs, a sheet write, the ask-completion shapes) is fanned out by BoardRoom to an
//      anonymous socket, which must hold no canary and only allow-listed key paths.
// Fictional data only. No network, no AI. Regenerate the allow list (and read its diff) with: UPDATE_PUBLIC_ALLOWLIST=1 node --test tests/unit/public-read-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import worker, { ROUTES, purgeWorkerCache, recordSheetEventInD1 } from "../../infrastructure/worker/index.js";
import { PUBLIC_DATA_DOCS, PUBLIC_ATLAS_DOCS } from "../../infrastructure/worker/public-docs.js";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { createVote, voterHash } from "../../infrastructure/worker/votes.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const ALLOW_URL = new URL("../contract/public-read-allowlist.json", import.meta.url);
const DATA = new URL("../../data/", import.meta.url);
const LIB = new URL("../../data/library/", import.meta.url);
const AT = "2026-11-12T00:00:00.000Z";

// The private values. Each must never appear in an anonymous read or socket message (compared case-insensitively).
const C = {
  sharedQ: "canary-shared-question-q7x", sharedA: "canary-shared-answer-a7x",
  privateQ: "canary-private-question-p7x", privateA: "canary-private-answer-p7x",
  hidden: "canary-hidden-sheet-value-h7x",
  discordId: "112233445566778899", discordId2: "998877665544332211",
  keyHash: "c".repeat(64), sessionHash: "d".repeat(64),
  persona: "canary-persona-text-r7x", members: "canary-members-row-m7x", config: "canary-config-row-k7x",
  snapshot: "canary-source-snapshot-s7x", proposal: "canary-wiki-proposal-w7x", fix: "canary-fact-fix-f7x",
  voterHash: null, voterHash2: null, // computed in makeEnv
};
const SALT = "user-salt-for-tests-0123456789";

// Every GET or ANY route of ROUTES, classified. public: called anonymously and its JSON key paths checked. auth: must refuse an anonymous
// caller (any status but 2xx). capability: the caller must hold an unguessable id; called with a canary-free fictional id. redirect: OAuth hops.
const CLASS = {
  "GET /discord/commands": "public", "GET /votes": "public", "GET /me": "auth", "ANY /sheet": "auth", "GET /admin/feedback": "auth",
  "GET /admin/export": "auth", "GET /admin/requests": "auth", "GET /admin/moments": "auth", "GET /intents": "auth", "GET /signups": "public",
  "ANY /live": "socket", "GET /state": "public", "GET /auth/discord/start": "redirect", "GET /auth/discord/callback": "redirect",
  "ANY /me": "auth", "GET /me/export": "auth", "ANY /state/:doc": "auth", "GET /ask": "capability", "GET /wiki/snapshots": "auth",
  "GET /wiki/proposals": "auth", "GET /wiki/proposals/:id": "auth", "GET /bootstrap": "public", "GET /library/*": "public",
  "GET /data/*": "public", "GET /atlas/*": "public", "GET /": "public", "GET /health": "public",
};
// Concrete anonymous GETs for the parameterised routes.
const LIB_NAMES = readdirSync(LIB).filter((f) => f.endsWith(".json"));
const concrete = (route) => {
  const p = route.split(" ")[1];
  if (p === "/data/*") return [...PUBLIC_DATA_DOCS].flatMap((n) => [`/data/${n}`, `/data/${n}.json`]);
  if (p === "/atlas/*") return [...PUBLIC_ATLAS_DOCS].map((n) => `/atlas/${n}.json`);
  if (p === "/library/*") return LIB_NAMES.map((n) => `/library/${n}`);
  if (p === "/state/:doc") return ["/state/settings", "/state/party_sheets", "/state/persona"];
  if (p === "/wiki/proposals/:id") return ["/wiki/proposals/wp1"];
  if (p === "/ask") return ["/ask?id=00000000-0000-4000-8000-000000000000", "/ask?id=1700000000000", "/ask"];
  return [p];
};

const fileJson = (u) => JSON.parse(readFileSync(u, "utf8"));
async function makeEnv() {
  const DB = schemaDb();
  const sql = (s, ...a) => DB.raw.prepare(s).run(...a);
  const kv = (k, v) => sql("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)", k, typeof v === "string" ? v : JSON.stringify(v), AT);
  for (const n of ["party", "timeline", "client", "signups", "tonight", "launch", "decide", "guided-atlas"]) { try { kv(n, fileJson(new URL(`${n}.json`, DATA))); } catch {} }
  for (const n of ["marks", "links"]) { try { kv(n, fileJson(new URL(`atlas/${n}.json`, DATA))); } catch {} }
  const stats = fileJson(new URL("stats.json", DATA));
  stats.recent = [{ id: "a1", by: "Red Fox", q: C.sharedQ, a: C.sharedA, cites: [], model: "m", provider: "p", at: AT, ms: 900 }];
  kv("stats", stats);
  const party = fileJson(new URL("party.json", DATA));
  const first = party.members[0];
  kv("party_sheets", [{ slug: "red-fox", name: first.name, fields: { class: { value: "paladin", visible: true, source: "board", at: AT }, notes: { value: C.hidden, visible: false, source: "board", at: AT } }, updated: AT }]);
  kv("persona", { text: C.persona });
  kv("discord_members", [{ name: "Red Fox", id: C.discordId, note: C.members }]);
  kv("name_map", { [C.discordId2]: "Blue Owl" });
  kv("config:x", { v: C.config });
  kv("feed_cache:stats", { recent: [{ q: C.sharedQ }] });
  const made = createVote({ id: "ab12cd34", title: "Raid night", choices: "Fri|Sat", hours: 720, now: Date.parse(AT) });
  assert.ok(made.ok, made.error);
  C.voterHash = await voterHash(C.discordId, "ab12cd34", SALT);
  C.voterHash2 = await voterHash(C.discordId2, "ab12cd34", SALT);
  kv("vote:ab12cd34", { ...made.vote, ballots: { [C.voterHash2]: 1 } }); // an old document that still holds a ballot
  sql("INSERT INTO vote_ballots (vote_id, voter_hash, choice, cast_at) VALUES ('ab12cd34', ?, 0, ?)", C.voterHash, AT);
  kv("votes:index", { ids: ["ab12cd34"] });
  for (const f of LIB_NAMES) sql("INSERT OR REPLACE INTO lib_blobs (name, stamp, json, updated_at) VALUES (?, ?, ?, ?)", f, "s1", JSON.stringify(fileJson(new URL(f, LIB))), AT);
  const turn = (id, q, a, share) => sql("INSERT INTO ask_turns (id, by_name, question, answer, status, share, created_at, answered_at) VALUES (?, ?, ?, ?, 'answered', ?, ?, ?)", id, "Red Fox", q, a, share, AT, AT);
  turn("11111111-1111-4111-8111-111111111111", C.sharedQ, C.sharedA, 1);
  turn("1700000000001", C.privateQ, C.privateA, 0);
  sql("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?)", C.discordId, "Red Fox", AT);
  sql("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", C.sessionHash, C.discordId, AT, "2026-12-12T00:00:00.000Z");
  sql("INSERT INTO accounts (id, name, slug, created_at) VALUES ('acct1', 'Red Fox', 'red-fox', ?)", AT);
  sql("INSERT INTO account_keys (key_hash, account_id, label, created_at) VALUES (?, 'acct1', 'k', ?)", C.keyHash, AT);
  sql("INSERT INTO lib_source_snapshots (id, source_id, url, sha8, body_text, fetched_at) VALUES ('s1', 'src', 'https://example.test/', 'abcd1234', ?, ?)", C.snapshot, AT);
  sql("INSERT INTO wiki_proposals (id, source_id, page_id, fact_key, proposed_value, status, created_at) VALUES ('wp1', 'src', 'p', 'f', ?, 'pending', ?)", C.proposal, AT);
  const sent = [];
  const room = { fetch: async (_u, init) => { if (init && init.body) sent.push(String(init.body)); return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0 })); } };
  return { DB, sent, BOARD_ADMIN_TOKEN: ADMIN, USER_SALT: SALT, KEY_SALT: "key-salt-for-tests-0123456789", ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}

const CANARIES = () => Object.values(C).filter(Boolean).map((v) => String(v).toLowerCase());
const leaks = (text) => { const t = String(text).toLowerCase(); return CANARIES().filter((c) => t.includes(c)); };
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };
const get = async (env, path, init = {}) => {
  await purgeWorkerCache(ORIGIN, [`/api${path}`]);
  const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, { redirect: "manual", ...init, headers: { "CF-Connecting-IP": "203.0.113.40", ...(init.headers || {}) } }), env, ctx));
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") || "" };
};

// Key paths: arrays become [], and object keys that are data (ids, dates, times, counts, hashes) become *.
const DYNAMIC = /^(\d.*|[0-9a-f]{8,}|.*\d{1,2}(am|pm)|.*[ :/].*|[A-Z][a-z]+ [A-Z].*)$/;
export function keyPaths(v, p = "", out = new Set(), dynamicAt = []) {
  if (Array.isArray(v)) { if (!v.length) out.add(`${p}[]`); for (const x of v) keyPaths(x, `${p}[]`, out, dynamicAt); return out; }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) out.add(p || "{}");
    for (const k of keys) {
      const star = DYNAMIC.test(k) || /-/.test(k) || keys.length > 40 || dynamicAt.some((d) => d === p); // place slugs and big maps are data
      keyPaths(v[k], p ? `${p}.${star ? "*" : k}` : (star ? "*" : k), out, dynamicAt);
    }
    return out;
  }
  out.add(p || "(value)");
  return out;
}
const ALLOW = (() => { try { return fileJson(ALLOW_URL); } catch { return { dynamicKeysUnder: [], surfaces: {} }; } })();
const pathsOf = (json) => keyPaths(json, "", new Set(), ALLOW.dynamicKeysUnder || []);
const observed = {}; // surface -> Set of key paths, for the allow list
const note = (surface, json) => { const s = (observed[surface] ||= new Set()); for (const p of pathsOf(json)) s.add(p); };
const surfaceOf = (path) => path.replace(/\?.*$/, "").replace(/\.json$/, "");

test("every GET or ANY route is classified (a new route fails here until someone decides who may read it)", () => {
  const reads = ROUTES.filter((r) => /^(GET|ANY) /.test(r));
  const missing = reads.filter((r) => !(r in CLASS));
  assert.deepEqual(missing, [], `classify these in CLASS: ${missing.join(", ")}`);
  const stale = Object.keys(CLASS).filter((r) => !ROUTES.includes(r));
  assert.deepEqual(stale, [], `no longer in ROUTES: ${stale.join(", ")}`);
});

test("an anonymous GET of every route holds no private value, whatever its status", async () => {
  const env = await makeEnv();
  const found = [];
  for (const [route, cls] of Object.entries(CLASS)) {
    if (cls === "socket") continue;
    for (const p of concrete(route)) {
      const r = await get(env, p);
      const l = leaks(r.text);
      if (l.length) found.push(`${p} (${r.status}): ${l.join(", ")}`);
      if (cls === "auth") assert.ok(r.status < 200 || r.status >= 300, `${p} answered ${r.status} with no credentials`);
      if (cls === "public" && r.status === 200 && /json/.test(r.type)) note(surfaceOf(p), JSON.parse(r.text));
    }
  }
  assert.deepEqual(found, []);
});

test("the ask capability: a UUID id shows that turn only, a guessable timestamp id needs a key", async () => {
  const env = await makeEnv();
  const shared = await get(env, "/ask?id=11111111-1111-4111-8111-111111111111");
  assert.equal(shared.status, 200, "the holder of the random id reads that turn (by design)");
  assert.deepEqual(leaks(shared.text).filter((c) => c.includes("private")), []);
  const guess = await get(env, "/ask?id=1700000000001");
  assert.ok(guess.status === 401 || guess.status === 403 || guess.status === 404, `timestamp id answered ${guess.status}`);
  assert.deepEqual(leaks(guess.text), []);
});

// Every message the Worker hands the room, sent through BoardRoom to one anonymous and one member socket.
function fanOut(payloadText) {
  const got = { anon: [], member: [] };
  const sock = (aud, sink) => ({ deserializeAttachment: () => aud, send: (m) => sink.push(m) });
  const roomCtx = { getWebSockets: () => [sock({}, got.anon), sock({ member: true }, got.member)], setWebSocketAutoResponse() {} };
  const room = new BoardRoom(roomCtx, {});
  room.broadcast(payloadText);
  return got;
}
// The ask-completion messages ai-models.js sends for a shared turn (step 4 there): the same keys as completedItem.
const askItem = () => ({ id: "w1", kind: "ask", by: "Red Fox", q: C.sharedQ, text: C.sharedQ, answer: C.sharedA, cites: [{ id: "c1" }], sources: [{ id: "c1" }], model: "m", provider: "p", share: true, ms: 900, status: "answered", at: AT });

test("every room message reaches an anonymous socket with no private value and only allow-listed keys", async () => {
  const env = await makeEnv();
  const put = (path, body) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, { method: "PUT", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.41" }, body: JSON.stringify(body) }), env, ctx));
  const stored = (k) => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(k).json);
  for (const k of ["stats", "party", "signups", "timeline", "tonight", "decide"]) assert.equal((await put(`/data/${k}`, stored(k))).status, 200, k);
  await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name: stored("party").members[0].name, field: "notes", value: C.hidden, visible: false }));
  await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name: stored("party").members[0].name, field: "level", value: 12 }));
  const messages = [...env.sent, JSON.stringify({ type: "data", key: "stats", intent: askItem() }), JSON.stringify({ type: "ask", slug: "red-fox", ask: askItem() })];
  assert.ok(env.sent.length >= 7, `the Worker broadcast ${env.sent.length} messages`);
  const found = [];
  for (const m of messages) {
    const { anon, member } = fanOut(m);
    assert.equal(anon.length, 1);
    assert.equal(member.length, 1);
    for (const a of anon) { const l = leaks(a); if (l.length) found.push(`${m.slice(0, 60)}: ${l.join(", ")}`); note("socket", JSON.parse(a)); }
  }
  assert.deepEqual(found, []);
  const memberSaw = fanOut(messages[messages.length - 1]).member[0];
  assert.ok(memberSaw.includes(C.sharedQ), "a member socket still gets the shared question (the redaction is per audience)");
});

test("every public key path is in tests/contract/public-read-allowlist.json", () => {
  assert.ok(Object.keys(observed).length > 10, "the read tests above ran first and recorded their surfaces");
  if (process.env.UPDATE_PUBLIC_ALLOWLIST === "1") {
    const surfaces = Object.fromEntries(Object.keys(observed).sort().map((s) => [s, [...observed[s]].sort()]));
    writeFileSync(ALLOW_URL, JSON.stringify({ about: ALLOW.about, known: ALLOW.known || {}, dynamicKeysUnder: ALLOW.dynamicKeysUnder || [], surfaces }, null, 1) + "\n");
    return;
  }
  const extra = [];
  for (const [s, set] of Object.entries(observed)) {
    const allowed = new Set((ALLOW.surfaces || {})[s] || []);
    for (const p of set) if (!allowed.has(p)) extra.push(`${s}: ${p}`);
  }
  assert.deepEqual(extra, [], "a public read gained a field: confirm it is meant to be public, then add it to the allow list (UPDATE_PUBLIC_ALLOWLIST=1)");
});
