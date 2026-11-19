// The listener (step f of the /ask rebuild): pure parts only (flag, command definition, signature, event validation). No imports from the rest of the Worker,
// so the command manifest can read it without a cycle. The route and the answer path are in listener.js.
//
// LISTENER (wrangler.toml [vars]): "off" (default, anything unrecognised) | "dry" | "live".
//   off  POST /api/listen answers 404, /quiet is not in the command manifest, nothing is read or written.
//   dry  events are checked, logged and answered into the private turn store, but NOTHING is posted to Discord; the turn it would have answered (listen_events.ask_id, a private ask_turns row) holds what Leeroy would have said.
//   live the same, and the answer is posted as a reply with every ping switched off.
// It also needs ASK_RESEARCH on (friend text must only ever reach the paid Claude hop) and is never on in a PR preview; listener.js checks both.

export const LISTENER_FLAG = "LISTENER";
export const listenerMode = (env) => {
  const v = String((env && env[LISTENER_FLAG]) || "").trim().toLowerCase();
  return v === "dry" || v === "live" ? v : "off";
};

export const LISTEN_MAX_BODY = 12 * 1024; // bytes of the signed JSON body
export const LISTEN_MAX_AGE_SECONDS = 120; // clock skew plus travel; the forwarder signs at send time
export const LISTEN_CONTENT_CHARS = 2000; // Discord's own message limit
export const LISTEN_REF_CHARS = 300; // the earlier line a reply points at
export const LISTEN_KINDS = Object.freeze(["mention", "reply", "chatter"]);

export const QUIET_COMMAND_NAME = "quiet";
export const QUIET_COMMAND_DEFINITION = {
  name: QUIET_COMMAND_NAME,
  description: "Tell Leeroy to stay out of this channel's chat (he still answers a tag), or let him back in",
  options: [
    {
      name: "state",
      description: "on: Leeroy stops reading and commenting here. off: he may read and chime in again",
      type: 3,
      required: true,
      choices: [
        { name: "on: stay quiet in this channel", value: "on" },
        { name: "off: you may read and speak here", value: "off" },
      ],
    },
  ],
};

const SNOWFLAKE = /^\d{15,25}$/;
export const isSnow = (v) => typeof v === "string" && SNOWFLAKE.test(v);

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

// SIGNING KEY. There is no separately provisioned secret: the key is derived from the bot token the Worker and the PC forwarder both already hold.
//   key       = HMAC-SHA256(key = the bot token as UTF-8 bytes, message = the ASCII string "leeroy-listener-v1")   -> 32 raw bytes
//   signature = lowercase hex of HMAC-SHA256(key = those 32 raw bytes (NOT their hex text), message = UTF-8 of `${timestamp}.${rawBody}`)
//   headers   = X-Listen-Timestamp: unix seconds as a base-10 integer string; X-Listen-Signature: the 64 hex characters (upper case is accepted on verify)
// The label separates this use of the token from any other. docs/runbooks/listener.md has a test vector the PC forwarder can reproduce.
export const LISTEN_KEY_LABEL = "leeroy-listener-v1";
export const LISTEN_MIN_TOKEN_CHARS = 16; // a Discord bot token is far longer; anything shorter is a mistake and never derives a key

// -> Uint8Array(32), or null when the token is missing or too short (the route then fails closed).
export async function listenerKey(botToken) {
  if (typeof botToken !== "string" || botToken.length < LISTEN_MIN_TOKEN_CHARS) return null;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(botToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(LISTEN_KEY_LABEL)));
}

// One derived key per isolate: re-derived only when the token changes (a rotation).
let keyCache = { token: null, key: null };
export async function listenerKeyFor(env) {
  const token = env && env.DISCORD_BOT_TOKEN;
  if (typeof token !== "string" || token.length < LISTEN_MIN_TOKEN_CHARS) return null;
  if (keyCache.token === token && keyCache.key) return keyCache.key;
  const key = await listenerKey(token);
  keyCache = { token, key };
  return key;
}
export function resetListenerKeyCacheForTests() { keyCache = { token: null, key: null }; }

// key: the 32 derived bytes from listenerKey (a string is not a key). The compare in verifyListen is constant time (equal length first, then every byte).
export async function signListen(key, timestamp, rawBody) {
  const hmac = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
}

export async function verifyListen(key, timestamp, rawBody, signature, nowSeconds) {
  if (!(key instanceof Uint8Array) || key.length !== 32) return false; // no derived key never verifies (a token or any other string is not a key)
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > LISTEN_MAX_AGE_SECONDS) return false;
  const want = await signListen(key, String(timestamp), rawBody);
  const got = String(signature || "").toLowerCase();
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

const clean = (v, max) => String(v ?? "").replace(/\u0000/g, "").slice(0, max);

// One forwarded Discord message. Returns { ok: true, ev } or { ok: false, why }. Strict: unknown kinds, bad ids and bot authors are refused.
//   { id, guild_id, channel_id, parent_id? (a thread's channel), author_id, bot?: boolean, kind: 'mention'|'reply'|'chatter', content, ref_text? }
// Mentions of any user or role are removed from the content here (the forwarder strips the bot's own already); Leeroy never repeats a ping.
export function parseListenEvent(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, why: "shape" };
  if (!isSnow(obj.id) || !isSnow(obj.guild_id) || !isSnow(obj.channel_id) || !isSnow(obj.author_id)) return { ok: false, why: "ids" };
  if (!LISTEN_KINDS.includes(obj.kind)) return { ok: false, why: "kind" };
  if (obj.bot === true) return { ok: false, why: "bot" };
  const strip = (s, max) => clean(s, max * 2).replace(/<@[!&]?\d+>|<#\d+>|@everyone|@here/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const content = strip(obj.content, LISTEN_CONTENT_CHARS);
  const ref = obj.ref_text == null ? "" : strip(obj.ref_text, LISTEN_REF_CHARS);
  return { ok: true, ev: { id: obj.id, guild_id: obj.guild_id, channel_id: obj.channel_id, parent_id: isSnow(obj.parent_id) ? obj.parent_id : "", author_id: obj.author_id, kind: obj.kind, content, ref_text: ref } };
}

// HEARTBEAT KEY (POST /api/heartbeat, deadman.js). Appended after everything else on purpose, so it does not collide with the other derived keys:
//   key = HMAC-SHA256(key = the bot token as UTF-8 bytes, message = the ASCII string "leeroy-heartbeat-v1")   -> 32 raw bytes
// Signature and headers are exactly the listener's (signListen / verifyListen). A signature made with the listener key (the self-test uses it too) or any other derived key never verifies under this one.
export const HEARTBEAT_KEY_LABEL = "leeroy-heartbeat-v1";
export async function heartbeatKey(botToken) {
  if (typeof botToken !== "string" || botToken.length < LISTEN_MIN_TOKEN_CHARS) return null;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(botToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(HEARTBEAT_KEY_LABEL)));
}
let heartbeatKeyCache = { token: null, key: null };
export async function heartbeatKeyFor(env) {
  const token = env && env.DISCORD_BOT_TOKEN;
  if (typeof token !== "string" || token.length < LISTEN_MIN_TOKEN_CHARS) return null;
  if (heartbeatKeyCache.token === token && heartbeatKeyCache.key) return heartbeatKeyCache.key;
  const key = await heartbeatKey(token);
  heartbeatKeyCache = { token, key };
  return key;
}
export function resetHeartbeatKeyCacheForTests() { heartbeatKeyCache = { token: null, key: null }; }
