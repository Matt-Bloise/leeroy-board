// Answer buttons (ANSWER_UX=on): "More if you want it" and "Sources" (detail text kept in D1) and "Helpful" / "Off" (the evaluation signal).
// Custom ids are opaque and bound to the message they sit on: leeroy:more:<intentId>:<sig>, leeroy:sources:<intentId>:<sig>,
// leeroy:fb:up|down:<intentId>:<sig>, where sig is the first 12 hex characters of HMAC-SHA256(USER_SALT, "answer-ux:<kind>:<intentId>:<messageId>").
// A click whose message id differs from the one signed is rejected. No new secret: USER_SALT is the existing per-user hash salt.
// Users are stored only as sha256(USER_SALT:answer-ux:<discord id>). Reactions are never used: the Worker cannot see them.
import { toHex, timingSafeEqualStr, sha256Hex } from "./crypto.js";
import { saltProblems } from "./salts.js";
import { ALLOWED_MENTIONS_NONE } from "./discord-safety.js";

export const MORE_LABEL = "More if you want it";
export const SOURCES_LABEL = "Sources";
export const EXPIRED_TEXT = "That detail has expired. Ask again and I will rebuild it.";
export const PART_CHARS = 1900;
export const MAX_PARTS = 4;
export const DETAILS_TTL_DAYS = 30;
export const FEEDBACK_TTL_DAYS = 90;

const ID_RE = "[A-Za-z0-9_-]{1,40}";
const DETAIL_RE = new RegExp(`^leeroy:(more|sources):(${ID_RE}):([0-9a-f]{12})$`);
const FB_RE = new RegExp(`^leeroy:fb:(up|down):(${ID_RE}):([0-9a-f]{12})$`);

export function isAnswerButtonId(customId) {
  return String(customId || "").startsWith("leeroy:");
}

export function saltReady(env) {
  return saltProblems(env, ["USER_SALT"]).length === 0;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function signButton(env, kind, intentId, messageId) {
  return (await hmacHex(env.USER_SALT, `answer-ux:${kind}:${intentId}:${messageId}`)).slice(0, 12);
}

export function userHash(env, discordId) {
  return sha256Hex(`${env.USER_SALT}:answer-ux:${discordId}`);
}

// Who asked an Ask turn, for erase and export (table ask_turn_askers, migration 0009). A Discord id wins; a board key has only its slug.
// The Discord form is the same hash as userHash, so it also matches answer_feedback and answer_details.asker_hash.
export const slugAskerHash = (env, slug) => sha256Hex(`${env.USER_SALT}:answer-ux:slug:${slug}`);
export async function askerHash(env, { discordId, slug } = {}) {
  if (!saltReady(env)) return null;
  if (discordId) return userHash(env, String(discordId));
  if (slug) return slugAskerHash(env, String(slug));
  return null; // a web guest: nothing identifies them, so nothing is stored
}
// Never fails an ask: a missing table or salt only means that turn is found by name (older rows) or not at all.
export async function recordAsker(env, intentId, who) {
  try {
    const h = await askerHash(env, who);
    if (!h) return;
    await env.DB.prepare("INSERT OR REPLACE INTO ask_turn_askers (intent_id, asker_hash) VALUES (?, ?)").bind(String(intentId), h).run();
  } catch (e) { console.error("ask_turn_askers write failed"); }
}

// Components for the final @original edit. Empty when there is nothing to show, no salt, or no message id to bind to.
export async function buildAnswerComponents(env, { intentId, messageId, hasMore, hasSources }) {
  if (!intentId || !messageId || !saltReady(env)) return [];
  const id = async (kind) => `leeroy:${kind}:${intentId}:${await signButton(env, kind, intentId, messageId)}`;
  const rows = [];
  const detail = [];
  if (hasMore) detail.push({ type: 2, style: 2, label: MORE_LABEL, custom_id: await id("more") });
  if (hasSources) detail.push({ type: 2, style: 2, label: SOURCES_LABEL, custom_id: await id("sources") });
  if (detail.length) rows.push({ type: 1, components: detail });
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 2, label: "Helpful", custom_id: `leeroy:fb:up:${intentId}:${await signButton(env, "fb:up", intentId, messageId)}` },
      { type: 2, style: 2, label: "Off", custom_id: `leeroy:fb:down:${intentId}:${await signButton(env, "fb:down", intentId, messageId)}` },
    ],
  });
  return rows;
}

// Learns the id of the message about to be edited (GET @original), binds the stored detail row to it (and to the asker when
// the answer is private), and returns the components for the final PATCH. Returns [] on any problem: no buttons, never an error.
export async function prepareAnswerButtons({ env, interaction, intentId, isPrivate = false, askerId = "" }) {
  if (!saltReady(env) || !interaction || !interaction.application_id || !interaction.token) return [];
  const res = await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res || !res.ok) return [];
  const message = await res.json().catch(() => null);
  const messageId = message && message.id ? String(message.id) : "";
  if (!messageId) return [];
  const row = await env.DB.prepare("SELECT more, sources FROM answer_details WHERE intent_id = ?").bind(String(intentId)).first();
  const hasMore = Boolean(row && row.more);
  const hasSources = Boolean(row && row.sources);
  if (row) {
    const asker = isPrivate && askerId ? await userHash(env, askerId) : null;
    await env.DB.prepare("UPDATE answer_details SET message_id = ?, asker_hash = ? WHERE intent_id = ?").bind(messageId, asker, String(intentId)).run();
  }
  return buildAnswerComponents(env, { intentId: String(intentId), messageId, hasMore, hasSources });
}

// At most MAX_PARTS parts of at most PART_CHARS characters, cut at a newline or space where possible.
export function splitForDiscord(text, size = PART_CHARS, maxParts = MAX_PARTS) {
  const parts = [];
  let rest = String(text || "").trim();
  while (rest && parts.length < maxParts) {
    if (rest.length <= size) {
      parts.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return parts;
}

const eph = (content) => ({
  body: { type: 4, data: { content, flags: 64, allowed_mentions: ALLOWED_MENTIONS_NONE } },
  followups: [],
});

// Returns { body, followups: [string] }. The caller sends body as the interaction response and followups as ephemeral webhook posts.
export async function handleAnswerButton({ env, interaction }) {
  const customId = String((interaction.data && interaction.data.custom_id) || "");
  if (!answerUxEnabledEnv(env)) return eph("Those buttons are switched off right now.");
  if (!saltReady(env)) return eph("Those buttons are unavailable right now.");
  const detail = DETAIL_RE.exec(customId);
  const fb = detail ? null : FB_RE.exec(customId);
  if (!detail && !fb) return eph("That button is not valid.");
  const kind = detail ? detail[1] : `fb:${fb[1]}`;
  const intentId = detail ? detail[2] : fb[2];
  const sig = detail ? detail[3] : fb[3];
  const messageId = String((interaction.message && interaction.message.id) || "");
  const user = (interaction.member && interaction.member.user) || interaction.user || {};
  const discordId = String(user.id || "");
  if (!messageId || !discordId) return eph("That button is not valid.");
  const expected = await signButton(env, kind, intentId, messageId);
  if (!timingSafeEqualStr(sig, expected)) return eph("That button is not valid.");
  const who = await userHash(env, discordId);

  if (fb) {
    const vote = fb[1] === "up" ? 1 : -1;
    await env.DB.prepare(
      "INSERT INTO answer_feedback (intent_id, user_hash, vote, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(intent_id, user_hash) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at"
    )
      .bind(intentId, who, vote, new Date().toISOString())
      .run();
    return eph("Thanks, noted.");
  }

  const row = await env.DB.prepare("SELECT more, sources, asker_hash, message_id FROM answer_details WHERE intent_id = ?").bind(intentId).first();
  if (!row) return eph(EXPIRED_TEXT);
  if (row.message_id && String(row.message_id) !== messageId) return eph("That button is not valid.");
  if (row.asker_hash && !timingSafeEqualStr(row.asker_hash, who)) return eph("That detail belongs to the person who asked.");
  const text = String(detail[1] === "more" ? row.more || "" : row.sources || "").trim();
  if (!text) return eph(EXPIRED_TEXT);
  const [first, ...rest] = splitForDiscord(text);
  const out = eph(first);
  out.followups = rest;
  return out;
}

function answerUxEnabledEnv(env) {
  return String((env && env.ANSWER_UX) || "off").toLowerCase().trim() === "on";
}

// Admin report: counts and the latest 50 votes with the question and the first 160 characters of the answer. No user ids.
export async function feedbackReport(env, sinceIso) {
  const counts = { up: 0, down: 0, total: 0 };
  const agg = await env.DB.prepare("SELECT vote, COUNT(*) AS n FROM answer_feedback WHERE created_at >= ? GROUP BY vote").bind(sinceIso).all();
  for (const r of (agg && agg.results) || []) {
    if (Number(r.vote) === 1) counts.up = Number(r.n) || 0;
    else if (Number(r.vote) === -1) counts.down = Number(r.n) || 0;
  }
  counts.total = counts.up + counts.down;
  const rows = await env.DB.prepare(
    "SELECT f.intent_id AS intent_id, f.vote AS vote, f.created_at AS created_at, t.question AS question, substr(t.answer, 1, 160) AS answer FROM answer_feedback f LEFT JOIN ask_turns t ON t.id = f.intent_id WHERE f.created_at >= ? ORDER BY f.created_at DESC LIMIT 50"
  )
    .bind(sinceIso)
    .all();
  const latest = ((rows && rows.results) || []).map((r) => ({
    intent_id: String(r.intent_id),
    vote: Number(r.vote) === 1 ? "up" : "down",
    created_at: String(r.created_at),
    question: r.question == null ? null : String(r.question),
    answer: r.answer == null ? null : String(r.answer).slice(0, 160),
  }));
  return { since: sinceIso, counts, latest };
}

// Called from the existing cron. Safe when the tables do not exist yet.
export async function cleanupAnswerUx(env, nowMs = Date.now()) {
  const cut = (days) => new Date(nowMs - days * 86400000).toISOString();
  try {
    await env.DB.prepare("DELETE FROM answer_details WHERE created_at < ?").bind(cut(DETAILS_TTL_DAYS)).run();
    await env.DB.prepare("DELETE FROM answer_feedback WHERE created_at < ?").bind(cut(FEEDBACK_TTL_DAYS)).run();
  } catch {}
}

export function newReqid() {
  return toHex(crypto.getRandomValues(new Uint8Array(4)));
}
