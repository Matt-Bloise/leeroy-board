// Pure helpers that keep the Worker's Discord traffic safe. No network, no D1, no secrets.

export const DISCORD_MAX_AGE_SECONDS = 300;
export const DISCORD_CONTENT_LIMIT = 2000;
export const ALLOWED_MENTIONS_NONE = Object.freeze({ parse: [] });

// True when a Discord X-Signature-Timestamp (seconds since epoch, as a string) is within maxAge
// seconds of nowSeconds. Rejects non-numeric input, and timestamps further in the future than
// maxAge (a far-future timestamp would otherwise stay replayable for a long time).
export function isFreshTimestamp(ts, nowSeconds, maxAge = DISCORD_MAX_AGE_SECONDS) {
  if (typeof ts !== "string" && typeof ts !== "number") return false;
  const text = String(ts).trim();
  if (!/^\d{1,15}$/.test(text)) return false;
  const t = Number(text);
  if (!Number.isFinite(t) || !Number.isFinite(nowSeconds)) return false;
  return Math.abs(nowSeconds - t) <= maxAge;
}

// Truncate to the Discord message limit, ending with an ellipsis character when cut.
export function clampContent(text, limit = DISCORD_CONTENT_LIMIT) {
  const s = text === undefined || text === null ? "" : String(text);
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1) + "…";
}

// Harden an interaction response object: no mention parsing, content clamped.
// Only message-bearing responses (type 4 and 7, or a deferred type 5 with data) are touched.
export function hardenInteractionBody(body) {
  if (!body || typeof body !== "object" || ![4, 5, 7].includes(body.type)) return body;
  const data = body.data && typeof body.data === "object" ? body.data : {};
  const next = { ...data, allowed_mentions: ALLOWED_MENTIONS_NONE };
  if (typeof next.content === "string") next.content = clampContent(next.content);
  return { ...body, data: next };
}
