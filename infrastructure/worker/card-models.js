// Picture cards: what each card shows, as plain data (a "model"). The CI renderer (tools/cards/render.mjs) draws a PNG from a model, and the
// Worker (card-images.js) rebuilds the model of the /page row or the sign-up options it is about to answer with, and sends the picture only
// when the two models hash the same. A card is therefore never older than the text beside it. docs/runbooks/card-images.md.
//
// Pure: no I/O, no Date, no locale, no network. Runs unchanged in Node (tools/cards) and in the Worker. Every model is built with a fixed key
// order, so JSON.stringify(model) is canonical and the hash is the same on both sides.

export const CARD_MODEL_VERSION = 1;
export const PAGE_FACTS = 2;
const ELLIPSIS = "\u2026";

// Invisible and layout-breaking characters: C0 and C1 controls, soft hyphen, zero-width and bidi controls, line and paragraph separators, BOM.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Card text: NFC, invisible characters dropped, whitespace collapsed, at most `max` code points (cut on a word boundary, with an ellipsis). */
export function cardText(raw, max) {
  const s = String(raw === undefined || raw === null ? "" : raw).normalize("NFC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  const cps = [...s];
  if (cps.length <= max) return s;
  let cut = cps.slice(0, Math.max(1, max - 1)).join("");
  const sp = cut.lastIndexOf(" ");
  if (sp >= Math.floor(max * 0.6)) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.\-\u2013\u2014(]+$/, "") + ELLIPSIS;
}

/** A fact key ("druid.role", "mage.spellbook.trainer_prices") as a short label ("Role", "Trainer prices"). A last segment under 4 letters takes the one before it too. */
export function factLabel(key) {
  const parts = String(key === undefined || key === null ? "" : key).split(".").filter(Boolean);
  let words = parts.length ? parts[parts.length - 1] : "";
  if (words.replace(/[^a-z0-9]/gi, "").length < 4 && parts.length > 1) words = `${parts[parts.length - 2]} ${words}`;
  words = words.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return cardText(words.charAt(0).toUpperCase() + words.slice(1), 26);
}

// Hosts whose text may be stored only with its attribution shown (data/library-sources.json, storedText "attribution-required": CC BY-SA
// text that needs a credit, a link to the page and a link to the licence). A picture cannot carry those links, so a page card never draws
// a fact that cites one; the reply's text and the board still show it with its sources. tests/unit/card-images.test.mjs keeps this list
// equal to the sources file.
export const ATTRIBUTION_HOSTS = Object.freeze(["warcraft.wiki.gg"]);
const refHost = (ref) => {
  if (!ref || typeof ref !== "object") return "";
  if (typeof ref.host === "string" && ref.host) return ref.host.toLowerCase();
  const m = /^https?:\/\/([^/?#:]+)/i.exec(typeof ref.url === "string" ? ref.url : "");
  return m ? m[1].toLowerCase() : "";
};
export const needsAttribution = (fact) => Array.isArray(fact && fact.refs) && fact.refs.some((r) => ATTRIBUTION_HOSTS.some((h) => refHost(r) === h || refHost(r).endsWith(`.${h}`)));

// The facts the /page reply lists, in its own order (discord.js: facts_json parsed, entries without a key dropped).
function pageFacts(factsJson) {
  try {
    const parsed = JSON.parse(factsJson || "[]");
    return Array.isArray(parsed) ? parsed.filter((f) => f && f.key) : [];
  } catch {
    return [];
  }
}

/** The /page card, from a lib_pages row ({ id, category, title, blurb, facts_json }) or a repo page shaped the same way. */
export function pageModel(row) {
  const r = row || {};
  return {
    kind: "page",
    v: CARD_MODEL_VERSION,
    id: String(r.id === undefined || r.id === null ? "" : r.id),
    category: cardText(r.category, 32),
    title: cardText(r.title, 48),
    blurb: cardText(r.blurb, 230),
    facts: pageFacts(r.facts_json).filter((f) => !needsAttribution(f)).slice(0, PAGE_FACTS).map((f) => ({ label: factLabel(f.key), value: cardText(f.value, 140) })),
  };
}

/** The pinned sign-up card's picture: what its buttons say (the four answers, meeting points, arrival times), never who signed up.
 *  `answers`, `meet` and `when` are the labels and option lists the card's own buttons use (cards.js RSVP_BUTTON_LABELS, meetOptions, whenOptions). */
export function signupModel(answers, meet, when) {
  const list = (a, n, max) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => cardText(x, max)).filter(Boolean);
  return { kind: "signup", v: CARD_MODEL_VERSION, answers: list(answers, 4, 24), meet: list(meet, 2, 40), when: list(when, 5, 40) };
}

/** sha256 (lower-case hex) of the canonical JSON of a model. Web Crypto, so it is the same function in the Worker and in Node 22. */
export async function modelHash(model) {
  const bytes = new TextEncoder().encode(JSON.stringify(model));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Manifest keys (infrastructure/worker/card-manifest.json). The Worker looks a card up by key, then checks its model where it can.
const normName = (s) => String(s === undefined || s === null ? "" : s).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export const pageKey = (id) => `page:${String(id === undefined || id === null ? "" : id)}`;
export const tooltipKey = (name) => `tooltip:${normName(name)}`;
export const mapKey = (placeId) => `map:${String(placeId === undefined || placeId === null ? "" : placeId)}`;
export const MAP_OVERVIEW = "atlas";
export const signupKey = (hash) => `signup:${String(hash || "").slice(0, 12)}`;

/** A file-name slug: lower case a-z, 0-9 and single hyphens, at most 60 characters. */
export const cardSlug = (s) => normName(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "") || "card";
