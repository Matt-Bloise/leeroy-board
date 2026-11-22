// The door's model: pure functions over the board's bootstrap document (GET /api/bootstrap), no DOM and no globals, so tests/unit/door-model.test.mjs
// runs this file as it ships. door/door.js renders what these return. The rules follow the board's own, named at each function, so the door and the
// board never disagree about who is in, what is next or which road is whose.

export const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const word = (n) => NUMBER_WORDS[n] || String(n);
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

// The board's cleanName (js/board.js, js/signups-week.js `who`): leading and trailing marks that are not letters or digits go, so "=Ada=" and "Ada" are one person.
export const cleanName = (n) => { const s = String(n == null ? "" : n); return s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || s; };
export const sameName = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
// The board's MEM.slug: the member key kept in localStorage board-me.
export const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function members(party) { return obj(party) ? arr(party.members).filter((m) => obj(m) && str(m.name)) : []; }

// Who this browser is, read only: board-me (a member slug, or "just-looking") first, then board-as (the name picked on the sign-up form). Both are the board's
// own keys; the door never writes them. Returns the party member or null.
export function meFrom(get, party) {
  const ms = members(party), me = str(get("board-me")), as = str(get("board-as"));
  if (me && me !== "just-looking") { const m = ms.find((x) => slug(x.name) === me); if (m) return m; }
  if (as) { const m = ms.find((x) => sameName(x.name, as)); if (m) return m; }
  return null;
}

// The next dated thing, as the board's tonightNext picks it: a window that is open now (it has an until_epoch) wins, else the first event still ahead.
export function nextEvent(timeline, nowMs) {
  const now = nowMs / 1000, evs = obj(timeline) ? arr(timeline.events).filter((e) => obj(e) && Number.isFinite(e.epoch)) : [];
  const open = evs.find((e) => Number.isFinite(e.until_epoch) && e.epoch <= now && now < e.until_epoch);
  if (open) return { ...open, isOpen: true };
  const ahead = evs.filter((e) => e.epoch > now).sort((a, b) => a.epoch - b.epoch)[0];
  return ahead ? { ...ahead, isOpen: false } : null;
}
// The short label for an event: the tonight document's own label when it has one (shorter, "Names open"), else the timeline's.
export function eventLabel(ev, tonight) {
  const t = obj(tonight) ? arr(tonight.events).find((x) => obj(x) && x.key === ev.key) : null;
  return str(t && t.label) || str(ev.label).split(":")[0] || "Next date";
}

// The board's own words for a window that is open now (tonight.events[].open_when, "Open now, until the end of Nov 3, Pacific time"), or "".
export function openWords(ev, tonight) {
  const t = obj(tonight) ? arr(tonight.events).find((x) => obj(x) && x.key === ev.key) : null;
  return str(t && t.open_when);
}

// "in 17 days", "tomorrow", "in 5 hours", "in 40 minutes", "starting now". Plain words, no seconds: the door never ticks (zero idle loops).
export function relWords(deltaS) {
  if (!Number.isFinite(deltaS)) return "";
  if (deltaS < 60) return "starting now";
  const m = Math.round(deltaS / 60), h = Math.round(deltaS / 3600), d = Math.round(deltaS / 86400);
  if (deltaS < 3600) return `in ${m} minute${m === 1 ? "" : "s"}`;
  if (deltaS < 36 * 3600) return h <= 1 ? "in an hour" : `in ${h} hours`;
  if (d <= 1) return "tomorrow";
  return `in ${d} days`;
}

// The date words for an event in the viewer's own time zone (tz injectable for tests). format "D" is a date with no time of day (timeline.json).
export function whenWords(ev, nowMs, tz) {
  const d = new Date(ev.epoch * 1000), o = tz ? { timeZone: tz } : {};
  const date = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", ...o }).format(d);
  const timeOnly = ev.format !== "D";
  const time = timeOnly ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...o }).format(d).replace(":00", "").replace(/\s?([AP])M$/, (x, p) => ` ${p}M`) : "";
  if (ev.isOpen) {
    const until = new Date(ev.until_epoch * 1000), u = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...o }).format(until);
    return { date, time, rel: `open now, until ${u}` };
  }
  return { date, time, rel: relWords(ev.epoch - nowMs / 1000) };
}

export const RSVP_KEYS = ["in", "maybe", "late", "out"];
export const RSVP_SAY = { in: "I'm in", maybe: "Tentative", late: "Running late", out: "Out" };
const WHEN_SAY = { "6pm": "6 PM ET", "8pm": "8 PM ET", later: "later" };

// The launch moment from the timeline (key "launch"), in ms, or NaN.
export function launchMs(timeline) {
  const e = obj(timeline) ? arr(timeline.events).find((x) => obj(x) && x.key === "launch") : null;
  return e && Number.isFinite(e.epoch) ? e.epoch * 1000 : NaN;
}

// The board's wk() (js/board.js): before launch the server's tallies are launch night's answers; after launch only this week's entries count
// (js/signups-week.js BoardWeek.week, passed in as `week` so this file stays pure). Returns who is in, tentative, late, out and silent, in party order.
export function signupView(signups, party, timeline, nowMs, week) {
  const ms = members(party), S = obj(signups) ? signups : null, lm = launchMs(timeline), past = Number.isFinite(lm) && nowMs >= lm;
  if (!S || !ms.length) return null;
  let rsvp, current, empty = null;
  if (past && typeof week === "function") {
    const w = week(S, nowMs, lm);
    rsvp = w.rsvp || {}; current = arr(w.current); empty = w.empty || null;
  } else {
    rsvp = obj(S.tallies) && obj(S.tallies.rsvp) ? S.tallies.rsvp : {}; current = arr(S.entries);
  }
  const stateOf = (m) => { for (const k of RSVP_KEYS) if (arr(rsvp[k] && rsvp[k].names).some((n) => sameName(n, m.name))) return k; return null; };
  const seats = ms.map((m) => ({ name: m.name, classKey: str(m.class_key), state: stateOf(m) }));
  const count = (k) => seats.filter((s) => s.state === k).length;
  const entryOf = (m) => current.find((e) => obj(e) && sameName(e.name, m.name)) || null;
  return {
    phase: past ? "week" : "launch",
    seats, empty,
    counts: { in: count("in"), maybe: count("maybe"), late: count("late"), out: count("out"), none: count(null) },
    mine(m) { if (!m) return null; const s = seats.find((x) => sameName(x.name, m.name)); const e = entryOf(m); return { state: s ? s.state : null, when: e && WHEN_SAY[e.when] ? WHEN_SAY[e.when] : null }; },
  };
}

// The party card: names, builds and the role count, with the board's rules for hidden fields (a member can hide race, class and spec; a hidden
// value is absent from the public document) and its party.n wording ("The five" at five members, "The party" otherwise).
// Roles follow the board's roles() and the Five tile (js/board.js): a member counts in the role they play now ("damage until 40" is damage), all three
// roles are listed, and a later change is added in brackets: "1 tank, 1 healer, 3 damage (a second healer from 40)."
const ROLE_WORD = { tank: "tank", healer: "healer", heal: "healer", dps: "damage", damage: "damage" };
export const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));
export const roleNow = (m) => (/^damage until \d+/i.test(str(m.role_detail)) ? "damage" : ROLE_WORD[str(m.role).toLowerCase()] || "");
export const roleFrom = (m) => { const f = /(\w+) from level (\d+)/i.exec(str(m.role_detail)); return f ? { role: ROLE_WORD[f[1].toLowerCase()] || f[1].toLowerCase(), level: +f[2] } : null; };
// the board's roleWords: "damage to 40, then healer"
export const roleWords = (m) => { const now = roleNow(m), from = roleFrom(m); return from ? `${now || "not shown"} to ${from.level}, then ${from.role}` : now; };
export function partyView(party) {
  const ms = members(party);
  if (!ms.length) return null;
  const count = (r) => ms.filter((m) => roleNow(m) === r).length;
  const later = ms.map(roleFrom).filter(Boolean);
  const said = [["tank", "tank", "tanks"], ["healer", "healer", "healers"], ["damage", "damage", "damage"]].map(([r, one, many]) => `${count(r)} ${count(r) === 1 ? one : many}`).join(", ");
  const tail = later.length ? ` (${andList(later.map((f) => `${count(f.role) === 1 ? "a second" : "a"} ${f.role} from ${f.level}`))})` : "";
  return {
    title: ms.length === 5 ? "The five" : "The party",
    count: ms.length,
    roleLine: ms.some((m) => roleNow(m)) ? `${said}${tail}.` : "",
    list: ms.map((m) => ({ name: m.name, classKey: str(m.class_key), cls: str(m.class) || "Class hidden", race: str(m.race), role: roleWords(m) })),
  };
}

// Node ids of the roads graph as words ("the-crossroads" -> "The Crossroads"). Zeppelin towers are not stops a person names: they become the zeppelin.
export function placeName(id) { return String(id).split("-").map((w, i) => (i > 0 && ["of", "the"].includes(w) ? w : cap(w))).join(" "); }

// The roads, grouped by where each class starts (routes.json day_one.starts, through atlas/routes.js makePlan): one group per start, the members who
// start there (party order, by class), the stops on the way, whether it takes a zeppelin or boat, and the minutes on foot. `zoneOf(nodeId)` names the zone.
export function roadGroups(plan, graph, party, zoneOf) {
  if (!plan || !arr(plan.who).length) return [];
  const ms = members(party), groups = new Map();
  for (const w of plan.who) {
    const g = groups.get(w.from) || { from: w.from, name: placeName(w.from), zone: zoneOf ? zoneOf(w.from) : "", classes: [], people: [], stops: [], transports: [], minutes: w.minutes, status: w.status, edges: w.edges };
    g.classes.push(w.class_key);
    for (const m of ms) if (m.class_key === w.class_key && !g.people.includes(m.name)) g.people.push(m.name);
    if (!g.stops.length) g.stops = w.route.slice(1, -1).filter((id) => !/^zeppelin-tower-|^boat-/.test(id)).map(placeName);
    for (const id of w.edges) { const t = graph && graph.transportOf ? graph.transportOf.get(id) : null; if (t && !g.transports.includes(t)) g.transports.push(t); }
    groups.set(w.from, g);
  }
  return [...groups.values()];
}
// One line for a road: "Deathknell, Tirisfal Glades: through Brill and Undercity, then the zeppelin to Orgrimmar. About 7 minutes on foot."
export function roadLine(g, end) {
  const via = g.stops.filter((s) => s !== end);
  const zep = g.transports.length ? ", then the zeppelin" : "";
  const path = via.length ? `through ${via.length > 1 ? `${via.slice(0, -1).join(", ")} and ${via[via.length - 1]}` : via[0]}${zep} to ${end}` : `straight to ${end}${zep}`;
  const mins = Number.isFinite(g.minutes) && g.minutes > 0 ? ` About ${Math.max(1, Math.round(g.minutes))} minutes on foot.` : "";
  return `${cap(path)}.${mins}`;
}

// The zone a point falls in: the smallest zone rectangle (world.json zones[].a_rect, atlas units) that holds it. Coarse on purpose; it names a start.
export function zoneAt(zones, p) {
  let best = null, area = Infinity;
  for (const z of arr(zones)) {
    const r = z && z.a_rect; if (!Array.isArray(r) || r.length !== 4) continue;
    if (p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]) { const a = (r[2] - r[0]) * (r[3] - r[1]); if (a < area) { area = a; best = z; } }
  }
  return best ? str(best.name) : "";
}
