
export const VERSION = 1;
export const WEIGHTS = Object.freeze({ "pick-name": 100, "launch-state": 95, "make-character": 90, rsvp: 85, meet: 70, decide: 65, "say-pack": 60, poll: 60, "learn-role": 40, "learn-role-guided": 10, "next-date": 20, rest: 1, snoozed: 5 });
const WEEK_WEIGHTS = Object.freeze({ "train-10": 48, "first-dungeon": 46, "meet-again": 44 });
export const MINUTES = Object.freeze({ "pick-name": 1, "launch-state": 1, "make-character": 10, rsvp: 1, meet: 1, decide: 5, "say-pack": 1, poll: 1, "learn-role": 3 });

const DAY = 24 * 3600 * 1000;
const ORDER = ["pick-name", "launch-state", "make-character", "say-pack", "rsvp", "meet", "decide", "poll", "train-10", "first-dungeon", "meet-again", "learn-role", "next-date", "rest"];
const JOURNEYS = ["guided", "curious", "everything"];
const RSVPS = ["in", "maybe", "late", "out"];
const RSVP_LINE = { in: "in", maybe: "tentative", late: "running late", out: "out" };
const LAUNCH_STATES = ["queue", "in", "done"];
const LAUNCH_SAY = { queue: "in the queue", in: "in the game", done: "done for tonight" };
const STEPS = { spec: "Choose your spec.", choose: "Choose {x}." };
const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

const str = (v) => (typeof v === "string" ? v : "");
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sentence = (s) => { const t = String(s ?? "").trim(); return !t ? "" : /[.!?]$/.test(t) ? t : `${t}.`; };
const fit = (s, max) => {
  const t = sentence(s); if (t.length < max) return t;
  const cut = t.slice(0, max - 1), at = cut.lastIndexOf(" ");
  return sentence((at > 20 ? cut.slice(0, at) : cut.slice(0, max - 2)).replace(/[\s,;:.]+$/, ""));
};
const fitLabel = (s) => (s.length < 16 ? s : s.slice(0, 15).trim());
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const numberWord = (n) => NUM[n] || String(n);
const unchosen = (o) => /nothing chosen|not chosen/i.test(str(o && o.status));

function events(timeline) {
  return arr(timeline && timeline.events).filter((e) => obj(e) && typeof e.key === "string")
    .slice().sort((a, b) => (num(a.epoch) ?? Infinity) - (num(b.epoch) ?? Infinity));
}
const eventOf = (timeline, key) => events(timeline).find((e) => e.key === key) || null;

export function launchWindow(timeline, nowMs) {
  const e = eventOf(timeline, "launch"), epoch = e ? num(e.epoch) : null;
  return { live: epoch !== null && nowMs >= epoch * 1000 - DAY && nowMs <= epoch * 1000 + DAY, epoch };
}
export function namesWindow(timeline, nowMs) {
  const e = eventOf(timeline, "names_open");
  if (!e) return { open: false, untilEpoch: null, until: null, zone: null };
  const start = num(e.epoch), until = num(e.until_epoch);
  return { open: until !== null && nowMs < until * 1000 && (start === null || nowMs >= start * 1000), untilEpoch: until, until: str(e.until) || null, zone: str(e.until_zone) || null };
}

function shortLabel(e, tonight) {
  const t = arr(tonight && tonight.events).find((x) => obj(x) && x.key === e.key);
  return (t && str(t.label)) || str(e.label).split(":")[0].trim() || e.key;
}
function tonightEvent(timeline, nowMs) { return events(timeline).find((e) => num(e.epoch) !== null && nowMs < e.epoch * 1000 + DAY) || null; }
function nextMoment(timeline, nowMs) {
  const out = [];
  for (const e of events(timeline)) {
    const start = num(e.epoch), until = num(e.until_epoch);
    if (until !== null && (start === null || start * 1000 <= nowMs) && nowMs < until * 1000) out.push({ e, t: until, closing: true });
    else if (start !== null && start * 1000 > nowMs) out.push({ e, t: start, closing: false });
  }
  return out.sort((a, b) => a.t - b.t)[0] || null;
}

function norm(input, nowMs) {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) throw new TypeError("nowMs must be a finite number of milliseconds");
  const I = obj(input) || {};
  const clean = typeof I.cleanName === "function" ? I.cleanName : (n) => n;
  const cleanSafe = (n) => { try { return String(clean(n) ?? ""); } catch (e) { return String(n ?? ""); } };
  return {
    party: obj(I.party) || { members: [], open: [], polls: [] }, timeline: obj(I.timeline) || { events: [] }, tonight: obj(I.tonight),
    signups: obj(I.signups), decide: obj(I.decide), launch: arr(I.launch).filter(obj), partyRows: arr(I.partyRows).filter(obj),
    me: obj(I.me), journey: JOURNEYS.includes(I.journey) ? I.journey : "curious", key: I.key === true,
    ticks: arr(I.ticks).filter((x) => typeof x === "string"), snoozed: obj(I.snoozed) || {}, library: I.library, clean: cleanSafe,
  };
}
const sameName = (a, b, clean) => a != null && b != null && clean(a).toLowerCase() === clean(b).toLowerCase();
function isPerson(row, names, slugs, clean) {
  if (!row) return false;
  if (typeof row.slug === "string" && row.slug && slugs.includes(row.slug)) return true;
  if (row.name == null) return false;
  return names.some((n) => sameName(row.name, n, clean)) || slugs.includes(slug(row.name)) || slugs.includes(slug(clean(row.name)));
}
function whoAmI(N) {
  const me = N.me; if (!me) return null;
  const members = arr(N.party.members).filter(obj), meSlug = str(me.slug) || slug(me.name);
  const member = members.find((m) => sameName(m.name, me.name, N.clean) || (meSlug && slug(m.name) === meSlug)) || members.find((m) => m.class_key === me.class_key) || null;
  const names = [me.name, member && member.name].filter((n) => n != null), slugs = [...new Set([meSlug, ...names.map(slug)].filter(Boolean))];
  return { member, class_key: str(me.class_key) || (member ? str(member.class_key) : ""), names, slugs };
}
const entriesOf = (N) => arr(N.signups && N.signups.entries).filter(obj);
const libraryHas = (lib, id) => {
  if (lib == null) return true;
  const ids = Array.isArray(lib) ? lib : arr(obj(lib) && lib.pages).map((p) => (obj(p) ? p.id : p));
  return ids.includes(id);
};
function pollWhen(p) { const m = str(p.text).match(/closes (?:on )?([^.]+?)\.(?:\s|$)/); return m ? m[1].trim() : null; }
function linkOf(tonight, key) { const L = obj(tonight && tonight.links); return L && typeof L[key] === "string" ? L[key] : null; }

export function candidates(input, nowMs) {
  const N = norm(input, nowMs), out = [];
  const voice = N.journey === "guided" ? "coach" : "library";
  const snoozed = (id) => { const until = num(N.snoozed[id]); return until !== null && nowMs < until && until <= nowMs + DAY; };
  const add = (id, base, s) => out.push(Object.defineProperty({
    id, kind: s.kind, title: fit(s.title, 60), why: s.why == null ? null : fit(s.why, 110), minutes: s.minutes === undefined ? (MINUTES[base] ?? null) : s.minutes, due: num(s.due),
    action: { label: s.label == null ? null : fitLabel(s.label), href: s.href || null, write: s.write || null, alt: s.alt || null },
    source: s.source, voice, weight: id !== "pick-name" && snoozed(id) ? WEIGHTS.snoozed : s.weight ?? WEIGHTS[base],
  }, "fact", { value: fit(s.fact || s.title, 110) }));
  const P = N.party, T = N.tonight, me = whoAmI(N), entries = entriesOf(N);
  const lw = launchWindow(N.timeline, nowMs), nw = namesWindow(N.timeline, nowMs);
  const launchE = eventOf(N.timeline, "launch"), launchEpoch = launchE ? num(launchE.epoch) : null;
  const afterLaunchDay = launchEpoch !== null && nowMs > launchEpoch * 1000 + DAY;
  const mine = me ? entries.find((e) => isPerson(e, me.names, me.slugs, N.clean)) || null : null;
  const member = me && me.member;

  if (!me) add("pick-name", "pick-name", { kind: "do", title: "Tell the board who you are", fact: "No name is picked on this device yet", why: "Each of the five has their own next step, shown once a name is picked here or Just looking.", label: "Pick your name", href: "#tn-me", source: "board" });

  if (lw.live) {
    const row = me ? N.launch.find((r) => isPerson(r, me.names, me.slugs, N.clean)) || N.partyRows.find((r) => isPerson(r, me.names, me.slugs, N.clean) && obj(r.fields) && r.fields.launch_state) : null;
    const state = row ? (LAUNCH_STATES.includes(row.state) ? row.state : row.fields && LAUNCH_STATES.includes(row.fields.launch_state) ? row.fields.launch_state : null) : null;
    add("launch-state", "launch-state", { kind: "party", title: "Launch night: say where you are", fact: "Launch night: each of the five marks where they are", why: `${state ? `Now: ${LAUNCH_SAY[state]}. ` : ""}The five see who is in the queue, in the game or done.`, due: lw.epoch, label: "Where I am", write: { client: "setLaunch", value: LAUNCH_STATES.slice() }, source: "board" });
  }

  if (me) {
    const pack = mine && (mine.pack === "yes" || mine.pack === "no") ? mine.pack : null;
    const until = nw.until ? `, until the end of ${nw.until}, ${nw.zone || "Pacific"} time` : "";
    if (nw.open && !afterLaunchDay && pack === "yes" && !N.ticks.includes("names"))
      add("make-character", "make-character", { kind: "do", title: "Make your character before names close", fact: "You hold a pack; no character is marked made on this device", why: `Pack holders can make characters now${until}.`, due: nw.untilEpoch, label: "I made mine", alt: "Not now", source: "blizzard" });
    if (nw.open && !afterLaunchDay && pack === null)
      add("say-pack", "say-pack", { kind: "do", title: "Say whether you hold a pack", fact: "Pack: no answer from you on the Sign-ups card yet", why: "It decides whether you can make your character early.", due: nw.untilEpoch, label: "Pack: yes or no", href: "#signups", write: { client: "setPack", value: ["yes", "no"] }, source: "discord" });
    if (!afterLaunchDay && !(mine && RSVPS.includes(mine.rsvp)))
      add("rsvp", "rsvp", { kind: "party", title: "Say if you are in for launch night", fact: `Launch-night answers: ${entries.filter((e) => RSVPS.includes(e.rsvp)).length} of ${arr(P.members).length} so far`, why: "The meeting point and the first dungeon run count on who is coming.", due: launchEpoch, label: "I'm in", href: "#signups", write: { client: "setRsvp", value: "in" }, alt: "Not now", source: "discord" });
    const meetItem = arr(P.open).find((o) => obj(o) && /meeting point/i.test(str(o.title)));
    if (!afterLaunchDay && meetItem && unchosen(meetItem) && !(mine && str(mine.meet))) {
      const places = arr(N.signups && obj(N.signups.options) && N.signups.options.meet).filter((x) => typeof x === "string" && x);
      const zones = new Set(arr(P.members).map((m) => obj(m) && str(m.start_zone)).filter(Boolean)).size;
      const orList = (l) => (l.length < 2 ? l.join("") : `${l.slice(0, -1).join(", ")} or ${l[l.length - 1]}`);
      const named = places.length ? `On the table: ${orList(places)}` : "", from = zones ? `; the party walks there from ${numberWord(zones)} start zone${zones === 1 ? "" : "s"}` : "";
      const why = named && `${named}${from}.`.length < 110 ? `${named}${from}.` : named ? `${named}.` : "Nothing is chosen on the board yet.";
      add("meet", "meet", { kind: "party", title: "Pick where to meet on launch night", fact: "Meeting point: not picked yet", why, due: launchEpoch, label: "Pick a place", href: "#signups", write: { client: "setMeet", value: places.length ? places : null }, source: "discord" });
    }

    const steps = { ...STEPS, ...(obj(T && T.steps) || {}) };
    const person = arr(T && T.people).find((x) => obj(x) && x.class_key === me.class_key);
    const mineDecide = arr(N.decide && N.decide.people).find((p) => obj(p) && p.class_key === me.class_key);
    const decisions = arr(mineDecide && mineDecide.decisions).filter(obj);
    const openOnes = decisions.filter((d) => d.state === "open");
    const prof = arr(member && member.professions).find((p) => obj(p) && p.status === "undecided");
    const gapItem = arr(P.open).find((o) => obj(o) && /profession/i.test(str(o.title))), gap = gapItem ? (str(gapItem.text).match(/Gap: ([A-Za-z]+)/) || [])[1] || null : null;
    const dueOf = (d) => { const e = d && obj(d.by) ? eventOf(N.timeline, d.by.event) : null; return e ? num(e.epoch) : null; };
    const seen = new Set();
    const addDecide = (key, title, d) => {
      if (!key || seen.has(key)) return; seen.add(key);
      const why = gap && new RegExp(`\\b${gap}\\b`).test(title) ? `The party has no ${gap} yet.` : "The party has a gap or your sheet is empty here.";
      add(`decide-${key}`, "decide", { kind: "decide", title, fact: `Still open for you: ${title.replace(/^choose\s+/i, "").replace(/\.$/, "")}`, why, due: dueOf(d), label: "Choose", href: "#decide", alt: "Not now", source: "board" });
    };
    const optionIn = (d, text) => arr(d.options).some((o) => obj(o) && str(o.name) && text.includes(o.name));
    if (person && str(person.step)) {
      const t = person.step;
      if (t === steps.spec) addDecide("spec", t, null);
      else {
        const d = openOnes.find((x) => optionIn(x, t)) || decisions.find((x) => optionIn(x, t));
        addDecide(d ? slug(d.title) : prof && str(prof.name) && t.includes(prof.name) ? "professions" : slug(t.replace(/^choose\s+/i, "")), t, d);
      }
    }
    for (const d of openOnes) {
      const x = d.key === "professions" && prof ? str(prof.name) : lowerFirst(str(d.title));
      if (x) addDecide(slug(d.title), steps.choose.replace("{x}", x), d);
    }
    if (member && obj(member.spec_status) && member.spec_status.status === "open") addDecide("spec", steps.spec, null);
  }

  for (const p of arr(P.polls).filter(obj)) {
    const closes = num(p.closes_epoch), title = str(p.title);
    if (!title || closes === null || closes * 1000 <= nowMs) continue;
    const when = pollWhen(p), url = /^https:\/\//.test(str(p.url)) ? p.url : linkOf(T, "poll");
    add(`poll-${slug(title)}`, "poll", { kind: "party", title: `Vote: ${title}`, fact: `Poll open: ${title}`, why: when ? `Closes ${when}.` : "Open in Discord until it closes.", due: closes, label: "Vote", href: /^https:\/\//.test(str(url)) ? url : null, alt: "Not now", source: "discord" });
  }

  const wk = obj(N.tonight && N.tonight.week_one), line = (v) => (typeof v === "string" && v.trim() ? fit(v, 110) : null);
  if (launchEpoch !== null && nowMs >= launchEpoch * 1000) {
    const place = me && me.class_key ? line(obj(wk && wk.trainers) && wk.trainers[me.class_key]) : null, dungeon = line(wk && wk.first_dungeon);
    const meetItem = arr(P.open).find((o) => obj(o) && /meeting point/i.test(str(o.title))), meetSet = meetItem && !unchosen(meetItem) && str(meetItem.status) ? meetItem.status : null;
    if (place) add("train-10", "train-10", { kind: "learn", title: `Visit your first trainer: ${place.replace(/\.$/, "")}`, fact: `Your first trainer: ${place.replace(/\.$/, "")}`, why: "The trainer is where new spells come from.", label: "Open my class page", href: me.class_key ? `#library.classes.${slug(me.class_key)}` : null, source: "library", weight: WEEK_WEIGHTS["train-10"] });
    if (dungeon) add("first-dungeon", "first-dungeon", { kind: "learn", title: `Plan the first dungeon run: ${dungeon.replace(/\.$/, "")}`, fact: `The first dungeon run: ${dungeon.replace(/\.$/, "")}`, why: null, label: "Read it", href: "#library.dungeons.overview", source: "library", weight: WEEK_WEIGHTS["first-dungeon"] });
    if (meetSet) add("meet-again", "meet-again", { kind: "party", title: "Meet the other four at the meeting point", fact: `Where the five meet after day one: ${meetSet}`, why: null, label: "Open the roads", href: "#roads", source: "discord", weight: WEEK_WEIGHTS["meet-again"] });
  }

  if (me && me.class_key && libraryHas(N.library, `classes/${me.class_key}`)) {
    const cls = (member && str(member.class)) || cap(me.class_key), role = member && (member.role === "tank" || member.role === "healer") ? ` ${member.role}` : "";
    const what = `${/^[AEIOU]/.test(cls) ? "an" : "a"} ${cls}${role} does in a group`;
    add("learn-role", "learn-role", { kind: "learn", title: `What ${what}`, fact: `The library has a page on what ${what}`, why: "Three minutes of reading before the first dungeon.", label: "Read it", href: `#library.classes.${slug(me.class_key)}`, source: "library", weight: N.journey === "guided" ? WEIGHTS["learn-role-guided"] : WEIGHTS["learn-role"] });
  }

  const nm = nextMoment(N.timeline, nowMs);
  if (nm) {
    const e = nm.e, label = shortLabel(e, T), t = arr(T && T.events).find((x) => obj(x) && x.key === e.key);
    const when = nm.closing ? `closes at the end of ${str(e.until) || "its last day"}, ${str(e.until_zone) || "Pacific"} time` : (t && str(t.when)) || null;
    const why0 = (t && str(t.meaning)) || (str(e.detail) ? cap(str(e.detail)) : null), since = nm.closing && t && str(t.when) ? `Open since ${str(t.when)}.` : null;
    const why = [why0, since].filter(Boolean).join(" ") || null;
    add("next-date", "next-date", { kind: "date", title: when ? `${label}: ${when}` : `Next date: ${label}`, why, minutes: null, due: nm.t, label: "Show the dates", href: `#timeline.${e.key.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`, source: "blizzard" });
  }

  if (!out.length) {
    const te = tonightEvent(N.timeline, nowMs);
    add("rest", "rest", { kind: "rest", title: te ? `Nothing to do before ${shortLabel(te, T)}` : "Nothing to do right now", why: null, minutes: null, due: te ? te.epoch : null, source: "board" });
  }
  return out;
}

const baseOf = (id) => (id.startsWith("decide-") ? "decide" : id.startsWith("poll-") ? "poll" : id);
const tier = (s) => (s.id === "pick-name" ? 0 : s.id === "launch-state" && s.weight === WEIGHTS["launch-state"] ? 1 : 2);
function sorted(list) {
  return list.map((s, i) => [s, i]).sort(([a, i], [b, j]) => tier(a) - tier(b) || b.weight - a.weight || ORDER.indexOf(baseOf(a.id)) - ORDER.indexOf(baseOf(b.id)) || i - j).map(([s]) => s);
}

function tonightOf(N, nowMs) {
  const te = tonightEvent(N.timeline, nowMs), nw = namesWindow(N.timeline, nowMs), entries = entriesOf(N);
  const coming = Object.fromEntries(RSVPS.map((k) => [k, entries.filter((e) => e.rsvp === k).length]));
  const names = Object.fromEntries(["in", "maybe", "late"].map((k) => [k, entries.filter((e) => e.rsvp === k && e.name != null).map((e) => N.clean(e.name))]));
  const meetItem = arr(N.party.open).find((o) => obj(o) && /meeting point/i.test(str(o.title)));
  return { label: te ? shortLabel(te, N.tonight) : null, epoch: te ? te.epoch : null, open: nw.open, untilEpoch: nw.open ? nw.untilEpoch : null, coming, names, meet: meetItem && !unchosen(meetItem) && str(meetItem.status) ? meetItem.status : null };
}
function partyOf(N) {
  const entries = entriesOf(N);
  return arr(N.party.members).filter(obj).map((m) => {
    const e = entries.find((x) => isPerson(x, [m.name], [slug(m.name)], N.clean)), rsvp = e && RSVPS.includes(e.rsvp) ? e.rsvp : null;
    const role = str(m.role) || null, base = [`${str(m.race)} ${str(m.class)}`.trim(), role].filter(Boolean).join(", ");
    return { class_key: str(m.class_key), name: N.clean(m.name), line: rsvp ? `${base}, ${RSVP_LINE[rsvp]}` : base, role, rsvp };
  });
}

export function nextSteps(input, nowMs) {
  const N = norm(input, nowMs), list = sorted(candidates(input, nowMs));
  return { version: VERSION, step: list[0] || null, queue: list.filter((s) => s.weight > 1), tonight: tonightOf(N, nowMs), party: partyOf(N) };
}
