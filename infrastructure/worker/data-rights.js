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
// Name-keyed tables (ask_turns, fact_fixes) are matched only for a member-key caller: a web display name is chosen by its owner
// and could collide with someone else's name, so it is never used to select rows.
import { sha256Hex } from "./crypto.js";
import { saltProblems, saltErrorBody } from "./salts.js";
import { authenticate, invalidateMembersCache } from "./auth.js";
import { userKey } from "./account.js";
import { webSessionFrom, SESS_COOKIE } from "./web-auth.js";
import { loadConfigKey } from "./config.js";

export const CONFIRM_PHRASE = "erase my data";
export const dataRightsOn = (env) => /^(1|on|true|yes)$/i.test(String((env && env.DATA_RIGHTS) || "").trim());
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

async function collect(env, who) {
  const out = { legacy: {}, tenancy: null };
  const id = who.discordId;
  if (who.slug) {
    out.legacy.members = await rows(env, "SELECT slug, created_at FROM members WHERE slug = ?", who.slug); // never key_hash
    out.legacy.sheet_events = await rows(env, "SELECT id, slug, name, field, value_json, visible, source, created_at FROM sheet_events WHERE slug = ?", who.slug);
    out.legacy.dispatches = await rows(env, "SELECT id, slug, name, ask_ids_json, created_at FROM dispatches WHERE slug = ?", who.slug);
    out.legacy.intents = await rows(env, "SELECT seq, at, slug, kind, body, ver FROM intents WHERE slug = ?", who.slug);
    out.legacy.ask_turns = await rows(env, "SELECT id, by_name, question, answer, cites_json, model, status, share, latency_ms, created_at, answered_at FROM ask_turns WHERE by_name IN (?, ?)", who.slug, who.name);
    out.legacy.fact_fixes = await rows(env, "SELECT id, page_id, fact_key, old_value, new_value, note, by_name, created_at FROM fact_fixes WHERE by_name IN (?, ?)", who.slug, who.name);
  }
  if (id) {
    const uk = await userKey(env, id);
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
      "Cloudflare request logs and Discord-side data.",
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
  if (id) {
    const uk = await userKey(env, id);
    st.push(db.prepare("DELETE FROM user_state WHERE user_key = ?").bind(uk));
    st.push(db.prepare("DELETE FROM sessions WHERE user_key = ?").bind(uk));
  }
  if (who.slug) {
    st.push(db.prepare("DELETE FROM sheet_events WHERE slug = ?").bind(who.slug));
    st.push(db.prepare("DELETE FROM dispatches WHERE slug = ?").bind(who.slug));
    st.push(db.prepare("DELETE FROM intents WHERE slug = ?").bind(who.slug));
    st.push(db.prepare("DELETE FROM ask_turns WHERE by_name IN (?, ?)").bind(who.slug, who.name));
    st.push(db.prepare("DELETE FROM fact_fixes WHERE by_name IN (?, ?)").bind(who.slug, who.name));
    st.push(db.prepare("DELETE FROM members WHERE slug = ?").bind(who.slug));
  }
  if (id) {
    st.push(db.prepare("DELETE FROM sessions_v2 WHERE discord_user_id = ?").bind(id));
    st.push(db.prepare("DELETE FROM humans WHERE id IN (SELECT human_id FROM human_members WHERE discord_user_id = ?) AND (SELECT COUNT(*) FROM human_members h WHERE h.human_id = humans.id) = 1").bind(id));
    st.push(db.prepare("DELETE FROM users WHERE discord_user_id = ?").bind(id));
  }
  const subject = id ? `discord:${id}` : `slug:${who.slug}`;
  const target = await sha256Hex(`${env.USER_SALT}:erase:${subject}`);
  st.push(db.prepare("INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) VALUES (NULL, NULL, 'erase', ?, '{}', ?)").bind(target, new Date(now).toISOString()));
  await db.batch(st);
  // the member-key cache lives 15 minutes per isolate: drop it so an erased key stops authenticating at once
  invalidateMembersCache();
  return respond(200, {
    erased: true,
    not_erased: [
      "Board documents in kv_state that mention you by name; ask the owner to review them.",
      "Account rows (accounts, account_keys: name, slug, label) are not erased by this route; ask the owner to remove them.",
      ...(who.via === "web-session" ? ["Slug-keyed and name-keyed rows (sheet_events, dispatches, intents, ask_turns, fact_fixes) are erased only through a member-key request."] : []),
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
      if (!warned) { warned = true; console.warn("data-rights: a table is missing; apply infrastructure/migrations 0002 and 0003"); }
      return respond(503, { error: "data rights not available" });
    }
    console.error("data-rights: failed");
    return respond(500, { error: "request failed" });
  }
}
