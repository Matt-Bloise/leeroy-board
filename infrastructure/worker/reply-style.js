// Leeroy's Discord reply style: one look for the sign-up card, the party board, the answer buttons and the /page, /tooltip and /map cards.
// The rules in words are docs/discord-reply-style.md; this file is the same rules in code. Pure: no I/O, no D1, no network.
// Behind REPLY_STYLE, an optional [vars] flag that is not declared in wrangler.toml: absent, or anything but the word "on", means off. With it off no
// styler here runs on a live path, so every reply is byte for byte what it was (tests/unit/reply-style.test.mjs).
//
// Every styler starts from the body the existing renderer built and changes presentation only: colour, the author line, the title, the footer and its
// timestamp, the button rows and their colours. Names, fields, custom ids and links are the renderer's. A styler that throws returns the body it was given.
// Picture cards: an embed's `image` is never set, changed or removed here. When an embed carries one, the thumbnail is left off (one picture per card).
// Discord limits (Embed object limits, https://discord.com/developers/docs/resources/message#embed-object-embed-limits; Components reference):
// title 256, description 4096, 25 fields, field name 256, field value 1024, footer 2048, author 256, and 6000 characters across title, description,
// author name, field names and values and footer text; 5 rows of at most 5 buttons, label 80, custom_id 100.
import { legacyOn } from "./flags.js";
import { MAP_PLAN_PLACES } from "./map-plan.js";

export const REPLY_STYLE_FLAG = "REPLY_STYLE";
// Only the word "on" (any case, trimmed) turns it on: legacyOn, like GROUP_MEMORY and GAME_FACTS_READ.
export const replyStyleOn = (env) => legacyOn(env, REPLY_STYLE_FLAG);

// Rule 2: one colour per kind of card, taken from the board itself.
export const REPLY_COLORS = Object.freeze({
  leeroy: 0xffd100, // WoW UI gold: library replies (/page, /tooltip), the colour /countdown, /dates and /library already use
  party: 0x8fc97a, // the board's Sign-ups tile (--ok, css/board.css): the sign-up card and the party board
  atlas: 0xb5471f, // the Atlas route-plan colour (--atlas-plan, css): /map
});

export const DISCORD = Object.freeze({ title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, total: 6000, rows: 5, perRow: 5, label: 80, customId: 100, url: 512 });
// House limits for the text this file writes or picks (inside Discord's): a title that fits one phone line, a short blurb, short inline values.
export const HOUSE = Object.freeze({ title: 80, category: 30, blurb: 300, inline: 24, facts: 5 });
// A timestamp further ahead than this is not shown: it would print a future time for a change that has not happened.
export const STAMP_AHEAD_MS = 10 * 60 * 1000;

// Board images Discord may show (Pages serves them; https only). The author line carries the shelf's icon.
export const ICONS = Object.freeze({ signups: "img/icons/tab-signups.png", party: "img/icons/tab-five.png", library: "img/icons/tab-library.png", atlas: "img/map/town.png" });
export const LINK_LABEL = "Open on the board";
export const ATLAS_LINK_LABEL = "Open in the Atlas";
const NO_MENTIONS = Object.freeze({ parse: [] });

// ---- text --------------------------------------------------------------------------------------------------------------------
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const BLANK_NAME = "\u200b"; // Discord's blank field name (the party board's continuation fields use it)
const text = (v) => (typeof v === "string" ? v : (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" ? String(v) : "");

// Cut to `max` UTF-16 units (what String.length counts, never less than what Discord counts), on a whole character, ending with "…" when cut.
// A lone surrogate (an emoji cut in half upstream) becomes U+FFFD so the JSON stays valid Unicode. Nothing else is changed.
export function clip(value, max) {
  const s = text(value).replace(LONE_SURROGATE, "\ufffd");
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}
// A one-line slot (title, author line, footer, field name): control, zero-width and direction characters become spaces, never nothing, so two
// pieces are never joined into a new word or number; whitespace collapsed.
export const oneLine = (value, max) => clip(text(value).replace(CONTROL, " ").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim(), max);
const blank = (s) => !text(s).trim();

// "class_guides" -> "Class guides"
const label = (raw, max) => {
  const s = oneLine(text(raw).replace(/[-_]+/g, " "), max);
  return s ? s[0].toUpperCase() + s.slice(1) : "";
};

// ---- urls and stamps ---------------------------------------------------------------------------------------------------------
export function httpsUrl(u, max = DISCORD.url) {
  if (typeof u !== "string" || !u || u.length > max || /\s/.test(u)) return null;
  let p;
  try { p = new URL(u); } catch { return null; }
  return p.protocol === "https:" && !p.username && !p.password ? u : null;
}
// The board's base URL for links and icons: https, no query or fragment, trailing slashes removed. "" when unusable.
export function boardBase(url) {
  const b = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
  return /^https:\/\/[^\s?#]+$/.test(b) && httpsUrl(b) ? b : "";
}
const icon = (base, path) => (base ? `${base}/${path}` : "");
const author = (name, base, path) => ({ name, ...(icon(base, path) ? { icon_url: icon(base, path) } : {}) });

// An ISO stamp WITH a zone (Z or an offset) that names a real calendar time, not before 2000 and not more than STAMP_AHEAD_MS ahead, as Discord's
// embed timestamp (shown in each reader's own time zone). Anything else is null: a zone-less stamp, an epoch number, a junk string or an impossible
// date such as February 30 is never guessed (the fields are checked here, not left to Date.parse, which rolls February 30 over to March 2).
const ISO_ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i;
export function embedTimestamp(value, now = Date.now()) {
  const m = typeof value === "string" ? ISO_ZONED.exec(value) : null;
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Math.floor(Number(`0.${m[7]}`) * 1000);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (m[8].toUpperCase() !== "Z") {
    const [oh, om] = [Number(m[10]), Number(m[11])];
    if (oh > 14 || om > 59) return null;
    offset = (m[9] === "-" ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  const t = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset;
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || !Number.isFinite(now) || t > now + STAMP_AHEAD_MS) return null;
  return new Date(t).toISOString();
}

// ---- embeds and buttons: the last step for every styled reply ------------------------------------------------------------------
// Characters Discord counts toward its 6000 budget.
export function embedChars(e) {
  const fields = e && Array.isArray(e.fields) ? e.fields : [];
  return text(e && e.title).length + text(e && e.description).length + text(e && e.author && e.author.name).length +
    text(e && e.footer && e.footer.text).length + fields.reduce((n, f) => n + text(f && f.name).length + text(f && f.value).length, 0);
}

// Fit one embed to Discord's rules. Text it did not write (the description, field values) is never changed: it is only cut to its limit (whole
// characters, "…"), a half character is repaired, and an empty value becomes "—". One-line slots are made one line (oneLine).
// Keeps every key it does not know (an `image` from picture cards, a `provider`), so it composes with other changes.
// `yields`: decoration that gives way, in order, before any fact is cut when the embed is over 6000 characters in all.
export function finishEmbed(input, { now = Date.now(), yields = ["author"] } = {}) {
  const e = { ...(input && typeof input === "object" ? input : {}) };
  const set = (key, value) => { if (value) e[key] = value; else delete e[key]; };
  if ("title" in e) set("title", oneLine(e.title, DISCORD.title));
  if ("description" in e) set("description", blank(e.description) ? null : clip(e.description, DISCORD.description));
  if ("url" in e) set("url", httpsUrl(e.url));
  if ("color" in e && !(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff)) delete e.color;
  if ("author" in e) {
    const name = oneLine(e.author && e.author.name, DISCORD.author);
    set("author", name ? { name, ...(httpsUrl(e.author.icon_url) ? { icon_url: e.author.icon_url } : {}), ...(httpsUrl(e.author.url) ? { url: e.author.url } : {}) } : null);
  }
  if ("footer" in e) {
    const ft = oneLine(e.footer && e.footer.text, DISCORD.footer);
    set("footer", ft ? { text: ft, ...(httpsUrl(e.footer.icon_url) ? { icon_url: e.footer.icon_url } : {}) } : null);
  }
  if ("timestamp" in e) set("timestamp", embedTimestamp(e.timestamp, now));
  // One picture per card: a picture card's image wins over the thumbnail. The image itself is not touched.
  if ("thumbnail" in e) set("thumbnail", !e.image && e.thumbnail && httpsUrl(e.thumbnail.url) ? { url: e.thumbnail.url } : null);
  if ("fields" in e) {
    e.fields = (Array.isArray(e.fields) ? e.fields : [])
      .filter((f) => f && typeof f === "object" && !Array.isArray(f))
      .map((f) => ({ name: f.name === BLANK_NAME ? BLANK_NAME : oneLine(f.name, DISCORD.fieldName) || BLANK_NAME, value: blank(f.value) ? "—" : clip(f.value, DISCORD.fieldValue), inline: f.inline === true }))
      .slice(0, DISCORD.fields);
  }
  // Over 6000 in all: decoration gives way first; then field values are trimmed from the last field back, then the description; trailing fields
  // are dropped only if that is still not enough.
  const over = () => embedChars(e) - DISCORD.total;
  for (const key of Array.isArray(yields) ? yields : []) if (over() > 0 && (key === "author" || key === "footer")) delete e[key];
  for (let i = (e.fields || []).length - 1; over() > 0 && i >= 0; i--) {
    const f = e.fields[i];
    e.fields[i] = { ...f, value: clip(f.value, Math.max(1, f.value.length - over())) };
  }
  if (over() > 0 && e.description) e.description = clip(e.description, Math.max(1, e.description.length - over()));
  while (over() > 0 && e.fields && e.fields.length) e.fields.pop();
  return e;
}

// Buttons: valid shapes only (a link button is style 5 with an https url and no custom_id, every other button has a custom_id of at most 100 and
// style 1 to 4), unique custom ids, link buttons last in their row, at most 5 per row and 5 rows. A label is only cut to 80, never otherwise
// changed; a button with an empty label is left out (Discord would refuse the whole message). Unknown keys on a button (an emoji) are kept.
// A row that holds anything but buttons (a select menu) is passed through as it is.
export function finishComponents(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.type !== 1 || !Array.isArray(row.components)) continue;
    if (row.components.some((c) => c && typeof c === "object" && c.type !== 2)) {
      out.push(row);
      continue;
    }
    const keep = [];
    for (const c of row.components) {
      if (!c || typeof c !== "object" || blank(c.label)) continue;
      const lab = clip(c.label, DISCORD.label);
      if (c.style === 5 || c.url !== undefined) {
        const url = httpsUrl(c.url);
        const { custom_id: _linkHasNoId, ...rest } = c;
        if (url) keep.push({ ...rest, style: 5, label: lab, url });
        continue;
      }
      if (typeof c.custom_id !== "string" || !c.custom_id || c.custom_id.length > DISCORD.customId || seen.has(c.custom_id)) continue;
      seen.add(c.custom_id);
      keep.push({ ...c, style: [1, 2, 3, 4].includes(c.style) ? c.style : 2, label: lab });
    }
    const ordered = [...keep.filter((c) => c.style !== 5), ...keep.filter((c) => c.style === 5)];
    for (let i = 0; i < ordered.length; i += DISCORD.perRow) out.push({ type: 1, components: ordered.slice(i, i + DISCORD.perRow) });
  }
  return out.slice(0, DISCORD.rows);
}

function safely(fallback, surface, build) {
  try {
    return build();
  } catch (err) {
    // A fixed tag and the error name only: never a value from the card.
    console.warn(JSON.stringify({ evt: "reply_style_fallback", surface, err: String((err && err.name) || "Error").slice(0, 24) }));
    return fallback;
  }
}
const firstEmbed = (body) => {
  const e = body && Array.isArray(body.embeds) ? body.embeds[0] : null;
  if (!e || typeof e !== "object") throw new TypeError("no embed");
  return e;
};

// ---- the pinned cards (cards.js) -----------------------------------------------------------------------------------------------
// Rule 6: one row per question, in this order; green for yes and in, red for no and out, grey for every other choice.
const SIGNUP_ROWS = ["rsvp", "meet", "when", "pack"];
const SIGNUP_COLOURS = new Map([["signup:rsvp:in", 3], ["signup:rsvp:out", 4]]);
function signupRows(rows) {
  const buttons = (Array.isArray(rows) ? rows : []).flatMap((r) => (r && Array.isArray(r.components) ? r.components : []));
  const groups = new Map(SIGNUP_ROWS.map((k) => [k, []]));
  const other = [];
  for (const b of buttons) {
    const id = b && typeof b.custom_id === "string" ? b.custom_id : "";
    const m = /^signup:([a-z]+):/.exec(id);
    const group = m && groups.has(m[1]) ? groups.get(m[1]) : other;
    group.push(b && b.style !== 5 && id ? { ...b, style: SIGNUP_COLOURS.get(id) || 2 } : b);
  }
  const regrouped = [...groups.values(), other].filter((g) => g.length).map((g) => ({ type: 1, components: g }));
  // The classic card fits in 3 rows; regrouped it needs 4. If a future change adds so many buttons that it would not fit, keep its rows as they are.
  if (regrouped.length > DISCORD.rows || regrouped.some((r) => r.components.length > DISCORD.perRow)) return finishComponents(rows);
  return finishComponents(regrouped);
}
const boardLink = (state) => httpsUrl(state && state.boardUrl) || "";
const cardBase = (state) => boardBase(state && state.siteBase);
// The text the style writes on the pinned cards. These, the card's own board link and time, and the board's icons are all it adds.
export const SIGNUP_LOOK = Object.freeze({ author: "Sign-ups", title: "Who is coming", footer: "The Living Board" });
export const BOARD_LOOK = Object.freeze({ author: "The party", title: "Party board", footer: "The Living Board" });
// Characters the styled party board adds to what renderBoardCard budgets for (its author line and footer). cards.js reserves them when it fits
// people into the 6000, so the style never has to cut a person's line; the "+N more on the board" note keeps its own reserve there (OMIT_NOTE_MAX).
export const BOARD_STYLE_RESERVE = BOARD_LOOK.author.length + BOARD_LOOK.footer.length;

// The sign-up card (cards.js renderSignupCard). Fields, names, description and custom ids are the renderer's. At the 6000 limit the author line
// and the footer text give way before a name list is cut.
export function styleSignupCard(body, state, { now = Date.now() } = {}) {
  return safely(body, "signups", () => {
    const e = firstEmbed(body);
    const stamp = embedTimestamp(state && state.updated, now);
    const embed = {
      ...e,
      author: author(SIGNUP_LOOK.author, cardBase(state), ICONS.signups),
      title: SIGNUP_LOOK.title,
      url: boardLink(state),
      color: REPLY_COLORS.party,
      footer: { text: SIGNUP_LOOK.footer },
      timestamp: stamp || "",
    };
    return { ...body, embeds: [finishEmbed(embed, { now, yields: ["author", "footer"] }), ...body.embeds.slice(1)], components: signupRows(body.components), allowed_mentions: NO_MENTIONS };
  });
}

// The party board card (cards.js renderBoardCard). `omitted` is the renderer's count of people that did not fit.
export function styleBoardCard(body, state, { omitted = 0, now = Date.now() } = {}) {
  return safely(body, "board", () => {
    const e = firstEmbed(body);
    const stamp = embedTimestamp(state && state.updated, now);
    const more = Number.isInteger(omitted) && omitted > 0 ? ` · +${omitted} more on the board` : "";
    const embed = {
      ...e,
      author: author(BOARD_LOOK.author, cardBase(state), ICONS.party),
      title: BOARD_LOOK.title,
      url: boardLink(state),
      color: REPLY_COLORS.party,
      footer: { text: `${BOARD_LOOK.footer}${more}` },
      timestamp: stamp || "",
    };
    const rows = (Array.isArray(body.components) ? body.components : []).map((r) => ({
      ...r,
      components: (r && Array.isArray(r.components) ? r.components : []).map((c) => (c && c.style === 5 ? { ...c, label: LINK_LABEL } : c)),
    }));
    return { ...body, embeds: [finishEmbed(embed, { now }), ...body.embeds.slice(1)], components: finishComponents(rows), allowed_mentions: NO_MENTIONS };
  });
}

// ---- /ask (answer-ux.js) -------------------------------------------------------------------------------------------------------
// An answer stays a message (rule 1); its buttons follow rule 6: the first detail button (More, else Sources) is the one blurple next step,
// Helpful and Off stay grey. Rows, labels and custom ids are the builder's.
export function styleAnswerButtons(rows) {
  return safely(rows, "answer", () => {
    const out = rows.map((r) => ({ ...r, components: r.components.map((c) => ({ ...c })) }));
    const detail = out.find((r) => r.components.some((c) => /^leeroy:(more|sources):/.test(String(c.custom_id || ""))));
    if (detail) detail.components[0] = { ...detail.components[0], style: 1 };
    return out;
  });
}

// ---- /page, /tooltip and /map --------------------------------------------------------------------------------------------------
// Cards built from what discord.js already has for each command. Not wired yet: discord.js builds these replies inline today, and the wiring is a
// follow-up (docs/discord-reply-style.md, "Applied now, and what waits"). Each returns { embeds, components, allowed_mentions }; the caller adds
// `flags: 64` for an ephemeral reply, exactly as today.
const PAGE_ID = /^[A-Za-z0-9._~\/-]{1,120}$/;
const pageLink = (base, id) => (base && typeof id === "string" && PAGE_ID.test(id) ? httpsUrl(`${base}/#lib.${id}`) || "" : "");
const linkRow = (url, lab = LINK_LABEL) => (url ? [{ type: 1, components: [{ type: 2, style: 5, label: lab, url }] }] : []);
const card = (embed, rows, now) => ({ embeds: [finishEmbed(embed, { now })], components: finishComponents(rows), allowed_mentions: NO_MENTIONS });

// /page: `row` is the lib_pages row (id, category, title, blurb), `facts` the parsed facts_json (rows with a key; at most 5 are shown, as today).
export function pageCard({ row, facts = [], boardUrl, now = Date.now() } = {}) {
  const base = boardBase(boardUrl);
  const url = pageLink(base, row && row.id);
  const shown = (Array.isArray(facts) ? facts : []).filter((f) => f && typeof f === "object" && !Array.isArray(f) && text(f.key)).slice(0, HOUSE.facts);
  // A fact prints as today's /page prints it (the value as stored, only cut to Discord's limit); its key is a field name, so one line.
  const fields = shown.map((f) => {
    const value = blank(f.value) ? "—" : clip(f.value, DISCORD.fieldValue);
    return { name: oneLine(f.key, DISCORD.fieldName), value, inline: value.length <= HOUSE.inline && !value.includes("\n") };
  });
  // The page's own blurb, under the title (today's /page shows it only when there are no facts).
  const blurb = blank(row && row.blurb) ? "" : clip(row.blurb, HOUSE.blurb);
  const shelf = label(row && row.category, HOUSE.category);
  return card({
    author: author(shelf ? `Library · ${shelf}` : "Library", base, ICONS.library),
    title: oneLine(row && row.title, HOUSE.title) || "Library page",
    url,
    description: blurb || (fields.length ? "" : "Open the page for every verified fact."),
    color: REPLY_COLORS.leeroy,
    fields,
    footer: { text: "Verified library" },
  }, linkRow(url), now);
}

// /tooltip: `name` is what the person typed, `row` the matching lib_pages row (id, category, title), `verified` whether the page's title or an
// alias names it (discord.js tooltipNamedBy), as today's "Verified in" / "Mentioned on".
export function tooltipCard({ name, row, verified = false, boardUrl, now = Date.now() } = {}) {
  const base = boardBase(boardUrl);
  const url = pageLink(base, row && row.id);
  const page = oneLine(row && row.title, HOUSE.title).replace(/\*/g, "") || "a library page";
  const shelf = label(row && row.category, HOUSE.category);
  return card({
    author: author("Library · Tooltip", base, ICONS.library),
    title: oneLine(name, HOUSE.title) || page,
    url,
    description: `${verified === true ? "Verified in" : "Mentioned on"} **${page}**${shelf ? ` (${shelf})` : ""}.`,
    color: REPLY_COLORS.leeroy,
    footer: { text: "Verified library" },
  }, linkRow(url), now);
}

// /map: `place` is the cleaned place slug ([a-z0-9_-], at most 40), `plan` the resolved route plan ({ value, name }) or null, as in discord.js.
// The link is the one /map sends today: <board>/#atlas.plan.<value>, <board>/#atlas.<place> or <board>/#atlas.
const SLUG = /^[a-z0-9_-]{1,40}$/;
const placeName = (slug) => {
  const known = MAP_PLAN_PLACES.find((p) => p.value === slug);
  return known ? known.name : slug.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
};
export function mapCard({ place = "", plan = null, boardUrl, now = Date.now() } = {}) {
  const base = boardBase(boardUrl);
  const planValue = plan && typeof plan.value === "string" && SLUG.test(plan.value) ? plan.value : "";
  const placeSlug = typeof place === "string" && SLUG.test(place) ? place : "";
  const hash = planValue ? `#atlas.plan.${planValue}` : placeSlug ? `#atlas.${placeSlug}` : "#atlas";
  const url = base ? httpsUrl(`${base}/${hash}`) || "" : "";
  const title = planValue ? `Route plan: ${oneLine(plan.name, HOUSE.title) || placeName(planValue)}` : placeSlug ? placeName(placeSlug) : "Azeroth Atlas";
  return card({
    author: author("Atlas", base, ICONS.atlas),
    title: oneLine(title, HOUSE.title),
    url,
    description: "Charted for you on the Living Board.",
    color: REPLY_COLORS.atlas,
    footer: { text: "The Living Board atlas" },
  }, linkRow(url, ATLAS_LINK_LABEL), now);
}
