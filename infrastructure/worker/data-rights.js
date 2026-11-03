// Member data export and erase (Q59), behind the DATA_RIGHTS flag (default off: both routes answer 404).
//   GET  /api/me/export   one JSON file of everything held about the caller. Never a token hash, key hash or encrypted token.
//   POST /api/me/erase    body { "confirm": "erase my data" } and an Origin header. Deletes the caller's rows in one D1 batch,
//                         writes one audit_log row with no personal data, revokes sessions, clears the cookie.
// Caller: the member key (as /api/me does) or, when WEB_LOGIN is on, the __Host-sess cookie. The admin token is NOT a caller here:
// it resolves to a default member elsewhere, and an erase must never run on that borrowed identity.
// Erase order inside the batch (atomic): legacy rows by user_key / slug / by_name, the members row, an orphan humans row,
// then DELETE FROM users, which cascades to identities, human_members, sessions_v2, provider_tokens, memberships, characters
// (-> builds; group_slots.character_id is SET NULL and the trigger re-opens the seat) and signups_v2. audit_log.actor is SET NULL
// by the cascade. The audit row is written last. kv_state board documents (signups, party, party_sheets, ...) are NOT edited here.
// Also cleared (everything keyed by a hash of the person): answer_feedback.user_hash and answer_details.asker_hash (answer-ux.js hash),
// answer_details rows for the person's own Ask turns (the "More" / "Sources" answer text), kv_state ai_budget:<day>:user:<hashId> rows
// (for the Discord id and for the slug) and the person's ballot inside each kv_state vote:<id> document. The audit row's target is a
// random value, so no row left after an erase can be tied back to the person. DATA_MAP below lists every table and how it is handled;
// tests/unit/data-map.test.mjs fails when a table in schema.sql is missing from it.
// Name-keyed tables (ask_turns, fact_fixes) are matched only for a member-key caller: a web display name is chosen by its owner
// and could collide with someone else's name, so it is never used to select rows.
import { sha256Hex } from "./crypto.js";
import { saltProblems, saltErrorBody } from "./salts.js";
import { authenticate, invalidateMembersCache } from "./auth.js";
import { userKey } from "./account.js";
import { webSessionFrom, SESS_COOKIE } from "./web-auth.js";
import { loadConfigKey } from "./config.js";
import { userHash, slugAskerHash } from "./answer-ux.js";
import { hashId } from "./budget.js";
import { voterHash, VOTE_ID_RE } from "./votes.js";

export const CONFIRM_PHRASE = "erase my data";
export const dataRightsOn = (env) => /^(1|on|true|yes)$/i.test(String((env && env.DATA_RIGHTS) || "").trim());

// One entry per table in schema.sql: what links a row to a person, how an erase clears it, and where it shows up in the exports.
//   links   what ties rows to one person (null: no per-person data)
//   erase   how POST /api/me/erase clears it (null: not touched)
//   member  section of GET /api/me/export that carries it (null: not in the member export)
// The admin backup (export.js) carries every table except EXCLUDED_TABLES there; tests/unit/data-map.test.mjs checks both lists against this one.
export const DATA_MAP = Object.freeze({
  kv_state: { links: "board documents by name; ai_budget:<day>:user:<hash> rows; vote:<id> ballots keyed by a hash", erase: "ai_budget user rows deleted; the person's ballot removed from each vote document; board documents (party, signups, ...) NOT edited", member: "legacy.ai_budget, legacy.vote_ballots" },
  lib_pages: { links: null, erase: null, member: null },
  lib_blobs: { links: null, erase: null, member: null },
  lib_sources: { links: null, erase: null, member: null },
  lib_source_snapshots: { links: null, erase: null, member: null },
  wiki_proposals: { links: null, erase: null, member: null },
  ask_turns: { links: "ask_turn_askers.asker_hash; rows older than migration 0007 only by_name = slug or roster name (member-key caller only)", erase: "DELETE by asker hash; legacy rows with no asker row by by_name", member: "legacy.ask_turns" },
  ask_turn_askers: { links: "asker_hash", erase: "DELETE by asker_hash", member: null },
  fact_fixes: { links: "by_name = slug or roster name (member-key caller only)", erase: "DELETE by by_name", member: "legacy.fact_fixes" },
  sheet_events: { links: "slug", erase: "DELETE by slug", member: "legacy.sheet_events" },
  dispatches: { links: "slug", erase: "DELETE by slug", member: "legacy.dispatches" },
  members: { links: "slug", erase: "DELETE by slug", member: "legacy.members" },
  accounts: { links: "name, slug (not tied to a Discord id)", erase: null, member: null },
  account_keys: { links: "account_id", erase: null, member: null },
  sessions: { links: "user_key = sha256(USER_SALT:user:<discord id>)", erase: "DELETE by user_key", member: "legacy.sessions" },
  user_state: { links: "user_key", erase: "DELETE by user_key", member: "legacy.user_state" },
  intents: { links: "slug", erase: "DELETE by slug", member: "legacy.intents" },
  guest_rate_limits: { links: "ip_hash of a guest visitor (no member link)", erase: null, member: null },
  users: { links: "discord_user_id", erase: "DELETE by discord_user_id (root of the cascade)", member: "tenancy.users" },
  identities: { links: "discord_user_id", erase: "cascade from users", member: "tenancy.identities" },
  humans: { links: "via human_members", erase: "DELETE when this user was its only member", member: null },
  human_members: { links: "discord_user_id", erase: "cascade from users", member: "tenancy.human_members" },
  sessions_v2: { links: "discord_user_id", erase: "DELETE by discord_user_id, then cascade", member: "tenancy.sessions_v2" },
  provider_tokens: { links: "discord_user_id", erase: "cascade from users", member: "tenancy.provider_tokens" },
  tenants: { links: null, erase: null, member: null },
  tenant_config: { links: null, erase: null, member: null },
  memberships: { links: "discord_user_id", erase: "cascade from users", member: "tenancy.memberships" },
  characters: { links: "discord_user_id", erase: "cascade from users", member: "tenancy.characters" },
  builds: { links: "via characters", erase: "cascade from characters", member: "tenancy.builds" },
  thread_cursors: { links: null, erase: null, member: null },
  audit_log: { links: "actor_discord_user_id", erase: "actor set to NULL by the cascade; the erase row itself has a random target", member: "tenancy.audit_log_as_actor" },
  groups: { links: null, erase: null, member: null },
  group_slots: { links: "character_id", erase: "character_id set to NULL, seat re-opened by trigger", member: "tenancy.group_slots" },
  signups_v2: { links: "user_id", erase: "cascade from users", member: "tenancy.signups_v2" },
  entitlements: { links: null, erase: null, member: null },
  discord_events: { links: null, erase: null, member: null },
  answer_details: { links: "asker_hash; intent_id of the person's own Ask turns (by asker hash, or legacy name match)", erase: "DELETE by asker_hash and by the person's intent ids", member: "legacy.answer_details" },
  answer_feedback: { links: "user_hash = sha256(USER_SALT:answer-ux:<discord id>)", erase: "DELETE by user_hash", member: "legacy.answer_feedback" },
  character_profiles: { links: "via characters", erase: "cascade from characters", member: "tenancy.character_profiles" },
  noise_ledger: { links: null, erase: null, member: null },
});
// Durable Object state: BoardRoom (room.js) is a pure relay. It never touches ctx.storage and keeps no state between messages, so there is nothing to erase.
export const DURABLE_OBJECT_STATE = Object.freeze({ BoardRoom: "none: relays live pushes to open sockets, no storage" });
const missingTable = (e) => /no such table/i.test(String((e && e.message) || e));
let warned = false;
export function _resetDataRights() { warned = false; }

function respond(status, body, headers = {}, cookies = []) {
  const h = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Credentials": "true", ...headers });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers: h });
}
const clearSession = `${SESS_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

// -> { slug, name, discordId, via } or null. A member key whose roster entry has no Discord id has discordId null.
async function whoIs(request, env, now) {
  const a = await authenticate(request, env);
  if (a && a.slug) {
    let discordId = null;
    const roster = await loadConfigKey(env, "discord_members");
    const entry = Array.isArray(roster) ? roster.find((m) => m && m.slug === a.slug) : null;
    if (entry && typeof entry.id === "string") discordId = entry.id;
    return { slug: a.slug, name: entry && entry.name ? entry.name : a.slug, discordId, via: "member-key" };
  }
  const ws = await webSessionFrom(request, env, now);
  if (ws) return { slug: null, name: null, discordId: ws.discord_user_id, via: "web-session" };
  return null;
}

const rows = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];


const kvLike = (hash) => `ai_budget:%:user:${hash}`;

// Every per-person key this Worker derives, for the caller. Nothing here is read from a request body.
// askerHashes: the two forms an ask_turn_askers row can hold for this caller (Discord id, board-key slug); null when not applicable.
async function personalKeys(env, who) {
  const k = { userKey: null, answerHash: null, budgetIds: [], askerHashes: [null, null] };
  if (who.discordId) {
    k.userKey = await userKey(env, who.discordId);
    k.answerHash = await userHash(env, who.discordId);
    k.askerHashes[0] = k.answerHash;
    k.budgetIds.push(await hashId(who.discordId));
  }
  if (who.slug) {
    k.askerHashes[1] = await slugAskerHash(env, who.slug);
    k.budgetIds.push(await hashId(who.slug));
  }
  return k;
}

// An ask_turns row is this person's when its asker row holds one of their hashes. Rows written before migration 0007 have no asker row;
// those (and only those) are matched by name, so a nickname that equals this person's name cannot pull in a row that has an asker row.
const MINE_ASK = "(id IN (SELECT intent_id FROM ask_turn_askers WHERE asker_hash IN (?, ?)) OR (by_name IN (?, ?) AND id NOT IN (SELECT intent_id FROM ask_turn_askers)))";
const askArgs = (pk, who) => [pk.askerHashes[0], pk.askerHashes[1], who.slug || null, who.name || null];

// Ids of every stored vote (kv_state vote:<id>), not just the 50 in votes:index, so an old vote keeps no ballot behind.
async function voteIds(env) {
  return (await rows(env, "SELECT key FROM kv_state WHERE key LIKE 'vote:%'")).map((r) => String(r.key).slice(5)).filter((id) => VOTE_ID_RE.test(id));
}
const ballotPath = (hash) => `$.ballots."${hash}"`; // hex only, quoted because a key may start with a digit

// -> [{ id, vote, hash, choice }] for each vote document that holds a ballot from this Discord id (export only; erase never reads the documents).
async function ballotsOf(env, who) {
  if (!who.discordId) return [];
  const out = [];
  for (const id of await voteIds(env)) {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(`vote:${id}`).first();
    let vote = null;
    try { vote = row ? JSON.parse(row.json) : null; } catch (e) { vote = null; }
    if (!vote || !vote.ballots || typeof vote.ballots !== "object") continue;
    const h = await voterHash(who.discordId, id, env.USER_SALT);
    if (Object.prototype.hasOwnProperty.call(vote.ballots, h)) out.push({ id, vote, hash: h, choice: vote.ballots[h] });
  }
  return out;
}

async function collect(env, who) {
  const out = { legacy: {}, tenancy: null };
  const id = who.discordId;
  if (who.slug) {
    out.legacy.members = await rows(env, "SELECT slug, created_at FROM members WHERE slug = ?", who.slug); // never key_hash
    out.legacy.sheet_events = await rows(env, "SELECT id, slug, name, field, value_json, visible, source, created_at FROM sheet_events WHERE slug = ?", who.slug);
    out.legacy.dispatches = await rows(env, "SELECT id, slug, name, ask_ids_json, created_at FROM dispatches WHERE slug = ?", who.slug);
    out.legacy.intents = await rows(env, "SELECT seq, at, slug, kind, body, ver FROM intents WHERE slug = ?", who.slug);
    out.legacy.fact_fixes = await rows(env, "SELECT id, page_id, fact_key, old_value, new_value, note, by_name, created_at FROM fact_fixes WHERE by_name IN (?, ?)", who.slug, who.name);
  }
  const pk = await personalKeys(env, who);
  out.legacy.ask_turns = await rows(env, `SELECT id, by_name, question, answer, cites_json, model, status, share, latency_ms, created_at, answered_at FROM ask_turns WHERE ${MINE_ASK}`, ...askArgs(pk, who));
  out.legacy.answer_details = await rows(env, `SELECT intent_id, more, sources, message_id, created_at FROM answer_details WHERE asker_hash = ? OR intent_id IN (SELECT id FROM ask_turns WHERE ${MINE_ASK})`, pk.answerHash, ...askArgs(pk, who));
  out.legacy.ai_budget = [];
  for (const b of pk.budgetIds) out.legacy.ai_budget.push(...await rows(env, "SELECT key, json, updated_at FROM kv_state WHERE key LIKE ?", kvLike(b)));
  if (id) {
    const uk = await userKey(env, id);
    out.legacy.answer_feedback = await rows(env, "SELECT intent_id, vote, created_at FROM answer_feedback WHERE user_hash = ?", pk.answerHash);
    out.legacy.vote_ballots = (await ballotsOf(env, who)).map((b) => ({ vote_id: b.id, title: b.vote.title, choice: b.choice }));
    out.legacy.user_state = await rows(env, "SELECT doc, json, updated_at FROM user_state WHERE user_key = ?", uk);
    out.legacy.sessions = await rows(env, "SELECT created_at, expires_at, last_seen FROM sessions WHERE user_key = ?", uk); // never token_hash
    const t = {};
    t.users = await rows(env, "SELECT discord_user_id, display_name, created_at FROM users WHERE discord_user_id = ?", id);
    t.identities = await rows(env, "SELECT provider, provider_user_id, attached_at FROM identities WHERE discord_user_id = ?", id);
    t.human_members = await rows(env, "SELECT human_id, added_at FROM human_members WHERE discord_user_id = ?", id);
    t.provider_tokens = await rows(env, "SELECT provider, scope, expires_at, updated_at FROM provider_tokens WHERE discord_user_id = ?", id); // never the encrypted tokens
    t.sessions_v2 = await rows(env, "SELECT created_at, expires_at, last_seen_at FROM sessions_v2 WHERE discord_user_id = ?", id); // never token_hash
    t.memberships = await rows(env, "SELECT m.tenant_id, t.name AS tenant_name, m.role, m.status, m.joined_at FROM memberships m LEFT JOIN tenants t ON t.id = m.tenant_id WHERE m.discord_user_id = ?", id);
    t.characters = await rows(env, "SELECT id, tenant_id, name, realm, region, class, spec, created_at FROM characters WHERE discord_user_id = ?", id);
    try { // character_profiles comes from migration 0005; before it is applied there is nothing to include
      t.character_profiles = await rows(env, "SELECT p.character_id, p.race, p.faction, p.ruleset, p.region_label, p.selected FROM character_profiles p JOIN characters c ON c.id = p.character_id WHERE c.discord_user_id = ?", id);
    } catch (e) { if (!missingTable(e)) throw e; t.character_profiles = []; }
    t.builds = await rows(env, "SELECT b.id, b.character_id, b.source, b.status, b.title, b.data_json, b.created_at, b.confirmed_at FROM builds b JOIN characters c ON c.id = b.character_id WHERE c.discord_user_id = ?", id);
    t.group_slots = await rows(env, "SELECT s.group_id, s.slot_index, s.role, s.character_id, s.status FROM group_slots s JOIN characters c ON c.id = s.character_id WHERE c.discord_user_id = ?", id);
    t.signups_v2 = await rows(env, "SELECT group_id, user_id, character_id, rsvp, updated_at FROM signups_v2 WHERE user_id = ?", id);
    t.audit_log_as_actor = await rows(env, "SELECT id, tenant_id, action, target, detail_json, at FROM audit_log WHERE actor_discord_user_id = ?", id);
    out.tenancy = t;
  }
  return out;
}

async function exportData(env, who, now) {
  const data = await collect(env, who);
  const body = {
    format: "leeroy-member-export-v1",
    generated_at: new Date(now).toISOString(),
    identified_by: who.via,
    legacy: data.legacy,
    tenancy: data.tenancy,
    not_included: [
      "Board documents in kv_state (signups, party, party_sheets, votes, feed_posts and similar) that may mention you by name.",
      "Cloudflare request logs, Cloudflare AI Gateway logs and cache, and Discord-side data.",
      "Account rows (accounts, account_keys: name, slug, label) are not part of this export; ask the owner for them.",
      ...(who.via === "web-session" ? ["Rows keyed only by a member slug or display name (sheet_events, dispatches, intents, ask_turns, fact_fixes): a web session cannot be tied to a slug."] : []),
      ...(!who.discordId ? ["Tenancy tables (users, characters, builds, signups_v2 and others): this member key has no linked Discord id."] : []),
    ],
  };
  return respond(200, body, { "Content-Disposition": 'attachment; filename="leeroy-export.json"' });
}

async function eraseData(request, env, who, now) {
  if (!request.headers.get("Origin")) return respond(403, { error: "origin not allowed" }); // a form post or curl; the allow-list check already ran in the Worker
  let body = null;
  try { body = JSON.parse(await request.text()); } catch (e) { body = null; }
  if (!body || typeof body !== "object" || body.confirm !== CONFIRM_PHRASE) return respond(400, { error: `body must be {"confirm":"${CONFIRM_PHRASE}"}` });
  const id = who.discordId, db = env.DB;
  const st = [];
  const pk = await personalKeys(env, who);
  if (id) {
    st.push(db.prepare("DELETE FROM user_state WHERE user_key = ?").bind(pk.userKey));
    st.push(db.prepare("DELETE FROM sessions WHERE user_key = ?").bind(pk.userKey));
    st.push(db.prepare("DELETE FROM answer_feedback WHERE user_hash = ?").bind(pk.answerHash));
    st.push(db.prepare("DELETE FROM answer_details WHERE asker_hash = ?").bind(pk.answerHash));
    // One in-database edit per vote: json_remove on the ballot key. Nothing is read first, so a ballot cast by someone else at the same moment is not overwritten.
    for (const vid of await voteIds(env)) {
      st.push(db.prepare("UPDATE kv_state SET json = json_remove(json, ?), updated_at = ? WHERE key = ? AND json_valid(json)").bind(ballotPath(await voterHash(id, vid, env.USER_SALT)), new Date(now).toISOString(), `vote:${vid}`));
    }
  }
  for (const h of pk.budgetIds) st.push(db.prepare("DELETE FROM kv_state WHERE key LIKE ?").bind(kvLike(h)));
  // the answer text behind "More" / "Sources" belongs to the Ask turn; it goes first, while the turn row can still be found
  st.push(db.prepare(`DELETE FROM answer_details WHERE intent_id IN (SELECT id FROM ask_turns WHERE ${MINE_ASK})`).bind(...askArgs(pk, who)));
  st.push(db.prepare(`DELETE FROM ask_turns WHERE ${MINE_ASK}`).bind(...askArgs(pk, who)));
  st.push(db.prepare("DELETE FROM ask_turn_askers WHERE asker_hash IN (?, ?)").bind(pk.askerHashes[0], pk.askerHashes[1]));
  if (who.slug) {
    st.push(db.prepare("DELETE FROM sheet_events WHERE slug = ?").bind(who.slug));
    st.push(db.prepare("DELETE FROM dispatches WHERE slug = ?").bind(who.slug));
    st.push(db.prepare("DELETE FROM intents WHERE slug = ?").bind(who.slug));
    st.push(db.prepare("DELETE FROM fact_fixes WHERE by_name IN (?, ?)").bind(who.slug, who.name));
    st.push(db.prepare("DELETE FROM members WHERE slug = ?").bind(who.slug));
  }
  if (id) {
    st.push(db.prepare("DELETE FROM sessions_v2 WHERE discord_user_id = ?").bind(id));
    st.push(db.prepare("DELETE FROM humans WHERE id IN (SELECT human_id FROM human_members WHERE discord_user_id = ?) AND (SELECT COUNT(*) FROM human_members h WHERE h.human_id = humans.id) = 1").bind(id));
    st.push(db.prepare("DELETE FROM users WHERE discord_user_id = ?").bind(id));
  }
  // A random target: the audit row proves an erase happened and when, and cannot be tied back to the person.
  const target = await sha256Hex(`${env.USER_SALT}:erase:${crypto.randomUUID()}`);
  st.push(db.prepare("INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) VALUES (NULL, NULL, 'erase', ?, '{}', ?)").bind(target, new Date(now).toISOString()));
  await db.batch(st);
  // the member-key cache lives 15 minutes per isolate: drop it so an erased key stops authenticating at once
  invalidateMembersCache();
  return respond(200, {
    erased: true,
    not_erased: [
      "Board documents in kv_state that mention you by name (party, signups, the Discord roster and similar); ask the owner to review them.",
      "Account rows (accounts, account_keys: name, slug, label) are not erased by this route; ask the owner to remove them.",
      "Copies held by Cloudflare (request logs, AI Gateway logs and its cached answers, up to 6 hours for the cache) and by Discord and the AI vendor; D1 backups (Time Travel) until they expire.",
      "The Discord roster entry (kv_state discord_members) stays, so the bot still treats you as a member until an admin edits the roster.",
      "Your display name, your question and the party's names and builds were sent to the AI vendor; AI Gateway request logs may keep the full request. This service cannot erase those.",
      "A member key that was already checked by another running copy of the Worker can still be accepted for read requests for up to 15 minutes; write requests re-check the database.",
      "Questions asked on Discord by someone who is not on the roster are kept under the Discord nickname and cannot be found by key; a nickname is never matched to a person.",
      ...(who.via === "web-session" ? ["Rows filed only under a handle or name (sheet_events, dispatches, intents, fact_fixes, and ask_turns written before migration 0007) are erased only through a member-key request."] : []),
    ],
  }, {}, [clearSession]);
}

// -> a Response for the two routes, or null for any other path. Flag off: 404, indistinguishable from no route.
export async function handleDataRights(request, env, { path, now }) {
  const routes = { "/me/export": "GET", "/me/erase": "POST" };
  if (!Object.prototype.hasOwnProperty.call(routes, path)) return null;
  if (!dataRightsOn(env)) return respond(404, { error: "not found" });
  if (request.method !== routes[path]) return respond(405, { error: "method not allowed" }, { Allow: `${routes[path]}, OPTIONS` });
  const salt = saltProblems(env, ["USER_SALT"]);
  if (salt.length) return respond(503, saltErrorBody(salt));
  try {
    const who = await whoIs(request, env, now);
    if (!who) return respond(401, { error: "unauthorized" });
    return path === "/me/export" ? await exportData(env, who, now) : await eraseData(request, env, who, now);
  } catch (e) {
    if (missingTable(e)) {
      if (!warned) { warned = true; console.warn("data-rights: a table is missing; apply infrastructure/migrations 0002, 0003 and 0007"); }
      return respond(503, { error: "data rights not available" });
    }
    console.error("data-rights: failed");
    return respond(500, { error: "request failed" });
  }
}
