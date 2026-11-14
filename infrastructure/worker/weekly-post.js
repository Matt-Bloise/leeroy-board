// Weekly board post (flag WEEKLY_POST, default off): once a week, a set time before play night, one quiet post in the sign-ups channel:
// who has signed up, which roles none of them has on the board, and one short library fact per signed-up build, each with its sources.
//
// Facts composed by code, never by a model: every sentence is a template filled from the public board documents (party, signups), or a
// library fact quoted exactly as the library wrote it, with its own sources. Nothing here calls an AI model. The post carries no date or
// time: those would come from the private schedule row and could contradict the sign-up card.
// Inputs are the PUBLIC documents only (the rows GET /api/data/party and /api/data/signups serve, and the library blobs), so a hidden sheet
// field, a Discord id or a private config row cannot reach the post. Names are the names the board shows.
//
// Pieces:
//   composeWeeklyPost(): pure. Documents in, { text, facts, skipped } out. Used by the runner and by tools/weekly-post-dry-run.mjs.
//   planWeeklyPost(): pure. Schedule, state and clock in, { due, playAt, postAt, week } out.
//   runWeeklyPost(): the executor. Reads nothing while the flag is off. Needs the admin config row `weekly_post` (PUT /api/config/weekly_post):
//     { weekday: 0-6 (UTC, 0 = Sunday), hour: 0-23 (UTC), minute?: 0-59, lead_hours?: 24-72 (default 24), channel?: id }
//   Runs on the 6-hourly cron. The noise budget holds posts during quiet hours (1 to 9 AM ET by default), so a tick can wait up to 18 hours;
//   a lead of at least 24 hours leaves room for that. One post per play week (state row `weekly_post_state`, claimed before the post and
//   released if the post fails).

import { RSVP_STATES, cleanName, discordRest, loadCards } from "./cards.js";
import { decidePost, noiseDay, readLedger, recordPost } from "./noise.js";
import { lookupRosterId } from "./announce.js";
import { loadConfigKey } from "./config.js";
import { flagOn } from "./flags.js";
import { ALLOWED_MENTIONS_NONE } from "./discord-safety.js";
import { validateWeeklyConfig, DEFAULT_LEAD_HOURS } from "./weekly-post-config.js";

export { validateWeeklyConfig, DEFAULT_LEAD_HOURS };

export const WEEKLY_CONFIG_KEY = "weekly_post";
export const WEEKLY_STATE_KEY = "weekly_post_state";
export const POST_MAX = 1900; // under Discord's 2000
export const TIP_MAX = 220; // a library fact longer than this is skipped, never cut (a cut fact can change its meaning)
export const TIP_MIN = 40; // shorter values are fragments ("16-point medal") that do not stand as a tip
export const MAX_SOURCES = 3;
export const SUPPRESS_NOTIFICATIONS = 4096; // a quiet post: it pings nobody and does not buzz phones
const WEEK_MS = 7 * 24 * 3600 * 1000;
const SIGNED = ["in", "late", "maybe"]; // "out" is not signed up
const COUNTED = ["in", "late"]; // a tentative sign-up is listed but does not cover a role
const STATE_WORD = { in: "in", late: "running late", maybe: "tentative" };
const ROLES = ["tank", "healer", "damage"];
const ROLE_LABEL = { tank: "tank", healer: "healer", damage: "damage dealer" };
const ROLE_WORDS = { tank: ["tank", "tanking", "threat"], healer: ["heal", "healer", "healing"], damage: ["damage", "dps"] };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const roleOf = (m) => { const r = String((m && m.role) || "").trim().toLowerCase(); return ROLES.includes(r) ? r : null; };

// Text from documents goes in as written, made inert: escapes stop formatting and masked links, a zero-width space after "<", "@" and "://"
// stops mentions, channel links, timestamps and link previews, and direction and zero-width characters are removed. allowed_mentions is empty too.
const ZW = "​";
export function plain(s) {
  return String(s == null ? "" : s)
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, "")
    .replace(/[\\*_~`|[\]]/g, (c) => `\\${c}`)
    .replace(/</g, `<${ZW}`).replace(/@/g, `@${ZW}`).replace(/:\/\//g, `:${ZW}//`).replace(/\bdiscord\.gg\//gi, (m) => m.replace(".", `${ZW}.`))
    .replace(/\s+/g, " ").trim();
}
// Names compare exactly (case and spacing aside) first, then on letters and digits only: a sign-up "=Red Fox=" is the party's "Red Fox".
export const nameKey = (s) => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ""); // combining marks are part of a name
const exactKey = (s) => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const httpsUrl = (u) => typeof u === "string" && /^https:\/\/[^\s<>]+$/.test(u);
export function sourcesOf(fact) {
  const out = [], seen = new Set();
  for (const r of Array.isArray(fact && fact.refs) ? fact.refs : []) {
    if (!r || !httpsUrl(r.url) || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ id: r.id || null, label: String(r.label || r.host || "source"), url: r.url });
    if (out.length === MAX_SOURCES) break;
  }
  return out;
}
const cite = (srcs) => `(${srcs.map((s) => `${plain(s.label)}: <${s.url}>`).join("; ")})`;
const pages = (doc) => (doc && Array.isArray(doc.pages) ? doc.pages : []);
const factsOf = (page) => (page && Array.isArray(page.facts) ? page.facts : []);

// ISO week of a time, as "2026-W47". The tip rotates by it, so each week brings a different fact for the same build.
export function isoWeek(ms) {
  const d = new Date(ms);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(t).getUTCDay() || 7;
  const thursday = new Date(t + (4 - day) * 86400000);
  const y = thursday.getUTCFullYear();
  const w = Math.ceil(((thursday - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return { key: `${y}-W${String(w).padStart(2, "0")}`, n: y * 53 + w };
}

// "warlock.curse_of_elements" on the warlock page reads "Curse of elements". Only facts whose key starts with the class's own name are
// used, so the subject always names something of that class.
export function subjectOf(key, classKey) {
  const parts = String(key || "").split(".").filter(Boolean);
  if (parts.length > 1 && parts[0] === classKey) parts.shift();
  const t = parts.map((x) => (own(SPEC_ALIAS, x.toLowerCase()) ? SPEC_DISPLAY[SPEC_ALIAS[x.toLowerCase()]] || SPEC_ALIAS[x.toLowerCase()] : x.replace(/_/g, " "))).join(", ");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}
const keyWords = (key) => new Set(String(key || "").toLowerCase().split(/[._\s-]+/).filter(Boolean));
// Specs by their full name; the library and the board also use short forms ("paladin.ret.x", "BM hunter"), which are read as the full name.
const SPECS = new Set(["protection", "holy", "retribution", "discipline", "shadow", "frost", "fire", "arcane", "affliction", "demonology", "destruction",
  "feral", "balance", "restoration", "enhancement", "elemental", "arms", "fury", "combat", "assassination", "subtlety", "beast", "marksmanship", "survival"]);
const SPEC_ALIAS = { prot: "protection", ret: "retribution", disc: "discipline", demo: "demonology", destro: "destruction", resto: "restoration",
  enh: "enhancement", ele: "elemental", bm: "beast", mm: "marksmanship", surv: "survival", sub: "subtlety", assn: "assassination", sin: "assassination" };
const SPEC_DISPLAY = { beast: "beast mastery" };
const canon = (w) => (own(SPEC_ALIAS, w) ? SPEC_ALIAS[w] : w);
// Druid forms: a Cat fact is never a bear tank's tip.
const FORMS = new Set(["cat", "bear", "moonkin", "tree"]);
const FORM_OF_SPEC = { balance: "moonkin", restoration: "tree" };
const ROLE_SEG = { tank: "tank", tanking: "tank", healer: "healer", healing: "healer", dps: "damage", damage: "damage" };
// a form restriction written in the value: "Cat only", "usable only in Cat Form", "requires Bear Form"; a spec one: "Balance druids only"
const FORM_ONLY_RE = /\b(cat|bear|moonkin|tree)(?: of life)?(?: form)? only\b|\bonly (?:usable )?in (cat|bear|moonkin|tree)\b|\brequires (cat|bear|moonkin|tree)\b/g;
const SPEC_ONLY_RE = /\b([a-z]+) [a-z]+s only\b/g;
const wordMatch = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
const quotable = (f, classKey) => f && typeof f.key === "string" && f.key.startsWith(`${classKey}.`) && typeof f.value === "string"
  && plainValue(f.value).length >= TIP_MIN && f.value.length <= TIP_MAX && /\p{L}{3,}.*\s.*\s.*\s/u.test(f.value) && sourcesOf(f).length > 0;

// Library shorthand a friend reading Discord cannot use (talent tiers, client builds, formula coefficients); such a fact is never the tip.
export const JARGON_RE = /\bmedal\b|\brow \d|\bcoefficient\b|\bclient \d|\bhotfix\b|\branks? \d|\bdesign pillars?\b|\bspell \d{3,}|\bhas not said\b|\buntestable\b|\bdisputed\b|\branks? at \d|\d+ ranks\b|\brescaled\b|\brenamed\b|\bwas \d|\bdoubled \w{3} \d|\bread from the wording\b|\bvanished\b|\babsent from\b|\b(since|before|after|fixed|until) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d|\bbug\b|\bnotes (cut|restored|changed|raised|lowered)\b/i; // also: what is not known, and patch history (ranks tables, "was 25%", "renamed"), is no tip
// A record or a report about other players ("fastest reported level 30 ... at 21 hours") tells the reader nothing to do: never a tip.
export const TRIVIA_RE = /\b(fastest|slowest|reported|record|played|census|survey|poll|most players|beta testers?|testers?|streamers?|world first|called it|design conflict)\b/i;
// A fact a player can act on: when they get something, how it casts, what it does in a fight, what to prioritise.
export const ACTION_RE = /\b(level \d+|at \d+|instant|cast|cooldown|slow|stun|root|heal(s|ing)?|taunt|threat|interrupt|trainer|first|priority|covers|lasts?|scales with|want|hits \d+)\b/i;
// The library's provenance at the end of a value ("(Oct 15 notes; Wowhead rank 1 tooltip)") is citation material: the source link carries it.
// Only a citation goes: a dated note, a client build, a named site, a tooltip. An aside that says something (a removal, a warning, a dissent,
// "only") stays, and so does a value the removal would leave empty.
const PROVENANCE_RE = /\b(notes?|client \d+|deep dive|wowhead|warcraft tavern|tavern|hotfix|tooltip|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i;
const CONTENT_RE = /\b(removed|never|not|no longer|only|otherwise|miss(es)?|instead|but|except|unless|wrong|breaks?)\b/i;
// A part of the aside that is history or a comparison, not advice: it starts with a date ("Sep 30 text said 15") or with "Classic".
const HISTORY_RE = /^((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|classic\b)/i;
const dropPart = (x) => HISTORY_RE.test(x) || (PROVENANCE_RE.test(x) && !CONTENT_RE.test(x) && !x.includes(":"));
export function plainValue(v) {
  let t = String(v == null ? "" : v).trim();
  for (let i = 0; i < 2; i++) {
    const m = /\s*\(([^()]*)\)(\.?)\s*$/.exec(t);
    if (!m || !(PROVENANCE_RE.test(m[1]) || m[1].split(/[;,]/).some((x) => HISTORY_RE.test(x.trim()))) || !t.slice(0, m.index).trim()) break;
    // "(Sep 30 deep dive; Wowhead tooltip; fictional caveat only)": the citations and history go, the part that says something stays
    const keep = m[1].split(/;|,\s/).map((x) => x.trim()).filter((x) => x && !dropPart(x));
    t = `${t.slice(0, m.index).trim()}${keep.length ? ` (${keep.join("; ")})` : ""}`;
    if (keep.length) break;
  }
  return t.replace(/[;,]\s*$/, "");
}
const tipText = (subject, value) => { const v = plainValue(value); return `${subject}: ${v}${/[.!?]$/.test(v) ? "" : "."}`; };

// One library fact for a build, from its class page, with https sources, as the most actionable one there is:
//   1. a good fact on the build's own spec or role that a player can act on (a level, a cast, a cooldown, a priority), with no jargon;
//   2. otherwise any such actionable fact of the class;
//   3. otherwise the page's core facts (role, difficulty), without jargon.
// The week picks one within the first tier that has any, so the tip changes from week to week.
export function pickTip(classesDoc, member, weekN) {
  const ck = member && member.class_key;
  if (!ck) return null;
  const page = pages(classesDoc).find((p) => p && p.id === `classes/${ck}`);
  const role = roleOf(member);
  // The build, as specs, forms and a role: from the board's spec, board line and role ("Undead Paladin: Ret to 40, then Ret/Holy" is
  // retribution and holy; "Feral Druid, bear tank" is feral with the bear form).
  const buildWords = `${(member && member.spec) || ""} ${(member && member.board_line) || ""}`.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(canon);
  const specs = new Set(buildWords.filter((w) => SPECS.has(w)));
  const forms = new Set(buildWords.filter((w) => FORMS.has(w)));
  if (ck === "druid" && !forms.size) {
    if (role === "tank") forms.add("bear"); else if (specs.has("feral")) forms.add("cat");
    for (const s of specs) if (own(FORM_OF_SPEC, s)) forms.add(FORM_OF_SPEC[s]);
  }
  // A fact's tags come from whole key segments after the class ("paladin.ret.x", "druid.forms.cat.prowl"), never from a word inside a spell
  // name ("mage.frost_blast"), and from a restriction written in the value. A tag the build does not have excludes the fact; an unknown build
  // (no spec, no board line) excludes nothing.
  const otherBuild = (f) => {
    const segs = String(f.key).toLowerCase().split(".").slice(1).map(canon);
    const v = plainValue(f.value).toLowerCase();
    const fSpecs = [...segs.filter((s) => SPECS.has(s)), ...[...v.matchAll(SPEC_ONLY_RE)].map((m) => canon(m[1])).filter((s) => SPECS.has(s))];
    const fForms = [...segs.filter((s) => FORMS.has(s)), ...[...v.matchAll(FORM_ONLY_RE)].map((m) => m[1] || m[2] || m[3])];
    const fRoles = segs.filter((s) => own(ROLE_SEG, s)).map((s) => ROLE_SEG[s]);
    if (specs.size && fSpecs.some((s) => !specs.has(s))) return true;
    if (forms.size && fForms.some((s) => !forms.has(s))) return true;
    if (role && fRoles.some((r) => r !== role)) return true;
    // a threat-raising fact is a tank's; threat reduction is anyone's
    return Boolean(role && role !== "tank" && /\b(generates?|more|high|extra|bonus|holds?) threat\b|\+\d+% (\w+ )?threat\b|\btaunt\b/i.test(v));
  };
  const words = [...(role && own(ROLE_WORDS, role) ? ROLE_WORDS[role] : []), ...specs, ...forms];
  // Jargon is judged on the text the friend reads: a citation in the value ("(client 70450)") that plainValue removes does not disqualify it.
  const ok = factsOf(page).filter((f) => quotable(f, ck) && !JARGON_RE.test(plainValue(f.value)) && !TRIVIA_RE.test(`${f.key} ${f.value}`) && !otherBuild(f));
  const actionable = (f) => f.depth === "good" && ACTION_RE.test(plainValue(f.value));
  const ownFact = (f) => [...keyWords(f.key)].map(canon).some((k) => words.some((w) => wordMatch(w, k)));
  const tiers = [ok.filter((f) => actionable(f) && ownFact(f)), ok.filter(actionable), ok.filter((f) => f.depth === "must")];
  // A small build-specific pool would repeat every few weeks: the class's other actionable facts join it, the build's own first.
  const joined = [...tiers[0], ...tiers[1].filter((f) => !tiers[0].includes(f))];
  const pool = tiers[0].length < 3 && joined.length ? joined : tiers.find((t) => t.length);
  if (!pool) return null;
  const f = pool[((weekN % pool.length) + pool.length) % pool.length];
  return { page: page.id, key: f.key, subject: subjectOf(f.key, ck), value: f.value, text: tipText(subjectOf(f.key, ck), f.value), sources: sourcesOf(f) };
}

const joinOr = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
const joinList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// Who a sign-up is: an exact name match wins; otherwise a letters-and-digits match, only when exactly one member has that key.
function matcher(members) {
  const exact = new Map(), loose = new Map();
  for (const m of members) {
    if (!m || typeof m.name !== "string") continue;
    const e = exactKey(m.name), l = nameKey(m.name);
    if (e && !exact.has(e)) exact.set(e, m); else if (e) exact.set(e, null); // two members with the same name: neither is matched
    if (l) loose.set(l, loose.has(l) ? null : m);
  }
  return (name) => {
    const e = exactKey(name);
    if (e && exact.has(e)) return exact.get(e);
    const l = nameKey(name);
    return l && loose.get(l) ? loose.get(l) : null;
  };
}

// Documents in, post out. signups and party are the public documents; classes is the library blob of that name.
// Each sign-up is judged on its own time. The card stamps entry.updated when that person's choice changes; the card-level stamp moves on any
// click by anyone (an Out, a pack), so it says nothing about the others. A sign-up is this week's when it was made after last week's play night
// (7 days before this one; 7 days before now with no play time) and not in the future. The stamp must be a full ISO time.
// An older sign-up still shows on the card, so the post names it as from an earlier week rather than saying nobody is in; it is not counted.
export const SIGNUPS_FRESH_MS = 7 * 24 * 3600 * 1000;
const PLAY_NIGHT_MS = 6 * 3600 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export function entryIsCurrent(entry, { playAt, now } = {}) {
  const raw = entry && entry.updated;
  if (typeof raw !== "string" || !ISO_RE.test(raw) || !Number.isFinite(now)) return false;
  const at = Date.parse(raw);
  // a click during last week's play night (up to 6 hours in) is for that night
  const since = Number.isFinite(playAt) ? playAt - SIGNUPS_FRESH_MS + PLAY_NIGHT_MS : now - SIGNUPS_FRESH_MS;
  return Number.isFinite(at) && at > since && at <= now + 60 * 1000;
}
export function composeWeeklyPost({ signups, party, classes, playAt, now = Date.now() } = {}) {
  const facts = [], skipped = [];
  const entries = Array.isArray(signups && signups.entries) ? signups.entries : [];
  const members = Array.isArray(party && party.members) ? party.members : [];
  const find = matcher(members);
  // One row per person: a second sign-up for the same member (or the same name) is dropped.
  const seen = new Set(), signed = [], earlier = [];
  const current = (e) => entryIsCurrent(e, { playAt, now });
  // this week's sign-ups first, so a person with an old entry and a new one under another spelling counts once, as this week's
  for (const e of [...entries.filter(current), ...entries.filter((x) => !current(x))]) {
    if (!e || typeof e.name !== "string" || !SIGNED.includes(e.rsvp) || !RSVP_STATES.includes(e.rsvp)) continue;
    const m = find(e.name);
    if (!exactKey(e.name)) continue;
    // A member is one person however the sign-up spells them; anyone else only by the exact name (so "Al" and "A.L." stay two people).
    const who = m ? `m:${members.indexOf(m)}` : `x:${exactKey(e.name)}`;
    if (seen.has(who)) continue;
    seen.add(who);
    (current(e) ? signed : earlier).push({ e, m, name: plain(cleanName(m ? m.name : e.name)) });
  }
  const head = ["**This week on the board**"];
  const tail = ["", "Want more on your build? Ask Leeroy with /ask."];
  const body = [];
  const tips = [];
  // whose builds get a tip: the people signed up, or, with no current sign-ups, every build on the board
  const tipPeople = signed.length ? signed : members.filter((m) => m && m.name && m.class_key).map((m) => ({ m, name: plain(cleanName(m.name)), e: { rsvp: "in" } }));
  if (!signed.length) {
    body.push("Nobody has signed up for this week yet. The sign-up card is in this channel: In, Tentative or Running late.");
  } else {
    body.push(`Signed up (${signed.length}): ${joinList(signed.map((s) => `${s.name}${s.e.rsvp === "in" ? "" : ` (${STATE_WORD[s.e.rsvp]})`}`))}.`);
    const count = { tank: 0, healer: 0, damage: 0 };
    const counted = signed.filter((s) => COUNTED.includes(s.e.rsvp));
    let noRole = 0;
    for (const s of counted) { const r = roleOf(s.m); if (r) count[r]++; else noRole++; }
    const withRole = counted.length - noRole;
    if (withRole > 0) {
      const missing = ROLES.filter((r) => count[r] === 0).map((r) => ROLE_LABEL[r]);
      const roles = ROLES.map((r) => `${ROLE_LABEL[r]} ${count[r]}`).join(", ");
      body.push(`Roles on the board for those who are in: ${roles}${noRole ? ` (${noRole} with no role on the board)` : ""}.${missing.length ? ` No ${joinOr(missing)} among them yet.` : ""}`);
    }
  }
  // The card still shows older choices; the post says so instead of contradicting it (names only, at most 8, never counted above).
  if (earlier.length) {
    const shown = earlier.slice(0, 8).map((s) => s.name);
    body.push(`Still on the card, not counted for this week: ${joinList(earlier.length > 8 ? [...shown, `${earlier.length - 8} more`] : shown)}. Click your choice on the card again, or use /signup, to count for this week.`);
  }
  const week = isoWeek(Number.isFinite(playAt) ? playAt : Date.now()).n;
  for (const s of tipPeople) {
    if (!s.m || !s.m.class_key) { skipped.push({ name: s.name, why: "no build on the board" }); continue; }
    const tip = pickTip(classes, s.m, week);
    if (!tip) { skipped.push({ name: s.name, why: `no quotable sourced fact on classes/${s.m.class_key}` }); continue; }
    const build = s.m.board_line || [s.m.race, s.m.class].filter(Boolean).join(" ") || s.m.class_key;
    tips.push({ line: `- ${s.name} (${plain(build)}). ${plain(tip.text)} ${cite(tip.sources)}`, tip });
  }
  const tipHead = signed.length ? "One tip per build, from the library:" : "One tip for each build on the board, from the library:";
  // Fit Discord: drop the longest tips first ("and N more"), so one long line does not cost everyone theirs; then shorten the name list (keeping
  // the tentative and running-late markers); the tip heading goes when no tip is left.
  const say = signed.map((s) => `${s.name}${s.e.rsvp === "in" ? "" : ` (${STATE_WORD[s.e.rsvp]})`}`);
  const build = (keep, names) => {
    const lines = [...head, ...(names ? [names, ...body.slice(1)] : body)];
    if (keep.length) { lines.push("", tipHead, ...keep.map((t) => t.line)); if (keep.length < tips.length) lines.push(`(and ${tips.length - keep.length} more)`); }
    return [...lines, ...tail].join("\n");
  };
  let kept = tips.slice(), text = build(kept);
  while (text.length > POST_MAX && kept.length) {
    const longest = kept.reduce((a, t, i) => (t.line.length > kept[a].line.length ? i : a), 0);
    kept = kept.filter((_, i) => i !== longest);
    text = build(kept);
  }
  if (text.length > POST_MAX && signed.length) {
    kept = [];
    for (let k = signed.length - 1; k >= 1 && text.length > POST_MAX; k--) text = build([], `Signed up (${signed.length}): ${say.slice(0, k).join(", ")} and ${signed.length - k} more.`);
  }
  if (text.length > POST_MAX) { kept = []; text = [...head, `Signed up: ${signed.length}.`, ...tail].join("\n"); }
  for (const t of kept) facts.push(t.tip);
  return { text, facts, skipped };
}

// ---- schedule ----

// The next play night at or after now, and whether this week's post is due: on or after play night minus lead_hours, before play night,
// and not already claimed for that play week.
export function planWeeklyPost({ config, state, now }) {
  if (validateWeeklyConfig(config)) return { due: false, why: "config" };
  const d = new Date(now);
  let playAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), config.hour, config.minute || 0) + ((config.weekday - d.getUTCDay() + 7) % 7) * 86400000;
  if (playAt <= now) playAt += WEEK_MS;
  const postAt = playAt - (config.lead_hours || DEFAULT_LEAD_HOURS) * 3600 * 1000;
  const week = isoWeek(playAt).key;
  if (state && state.week === week) return { due: false, why: "posted", playAt, postAt, week };
  if (now < postAt) return { due: false, why: "early", playAt, postAt, week };
  return { due: true, playAt, postAt, week };
}

// ---- executor ----

async function readJson(db, sql, key) {
  const row = await db.prepare(sql).bind(key).first();
  if (!row) return { raw: null, value: null };
  try { return { raw: row.json, value: JSON.parse(row.json) }; } catch { return { raw: row.json, value: null }; }
}
const KV = "SELECT json FROM kv_state WHERE key = ?";
const BLOB = "SELECT json FROM lib_blobs WHERE name = ?";

export async function loadWeeklyInput(db) {
  const [signups, party, classes] = await Promise.all([readJson(db, KV, "signups"), readJson(db, KV, "party"), readJson(db, BLOB, "classes.json")]);
  return { signups: signups.value, party: party.value, classes: classes.value };
}

// Claim the play week before posting: a compare-and-swap on the state row, so two overlapping runs cannot both post.
async function claimWeek(db, raw, week, now) {
  const json = JSON.stringify({ week, at: new Date(now).toISOString() });
  const r = raw === null
    ? await db.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(WEEKLY_STATE_KEY, json, new Date(now).toISOString()).run()
    : await db.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(json, new Date(now).toISOString(), WEEKLY_STATE_KEY, raw).run();
  return !!(r && r.meta && r.meta.changes === 1) ? json : null;
}
async function releaseWeek(db, claimed, previousRaw, now) {
  if (previousRaw === null) await db.prepare("DELETE FROM kv_state WHERE key = ? AND json = ?").bind(WEEKLY_STATE_KEY, claimed).run();
  else await db.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(previousRaw, new Date(now).toISOString(), WEEKLY_STATE_KEY, claimed).run();
}
const isChannelId = (v) => typeof v === "string" && /^[0-9]{5,25}$/.test(v);

export async function runWeeklyPost(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!(await flagOn(env, "WEEKLY_POST"))) return { status: "off" }; // nothing is read while the flag is off
    if (!env.DB) return { status: "no_db" };
    const config = await loadConfigKey(env, WEEKLY_CONFIG_KEY);
    if (!config || validateWeeklyConfig(config)) return { status: "unconfigured" };
    const st = await readJson(env.DB, KV, WEEKLY_STATE_KEY);
    const plan = planWeeklyPost({ config, state: st.value, now });
    if (!plan.due) return { status: "not_due", why: plan.why, week: plan.week };
    const post = composeWeeklyPost({ ...(await loadWeeklyInput(env.DB)), playAt: plan.playAt, now });
    const cards = await loadCards(env.DB);
    const channel = [config.channel, cards && cards.signups && cards.signups.channel, lookupRosterId(await loadConfigKey(env, "discord_roster"), "channels", "signups")].find(isChannelId);
    if (!channel) return { status: "no_channel" };
    const noise = await loadConfigKey(env, "noise");
    const day = noiseDay(now, noise);
    const decision = decidePost({ now, ledger: await readLedger(env.DB, channel, day), config: noise });
    if (!decision.ok) return { status: "held", reason: decision.reason }; // the window stays open: the next tick tries again
    if (!env.DISCORD_BOT_TOKEN) return { status: "unconfigured_token" };
    const claimed = await claimWeek(env.DB, st.raw, plan.week, now);
    if (!claimed) return { status: "claimed_elsewhere" };
    let r;
    try {
      r = await discordRest(env, "POST", `/channels/${channel}/messages`, { content: post.text, flags: SUPPRESS_NOTIFICATIONS, allowed_mentions: ALLOWED_MENTIONS_NONE }, fetchImpl);
    } catch (e) {
      r = { ok: false, status: "throw" };
    }
    if (!r || !r.ok) { await releaseWeek(env.DB, claimed, st.raw, now); return { status: "post_failed", code: r && r.status }; }
    await recordPost(env.DB, channel, day);
    return { status: "posted", week: plan.week, facts: post.facts.length };
  } catch (e) {
    console.error("weekly post failed:", String((e && e.message) || e));
    return { status: "error" };
  }
}
