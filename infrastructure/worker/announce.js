// Pure helpers for Discord posts made by the Worker: the /start reply and POST /api/announce.
// No network, no D1. Channel and role ids are never written here; they come from the discord_roster config row.

export const DISCORD_CONTENT_MAX = 2000;
export const BUTTON_LABEL_MAX = 80;
export const BUTTON_URL_MAX = 512;

export function clampContent(text, max = DISCORD_CONTENT_MAX) {
  const s = typeof text === "string" ? text : "";
  return s.length > max ? s.slice(0, max) : s;
}

function isId(v) {
  return typeof v === "string" && /^[0-9]{5,25}$/.test(v);
}

// Name -> id lookup inside a roster object ("channels" or "roles"). Returns null for unknown names or malformed ids.
export function lookupRosterId(roster, field, key) {
  const map = roster && roster[field];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(map, key)) return null;
  return isId(map[key]) ? map[key] : null;
}

// No mentions at all by default; exactly one role when a role id is given.
export function buildAllowedMentions(roleId) {
  return isId(roleId) ? { parse: [], roles: [roleId] } : { parse: [] };
}

// Link buttons must be https. Returns { ok: true, url, label } or { ok: false, error }.
export function validateButton(label, url) {
  const l = typeof label === "string" ? label.trim() : "";
  if (!l) return { ok: false, error: "button_label is required with button_url" };
  if (typeof url !== "string" || !url || url.length > BUTTON_URL_MAX) return { ok: false, error: "button_url must be an https URL" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "button_url must be an https URL" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "button_url must be an https URL" };
  return { ok: true, url: parsed.href, label: l.slice(0, BUTTON_LABEL_MAX) };
}

// One action row (type 1) holding one link button (type 2, style 5).
export function buildLinkButtonRow(label, url) {
  const v = validateButton(label, url);
  if (!v.ok) return null;
  return { type: 1, components: [{ type: 2, style: 5, label: v.label, url: v.url }] };
}

// Request body for POST /channels/<id>/messages. Returns { ok: true, body } or { ok: false, error }.
export function buildAnnounceBody({ text, roleId, buttonLabel, buttonUrl } = {}) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "text is required" };
  const body = {
    content: clampContent(isId(roleId) ? `<@&${roleId}> ${text}` : text),
    allowed_mentions: buildAllowedMentions(roleId),
  };
  if (buttonLabel !== undefined || buttonUrl !== undefined) {
    const v = validateButton(buttonLabel, buttonUrl);
    if (!v.ok) return v;
    body.components = [buildLinkButtonRow(v.label, v.url)];
  }
  return { ok: true, body };
}

// Ephemeral /start reply: four plain lines and a link button.
export function buildStartReply(siteUrl = "https://leeroy.party/") {
  const lines = [
    "Leeroy Board is the party's shared board for WoW: Forever.",
    "It keeps your character sheet, the build and the launch-night plan in one place, so nobody has to ask twice.",
    "Everything you post in Discord, forms, threads and votes, shows up there too.",
    siteUrl,
  ];
  return {
    content: lines.join("\n"),
    flags: 64,
    components: [buildLinkButtonRow("Open the board", siteUrl)],
  };
}
