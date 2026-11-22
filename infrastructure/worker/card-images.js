// Picture cards in Leeroy's Discord replies (docs/runbooks/card-images.md). Behind the Flagship flag CARD_IMAGES, default off.
// The pictures are drawn in CI by tools/cards (one pinned Chromium) and served by Pages as immutable files, /cards/<kind>/<name>-<pixel hash>.png:
// the name changes whenever the pixels change. This module only decides whether a reply carries one. It never draws, decodes or reads D1.
//
// A reply carries a card only when all of these hold:
//   1. the bundled manifest (card-manifest.json, written by tools/cards/render.mjs --write) has a card for the key;
//   2. the flag is on;
//   3. where the Worker has the data the reply shows (a /page row, the pinned sign-up card's buttons), the card's model hash equals the model of
//      THAT data, so a picture is never older than the text beside it (D1 pages change after a deploy: the cron and wiki approvals write them);
//   4. BOARD_PUBLIC_URL is an https origin and the file answers 200 image/png there (a HEAD, remembered per isolate: a hit for ten minutes, a
//      miss for one). The Worker deploys before Pages, and Pages can be rolled back alone, so this keeps a reply from naming a file Pages does
//      not serve (after a Pages-only rollback, within ten minutes). The HEAD carries a one-off query (?probe=...), which Pages ignores when it
//      looks up the file but every cache keys on: a 404 seen before Pages has the file can never be cached under the card's real URL.
// Anything else, any error included: no card, and the reply is exactly what it was without this module.
import MANIFEST from "./card-manifest.json" with { type: "json" };
import { flagOn } from "./flags.js";
import { modelHash, pageKey, tooltipKey, mapKey, signupKey, MAP_OVERVIEW, pageModel, signupModel } from "./card-models.js";

export const PUBLISHED_TIMEOUT_MS = 600;
export const HIT_TTL_MS = 10 * 60 * 1000;
export const MISS_TTL_MS = 60 * 1000;
const MAX_REMEMBERED = 512;
const CARD_FILE = /^cards\/[a-z]+\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}\.png$/;
const published = new Map(); // url -> { ok, at }

export const _forgetPublished = () => published.clear(); // tests only

/** The https origin cards are served from (BOARD_PUBLIC_URL: https://leeroy.party, or the PR preview's Pages origin), or null. */
export function cardSiteBase(env) {
  const base = String((env && env.BOARD_PUBLIC_URL) || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i.test(base) ? base : null;
}

/** True when `url` answers 200 with a PNG. Never throws; at most one HEAD per URL per minute (per ten minutes once it answered).
 *  `timeoutMs`: how long to wait (default PUBLISHED_TIMEOUT_MS, for replies on Discord's 3-second path). `retryMiss`: ignore a remembered miss and ask again
 *  (for the deferred redraw of the pinned card, which is rare and not time-critical: a miss there would take the picture off the card until the next redraw). */
export async function isPublished(url, { fetchImpl = fetch, now = Date.now(), timeoutMs = PUBLISHED_TIMEOUT_MS, retryMiss = false } = {}) {
  const seen = published.get(url);
  if (seen && now - seen.at < (seen.ok ? HIT_TTL_MS : MISS_TTL_MS) && !(retryMiss && !seen.ok)) return seen.ok;
  let ok = false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const probe = `${url}?probe=${crypto.randomUUID()}`;
    const res = await fetchImpl(probe, { method: "HEAD", redirect: "manual", signal: ctl.signal });
    ok = res.status === 200 && /^image\/png\b/i.test((res.headers && res.headers.get("content-type")) || "");
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  published.delete(url);
  if (published.size >= MAX_REMEMBERED) published.delete(published.keys().next().value);
  published.set(url, { ok, at: now });
  return ok;
}

/** The card URL for a manifest key, or null. `model`: the model of what the reply shows, when the Worker has it. Never throws. */
export async function cardImageUrl(env, key, { model, fetchImpl = fetch, manifest = MANIFEST, now, timeoutMs, retryMiss } = {}) {
  try {
    const cards = manifest && manifest.cards;
    const entry = cards && typeof key === "string" && Object.hasOwn(cards, key) ? cards[key] : null;
    if (!entry || typeof entry.file !== "string" || !CARD_FILE.test(entry.file)) return null;
    if (!(await flagOn(env, "CARD_IMAGES"))) return null;
    if (model !== undefined && (await modelHash(model)) !== entry.model) return null;
    const base = cardSiteBase(env);
    if (!base) return null;
    const url = `${base}/${entry.file}`;
    return (await isPublished(url, { fetchImpl, now: now === undefined ? Date.now() : now, timeoutMs, retryMiss })) ? url : null;
  } catch {
    return null;
  }
}

/** /page: the card of the lib_pages row the reply is about to show ({ id, category, title, blurb, facts_json }). */
export const pageCardUrl = (env, row, opts = {}) => cardImageUrl(env, pageKey(row && row.id), { ...opts, model: pageModel(row) });

/** /tooltip: the card of a named spell or item, by the name asked for (case and spacing do not matter). */
export const tooltipCardUrl = (env, name, opts = {}) => cardImageUrl(env, tooltipKey(name), opts);

/** /map: the key for the handler's slugged `place` or resolved `plan` value; neither means the whole-atlas card. */
export function mapCardKey(place, plan, manifest = MANIFEST) {
  const raw = String(plan || place || "");
  if (!raw) return mapKey(MAP_OVERVIEW);
  const aliases = (manifest && manifest.aliases) || {};
  return mapKey(Object.hasOwn(aliases, raw) ? aliases[raw] : raw);
}
export const mapCardUrl = (env, place, plan, opts = {}) => cardImageUrl(env, mapCardKey(place, plan, opts.manifest), opts);

/** The pinned sign-up card (cards.js loadCardState): the picture of its own buttons (answers, meeting points, arrival times as that card shows them). */
export async function signupCardUrl(env, answers, meet, when, opts = {}) {
  try {
    const model = signupModel(answers, meet, when);
    return await cardImageUrl(env, signupKey(await modelHash(model)), { ...opts, model });
  } catch {
    return null;
  }
}
