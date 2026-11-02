// Web Discord login (Q18), behind the WEB_LOGIN flag (default off: every route here answers 404 and /api/me ignores cookies).
//   GET  /auth/discord/start     random state + PKCE (S256) verifier go into a 10 minute pre-session cookie, then 302 to Discord
//   GET  /auth/discord/callback  checks state, exchanges the code, asks Discord who it is ONCE, discards the Discord token,
//                                upserts users, inserts sessions_v2 (sha256 of the token only), sets __Host-sess, 302 to the board
//   POST /auth/logout            revokes the row, clears the cookie
// Tables come from migrations/0002_identity_tenancy.sql. If they are missing the routes answer 503 and log once; /api/me falls back.
// Identities: the migration's identities table is attach-only (CHECK excludes 'discord'), so Discord itself is the users row.
// Secrets: DISCORD_CLIENT_SECRET and DISCORD_CLIENT_ID come from the environment and are never logged or stored.
import { sha256Hex, timingSafeEqualStr } from "./crypto.js";
import { DISCORD_TOKEN_URL, DISCORD_ME_URL } from "./account.js";

export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const WEB = { sessionDays: 30, maxSessionsPerUser: 10, preSessionSeconds: 600, perMin: 20, touchEveryMs: 3600 * 1000 };
export const SESS_COOKIE = "__Host-sess";
export const PRE_COOKIE = "__Host-oauth";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9_-]{6,128}$/;
const ID_RE = /^\d{17,20}$/;

export const webLoginOn = (env) => /^(1|on|true|yes)$/i.test(String(env.WEB_LOGIN || "").trim());

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const webSessionHash = (token) => sha256Hex(`session_v2:${token}`);
export async function pkceChallenge(verifier) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;

let warned = false;
const hits = new Map(), used = new Set(); // courtesy limit and replayed-state memory, per isolate
const missingTable = (e) => /no such table/i.test(String((e && e.message) || e));
function tableMissing(e) { // true (and one log line) when the migration has not been applied
  if (!missingTable(e)) return false;
  if (!warned) { warned = true; console.warn("web-auth: sessions_v2/users tables missing; apply infrastructure/migrations/0002_identity_tenancy.sql"); }
  return true;
}
export function _resetWebAuth() { warned = false; used.clear(); hits.clear(); }

function limited(ip, now) {
  const minute = Math.floor(now / 60000), key = `${ip}:${minute}`;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 2000) for (const k of hits.keys()) if (!k.endsWith(`:${minute}`)) hits.delete(k);
  return n > WEB.perMin;
}

const boardUrl = (env) => String(env.BOARD_PUBLIC_URL || "https://leeroy.party").replace(/\/+$/, "");
const redirectUri = (env) => `${String(env.API_ORIGIN || "https://api.leeroy.party").replace(/\/+$/, "")}/api/auth/discord/callback`;

function respond(status, body, headers = {}, cookies = []) {
  const h = new Headers({ "Cache-Control": "no-store", ...headers });
  if (body !== null) h.set("Content-Type", "application/json; charset=utf-8");
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: h });
}
const back = (env, reason, cookies) => respond(302, null, { Location: `${boardUrl(env)}/?login=${reason}` }, cookies);

async function start(request, env, ip, now) {
  if (!env.DISCORD_CLIENT_ID) return respond(503, { error: "worker not configured" });
  if (limited(ip, now)) return respond(429, { error: "rate_limited" }, { "Retry-After": "60" });
  const state = randomToken(), verifier = randomToken();
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, response_type: "code", scope: "identify", redirect_uri: redirectUri(env),
    state, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", prompt: "none",
  });
  return respond(302, null, { Location: `${DISCORD_AUTHORIZE_URL}?${q}` }, [setCookie(PRE_COOKIE, `${state}.${verifier}`, WEB.preSessionSeconds)]);
}

async function callback(request, env, url, ip, now, deps) {
  const clear = [setCookie(PRE_COOKIE, "", 0)];
  if (limited(ip, now)) return respond(429, { error: "rate_limited" }, { "Retry-After": "60" }, clear);
  const pre = (readCookie(request, PRE_COOKIE) || "").split(".");
  const state = url.searchParams.get("state") || "";
  const okShape = pre.length === 2 && TOKEN_RE.test(pre[0]) && TOKEN_RE.test(pre[1]);
  if (!okShape || !TOKEN_RE.test(state) || !timingSafeEqualStr(pre[0], state) || used.has(state)) return back(env, "state", clear);
  used.add(state); // one use per state, even if the cookie is replayed
  if (used.size > 2000) used.clear();
  if (url.searchParams.get("error")) return back(env, "denied", clear);
  const code = url.searchParams.get("code") || "";
  if (!CODE_RE.test(code)) return back(env, "code", clear);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return respond(503, { error: "worker not configured" }, {}, clear);
  const send = deps.fetch || ((...a) => fetch(...a));
  let id = null, name = null;
  try {
    const r = await send(DISCORD_TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri(env), code_verifier: pre[1] }),
    });
    if (!r.ok) return back(env, "exchange", clear);
    const d = await r.json().catch(() => null);
    const access = d && d.access_token;
    if (typeof access !== "string" || !access) return back(env, "exchange", clear);
    const me = await send(DISCORD_ME_URL, { headers: { Authorization: `Bearer ${access}` } });
    if (!me.ok) return back(env, "exchange", clear);
    const u = await me.json().catch(() => null);
    id = u && typeof u.id === "string" && ID_RE.test(u.id) ? u.id : null;
    const n = u && (u.global_name || u.username);
    name = typeof n === "string" && n ? n.slice(0, 64) : null;
    // the Discord token goes out of scope here
  } catch (e) { return back(env, "exchange", clear); }
  if (!id) return back(env, "exchange", clear);
  const token = randomToken();
  const created = new Date(now).toISOString(), expires = new Date(now + WEB.sessionDays * 86400000).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (discord_user_id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(discord_user_id) DO UPDATE SET display_name = excluded.display_name").bind(id, name, created),
      env.DB.prepare("DELETE FROM sessions_v2 WHERE expires_at < ?").bind(created),
      env.DB.prepare("INSERT INTO sessions_v2 (token_hash, discord_user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").bind(await webSessionHash(token), id, created, expires, created),
      env.DB.prepare("DELETE FROM sessions_v2 WHERE discord_user_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions_v2 WHERE discord_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)").bind(id, id, WEB.maxSessionsPerUser),
    ]);
  } catch (e) {
    if (tableMissing(e)) return respond(503, { error: "web login not available" }, {}, clear);
    console.error("web-auth: session write failed");
    return back(env, "error", clear);
  }
  return back(env, "ok", [...clear, setCookie(SESS_COOKIE, token, WEB.sessionDays * 86400)]);
}

// -> { discord_user_id, name, expires_at (ISO) } or null. Never throws: missing tables and D1 errors mean "no session".
export async function webSessionFrom(request, env, now) {
  if (!webLoginOn(env)) return null;
  const token = readCookie(request, SESS_COOKIE);
  if (!token || !TOKEN_RE.test(token)) return null;
  const hash = await webSessionHash(token);
  try {
    const row = await env.DB.prepare("SELECT s.token_hash, s.discord_user_id, s.expires_at, s.last_seen_at, u.display_name FROM sessions_v2 s JOIN users u ON u.discord_user_id = s.discord_user_id WHERE s.token_hash = ?").bind(hash).first();
    if (!row || !timingSafeEqualStr(row.token_hash, hash)) return null;
    if (!(Date.parse(row.expires_at) > now)) { await env.DB.prepare("DELETE FROM sessions_v2 WHERE token_hash = ?").bind(hash).run(); return null; }
    if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > WEB.touchEveryMs) await env.DB.prepare("UPDATE sessions_v2 SET last_seen_at = ? WHERE token_hash = ?").bind(new Date(now).toISOString(), hash).run();
    return { hash, discord_user_id: row.discord_user_id, name: row.display_name, expires_at: row.expires_at };
  } catch (e) {
    if (!tableMissing(e)) console.error("web-auth: session lookup failed");
    return null;
  }
}

async function logout(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return respond(403, { error: "origin not allowed" }); // a form post or curl; the allow-list check already ran in the Worker
  const clearCookie = [setCookie(SESS_COOKIE, "", 0)];
  const token = readCookie(request, SESS_COOKIE);
  if (token && TOKEN_RE.test(token)) {
    try { await env.DB.prepare("DELETE FROM sessions_v2 WHERE token_hash = ?").bind(await webSessionHash(token)).run(); }
    catch (e) {
      if (!tableMissing(e)) { console.error("web-auth: logout failed"); return respond(500, { error: "logout failed" }, { "Access-Control-Allow-Credentials": "true" }, clearCookie); }
    }
  }
  return respond(200, { ok: true }, { "Access-Control-Allow-Credentials": "true" }, clearCookie);
}

// -> a Response for the three web-auth routes, or null for any other path. Flag off: 404, indistinguishable from no route.
export async function handleWebAuth(request, env, { path, ip, now, deps = {} }) {
  const routes = { "/auth/discord/start": "GET", "/auth/discord/callback": "GET", "/auth/logout": "POST" };
  if (!Object.prototype.hasOwnProperty.call(routes, path)) return null;
  if (!webLoginOn(env)) return respond(404, { error: "not found" });
  if (request.method !== routes[path]) return respond(405, { error: "method not allowed" }, { Allow: `${routes[path]}, OPTIONS` });
  if (path === "/auth/logout") return logout(request, env);
  if (path === "/auth/discord/start") return start(request, env, ip, now);
  return callback(request, env, new URL(request.url), ip, now, deps);
}
