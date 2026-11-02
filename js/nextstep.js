/* Q36 next-step engine (flag nextstep.v2). Pure: no DOM, no fetch, no clock, no globals, so Node can import it and the unit test can cover every rule.
   nextStep({ build, group, signups, ruleset, faction, now, copy, fmt }) returns ONE { id, title, why, cta }, or null when no rule applies (the caller keeps its own card).
   build   { class_key, role, ruleset?, faction? } or null            group  { name, ruleset?, faction?, slots: [{ role, status }], event_epoch? } or null
   signups { rsvp: "in" | "maybe" | "late" | "out" | null }            ruleset / faction  the player's own values; they win over build.ruleset / build.faction
   now     ms since epoch                                              copy   { "<id>": "<string>" } from data/cta.json (ids nextstep-<rule>-title|why|cta)
   fmt     optional (epochMs) => string, so tests do not depend on the time zone
   Rules, first match wins (the tie-break order). Copy informs; it never tells anyone which class, race or role to pick.
     1 no-build   2 no-group   3 mismatch (ruleset before faction)   4 event-soon (RSVP is "in" and the event is within SOON_MS)   5 rsvp (open seat for your role, no answer yet) */
export const RULES = Object.freeze(["no-build", "no-group", "mismatch", "event-soon", "rsvp"]);
export const SOON_MS = 24 * 3600 * 1000;
const ROLE = { tank: "tank", healer: "healer", heal: "healer", dps: "dps", damage: "dps" };
const ROLE_NAME = { tank: "tank", healer: "healer", dps: "damage" };
const str = (v) => (typeof v === "string" ? v.trim() : "");
const norm = (v) => str(v).toLowerCase();
const role = (v) => ROLE[norm(v)] || "";
const ms = (e) => (typeof e === "number" && Number.isFinite(e) ? (e < 1e12 ? e * 1000 : e) : null);
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));

function own(build, ruleset, faction) {
  const b = build || {};
  return { ruleset: str(ruleset) || str(b.ruleset), faction: str(faction) || str(b.faction) };
}
function mismatch(group, mine) {
  for (const k of ["ruleset", "faction"]) {
    const theirs = str(group[k]);
    if (theirs && mine[k] && norm(theirs) !== norm(mine[k])) return { what: k, yours: mine[k], theirs };
  }
  return null;
}
function openSeat(group, r) {
  return (Array.isArray(group.slots) ? group.slots : []).some((s) => s && norm(s.status) === "open" && role(s.role) === r);
}
function pick(id, copy, vars) {
  const c = copy || {}, t = str(c[`nextstep-${id}-title`]), w = str(c[`nextstep-${id}-why`]), a = str(c[`nextstep-${id}-cta`]);
  if (!t || !w || !a) return null; /* no copy, no card: the caller falls back */
  return { id, title: fill(t, vars), why: fill(w, vars), cta: fill(a, vars) };
}

export function nextStep(input) {
  const i = input && typeof input === "object" ? input : {}, copy = i.copy, build = i.build && typeof i.build === "object" ? i.build : null;
  const group = i.group && typeof i.group === "object" ? i.group : null, rsvp = norm(i.signups && i.signups.rsvp), now = typeof i.now === "number" ? i.now : 0;
  if (!build) return pick("no-build", copy, {});
  if (!group) return pick("no-group", copy, {});
  const name = str(group.name) || "your group", mine = own(build, i.ruleset, i.faction), mm = mismatch(group, mine);
  if (mm) return pick("mismatch", copy, { group: name, what: mm.what, yours: mm.yours, theirs: mm.theirs });
  const at = ms(group.event_epoch);
  if (rsvp === "in" && at !== null && at >= now && at - now <= SOON_MS) {
    const time = typeof i.fmt === "function" ? String(i.fmt(at)) : new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    return pick("event-soon", copy, { group: name, time });
  }
  const r = role(build.role);
  if (!rsvp && r && openSeat(group, r)) return pick("rsvp", copy, { group: name, role: ROLE_NAME[r] });
  return null;
}
