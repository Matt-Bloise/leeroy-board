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

// The signature is HMAC-SHA256 over `${timestamp}.${rawBody}` with the shared secret, hex. The compare is constant time (equal length first, then every byte).
export async function signListen(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
}

export async function verifyListen(secret, timestamp, rawBody, signature, nowSeconds) {
  if (!secret || typeof secret !== "string" || secret.length < 16) return false; // a missing or short secret never verifies
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > LISTEN_MAX_AGE_SECONDS) return false;
  const want = await signListen(secret, String(timestamp), rawBody);
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
