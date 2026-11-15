// Which Discord sign-ups are this week's. The signups document keeps every answer ever given, and its tallies count them all, so after
// launch night the board kept showing those answers as if they were for the next play night. A sign-up counts as current when its own
// entry.updated is a full ISO time within the last 7 days and not in the future (the same idea as entryIsCurrent in the weekly post,
// infrastructure/worker/weekly-post.js). 7 days rolling, because the board has no public play-night schedule. The document-level
// `updated` is never used for this: any click by anyone moves it. Pure functions, no DOM; tests/unit/signups-week.test.mjs runs this file.
// Known limit (kept on purpose, the weekly post has the same one): an entry has one `updated` for all its fields, so a pack, meeting-point or
// time click this week re-stamps the entry and its older RSVP counts again. Telling them apart needs a stamp per field, a separate change.
(() => {
"use strict";
const FRESH_MS = 7 * 24 * 3600 * 1000, SKEW_MS = 60 * 1000, NIGHT_MS = 12 * 3600 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const RSVP_KEYS = ["in", "maybe", "late", "out"], SIGNED = ["in", "late", "maybe"], WHEN_KEYS = ["6pm", "8pm", "later"];
const stampOf = (e) => { const raw = e && e.updated; if (typeof raw !== "string" || !ISO_RE.test(raw)) return null; const at = Date.parse(raw); return Number.isFinite(at) ? at : null; };
function isCurrent(entry, now) {
  const at = stampOf(entry);
  return at !== null && Number.isFinite(now) && at > now - FRESH_MS && at <= now + SKEW_MS;
}
// The RSVP and time-slot tallies over the given entries, in the server's shape ({ key: { count, names } }). Pack and meeting point are not here:
// they are launch-night questions and keep the server's tallies.
const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k); // never "constructor" or "__proto__"
// the board's cleanName (js/board.js): leading and trailing marks that are not letters or digits go, so "=Ada=" and "Ada" are one person
const who = (e) => { const n = String(e.name == null ? "" : e.name); return (n.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || n).toLowerCase(); };
function tallies(entries, whenKeys) {
  const slot = () => ({ count: 0, names: [] });
  const keys = Array.isArray(whenKeys) ? whenKeys.filter((k) => typeof k === "string") : [];
  const rsvp = Object.fromEntries(RSVP_KEYS.map((k) => [k, slot()])), when = Object.fromEntries((keys.length ? keys : WHEN_KEYS).map((k) => [k, slot()]));
  for (const e of entries) {
    const name = (e && e.name) || "Someone";
    if (e && own(rsvp, e.rsvp)) { rsvp[e.rsvp].count++; rsvp[e.rsvp].names.push(name); }
    if (e && own(when, e.when)) { when[e.when].count++; when[e.when].names.push(name); }
  }
  return { rsvp, when };
}
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
// What the board says when no sign-up is current: plain words, when the last answers were, and how to answer.
function emptyWeek(last, launchMs) {
  const at = Number.isFinite(last) ? DAY.format(new Date(last)) : null;
  const forLaunch = at && Number.isFinite(launchMs) && last <= launchMs + NIGHT_MS;
  return {
    nobody: "Nobody has answered for this week yet.",
    last: at ? `Last answers: ${at}${forLaunch ? ", for launch night" : ""}.` : "Nobody has answered the card yet.",
    how: "To answer, use the Sign-ups card in Discord, or type /signup in #wow-forever.",
  };
}
// The week as the board shows it: current entries (counted), earlier ones (listed as from an earlier week, never counted), recomputed tallies,
// the newest stamp among all entries, and the empty-week words when nothing is current.
function week(S, now, launchMs) {
  const all = S && Array.isArray(S.entries) ? S.entries.filter((e) => e && typeof e === "object") : [];
  const current = all.filter((e) => isCurrent(e, now)), now_ = new Set(current.map(who));
  // earlier: an older RSVP from someone with no entry this week (a person with an old and a new entry shows once, as this week's)
  const earlier = all.filter((e) => !current.includes(e) && RSVP_KEYS.includes(e.rsvp) && !now_.has(who(e)));
  // the last answers: the newest stamp on an entry that carries an RSVP (a pack-only click is not an answer, so it does not move this)
  const stamps = all.filter((e) => RSVP_KEYS.includes(e.rsvp)).map(stampOf).filter((x) => x !== null && x <= now + SKEW_MS), last = stamps.length ? Math.max(...stamps) : null;
  const t = tallies(current, S && S.options && S.options.when);
  const total = current.filter((e) => RSVP_KEYS.includes(e.rsvp)).length; // answers this week; a current click on pack or meeting point alone is not one
  const signed = current.filter((e) => SIGNED.includes(e.rsvp)).length; // "out" answered but is not signed up
  return { current, earlier, rsvp: t.rsvp, when: t.when, total, signed, last, empty: total ? null : emptyWeek(last, launchMs) };
}
// A document arriving later (a reload, a pushed update) must not replace a newer one already shown: true when `next` is stamped before `cur`.
// Unknown or malformed stamps are not compared (the caller keeps its old behaviour and takes the new document).
function older(next, cur) {
  const a = stampOf(next), b = stampOf(cur);
  return a !== null && b !== null && a < b;
}
// Whether the board should take a sign-ups document and render it: not when it is older than the one in hand (a late socket message, a slow
// bootstrap after /state), and not when it is the same document again (the socket can send one document both as state and as data; the board
// renders it once).
function accept(next, cur) {
  if (!next || typeof next !== "object") return false;
  if (!cur || typeof cur !== "object") return true;
  if (older(next, cur)) return false;
  const a = stampOf(next), b = stampOf(cur);
  return !(a !== null && a === b && JSON.stringify(next.entries || null) === JSON.stringify(cur.entries || null));
}
window.BoardWeek = { FRESH_MS, isCurrent, tallies, emptyWeek, week, older, accept };
})();
