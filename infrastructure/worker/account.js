// Login and per-user persistence (pilot). Discord is the identity: the board sends the Embedded App SDK code, this Worker
// exchanges it, asks Discord who it is ONCE, and throws the Discord token away. What is kept:
//   sessions(token_hash, user_key, created_at, expires_at, last_seen)  token_hash = sha256 of the opaque session token
//   user_state(user_key, doc, etag, json, updated_at)                   board preferences only, five allow-listed documents
// user_key = sha256(USER_SALT ":user:" discord_id): the Discord id, email, name and tokens are never stored or logged.
// Everything answers Cache-Control: no-store and is never put in the edge cache.
import { sha256Hex, timingSafeEqualStr } from "./crypto.js";

export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_ME_URL = "https://discord.com/api/users/@me";
export const ACCOUNT = {
  sessionDays: 30, maxSessionsPerUser: 10, bodyMax: 1024, docMax: 16 * 1024, valueMax: 4096,
  loginPerMin: 10, failPerMin: 10, touchEveryMs: 3600 * 1000,
};
// The only documents, and the only localStorage keys each may carry. Anything else is a 404 or a 400.
export const DOCS = {
  journey: ["board-journey"],
  prefs: ["board-calm", "board-still", "board-screencare", "board-foley", "board-sense", "board-mode"],
  walked: ["board-walked"],
  seen: ["board-seen"],
  "signups-choice": ["board-me"],
};
const CODE_RE = /^[A-Za-z0-9_-]{6,128}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^\d{15,25}$/;

const logins = new Map(), fails = new Map(); // `${ip}:${minute}` -> n; isolate memory, a courtesy limit
export function _resetAccountLimits() { logins.clear(); fails.clear(); }
function hit(map, ip, now, max) {
  const minute = Math.floor(now / 60000), key = `${ip}:${minute}`;
  const n = (map.get(key) || 0) + 1;
  map.set(key, n);
  if (map.size > 2000) for (const k of map.keys()) if (!k.endsWith(`:${minute}`)) map.delete(k);
  return n > max;
}
const over = (map, ip, now, max) => (map.get(`${ip}:${Math.floor(now / 60000)}`) || 0) >= max;

const saltOk = (env) => !!env.USER_SALT && String(env.USER_SALT).length >= 16;
export const userKey = (env, discordId) => sha256Hex(`${env.USER_SALT}:user:${discordId}`);
export const sessionHash = (token) => sha256Hex(`session:${token}`);
const newToken = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

// Newer timestamp wins per key; a tie keeps the stored value. Used for the prefs document.
export function mergeKeys(oldKeys, newKeys) {
  const out = { ...(oldKeys || {}) };
  for (const [k, e] of Object.entries(newKeys || {})) {
    const cur = out[k];
    if (!cur || e.t > cur.t) out[k] = e;
  }
  return out;
}

// -> { ok, body } or { ok:false, status, error }. The shape is { keys: { <allowed key>: { v: string|null, t: integer } } }.
export function validateDoc(doc, text) {
  if (new TextEncoder().encode(text).length > ACCOUNT.docMax) return { ok: false, status: 413, error: "document too large" };
  let body;
  try { body = JSON.parse(text); } catch (e) { return { ok: false, status: 400, error: "body is not JSON" }; }
  if (!body || typeof body !== "object" || Array.isArray(body) || !body.keys || typeof body.keys !== "object" || Array.isArray(body.keys)) return { ok: false, status: 400, error: "expected { keys: {...} }" };
  if (Object.keys(body).some((k) => k !== "keys")) return { ok: false, status: 400, error: "unknown field" };
  const clean = {};
  for (const [k, e] of Object.entries(body.keys)) {
    if (!DOCS[doc].includes(k)) return { ok: false, status: 400, error: "key not allowed in this document" };
    if (!e || typeof e !== "object" || Array.isArray(e) || !Number.isSafeInteger(e.t) || e.t < 0) return { ok: false, status: 400, error: "bad entry" };
    if (!(e.v === null || (typeof e.v === "string" && e.v.length <= ACCOUNT.valueMax))) return { ok: false, status: 400, error: "bad value" };
    clean[k] = { v: e.v, t: e.t };
  }
  return { ok: true, body: { keys: clean } };
}

const etagOf = async (text) => `"${(await sha256Hex(text)).slice(0, 16)}"`;

async function readBody(request, max) {
  let text;
  try { text = await request.text(); } catch (e) { return { status: 400, error: "body unreadable" }; }
  if (new TextEncoder().encode(text).length > max) return { status: 413, error: "body too large" };
  return { text };
}

async function login(request, env, ip, now, deps) {
  if (!request.headers.get("Origin")) return [403, { error: "origin not allowed" }];
  if (!saltOk(env) || !env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return [500, { error: "worker not configured" }];
  if (hit(logins, ip, now, ACCOUNT.loginPerMin)) return [429, { error: "rate_limited" }, { "Retry-After": "60" }];
  const b = await readBody(request, ACCOUNT.bodyMax);
  if (b.error) return [b.status, { error: b.error }];
  let body; try { body = JSON.parse(b.text || "null"); } catch (e) { return [400, { error: "body is not JSON" }]; }
  const code = body && body.code;
  if (typeof code !== "string" || !CODE_RE.test(code)) return [400, { error: "code missing or malformed" }];
  const send = deps.fetch || ((...a) => fetch(...a));
  let id = null;
  try {
    const r = await send(DISCORD_TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code }),
    });
    if (!r.ok) return [502, { error: "sign-in failed" }];
    const d = await r.json().catch(() => null);
    const access = d && d.access_token;
    if (typeof access !== "string" || !access) return [502, { error: "sign-in failed" }];
    const me = await send(DISCORD_ME_URL, { headers: { Authorization: `Bearer ${access}` } });
    if (!me.ok) return [502, { error: "sign-in failed" }];
    const u = await me.json().catch(() => null);
    id = u && typeof u.id === "string" && ID_RE.test(u.id) ? u.id : null;
    // the Discord token goes out of scope here; nothing below can reach it
  } catch (e) { return [502, { error: "sign-in failed" }]; }
  if (!id) return [502, { error: "sign-in failed" }];
  const user = await userKey(env, id);
  id = null;
  const token = newToken();
  const expires = now + ACCOUNT.sessionDays * 86400000;
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_key, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)").bind(await sessionHash(token), user, now, expires, now).run();
  // keep the newest few sessions per person
  await env.DB.prepare("DELETE FROM sessions WHERE user_key = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)").bind(user, user, ACCOUNT.maxSessionsPerUser).run();
  return [200, { session: token, expires_at: expires }];
}

// -> { user_key, hash, expires_at } or null. A well-formed token is looked up by its hash; the comparison is constant time.
async function sessionFrom(request, env, now) {
  const m = /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") || "");
  if (!m || !TOKEN_RE.test(m[1])) return null;
  const hash = await sessionHash(m[1]);
  const row = await env.DB.prepare("SELECT token_hash, user_key, expires_at, last_seen FROM sessions WHERE token_hash = ?").bind(hash).first();
  if (!row || !timingSafeEqualStr(row.token_hash, hash)) return null;
  if (row.expires_at <= now) { await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run(); return null; }
  if (now - row.last_seen > ACCOUNT.touchEveryMs) await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").bind(now, hash).run();
  return { user_key: row.user_key, hash, expires_at: row.expires_at };
}

const readDoc = (env, user, doc) => env.DB.prepare("SELECT etag, json, updated_at FROM user_state WHERE user_key = ? AND doc = ?").bind(user, doc).first();

async function putDoc(request, env, s, doc, now) {
  const b = await readBody(request, ACCOUNT.docMax + 256);
  if (b.error) return [b.status, { error: b.error }];
  const v = validateDoc(doc, b.text);
  if (!v.ok) return [v.status, { error: v.error }];
  const cur = await readDoc(env, s.user_key, doc);
  const ifMatch = (request.headers.get("If-Match") || "").trim();
  let body = v.body;
  if (cur && ifMatch !== cur.etag) {
    if (doc !== "prefs") return [409, { error: "changed elsewhere" }, { ETag: cur.etag }];
    body = { keys: mergeKeys(JSON.parse(cur.json).keys, body.keys) }; // prefs: the newest write per key wins
  }
  if (!cur && ifMatch) return [409, { error: "no such document" }];
  const text = JSON.stringify(body);
  const etag = await etagOf(text);
  let r;
  if (cur) r = await env.DB.prepare("UPDATE user_state SET etag = ?, json = ?, updated_at = ? WHERE user_key = ? AND doc = ? AND etag = ?").bind(etag, text, now, s.user_key, doc, cur.etag).run();
  else r = await env.DB.prepare("INSERT INTO user_state (user_key, doc, etag, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(s.user_key, doc, etag, text, now).run();
  if (!r.meta || r.meta.changes !== 1) return [409, { error: "changed elsewhere" }];
  return [200, body, { ETag: etag }];
}

// Returns [status, bodyObject, extraHeaders] for the account routes, or null when the path is not one of them.
export async function handleAccount(request, env, { path, ip, now, deps = {} }) {
  const m = request.method;
  if (path === "/auth/discord") {
    if (m !== "POST") return [405, { error: "method not allowed" }, { Allow: "POST, OPTIONS" }];
    return login(request, env, ip, now, deps);
  }
  const state = /^\/state\/([a-z-]{1,32})$/.exec(path);
  if (path !== "/me" && !state) return null;
  if (!saltOk(env)) return [500, { error: "worker not configured" }];
  if (over(fails, ip, now, ACCOUNT.failPerMin)) return [429, { error: "slow down" }, { "Retry-After": "60" }];
  const s = await sessionFrom(request, env, now);
  if (!s) { hit(fails, ip, now, ACCOUNT.failPerMin); return [401, { error: "unauthorized" }]; }
  if (path === "/me") {
    if (m === "GET" || m === "HEAD") return [200, { user: s.user_key.slice(0, 8), expires_at: s.expires_at }];
    if (m === "DELETE") { // a real erase: every session and every document of this person
      await env.DB.prepare("DELETE FROM user_state WHERE user_key = ?").bind(s.user_key).run();
      await env.DB.prepare("DELETE FROM sessions WHERE user_key = ?").bind(s.user_key).run();
      return [200, { erased: true }];
    }
    return [405, { error: "method not allowed" }, { Allow: "GET, DELETE, OPTIONS" }];
  }
  const doc = state[1];
  if (!Object.prototype.hasOwnProperty.call(DOCS, doc)) return [404, { error: "not found" }];
  if (m === "GET" || m === "HEAD") {
    const row = await readDoc(env, s.user_key, doc);
    if (!row) return [404, { error: "not found" }];
    return [200, JSON.parse(row.json), { ETag: row.etag }];
  }
  if (m === "PUT") return putDoc(request, env, s, doc, now);
  return [405, { error: "method not allowed" }, { Allow: "GET, PUT, OPTIONS" }];
}
