// Character switcher on the Worker (CHARS_V1): GET /api/me gains characters, POST /api/me/characters adds, renames and selects.
// Runs the real Worker against a real SQLite built from infrastructure/schema.sql (constraints and cascades are real). Made-up ids and names.
// No network, no AI, no secrets. Run: node --test tests/unit/characters-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infrastructure/worker/index.js";
import { webSessionHash, SESS_COOKIE } from "../../infrastructure/worker/web-auth.js";
import * as api from "../../infrastructure/worker/characters-api.js";
import * as client from "../../js/characters.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";

const ORIGIN = "https://leeroy.test", CTX = { waitUntil() {}, passThroughOnException() {} };
const U1 = "100000000000000001", U2 = "100000000000000002", T1 = "t-one";
const TOK1 = "A".repeat(43), TOK2 = "B".repeat(43);
const NOW = Date.now();
const baseEnv = (db, over = {}) => ({ DB: db, WEB_LOGIN: "on", CHARS_V1: "on", ALLOWED_ORIGINS: ORIGIN, KEY_SALT: "k".repeat(24), USER_SALT: "u".repeat(24), ...over });
const ISO = (ms) => new Date(ms).toISOString();

async function seed(db, { tenants = 1 } = {}) {
  const raw = db.raw;
  raw.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'Tester One', ?)").run(U1, ISO(NOW));
  raw.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, 'Tester Two', ?)").run(U2, ISO(NOW));
  raw.prepare("INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES (?, '200000000000000001', 'Guild', 'active', ?)").run(T1, ISO(NOW));
  if (tenants > 1) raw.prepare("INSERT INTO tenants (id, discord_guild_id, name, status, created_at) VALUES ('t-two', '200000000000000002', 'Guild Two', 'active', ?)").run(ISO(NOW));
  for (const [tok, id] of [[TOK1, U1], [TOK2, U2]]) {
    raw.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(await webSessionHash(tok), id, ISO(NOW - 1000), ISO(NOW + 86400000), ISO(NOW));
  }
}
const send = (env, method, path, { tok = TOK1, body, origin = ORIGIN } = {}) => worker.fetch(new Request(`https://api.leeroy.test${path}`, {
  method,
  headers: { ...(tok ? { Cookie: `${SESS_COOKIE}=${tok}` } : {}), ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
}), env, CTX);
const PIP = { name: "Pip Fizzwick", class: "Mage", race: "Gnome", ruleset: "Normal", faction: "Alliance", region: "Americas" };
const MARROW = { name: "Marrow Ironkettle", class: "Warrior", race: "Dwarf", ruleset: "Normal", faction: "Alliance", region: "EU" };
const meOf = async (env, tok = TOK1) => (await send(env, "GET", "/api/me", { tok })).json();

test("the constants match the client: factions, regions, limits, max, and the same accept/refuse verdict on sample forms", () => {
  assert.deepEqual([...api.FACTIONS], [...client.FACTIONS]);
  assert.deepEqual([...api.REGIONS], [...client.REGIONS]);
  assert.deepEqual({ ...api.LIMITS }, { ...client.LIMITS });
  assert.equal(api.MAX, client.MAX);
  assert.deepEqual([...api.ADD_FIELDS].sort(), [...client.FIELDS].sort());
  const forms = [PIP, { ...PIP, name: "x" }, { ...PIP, name: "R2-D2" }, { ...PIP, faction: "Elves" }, { ...PIP, region: "Moon" }, { ...PIP, ruleset: "" }, { ...PIP, class: "" }, {}, { ...PIP, name: "  Brindle \n Oakhand " }, { ...PIP, faction: "horde", region: "anz" }];
  for (const f of forms) {
    const mine = api.validateAdd(f), theirs = client.validate(f);
    assert.equal(mine.ok, theirs.ok, JSON.stringify(f));
    if (mine.ok) assert.deepEqual(mine.value, theirs.value, JSON.stringify(f));
  }
});

test("flag off (the default): the route is a 404 and /api/me carries no characters", async () => {
  const db = schemaDb(); await seed(db);
  for (const flag of [undefined, "", "off", "0", "false"]) {
    const env = baseEnv(db, { CHARS_V1: flag });
    assert.equal((await send(env, "POST", "/api/me/characters", { body: PIP })).status, 404, String(flag));
    const me = await meOf(env);
    assert.equal("characters" in me, false);
  }
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM characters").get().n, 0);
});

test("wrangler.toml ships CHARS_V1 off", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../../infrastructure/wrangler.toml", import.meta.url), "utf8"), /^CHARS_V1 = "off"/m);
});

test("add: 201 with { character }, the six fields echoed, an id, and /api/me lists it as selected", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  assert.deepEqual((await meOf(env)).characters, []);
  const res = await send(env, "POST", "/api/me/characters", { body: PIP });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const j = await res.json();
  assert.deepEqual(Object.keys(j.character).sort(), ["class", "faction", "id", "name", "race", "region", "ruleset"]);
  assert.deepEqual({ ...j.character, id: undefined }, { ...PIP, id: undefined });
  assert.equal(j.selected, j.character.id);
  const me = await meOf(env);
  assert.deepEqual(me.characters, [j.character]);
  assert.equal(me.selected, j.character.id);
  assert.equal(me.via, "web-session");
  // the client accepts exactly what the Worker sends back
  assert.deepEqual(client.list(me).map((c) => c.name), ["Pip Fizzwick"]);
  assert.deepEqual(client.one(j.character), j.character);
});

test("add writes the 0002 owner row (region column, composite realm) and a profile row", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  await send(env, "POST", "/api/me/characters", { body: { ...PIP, region: "ANZ" } });
  const c = db.raw.prepare("SELECT c.*, p.race, p.faction, p.ruleset, p.region_label, p.selected FROM characters c JOIN character_profiles p ON p.character_id = c.id").get();
  assert.equal(c.discord_user_id, U1);
  assert.equal(c.tenant_id, T1);
  assert.equal(c.region, "us");
  assert.equal(c.realm, "Normal|ANZ");
  assert.equal(c.class, "Mage");
  assert.deepEqual([c.race, c.faction, c.ruleset, c.region_label, c.selected], ["Gnome", "Alliance", "Normal", "ANZ", 1]);
});

test("validation: named errors for each bad line, nothing written, unknown fields refused", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  const res = await send(env, "POST", "/api/me/characters", { body: { name: "x", faction: "Elves", extra: 1 } });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.deepEqual(Object.keys(j.errors).sort(), ["class", "extra", "faction", "name", "race", "region", "ruleset"]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM characters").get().n, 0);
  for (const bad of ["not json", "[]", "null", "7"]) assert.equal((await send(env, "POST", "/api/me/characters", { body: bad })).status, 400, bad);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: JSON.stringify({ ...PIP, pad: "x".repeat(3000) }) })).status, 413);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { ...PIP, action: "nuke" } })).status, 400);
});

test("a duplicate (same region, ruleset and name, any case) is a 409; the same name in another region is fine", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: PIP })).status, 201);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { ...PIP, name: "PIP FIZZWICK" } })).status, 409);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { ...PIP, region: "EU" } })).status, 201);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { ...PIP, region: "ANZ" } })).status, 201, "ANZ and Americas share a region column but not an identity");
  assert.equal((await meOf(env)).characters.length, 3);
});

test("at most 12 characters", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  for (let i = 0; i < 12; i++) assert.equal((await send(env, "POST", "/api/me/characters", { body: { ...PIP, name: `Pip${"abcdefghijkl"[i]}${"mnopqrstuvwx"[i]}` } })).status, 201, String(i));
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { ...PIP, name: "Overflow Name" } })).status, 409);
  assert.equal((await meOf(env)).characters.length, 12);
});

test("select: one selected at a time; adding selects the new one; rename keeps everything else", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  const a = (await (await send(env, "POST", "/api/me/characters", { body: PIP })).json()).character;
  const b = (await (await send(env, "POST", "/api/me/characters", { body: MARROW })).json()).character;
  assert.equal((await meOf(env)).selected, b.id);
  const sel = await send(env, "POST", "/api/me/characters", { body: { action: "select", id: a.id } });
  assert.equal(sel.status, 200);
  assert.deepEqual(await sel.json(), { selected: a.id });
  assert.equal((await meOf(env)).selected, a.id);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM character_profiles WHERE selected = 1").get().n, 1);
  const ren = await send(env, "POST", "/api/me/characters", { body: { action: "rename", id: b.id, name: "Marrow Ironbelly" } });
  assert.equal(ren.status, 200);
  assert.deepEqual((await ren.json()).character, { ...b, name: "Marrow Ironbelly" });
  const me = await meOf(env);
  assert.deepEqual(me.characters.map((c) => c.name), ["Pip Fizzwick", "Marrow Ironbelly"]);
  assert.equal(me.selected, a.id);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { action: "rename", id: b.id, name: "Pip Fizzwick" } })).status, 200, "same name, different region: not a duplicate");
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { action: "rename", id: a.id, name: "pip fizzwick" } })).status, 200, "renaming to your own name in a different case is fine");
  await send(env, "POST", "/api/me/characters", { body: { ...MARROW, name: "Third Dwarf" } });
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { action: "rename", id: b.id, name: "third dwarf" } })).status, 409);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { action: "rename", id: b.id, name: "9" } })).status, 400);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: { action: "select", id: a.id, extra: 1 } })).status, 400);
});

test("authz: no cookie 401, no Origin 403, wrong method 405; another user cannot see, rename or select your character", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  const a = (await (await send(env, "POST", "/api/me/characters", { body: PIP })).json()).character;
  assert.equal((await send(env, "POST", "/api/me/characters", { tok: null, body: PIP })).status, 401);
  assert.equal((await send(env, "POST", "/api/me/characters", { tok: "C".repeat(43), body: PIP })).status, 401);
  assert.equal((await send(env, "POST", "/api/me/characters", { origin: null, body: PIP })).status, 403);
  for (const m of ["GET", "PUT", "DELETE"]) assert.equal((await send(env, m, "/api/me/characters", { body: m === "GET" ? undefined : PIP })).status, 405, m);
  // a board key or the admin token is not a web session
  const admin = await worker.fetch(new Request("https://api.leeroy.test/api/me/characters", { method: "POST", headers: { Authorization: "Bearer admin-token-for-tests-0123456789abcdef", Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(PIP) }), baseEnv(db, { BOARD_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef" }), CTX);
  assert.equal(admin.status, 401);
  // user two
  assert.deepEqual((await meOf(env, TOK2)).characters, []);
  assert.equal((await send(env, "POST", "/api/me/characters", { tok: TOK2, body: { action: "rename", id: a.id, name: "Stolen Name" } })).status, 404);
  assert.equal((await send(env, "POST", "/api/me/characters", { tok: TOK2, body: { action: "select", id: a.id } })).status, 404);
  assert.equal((await meOf(env)).characters[0].name, "Pip Fizzwick");
  // a body can never name another owner
  const sneaky = await send(env, "POST", "/api/me/characters", { tok: TOK2, body: { ...MARROW, discord_user_id: U1 } });
  assert.equal(sneaky.status, 400);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM characters WHERE discord_user_id = ?").get(U1).n, 1);
});

test("nothing returned carries a Discord id, a hash or a tenant", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  const add = await (await send(env, "POST", "/api/me/characters", { body: PIP })).text();
  const me = JSON.stringify((await meOf(env)).characters) + add;
  assert.equal(me.includes(U1), false);
  assert.equal(me.includes(T1), false);
});

test("tenant choice: the only active tenant, else the caller's own membership, else a plain 409", async () => {
  const db = schemaDb(); await seed(db, { tenants: 2 }); const env = baseEnv(db);
  assert.equal((await send(env, "POST", "/api/me/characters", { body: PIP })).status, 409, "two tenants and no membership");
  db.raw.prepare("INSERT INTO memberships (tenant_id, discord_user_id, role, status, joined_at) VALUES ('t-two', ?, 'member', 'active', ?)").run(U1, ISO(NOW));
  assert.equal((await send(env, "POST", "/api/me/characters", { body: PIP })).status, 201);
  assert.equal(db.raw.prepare("SELECT tenant_id FROM characters").get().tenant_id, "t-two");
  assert.equal((await meOf(env, TOK2)).characters.length, 0);
});

test("rows written by the /build modal (realm 'unset', no profile) are never listed", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  db.raw.prepare("INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, class, created_at) VALUES ('t-one:x', ?, ?, ?, 'unset', 'us', 'Mage', ?)").run(T1, U1, U1, ISO(NOW));
  assert.deepEqual((await meOf(env)).characters, []);
  const res = await send(env, "POST", "/api/me/characters", { body: PIP });
  assert.equal(res.status, 201);
  assert.equal((await meOf(env)).characters.length, 1);
});

test("erase cascade: deleting the users row removes characters and profiles", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db);
  await send(env, "POST", "/api/me/characters", { body: PIP });
  db.raw.prepare("DELETE FROM users WHERE discord_user_id = ?").run(U1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM character_profiles").get().n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM characters").get().n, 0);
});

test("migration 0005 missing: the route answers 503 once-logged, /api/me still answers without characters", async () => {
  const db = schemaDb(); await seed(db); db.raw.exec("DROP TABLE character_profiles");
  api._resetCharactersApi();
  const env = baseEnv(db), warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    assert.equal((await send(env, "POST", "/api/me/characters", { body: PIP })).status, 503);
    const me = await meOf(env);
    assert.equal(me.via, "web-session");
    assert.deepEqual(me.characters, []);
    assert.equal(warned, 1);
  } finally { console.warn = warn; }
});

test("migration 0005 is idempotent on top of schema.sql and builds on its own after 0002", async () => {
  const { readFileSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const m5 = rd("../../infrastructure/migrations/0005_character_profiles.sql");
  const a = new DatabaseSync(":memory:"); a.exec(rd("../../infrastructure/schema.sql")); a.exec(m5); a.exec(m5);
  const b = new DatabaseSync(":memory:"); b.exec(rd("../../infrastructure/migrations/0002_identity_tenancy.sql")); b.exec(m5);
  for (const db of [a, b]) assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'character_profiles'").get().n, 1);
  assert.doesNotMatch(m5.replace(/^--.*$/gm, ""), /ALTER\s+TABLE/i);
});

test("the member data export includes the character profile rows (and survives a database without migration 0005)", async () => {
  const db = schemaDb(); await seed(db); const env = baseEnv(db, { DATA_RIGHTS: "on" });
  await send(env, "POST", "/api/me/characters", { body: PIP });
  const res = await send(env, "GET", "/api/me/export");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.tenancy.characters.length, 1);
  assert.deepEqual(j.tenancy.character_profiles.map((p) => [p.race, p.faction, p.ruleset, p.region_label, p.selected]), [["Gnome", "Alliance", "Normal", "Americas", 1]]);
  db.raw.exec("DROP TABLE character_profiles");
  const old = await send(env, "GET", "/api/me/export");
  assert.equal(old.status, 200);
  assert.deepEqual((await old.json()).tenancy.character_profiles, []);
});
