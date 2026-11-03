// Character switcher support (Q37 client, flag chars.v1), behind the Worker flag CHARS_V1 (default off).
//   GET  /api/me             (web session) gains "characters" and "selected" while CHARS_V1 is on; see listFor()
//   POST /api/me/characters  (web session) add, rename or select one character. 404 while CHARS_V1 is off.
// Contract: js/characters.js and scenes/sheet.js. The add body is exactly { name, class, race, ruleset, faction, region } and the answer is
// 201 { character: { id, name, class, race, ruleset, faction, region }, selected }. Rename is { action: "rename", id, name },
// select is { action: "select", id }; both answer 200. Everything is scoped to the caller's own Discord id from the cookie session:
// a body can never name another user. Caller: the __Host-sess cookie only (a member key has no Discord id here, the admin token is refused).
// Storage: the owner row is migration 0002 `characters`; what the client calls race, faction, ruleset, the region label and "selected"
// has no column there, so migration 0005 adds `character_profiles` (one row per character, cascade from characters). The 0002 `realm`
// column holds "<ruleset>|<region label>" so the table's UNIQUE (tenant, region, realm, name) is exactly the client's identity
// (region + ruleset + name, case-insensitive). Rows written by the /build modal (realm "unset") are never listed.
// No Blizzard data, no AI, no secrets. Discord ids are never returned.
import { webSessionFrom } from "./web-auth.js";

export const charsOn = (env) => /^(1|on|true|yes)$/i.test(String((env && env.CHARS_V1) || "").trim());
// Mirrors js/characters.js (FACTIONS, REGIONS, LIMITS, MAX, NAME_OK); tests/unit/characters-api.test.mjs fails if they drift.
export const MAX = 12;
export const FACTIONS = Object.freeze(["Alliance", "Horde"]);
export const REGIONS = Object.freeze(["Americas", "EU", "KR", "TW", "ANZ"]);
export const LIMITS = Object.freeze({ name: 40, class: 24, race: 24, ruleset: 24 });
// The 0002 table's region column is us|eu|kr|tw|cn. ANZ shares the us API region; the label itself is kept in character_profiles.
export const REGION_COLUMN = Object.freeze({ Americas: "us", EU: "eu", KR: "kr", TW: "tw", ANZ: "us" });
export const ADD_FIELDS = Object.freeze(["name", "class", "race", "ruleset", "faction", "region"]);
const NAME_OK = /^[\p{L}][\p{L}\p{M}' -]*$/u;
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;
const BODY_MAX = 2048;

const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const pick = (v, list) => { const s = str(v, 24).toLowerCase(); return list.find((x) => x.toLowerCase() === s) || ""; };
export const realmOf = (ruleset, region) => `${ruleset}|${region}`;

// -> { ok, value } or { ok: false, errors: { field: message } }. No class/race word lists here (the board's vocabulary lives in the client);
// every value is cleaned, cut and must be present.
export function validateAdd(body) {
  const errors = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: { body: "expected an object" } };
  for (const k of Object.keys(body)) if (!ADD_FIELDS.includes(k) && k !== "action") errors[k] = "unknown field";
  const v = { name: str(body.name, LIMITS.name), class: str(body.class, LIMITS.class), race: str(body.race, LIMITS.race), ruleset: str(body.ruleset, LIMITS.ruleset), faction: pick(body.faction, FACTIONS), region: pick(body.region, REGIONS) };
  if (v.name.length < 2 || !NAME_OK.test(v.name)) errors.name = "name must be 2 or more letters, spaces, hyphens or apostrophes";
  for (const k of ["class", "race", "ruleset"]) if (!v[k]) errors[k] = `${k} is required`;
  if (!v.faction) errors.faction = "faction must be Alliance or Horde";
  if (!v.region) errors.region = `region must be one of ${REGIONS.join(", ")}`;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: v };
}

const respond = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Credentials": "true", ...headers },
});
const missingTable = (e) => /no such table/i.test(String((e && e.message) || e));
let warned = false;
export function _resetCharactersApi() { warned = false; }
function warnMissing() { if (!warned) { warned = true; console.warn("characters-api: character_profiles or tenancy tables missing; apply infrastructure/migrations 0002 and 0005"); } }

// Which tenant a web caller's characters live in: their own active membership first, else the only active tenant, else none.
async function tenantFor(env, discordId) {
  const own = await env.DB.prepare(
    "SELECT t.id AS id FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.discord_user_id = ? AND m.status = 'active' AND t.status = 'active' ORDER BY m.joined_at, t.id LIMIT 1"
  ).bind(discordId).first();
  if (own && own.id) return own.id;
  const { results } = await env.DB.prepare("SELECT id FROM tenants WHERE status = 'active' ORDER BY id LIMIT 2").all();
  return results && results.length === 1 ? results[0].id : null;
}

const LIST_SQL =
  "SELECT c.id AS id, c.name AS name, c.class AS class, p.race AS race, p.faction AS faction, p.ruleset AS ruleset, p.region_label AS region, p.selected AS selected " +
  "FROM characters c JOIN character_profiles p ON p.character_id = c.id " +
  "WHERE c.tenant_id = ? AND c.discord_user_id = ? AND c.realm <> 'unset' ORDER BY c.created_at, c.rowid LIMIT ?";
const shape = (r) => ({ id: r.id, name: r.name, class: r.class || "", race: r.race || "", ruleset: r.ruleset || "", faction: r.faction || "", region: r.region || "" });

// -> { characters, selected } for a Discord id. Never throws: a missing table or tenant is an empty list.
export async function listFor(env, discordId) {
  try {
    const tenant = await tenantFor(env, discordId);
    if (!tenant) return { characters: [], selected: null };
    const { results } = await env.DB.prepare(LIST_SQL).bind(tenant, discordId, MAX).all();
    const rows = results || [];
    const sel = rows.find((r) => Number(r.selected) === 1);
    return { characters: rows.map(shape), selected: sel ? sel.id : null };
  } catch (e) {
    if (missingTable(e)) warnMissing(); else console.error("characters-api: list failed");
    return { characters: [], selected: null };
  }
}

async function readJson(request) {
  let text;
  try { text = await request.text(); } catch (e) { return { status: 400, error: "body unreadable" }; }
  if (new TextEncoder().encode(text).length > BODY_MAX) return { status: 413, error: "body too large" };
  try { const body = JSON.parse(text); return body && typeof body === "object" && !Array.isArray(body) ? { body } : { status: 400, error: "expected a JSON object" }; }
  catch (e) { return { status: 400, error: "body is not JSON" }; }
}

async function add(env, ws, tenant, body, now) {
  const v = validateAdd(body);
  if (!v.ok) return respond(400, { error: "invalid character", errors: v.errors });
  const v2 = v.value, id = crypto.randomUUID(), at = new Date(now).toISOString(), me = ws.discord_user_id;
  const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM characters c JOIN character_profiles p ON p.character_id = c.id WHERE c.tenant_id = ? AND c.discord_user_id = ?").bind(tenant, me).first();
  if (have && Number(have.n) >= MAX) return respond(409, { error: `up to ${MAX} characters` });
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE character_profiles SET selected = 0 WHERE character_id IN (SELECT id FROM characters WHERE tenant_id = ? AND discord_user_id = ?)").bind(tenant, me),
      env.DB.prepare("INSERT INTO characters (id, tenant_id, discord_user_id, name, realm, region, class, spec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)").bind(id, tenant, me, v2.name, realmOf(v2.ruleset, v2.region), REGION_COLUMN[v2.region], v2.class, at),
      env.DB.prepare("INSERT INTO character_profiles (character_id, race, faction, ruleset, region_label, selected) VALUES (?, ?, ?, ?, ?, 1)").bind(id, v2.race, v2.faction, v2.ruleset, v2.region),
    ]);
  } catch (e) {
    if (/UNIQUE constraint/i.test(String((e && e.message) || e))) return respond(409, { error: "you already have a character with that name in this region and ruleset" });
    throw e;
  }
  return respond(201, { character: { id, ...v2 }, selected: id });
}

async function owned(env, tenant, me, id) {
  if (typeof id !== "string" || !ID_OK.test(id)) return null;
  return env.DB.prepare(LIST_SQL.replace("ORDER BY", "AND c.id = ? ORDER BY")).bind(tenant, me, id, MAX).first();
}

async function rename(env, ws, tenant, body) {
  const cur = await owned(env, tenant, ws.discord_user_id, body.id);
  if (!cur) return respond(404, { error: "not found" });
  for (const k of Object.keys(body)) if (!["action", "id", "name"].includes(k)) return respond(400, { error: "unknown field", errors: { [k]: "unknown field" } });
  const name = str(body.name, LIMITS.name);
  if (name.length < 2 || !NAME_OK.test(name)) return respond(400, { error: "invalid character", errors: { name: "name must be 2 or more letters, spaces, hyphens or apostrophes" } });
  try {
    await env.DB.prepare("UPDATE characters SET name = ? WHERE id = ? AND tenant_id = ? AND discord_user_id = ?").bind(name, cur.id, tenant, ws.discord_user_id).run();
  } catch (e) {
    if (/UNIQUE constraint/i.test(String((e && e.message) || e))) return respond(409, { error: "you already have a character with that name in this region and ruleset" });
    throw e;
  }
  return respond(200, { character: { ...shape(cur), name } });
}

async function select(env, ws, tenant, body) {
  for (const k of Object.keys(body)) if (!["action", "id"].includes(k)) return respond(400, { error: "unknown field", errors: { [k]: "unknown field" } });
  const cur = await owned(env, tenant, ws.discord_user_id, body.id);
  if (!cur) return respond(404, { error: "not found" });
  await env.DB.batch([
    env.DB.prepare("UPDATE character_profiles SET selected = 0 WHERE character_id IN (SELECT id FROM characters WHERE tenant_id = ? AND discord_user_id = ?)").bind(tenant, ws.discord_user_id),
    env.DB.prepare("UPDATE character_profiles SET selected = 1 WHERE character_id = ?").bind(cur.id),
  ]);
  return respond(200, { selected: cur.id });
}

// -> a Response for POST /me/characters, or null for any other path. Flag off: 404, indistinguishable from no route.
export async function handleCharacters(request, env, { path, now }) {
  if (path !== "/me/characters") return null;
  if (!charsOn(env)) return respond(404, { error: "not found" });
  if (request.method !== "POST") return respond(405, { error: "method not allowed" }, { Allow: "POST, OPTIONS" });
  if (!request.headers.get("Origin")) return respond(403, { error: "origin not allowed" }); // the allow-list check already ran in the Worker
  try {
    const ws = await webSessionFrom(request, env, now);
    if (!ws) return respond(401, { error: "unauthorized" });
    const b = await readJson(request);
    if (b.error) return respond(b.status, { error: b.error });
    const action = b.body.action === undefined ? "add" : b.body.action;
    if (!["add", "rename", "select"].includes(action)) return respond(400, { error: "action must be add, rename or select" });
    const tenant = await tenantFor(env, ws.discord_user_id);
    if (!tenant) return respond(409, { error: "no board is set up for you yet" });
    if (action === "add") return await add(env, ws, tenant, b.body, now);
    return action === "rename" ? await rename(env, ws, tenant, b.body) : await select(env, ws, tenant, b.body);
  } catch (e) {
    if (missingTable(e)) { warnMissing(); return respond(503, { error: "characters not available" }); }
    console.error("characters-api: failed");
    return respond(500, { error: "request failed" });
  }
}
