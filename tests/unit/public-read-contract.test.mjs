// Public read contract: a regression guard for private data leaving through an anonymous read or an anonymous socket.
// Fixture state carries private values (canaries) in every place the Worker keeps them: shared and private /ask turns (with a private
// asker and a private time), stats.recent, a hidden sheet field, Discord ids, member key and session hashes, private kv rows, admin-only
// library tables, vote ballots, and the Worker's own secrets (admin token, salts). Then:
//   1. every GET or ANY route in ROUTES is classified (public, auth, capability, redirect, socket); a new one fails until it is.
//      (Dispatch without a ROUTES entry is caught by tests/unit/authz.test.mjs.)
//   2. every GET is called with no credentials, with and without a query string, and with denied and unknown document names. No body,
//      whatever its status or content type, may hold a canary, even cut short or re-spaced (each canary starts with its own marker).
//   3. a public route must answer 200 JSON, and every JSON body an anonymous caller gets (any route, any status) may use only the key paths
//      in tests/contract/public-read-allowlist.json; every public surface must have been read.
//   4. every message the Worker hands the room (admin PUTs, sheet writes, the ask and intent shapes of ai-models.js and index.js, with every
//      content key and a guest-owned forAsk message) goes through BoardRoom to an anonymous socket: no canary, allow-listed keys only.
//      room.js keeps an allow list of item and intent keys for anonymous sockets, so a new field at a call site this test does not drive
//      is dropped by construction; a new TOP-LEVEL field at such a site is not covered here.
// Fictional data only. No network, no AI. The fixtures are the repo's data/*.json and data/library/*.json, so a data commit that adds a public
// field fails here until the field is allow-listed. Regenerate (outside CI, and only while every canary test passes), then read the diff:
//   UPDATE_PUBLIC_ALLOWLIST=1 node --test tests/unit/public-read-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import worker, { ROUTES, purgeWorkerCache, recordSheetEventInD1 } from "../../infrastructure/worker/index.js";
import { PUBLIC_DATA_DOCS, PUBLIC_ATLAS_DOCS } from "../../infrastructure/worker/public-docs.js";
import { BoardRoom, redactForPublic, PUBLIC_ITEM_KEYS } from "../../infrastructure/worker/room.js";
import { createVote, voterHash } from "../../infrastructure/worker/votes.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const ALLOW_URL = new URL("../contract/public-read-allowlist.json", import.meta.url);
const DATA = new URL("../../data/", import.meta.url);
const LIB = new URL("../../data/library/", import.meta.url);
const AT = "2026-11-12T00:00:00.000Z";
const PRIVATE_AT = "2026-11-03T03:03:03.333Z"; // when the private turn was asked: a time is private too

// The private values. Each starts with its own marker (zq + letters, no dash, no space), and a leak is the marker anywhere in the output,
// so a value cut to its first few characters or with its dashes replaced is still caught. Secrets are matched whole and by their first 16.
const C = {
  sharedQ: "zqsq shared question", sharedA: "zqsa shared answer",
  privateQ: "zqpq private question", privateA: "zqpa private answer", privateBy: "zqpb hidden asker",
  hidden: "zqhs hidden sheet value",
  persona: "zqpr persona text", members: "zqmr members row", config: "zqcf config row", feed: "zqfd feed cache",
  snapshot: "zqss source snapshot", proposal: "zqwp wiki proposal", askerSlug: "zqsl-asker-slug",
};
const ASK_UUID = "11111111-1111-4111-8111-111111111111"; // a shared turn's id: GET /api/ask?id= answers whoever holds it, so a stranger must never see it
const IDS = { discordId: "112233445566778899", discordId2: "998877665544332211", keyHash: "c".repeat(64), sessionHash: "d".repeat(64), askId: ASK_UUID };
const SECRETS = { ADMIN: "admin-token-for-tests-0123456789abcdef", KEY_SALT: "key-salt-for-tests-0123456789", USER_SALT: "user-salt-for-tests-0123456789" };
const HASHES = {}; // vote voter hashes, computed in makeEnv

// Every GET or ANY route of ROUTES, classified. public: anonymous, must answer 200 JSON, key paths checked. auth: must refuse an anonymous
// caller. capability: the caller must hold an unguessable id. redirect: OAuth hops. socket: the WebSocket upgrade (covered by test 4).
const CLASS = {
  "GET /discord/commands": "public", "GET /votes": "public", "GET /me": "auth", "ANY /sheet": "auth", "GET /admin/feedback": "auth",
  "GET /admin/export": "auth", "GET /admin/requests": "auth", "GET /admin/moments": "auth", "GET /intents": "auth", "GET /signups": "public",
  "ANY /live": "socket", "GET /state": "public", "GET /auth/discord/start": "redirect", "GET /auth/discord/callback": "redirect",
  "ANY /me": "auth", "GET /me/export": "auth", "ANY /state/:doc": "auth", "GET /ask": "capability", "GET /wiki/snapshots": "auth",
  "GET /wiki/proposals": "auth", "GET /wiki/proposals/:id": "auth", "GET /bootstrap": "public", "GET /library/*": "public",
  "GET /data/*": "public", "GET /atlas/*": "public", "GET /": "public", "GET /health": "public",
};
const LIB_NAMES = readdirSync(LIB).filter((f) => f.endsWith(".json"));
// Names the public document routes must refuse: every private row the fixture holds, and names that are not documents at all.
const DENIED = ["persona", "discord_members", "name_map", "config:x", "feed_cache:stats", "vote:ab12cd34", "votes:index", "party_sheets", "moments", "noise", "cards", "nope", "..%2Fpersona", "PERSONA", "persona%20"];
const QUERY = "?full=1&all=1&raw=1&debug=1&admin=1&include=recent&private=1";
// Concrete anonymous GETs: [path, isPublicSurface]
const concrete = (route) => {
  const p = route.split(" ")[1];
  if (p === "/data/*") return [...[...PUBLIC_DATA_DOCS].flatMap((n) => [[`/data/${n}`, true], [`/data/${n}.json`, true]]), ...DENIED.map((n) => [`/data/${n}`, false])];
  if (p === "/atlas/*") return [...[...PUBLIC_ATLAS_DOCS].map((n) => [`/atlas/${n}.json`, true]), ...DENIED.map((n) => [`/atlas/${n}.json`, false])];
  if (p === "/library/*") return [...LIB_NAMES.map((n) => [`/library/${n}`, true]), ...["persona.json", "seed.stamp", "stats.json", "party_sheets.json", "nope.json"].map((n) => [`/library/${n}`, false])];
  if (p === "/state/:doc") return ["/state/settings", "/state/party_sheets", "/state/persona", "/state/stats"].map((x) => [x, false]);
  if (p === "/wiki/proposals/:id") return [["/wiki/proposals/wp1", false]];
  if (p === "/ask") return ["/ask?id=00000000-0000-4000-8000-000000000000", "/ask?id=1700000000001", "/ask?id=17", "/ask"].map((x) => [x, false]);
  return [[p, CLASS[route] === "public"]];
};

const fileJson = (u) => JSON.parse(readFileSync(u, "utf8"));
async function makeEnv() {
  const DB = schemaDb();
  const sql = (s, ...a) => DB.raw.prepare(s).run(...a);
  const kv = (k, v) => sql("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)", k, typeof v === "string" ? v : JSON.stringify(v), AT);
  for (const n of ["party", "timeline", "client", "signups", "tonight", "launch", "decide", "guided-atlas"]) { try { kv(n, fileJson(new URL(`${n}.json`, DATA))); } catch {} }
  for (const n of ["marks", "links"]) { try { kv(n, fileJson(new URL(`atlas/${n}.json`, DATA))); } catch {} }
  const stats = fileJson(new URL("stats.json", DATA));
  stats.recent = [{ id: "a1", by: "Red Fox", q: C.sharedQ, a: C.sharedA, cites: [], model: "m", provider: "p", at: AT, ms: 900 }, { id: "a2", by: C.privateBy, q: C.privateQ, a: C.privateA, at: PRIVATE_AT }];
  kv("stats", stats);
  const party = fileJson(new URL("party.json", DATA));
  kv("party_sheets", [{ slug: "red-fox", name: party.members[0].name, fields: { class: { value: "paladin", visible: true, source: "board", at: AT }, notes: { value: C.hidden, visible: false, source: "board", at: AT } }, updated: AT }]);
  kv("persona", { text: C.persona });
  kv("discord_members", [{ name: "Red Fox", id: IDS.discordId, note: C.members }]);
  kv("name_map", { [IDS.discordId2]: "Blue Owl" });
  kv("config:x", { v: C.config });
  kv("feed_cache:stats", { recent: [{ q: C.feed }] });
  kv("moments", { note: C.config }); kv("noise", { note: C.config }); kv("cards", { note: C.config });
  const made = createVote({ id: "ab12cd34", title: "Raid night", choices: "Fri|Sat", hours: 720, now: Date.parse(AT) });
  assert.ok(made.ok, made.error);
  HASHES.v1 = await voterHash(IDS.discordId, "ab12cd34", SECRETS.USER_SALT);
  HASHES.v2 = await voterHash(IDS.discordId2, "ab12cd34", SECRETS.USER_SALT);
  kv("vote:ab12cd34", { ...made.vote, ballots: { [HASHES.v2]: 1 } }); // an old document that still holds a ballot
  sql("INSERT INTO vote_ballots (vote_id, voter_hash, choice, cast_at) VALUES ('ab12cd34', ?, 0, ?)", HASHES.v1, AT);
  kv("votes:index", { ids: ["ab12cd34"] });
  for (const f of LIB_NAMES) sql("INSERT OR REPLACE INTO lib_blobs (name, stamp, json, updated_at) VALUES (?, ?, ?, ?)", f, "s1", JSON.stringify(fileJson(new URL(f, LIB))), AT);
  const turn = (id, by, q, a, share, at) => sql("INSERT INTO ask_turns (id, by_name, question, answer, status, share, created_at, answered_at) VALUES (?, ?, ?, ?, 'answered', ?, ?, ?)", id, by, q, a, share, at, at);
  turn(ASK_UUID, "Red Fox", C.sharedQ, C.sharedA, 1, AT);
  turn("1700000000001", C.privateBy, C.privateQ, C.privateA, 0, PRIVATE_AT);
  sql("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?)", IDS.discordId, "Red Fox", AT);
  sql("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", IDS.sessionHash, IDS.discordId, AT, "2026-12-12T00:00:00.000Z");
  sql("INSERT INTO accounts (id, name, slug, created_at) VALUES ('acct1', 'Red Fox', 'red-fox', ?)", AT);
  sql("INSERT INTO account_keys (key_hash, account_id, label, created_at) VALUES (?, 'acct1', 'k', ?)", IDS.keyHash, AT);
  sql("INSERT INTO lib_source_snapshots (id, source_id, url, sha8, body_text, fetched_at) VALUES ('s1', 'src', 'https://example.test/', 'abcd1234', ?, ?)", C.snapshot, AT);
  sql("INSERT INTO wiki_proposals (id, source_id, page_id, fact_key, proposed_value, status, created_at) VALUES ('wp1', 'src', 'p', 'f', ?, 'pending', ?)", C.proposal, AT);
  const sent = [];
  const room = { fetch: async (_u, init) => { if (init && init.body) sent.push(String(init.body)); return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0 })); } };
  return { DB, sent, BOARD_ADMIN_TOKEN: SECRETS.ADMIN, USER_SALT: SECRETS.USER_SALT, KEY_SALT: SECRETS.KEY_SALT, ALLOWED_ORIGINS: "", BOARD_ROOM: { idFromName: () => "r", get: () => room } };
}

// A leak: a canary's marker (zq + 2 letters), an id, a hash, a secret (whole or its first 16 characters), or the private turn's time.
const NEEDLES = () => [
  ...Object.values(C).map((v) => v.split(" ")[0]),
  ...Object.values(IDS), ...Object.values(HASHES).filter(Boolean),
  ...Object.values(SECRETS).flatMap((s) => [s, s.slice(0, 16)]), PRIVATE_AT, PRIVATE_AT.slice(0, 19),
].map((x) => String(x).toLowerCase());
const leaks = (text, except = []) => { const t = String(text).toLowerCase(); return NEEDLES().filter((n) => !except.includes(n) && t.includes(n)); };
let canaryFailures = 0; // the allow list is never regenerated while a canary test fails
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };
const fetchApi = (env, path, headers = {}) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, { redirect: "manual", headers: { "CF-Connecting-IP": "203.0.113.40", ...headers } }), env, ctx));
// An anonymous read. With warm, the same path is first read with the admin token and the cache is NOT purged in between, so a privileged body
// cached by URL would be served to the anonymous caller and caught here. The text checked is the body and every response header.
const get = async (env, path, { warm = false } = {}) => {
  await purgeWorkerCache(ORIGIN, [`/api${path.replace(/\?.*$/, "")}`, `/api${path}`]);
  if (warm) await (await fetchApi(env, path, { Authorization: `Bearer ${SECRETS.ADMIN}` })).text();
  const res = await fetchApi(env, path);
  const body = await res.text();
  const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  return { status: res.status, text: body, scan: `${headers}\n${body}`, type: res.headers.get("content-type") || "" };
};
const asJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// Key paths: arrays become [], and object keys that are data (ids, dates, times, place slugs, keys of a map of more than 40) become *.
const DYNAMIC = /^(\d.*|[0-9a-f]{8,}|.*\d{1,2}(am|pm)|.*[ :/].*|[A-Z][a-z]+ [A-Z].*)$/;
export function keyPaths(v, p = "", out = new Set()) {
  if (Array.isArray(v)) { if (!v.length) out.add(`${p}[]`); for (const x of v) keyPaths(x, `${p}[]`, out); return out; }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) out.add(p || "{}");
    for (const k of keys) {
      const star = DYNAMIC.test(k) || /-/.test(k) || keys.length > 40;
      keyPaths(v[k], p ? `${p}.${star ? "*" : k}` : (star ? "*" : k), out);
    }
    return out;
  }
  out.add(p || "(value)");
  return out;
}
const ALLOW = (() => { try { return fileJson(ALLOW_URL); } catch { return { surfaces: {} }; } })();
const observed = {}; // surface -> Set of key paths
const note = (surface, json) => { const s = (observed[surface] ||= new Set()); for (const p of keyPaths(json)) s.add(p); };
const surfaceOf = (path) => path.replace(/\?.*$/, "").replace(/\.json$/, "");
const expectedSurfaces = new Set();

test("every GET or ANY route is classified (a new route fails here until someone decides who may read it)", () => {
  const reads = ROUTES.filter((r) => /^(GET|ANY) /.test(r));
  const missing = reads.filter((r) => !(r in CLASS));
  assert.deepEqual(missing, [], `classify these in CLASS: ${missing.join(", ")}`);
  const stale = Object.keys(CLASS).filter((r) => !ROUTES.includes(r));
  assert.deepEqual(stale, [], `no longer in ROUTES: ${stale.join(", ")}`);
});

test("an anonymous GET of every route, name and query holds no private value; public routes answer 200 JSON", async () => {
  const env = await makeEnv();
  const found = [], shape = [];
  for (const [route, cls] of Object.entries(CLASS)) {
    if (cls === "socket") continue;
    for (const [p, isPublic] of concrete(route)) {
      for (const q of ["", QUERY]) {
        const path = p.includes("?") ? `${p}${q.replace("?", "&")}` : `${p}${q}`;
        const r = await get(env, path, { warm: true });
        const l = leaks(r.scan);
        if (l.length) found.push(`${path} (${r.status}): ${l.join(", ")}`);
        if (cls === "auth") assert.ok(r.status < 200 || r.status >= 300, `${path} answered ${r.status} with no credentials`);
        const j = asJson(r.text);
        if (isPublic) {
          expectedSurfaces.add(surfaceOf(p));
          if (r.status !== 200 || !/json/.test(r.type) || j === undefined) shape.push(`${path}: ${r.status} ${r.type}`);
        }
        if (j !== undefined) note(isPublic ? surfaceOf(p) : r.status >= 400 ? "error" : `other:${surfaceOf(p)}`, j);
      }
    }
  }
  if (found.length) canaryFailures++;
  assert.deepEqual(found, []);
  assert.deepEqual(shape, [], "a public route must answer 200 with a JSON body");
});

test("the ask capability: a UUID id shows that one shared turn and nothing private; a guessable id needs a key", async () => {
  const env = await makeEnv();
  const shared = await get(env, `/ask?id=${ASK_UUID}`);
  assert.equal(shared.status, 200, "the holder of the random id reads that turn (by design)");
  const own = [...[C.sharedQ, C.sharedA].map((v) => v.split(" ")[0]), ASK_UUID];
  const l = leaks(shared.text, own);
  if (l.length) canaryFailures++;
  assert.deepEqual(l, []);
  note("/ask (capability)", JSON.parse(shared.text));
  for (const id of ["1700000000001", "17000000000%25", "1700000000001%20"]) {
    const guess = await get(env, `/ask?id=${id}`);
    assert.ok(guess.status === 401 || guess.status === 403 || guess.status === 404, `id ${id} answered ${guess.status}`);
    const g = leaks(guess.scan);
    if (g.length) canaryFailures++;
    assert.deepEqual(g, []);
  }
});

// Every message the Worker hands the room, sent through BoardRoom to an anonymous, a member and a guest-owner socket.
function fanOut(payloadText) {
  const got = { anon: [], member: [], owner: [] };
  const sock = (aud, sink) => ({ deserializeAttachment: () => aud, send: (m) => sink.push(m) });
  const roomCtx = { getWebSockets: () => [sock({}, got.anon), sock({ member: true }, got.member), sock({ ask: "owned-ask" }, got.owner)], setWebSocketAutoResponse() {} };
  new BoardRoom(roomCtx, {}).broadcast(payloadText);
  return got;
}
// The shapes ai-models.js and index.js send, with every content key room.js knows and a few it does not.
const fullItem = () => ({ id: ASK_UUID, kind: "ask", by: C.privateBy, slug: "zqsl-asker-slug", q: C.sharedQ, text: C.sharedQ, question: C.sharedQ, answer: C.sharedA, body: C.sharedA, error: C.sharedA, cites: [{ id: "c1", text: C.sharedA }], sources: [{ id: "c1" }], model: "m", provider: "p", share: true, ms: 900, status: "answered", at: AT, prompt: C.sharedQ, preview: C.sharedQ, asker: IDS.discordId, member: { id: IDS.discordId } });

test("every room message reaches an anonymous socket with no private value and only allow-listed keys", async () => {
  const env = await makeEnv();
  const put = (path, body) => quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, { method: "PUT", headers: { Authorization: `Bearer ${SECRETS.ADMIN}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.41" }, body: JSON.stringify(body) }), env, ctx));
  const stored = (k) => JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = ?").get(k).json);
  for (const k of ["stats", "party", "signups", "timeline", "tonight", "decide"]) assert.equal((await put(`/data/${k}`, stored(k))).status, 200, k);
  const name = stored("party").members[0].name;
  await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name, field: "notes", value: C.hidden, visible: false }));
  await quiet(() => recordSheetEventInD1(env, ORIGIN, { slug: "red-fox", name, field: "level", value: 12 }));
  assert.ok(env.sent.length >= 7, `the Worker broadcast ${env.sent.length} messages`);
  const synthetic = [
    { type: "data", key: "stats", intent: fullItem() }, { type: "ask", slug: "zqsl-asker-slug", ask: fullItem() },
    { type: "ask", slug: "zqsl-asker-slug" }, { type: "ask", slug: "zqsl-asker-slug", forAsk: "owned-ask", ask: fullItem() }, { type: "intent", item: fullItem() },
    { type: "intent", item: "a string item" }, { type: "intent", item: [fullItem()] }, { type: "intent", item: { ...fullItem(), nested: { q: C.sharedQ } } },
  ].map((m) => JSON.stringify(m));
  const found = [];
  for (const m of [...env.sent, ...synthetic]) {
    const { anon, member, owner } = fanOut(m);
    assert.equal(anon.length + member.length + owner.length, 3);
    const l = leaks(anon[0]);
    if (l.length) found.push(`${m.slice(0, 60)}: ${l.join(", ")}`);
    note("socket", JSON.parse(anon[0]));
  }
  if (found.length) canaryFailures++;
  assert.deepEqual(found, []);
  // The redaction is per audience: a member sees the shared text; the owner of a guest ask sees its own answer, and only that socket does.
  const forAsk = fanOut(synthetic[3]);
  assert.ok(forAsk.owner[0].includes(C.sharedQ.split(" ")[0]));
  assert.ok(!forAsk.anon[0].includes(C.sharedQ.split(" ")[0]));
  assert.ok(!forAsk.member[0].includes("forAsk"), "forAsk never leaves the room");
  assert.ok(fanOut(synthetic[0]).member[0].includes(C.sharedQ.split(" ")[0]));
  // After the sheet writes, the public reads still hold no hidden value or id.
  for (const p of ["/data/party", "/state", "/bootstrap"]) { const l2 = leaks((await get(env, p)).scan); if (l2.length) canaryFailures++; assert.deepEqual(l2, [], p); }
});

// A sheet level is a number, so no text canary can mark it: the level key itself must be absent. Driven through the HTTP routes: the owner
// hides an empty level (the sheet's switch sends { field, visible: false } with no value), the admin fills 41, the owner changes it while
// hidden. After each step the level is absent from /data/party, /state, /bootstrap and every message an anonymous socket receives.
test("a hidden sheet level, filled by the admin through POST /api/admin/sheet, reaches no public read and no anonymous socket", async () => {
  const env = await makeEnv();
  const KEY = "member-key-red-fox-for-contract-01";
  env.DB.raw.prepare("INSERT INTO members (slug, key_hash, created_at) VALUES ('red-fox', ?, ?)").run(await sha256Hex(`${SECRETS.KEY_SALT}:${KEY}`), AT);
  const doc = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party'").get().json);
  doc.members.push({ name: "Red Fox", class: "Paladin", class_key: "paladin", race: "Human", role: "tank" });
  env.DB.raw.prepare("UPDATE kv_state SET json = ? WHERE key = 'party'").run(JSON.stringify(doc));
  const post = async (path, auth, body) => (await quiet(() => worker.fetch(new Request(`${ORIGIN}/api${path}`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.42" }, body: JSON.stringify(body) }), env, ctx))).status;
  const lv = (rows) => { const r = Array.isArray(rows) ? rows.find((s) => s && s.slug === "red-fox") : null; return r && r.fields ? r.fields.level : undefined; };
  const check = async (why) => {
    const pd = await get(env, "/data/party");
    assert.equal(pd.status, 200);
    assert.ok(!/"level"/.test(pd.text), `${why}: /data/party`);
    const stParty = JSON.parse((await get(env, "/state")).text).party;
    assert.ok(Array.isArray(stParty) && stParty.some((r) => r && r.slug === "red-fox"), `${why}: red-fox has a public row, so the check below is not empty`);
    assert.equal(lv(stParty), undefined, `${why}: /state`);
    assert.equal(lv(JSON.parse((await get(env, "/bootstrap")).text).partySheets), undefined, `${why}: /bootstrap`);
    for (const m of env.sent) for (const s of fanOut(m).anon) { const j = JSON.parse(s); assert.equal(lv(j.party), undefined, `${why}: anonymous socket`); assert.ok(!JSON.stringify(j).includes("\"value\":41") && !JSON.stringify(j).includes("\"value\":42"), `${why}: socket carries the number`); }
  };
  assert.equal(await post("/sheet", `Board ${KEY}`, { field: "level", visible: false }), 200, "the owner hides an empty level");
  await check("after the hide");
  assert.equal(await post("/admin/sheet", `Bearer ${SECRETS.ADMIN}`, { slug: "red-fox", field: "level", value: 41 }), 200, "the admin fills it");
  await check("after the admin fill");
  assert.equal(await post("/sheet", `Board ${KEY}`, { field: "level", value: 42, visible: false }), 200, "the owner changes it, still hidden");
  await check("after the owner's change");
  const sheets = JSON.parse(env.DB.raw.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").get().json);
  assert.deepEqual([lv(sheets).value, lv(sheets).visible], [42, false], "the private row holds it");
});
test("room.js: an anonymous message keeps only PUBLIC_TOP_KEYS, and an item or intent only PUBLIC_ITEM_KEYS with scalar values", () => {
  const top = redactForPublic({ type: "ask", slug: "red-fox", preview: C.sharedQ, entry: fullItem(), member: { id: IDS.discordId }, turn: fullItem() });
  assert.deepEqual(Object.keys(top).sort(), ["type"], "no slug: it names the asker of an ask nudge");
  const out = redactForPublic({ type: "intent", item: { ...fullItem(), brand_new_field: "x" } });
  assert.deepEqual(Object.keys(out.item).sort(), PUBLIC_ITEM_KEYS.filter((k) => k in fullItem()).sort());
  assert.equal("item" in redactForPublic({ type: "intent", item: "text" }), false);
  const same = { type: "intent", item: { kind: "ask", status: "thinking" } };
  assert.equal(redactForPublic(same), same, "a message with nothing to remove is passed on as it is");
});

test("every public key path is in tests/contract/public-read-allowlist.json, and every public surface was read", () => {
  assert.ok(expectedSurfaces.size > 10, "the read tests above ran first");
  for (const s of expectedSurfaces) assert.ok(observed[s], `${s} answered no JSON`);
  if (process.env.UPDATE_PUBLIC_ALLOWLIST === "1") {
    assert.ok(!process.env.CI, "the allow list is never regenerated in CI");
    assert.equal(canaryFailures, 0, "a canary test failed: fix the leak first; the allow list is not regenerated over it");
    const surfaces = Object.fromEntries(Object.keys(observed).sort().map((s) => [s, [...observed[s]].sort()]));
    writeFileSync(ALLOW_URL, JSON.stringify({ about: ALLOW.about, known: ALLOW.known || {}, surfaces }, null, 1) + "\n");
    return;
  }
  const extra = [];
  for (const [s, set] of Object.entries(observed)) {
    const allowed = new Set((ALLOW.surfaces || {})[s] || []);
    for (const p of set) if (!allowed.has(p)) extra.push(`${s}: ${p}`);
  }
  assert.deepEqual(extra, [], "a public read gained a field: confirm it is meant to be public, then add it to the allow list (UPDATE_PUBLIC_ALLOWLIST=1)");
});
