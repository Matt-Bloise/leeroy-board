// Per-member keys. A member's key is never stored: the table holds sha256(KEY_SALT + ":" + key). A request carries
// "Authorization: Board <key>". There is no default member and no shared admin token: an unknown key, a missing salt
// and a malformed header are all a refusal. The shape check below is only a cheap pre-filter, never the proof.
import { sha256Hex, timingSafeEqualStr } from "./crypto.js";

export const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function keyFromRequest(request) {
  const m = /^Board ([^\s]+)$/.exec(request.headers.get("Authorization") || "");
  return m && KEY_RE.test(m[1]) ? m[1] : null;
}

export async function hashKey(env, key) {
  return sha256Hex(`${env.KEY_SALT}:${key}`);
}

// Returns { slug } for a good key, { configured: false } when the salt is missing, or null. Every stored hash is compared,
// so the time taken does not depend on which member (if any) matched.
export async function authenticate(request, env) {
  if (!env.KEY_SALT || String(env.KEY_SALT).length < 16) return { configured: false };
  const key = keyFromRequest(request);
  if (!key) return null;
  const h = await hashKey(env, key);
  const { results } = await env.DB.prepare("SELECT slug, key_hash FROM members").all();
  let slug = null;
  for (const row of results || []) {
    const same = timingSafeEqualStr(row.key_hash, h);
    if (same) slug = row.slug;
  }
  return slug ? { slug } : null;
}
