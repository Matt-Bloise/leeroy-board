
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h, D, MEM } = K;
const root = document.documentElement, JOURNEYS = ["guided", "curious", "everything"], DAY = 86400000, CAP = 60;
const NX = { engine: "none", out: null, open: false, seq: 0, say: "", buttons: 0 };
const NO_KEY = "To answer here, tap My board link on the Sign-ups card in Discord. It opens this board as you.";
const NO_BASE = "Answers from this view go through Discord: the Sign-ups card.";
const NOT_YET = "Not switched on yet; your answer stays on this device.";
const SENT = "Sent. Waiting for Discord.", FAILED = "Not sent.";
const LAUNCH = [["queue", "In the queue"], ["in", "In the game"], ["done", "Done for tonight"]];
const SOURCE = { board: "From the board's records.", blizzard: "From Blizzard.", library: "From the library.", discord: "From the group's Discord." };
const FOLD = ["#tn-cards", "#tn-before", "#tn-how", "#tn-actions", "#tn-left", ".jr-path"];
const sfx = (n) => { try { K.sfx(n); } catch (e) {} };
const hap = (n) => { try { if (window.BoardHaptics) window.BoardHaptics.fire(n); } catch (e) {} };
const rm = (el) => { if (el && el.parentNode) el.parentNode.removeChild(el); };
const focus = (el) => { try { if (el) el.focus({ preventScroll: true }); } catch (e) {} };
const btn = (cls, label, fn, a = {}) => h("button", { type: "button", class: cls, ...a, onclick: fn }, label);
const journey = () => (JOURNEYS.includes(root.dataset.journey) ? root.dataset.journey : "guided");
const WAX = { guided: "red", curious: "amber", everything: "green" };
const WEEK = ["train-10", "first-dungeon", "meet-again"];
const brain = () => window.BoardBrain || null;
const keyed = (B) => !!(B && B.hasKey && B.hasKey());
const rules = () => window.__nextRules ? Promise.resolve(window.__nextRules) : (NX.p ||= import("../next/rules.js?v=020417741f").catch(() => null));

const meSlug = () => { const m = MEM.member(); return m ? MEM.slug(m.name) : null; };
const ticksOf = (slug) => (slug && typeof K.beforeTicks === "function" ? K.beforeTicks(slug) : []);
function snoozeMap() {
  const out = {}; try { for (const [k, v] of Object.entries(JSON.parse(MEM.get("snooze") || "{}") || {})) if (typeof v === "number" && v > Date.now()) out[k] = v; } catch (e) {} return out;
}
function buildInput() {
  const B = brain(), m = MEM.member(), me = m ? { class_key: m.class_key, name: m.name, slug: MEM.slug(m.name) } : null;
  return { party: D.party, timeline: D.timeline, tonight: D.tonight, signups: D.signups || null, decide: window.__decide && window.__decide.data ? window.__decide.data : null,
    launch: B && B.launch ? B.launch() : [], partyRows: B && B.party ? B.party() : [], me, partyWord: K.pn.word(), partyOther: K.pn.word(-1), partyNoun: K.pn.noun(), say: K.pn.say, journey: journey(), key: keyed(B), ticks: ticksOf(me && me.slug), snoozed: snoozeMap(), cleanName: K.cleanName };
}

function words(box, layout) {
  const L = journey().charAt(0), dj = (el) => (el.getAttribute("data-j") || L).split(" ").includes(L); let n = 0;
  const walk = (el) => { for (const c of el.childNodes) { if (c.nodeType !== 1) n += c.nodeType === 3 || c.nodeType === undefined ? String(c.textContent).split(/\s+/).filter(Boolean).length : 0; else if (!c.hidden && dj(c) && !/^(script|style)$/.test(c.localName) && (!layout || c.getClientRects().length)) walk(c); } };
  if (box && dj(box)) walk(box);
  return n;
}
const panelWords = () => { const p = $("#panel-tonight"); return p && !p.hidden ? words(p, p.getClientRects().length > 0) : 0; };

function setHidden(el, on) {
  if (on) { if (!el.hasAttribute("hidden")) { el.setAttribute("hidden", ""); el.setAttribute("data-nx-hid", ""); } }
  else if (el.hasAttribute("data-nx-hid")) { el.removeAttribute("hidden"); el.removeAttribute("data-nx-hid"); }
}
function markSet() {
  root.classList.toggle("jr-set", JOURNEYS.includes(MEM.get("journey")));
  root.classList.toggle("nx-solo", journey() === "guided" && !NX.open && NX.solo !== false);
}
function fold(panel, j, on) {
  const g = on && j === "guided", meBox = $("#tn-me");
  for (const q of FOLD) for (const el of panel.querySelectorAll(q)) setHidden(el, g && !(NX.open && q === "#tn-cards"));
  for (const el of panel.querySelectorAll("#tn-me .ps-mine")) setHidden(el, g && !NX.open);
  for (const el of panel.querySelectorAll("#tn-me .tn-why, #tn-me .tn-pick .tn-who")) setHidden(el, on);
  if (meBox) meBox.classList.toggle("nx-compact", g && !!MEM.me());
  panel.classList.toggle("nx-open", g && NX.open);
}

const REST = { curious: ["#tn-cards", "#tn-before", "#tn-how"], everything: ["#tn-before", "#tn-how"] };
function restFold(panel, j) {
  let d = $("#nx-rest"); const ids = REST[j] || [];
  const els = ids.map((q) => $(q)).filter(Boolean);
  if (!els.length) { if (d) { for (const el of Array.from(d.children)) if (el.tagName !== "SUMMARY") panel.insertBefore(el, d); rm(d); } return; }
  if (!d) { d = h("details", { class: "nx-rest", id: "nx-rest" }, h("summary", { class: "nx-rest-s lib-tool" }, "Show me more")); }
  const all = ["#tn-cards", "#tn-before", "#tn-how"].map((q) => $(q)).filter(Boolean);
  for (const el of all) if (!els.includes(el) && d.contains(el)) panel.insertBefore(el, d);
  if (!d.parentNode) panel.insertBefore(d, $("#tn-me") || els[0]);
  for (const el of els) if (el.parentNode !== d) d.appendChild(el);
  for (const el of els) d.appendChild(el);
}

const minutes = (n) => (!(n > 0) ? "" : n <= 1 ? "About a minute." : `About ${Math.round(n)} minutes.`);
function tonightLine(t, short) {
  if (!t || !t.label) return null;
  const when = Number.isFinite(t.epoch) ? K.fmtWhen(t.epoch, { rel: true }) : t.open && t.untilEpoch ? `open until ${K.fmtWhen(t.untilEpoch, { rel: true })}` : "";
  let s = `${String(t.label).split(":")[0].trim()}${when ? `: ${when}` : ""}.`;
  if (!short) {
    const c = t.coming || {}, n = c.in || 0, rest = [[c.maybe, "tentative"], [c.late, "running late"], [c.out, "out"]].filter(([k]) => k > 0), none = ((D.party && D.party.members.length) || 5) - n - rest.reduce((x, [k]) => x + k, 0);
    s += n ? ` ${n} of the ${K.pn.word()} ${n === 1 ? "has" : "have"} said they're in for launch night.` : " Nobody has said they're in for launch night yet.";
    if (rest.length) s += ` ${K.andList(rest.map(([k, w]) => `${k} ${w}`))}.`;
    if (none > 0) s += ` ${none} ${none === 1 ? "has" : "have"} not answered yet.`;
  }
  return h("p", { class: "nx-line", id: "nx-tonight", text: s });
}

const SEAL_EMB = { next: "pin", done: "laurel", wait: "hourglass" };
function seal(step) {
  const k = step.id === "rest" ? "done" : NX.say === SENT || step.kind === "date" ? "wait" : "next";
  const im = h("img", { class: "nx-stepseal", src: `img/companion/seal-${k}.webp`, alt: "", width: 32, height: 32, decoding: "async", "data-seal": k });
  im.addEventListener("error", () => { const e = K.emb && K.emb(SEAL_EMB[k], "emblem nx-stepseal"); if (e && im.parentNode) im.parentNode.replaceChild(e, im); });
  return im;
}
const launchNow = () => { try { return window.__v15.status().state; } catch (e) { return null; } };
const signupHref = () => { const L = (D.tonight && D.tonight.links) || {}; return /^https:\/\/discord\.com\//.test(String(L.signup || "")) ? L.signup : null; };
const link = (id, label, fn, a = {}) => h("a", { class: "nx-link", id, href: "#tonight", ...a, onclick: (e) => { e.preventDefault(); fn(); } }, label);
const links = (g) => (g ? h("p", { class: "nx-links" }, MEM.me() ? link("nx-who", "Change person", () => { const c = $("#tn-change"); if (c) c.click(); }) : null, link("nx-more", NX.open ? "Show less" : "Show me more", () => expand(), { class: "nx-link jr-more", "aria-expanded": String(NX.open) })) : null);
function actions(step, g) {
  const a = step.action || {}, box = h("div", { class: "nx-act", role: "group", "aria-label": "Your next step" });
  if (step.id === "launch-state") {
    const cur = launchNow(), fold = g && !NX.open, nxt = { queue: "in", in: "done", done: "in" }[cur] || "queue";
    for (const [k, label] of LAUNCH) if (!fold || k === nxt) box.append(btn(`lib-btn${(fold ? k === nxt : cur === k) ? " strong" : ""}`, label, () => launchSet(k), { "data-state": k, "aria-pressed": String(cur === k) }));
    return box;
  }

  const pickHere = step.id === "pick-name";
  if (!pickHere && a.label && (a.href || a.write)) box.append(h("button", { type: "button", class: "lib-btn strong jr-go", id: "nx-go", onclick: () => run(step, a) }, a.label));
  const alt = a.alt || (!pickHere && g && step.id !== "rest" ? "Not now" : null);
  if (alt) box.append(h("button", { type: "button", class: "lib-btn", id: "nx-alt", onclick: () => snooze(step.id) }, alt));
  return box.childNodes.length ? box : null;
}
function trails(step, out) {
  const q = (out && out.queue) || [], rows = [], add = (href, label) => { if (href && label && rows.length < 3 && !rows.some((r) => r[0] === href)) rows.push([href, label]); };
  const learn = q.find((s) => s.id === "learn-role"), date = q.find((s) => s.id === "next-date");
  if (learn && learn.action) add(learn.action.href, `${String(learn.title).replace(/\.$/, "")}${learn.minutes ? `: ${learn.minutes} minutes` : ""}`);
  if (date && date.action && step.id !== "next-date") add(date.action.href, String(date.title).replace(/,\s*[A-Z][a-z]+ time\.?$/, ""));
  if (step.id === "meet" || step.place) add("#roads", "The roads to the meeting point");
  return rows.length ? h("div", { class: "nx-trails", id: "nx-trails", role: "group", "aria-labelledby": "nx-trails-h" }, h("h4", { class: "nx-trails-h", id: "nx-trails-h", text: "Worth a look next" }),
    ...rows.map(([href, label]) => h("a", { class: "lib-tool nx-trail", href }, label))) : null;
}
const queueEl = (out) => h("ol", { class: "nx-queue", id: "nx-queue", "aria-label": "Every next step, in order" }, ...((out && out.queue) || []).map((s) => h("li", { class: "nx-q", "data-step": s.id },
  s.action && /^#[a-z]/.test(String(s.action.href || "")) ? h("a", { class: "nx-q-go", href: s.action.href }, h("b", { text: s.fact })) : h("b", { text: s.fact }), s.why ? ` ${s.why}` : null, h("small", { text: ` ${SOURCE[s.source] || SOURCE.board} ${minutes(s.minutes)}` }))));
function weekEl(out, step) {
  const rows = ((out && out.queue) || []).filter((x) => WEEK.includes(x.id));
  return rows.length ? h("div", { class: "nx-week" }, h("h4", { class: "nx-week-h", text: "Your first week" }), h("ol", {}, ...rows.map((x) => h("li", { "data-step": x.id }, h("b", { text: x.fact }), h("small", { text: x.id === step.id ? " Next." : " After that." }))))) : null;
}
function draw(out) {
  const panel = $("#panel-tonight"), meBox = $("#tn-me"); if (!panel || !meBox) return;
  const j = journey(), step = out && out.step, g = j === "guided";
  markSet();
  if (!step) { NX.solo = false; markSet(); root.classList.remove("nx-on", "nx-intro"); rm(NX.card); rm(NX.queue); rm(NX.lead); fold(panel, j, false); NX.buttons = 0; return; }
  NX.solo = true; markSet();
  root.classList.add("nx-on"); const intro = step.id === "pick-name"; root.classList.toggle("nx-intro", intro);
  if (NX.sayFor !== step.id) { NX.say = ""; NX.sayFor = step.id; }
  const card = NX.card || (NX.card = h("section", { class: "nx", id: "nx-card", "aria-labelledby": "nx-t" }));
  if (card.parentNode !== panel || (card.nextSibling !== meBox && card.nextSibling !== $("#nx-rest") && card.nextSibling !== NX.queue)) panel.insertBefore(card, meBox);
  const had = card.contains(document.activeElement) ? document.activeElement.id : null, deep = !g || NX.open;
  card.classList.toggle("nx-open", g && NX.open);
  card.classList.toggle("jr-core", g);
  card.setAttribute("data-voice", g && step.voice === "coach" ? "coach" : "library");
  const meta = [g && !NX.open ? "" : minutes(step.minutes), deep ? SOURCE[step.source] || SOURCE.board : ""].filter(Boolean).join(" "), all = j === "everything";

  const facts = all && Number.isFinite(step.due) && step.kind !== "date" ? `Open until ${K.fmtWhen(step.due, { rel: true })}.` : "";
  const stored = MEM.get("journey"), week = g && NX.open ? weekEl(out, step) : null;
  card.replaceChildren(...[JOURNEYS.includes(stored) ? h("span", { class: "nx-seal", "data-wax": WAX[stored], "aria-hidden": "true" }) : null, h("div", { class: "nx-k" }, seal(step), "Next"), h("h3", { id: "nx-t", text: g ? step.title : step.fact || step.title }),
    step.why ? h("p", { class: "nx-why", text: g && !NX.open ? step.why.split(/;\s/)[0].replace(/\.?$/, ".") : step.why }) : null, meta ? h("p", { class: deep ? "nx-min nx-source" : "nx-min", text: meta }) : null, facts ? h("p", { class: "nx-min nx-facts", id: "nx-facts", text: facts }) : null, actions(step, g),
    h("p", { class: "nx-say", id: "nx-say", role: "status", "aria-live": "polite", text: NX.say }),

    NX.extFor === step.id && NX.say === NO_KEY && signupHref() ? h("div", { class: "nx-ext" }, h("a", { class: "tn-link", id: "nx-ext", href: signupHref(), target: "_blank", rel: "noopener" }, "Open the Sign-ups card in Discord")) : null,
    links(g), week, deep && !all ? trails(step, out) : null, g || intro ? null : tonightLine(out.tonight, false)].filter(Boolean));
  rm(NX.lead); NX.lead = null;
  if (g || intro) { NX.lead = tonightLine(out.tonight, true); if (NX.lead) panel.insertBefore(NX.lead, intro ? meBox.nextSibling : card); } /* first run: the countdown sits below the primary action */
  if (j === "everything") { const q = queueEl(out); rm(NX.queue); panel.insertBefore(q, card.nextSibling || null); NX.queue = q; }
  else { rm(NX.queue); NX.queue = null; }
  fold(panel, j, true); restFold(panel, j); tabFold();
  if (g && !intro && !NX.open && NX.lead && words(card, false) + words(NX.lead, false) >= 44) { rm(NX.lead); NX.lead = null; }
  const sq = $("#tn-seals .tn-seals-q"); if (sq) sq.textContent = "Change how much the board shows you.";
  for (const x of document.querySelectorAll("#tn-seals .wx-line, #tn-seals .tn-wall")) x.hidden = true;
  if (had) focus(document.getElementById(had));
  NX.buttons = card.querySelectorAll(".nx-act button").length;
}
/* nextstep.v2 (data/client.json flags, default false): js/nextstep.js (Q36) picks one card from the viewer's build, group and answer. When it returns a step it replaces the card below; when it returns null, or anything fails, the card above stays. Copy: data/cta.json (ids nextstep-*). The group is the sample roster until the groups API exists (same file scenes/roster.js reads). */
const NS = { p: null };
const nsFlag = () => !!(D.client && D.client.flags && D.client.flags["nextstep.v2"]);
const nsJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const nsLoad = () => (NS.p ||= Promise.all([import("./nextstep.js?v=bb23497925").catch(() => null), nsJson("data/cta.json"), nsJson("data/sample/roster.json")]).then(([mod, cta, roster]) => {
  const copy = {}; if (Array.isArray(cta)) for (const e of cta) if (e && /^nextstep-/.test(e.id) && typeof e.new === "string") copy[e.id] = e.new;
  return mod && typeof mod.nextStep === "function" ? { mod, copy, roster } : null;
}));
const NS_HREF = { "no-build": () => signupHref() || "#signups", "no-group": () => "#signups", mismatch: () => "#library", rsvp: () => "#signups", "event-soon": () => "#tonight" };
function nsApply(out, N) {
  const P = D.party, me = MEM.member(), just = MEM.get("me") === "just-looking";
  if (!N || !out || !out.step || !P || (!me && !just)) return out;
  const ro = N.roster && N.roster.group ? N.roster : null, slots = ro && Array.isArray(ro.slots) ? ro.slots : [], bench = ro && Array.isArray(ro.bench) ? ro.bench : [];
  const mine = me && ro && slots.concat(bench).some((s) => s && s.character && s.character.name === me.name);
  const sg = me && D.signups && Array.isArray(D.signups.entries) ? D.signups.entries.find((e) => e.name === me.name) : null;
  let r = null;
  try {
    r = N.mod.nextStep({ build: me ? { class_key: me.class_key, role: me.role, faction: P.faction, ruleset: P.ruleset } : null,
      group: mine ? { name: ro.group.name, ruleset: ro.group.ruleset, faction: ro.group.faction, slots, event_epoch: ro.group.event_epoch } : null,
      signups: { rsvp: sg ? sg.rsvp : null }, now: Date.now(), copy: N.copy, fmt: (t) => K.fmtWhen(t, { rel: true }) });
  } catch (e) { console.error("nextstep", e); }
  const href = r && NS_HREF[r.id] ? NS_HREF[r.id]() : null; if (!r || !href) return out;
  return { ...out, step: { id: `ns-${r.id}`, kind: "nextstep", title: r.title, fact: r.title, why: r.why, source: "board", minutes: 1, action: { label: r.cta, href } } };
}
function render() {
  const seq = ++NX.seq; firstRun();
  return rules().then((R) => {
    if (seq !== NX.seq) return NX.out;
    NX.engine = !R ? "none" : R === window.__nextRules ? "injected" : "imported";
    let out = null;
    if (R && typeof R.nextSteps === "function" && D.party && D.timeline && D.tonight) { try { out = R.nextSteps(buildInput(), Date.now()); } catch (e) { console.error("next", e); } }
    const done = (o) => { NX.out = o; draw(o); firstRun(); return o; };
    if (!nsFlag() || !out) return done(out);
    return nsLoad().then((N) => (seq !== NX.seq ? NX.out : done(nsApply(out, N))), () => done(out));
  });
}

/* firstrun.v2 (data/client.json flags): a visitor with no saved name sees purpose, one button and one quiet link, never the list of names. "Just take a look" opens the old name grid. Strings: data/cta.json (ids firstrun-*). */
const FR = { peek: false, cta: null, p: null, you: null };
/* Q28 "Is this you?": when the board knows the viewer's Discord display name (the Activity user, or the web session answer of /api/me), one confirmation card replaces the name grid. No Discord id is read or shown. */
const YOU = { name: null, build: null, no: false, empty: false, p: null };
const clip = (v) => (typeof v === "string" ? v.replace(/[ -<>]/g, "").trim().slice(0, 40) : "");
function youFrom(o) {
  if (!o || typeof o !== "object") return;
  const n = clip(o.display_name) || clip(o.global_name) || clip(o.name) || clip(o.username);
  if (n && !YOU.name) YOU.name = n;
  const b = { class: clip(o.class || o.class_name), race: clip(o.race), role: clip(o.role) };
  if (b.class || b.race || b.role) YOU.build = b;
}
function youLoad() {
  if (YOU.p) return YOU.p;
  const A = window.__ACTIVITY__; if (A && typeof A === "object") youFrom(A.user && typeof A.user === "object" ? A.user : A);
  const B = brain(), u = B && B.url ? B.url("/me") : null;
  if (!u || typeof fetch !== "function") return null; /* the brain may not be loaded yet: ask again on the next pass */
  /* a credentialed call to the API origin is cross-origin: only make it for someone who has just signed in on the web (marker board-wl), so nobody else triggers a CORS refusal */
  let wl = false; try { wl = localStorage.getItem("board-wl") === "1"; } catch (e) {}
  if (!wl) return null;
  YOU.p = fetch(u, { cache: "no-store", credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => { youFrom(j); firstRun(); });
  return YOU.p;
}
const youOn = () => !!(FR.you && YOU.name && !YOU.no);
const youMember = () => {
  const ms = (D.party && D.party.members) || [], n = K.cleanName(YOU.name).toLowerCase();
  const byName = ms.filter((m) => K.cleanName(m.name).toLowerCase() === n);
  return byName.length === 1 ? byName[0] : null; /* by name only: a shared class never makes someone else you */
};
const buildText = (b) => [b.race, b.class].filter(Boolean).join(" ") + (b.role ? `, ${b.role}` : "");
function youYes() {
  sfx("page"); const m = youMember();
  if (!m) { YOU.empty = true; firstRun(); focus($("#nx-you-h")); return; }
  const sl = MEM.slug(m.name);
  if (!MEM.setMe(sl)) { YOU.empty = true; firstRun(); return; }
  location.hash = `#tonight.${sl}`;
  try { document.dispatchEvent(new CustomEvent("board:first-value")); } catch (err) {}
  setTimeout(() => {
    firstRun(); render();
    const was = K.SC.open !== null; /* a scene is already open (the Next card the hash above just opened): goScene only switches the tab and never lands, so the sheet would not open */
    go(`five.sheet-${sl}`);
    if (was && K.SC.land && K.SC.land.key === "five") { K.SC.land = null; try { if (K.lander) K.lander("five", `sheet-${sl}`); } catch (err) {} }
  }, 0);
}
function youNo() { YOU.no = true; FR.peek = true; sfx("page"); firstRun(); render(); }
function youCard(el) {
  const T = FR.you, nm = YOU.name, key = YOU.empty ? "e" : "c";
  if (el && el.dataset.k === key) return el;
  rm(el);
  const kids = YOU.empty
    ? [h("h2", { id: "nx-you-h", tabindex: "-1", text: T["isyou-empty-heading"] }), YOU.build ? h("p", { class: "nx-fr2-line", id: "nx-you-known", text: T["isyou-known"].replace("{build}", buildText(YOU.build)) }) : null, h("p", { class: "nx-fr2-line", id: "nx-you-empty", text: T["isyou-empty-line"] }),
      h("a", { class: "nx-link", id: "nx-you-back", href: "#tonight", onclick: (e) => { e.preventDefault(); youNo(); } }, T["isyou-back"])]
    : [h("h2", { id: "nx-you-h", tabindex: "-1", text: T["isyou-heading"].replace("{name}", nm) }), btn("lib-btn strong", T["isyou-yes"], youYes, { id: "nx-you-yes" }), btn("lib-btn", T["isyou-no"], youNo, { id: "nx-you-no" })];
  return h("section", { class: "nx-fr2 nx-you", id: "nx-you", "data-k": key, "aria-labelledby": "nx-you-h" }, ...kids.filter(Boolean));
}
const FR_IDS = ["firstrun-heading", "firstrun-line", "firstrun-primary-activity", "firstrun-primary-discord", "firstrun-look"];
const YOU_IDS = ["isyou-heading", "isyou-yes", "isyou-no", "isyou-known", "isyou-empty-heading", "isyou-empty-line", "isyou-back"];
const inActivity = () => !!window.__ACTIVITY__ || /[?&](frame_id|instance_id)=/.test(location.search);
const frFlag = () => !!(D.client && D.client.flags && D.client.flags["firstrun.v2"]);
const frCta = () => (FR.p ||= fetch("data/cta.json").then((r) => (r.ok ? r.json() : null)).catch(() => null).then((list) => {
  const m = {}; if (Array.isArray(list)) for (const e of list) if (e && (FR_IDS.includes(e.id) || YOU_IDS.includes(e.id)) && typeof e.new === "string") m[e.id] = e.new;
  FR.cta = FR_IDS.every((k) => m[k]) ? m : false; FR.you = YOU_IDS.every((k) => m[k]) ? m : false; firstRun();
}));
function frPrimary() {
  sfx("page");
  if (inActivity()) { go("five"); return; }
  const u = signupHref(); if (u) window.open(u, "_blank", "noopener"); else go("signups");
}
function firstRun() {
  const panel = $("#panel-tonight"), meBox = $("#tn-me"), on = frFlag() && !MEM.me() && !FR.peek && FR.cta !== false && !!panel && !!meBox;
  root.classList.toggle("nx-first-run", on);
  let el = $("#nx-fr2"), yo = $("#nx-you");
  if (!on) { rm(el); rm(yo); return; }
  if (!FR.cta) { frCta(); return; } /* names stay hidden while the strings load */
  youLoad();
  if (youOn()) { rm(el); yo = youCard(yo); if (yo.parentNode !== panel || yo.nextSibling !== meBox) panel.insertBefore(yo, meBox); return; }
  rm(yo);
  if (!el) {
    el = h("section", { class: "nx-fr2", id: "nx-fr2", "aria-labelledby": "nx-fr2-h" }, h("h2", { id: "nx-fr2-h", text: FR.cta["firstrun-heading"] }), h("p", { class: "nx-fr2-line", text: FR.cta["firstrun-line"] }),
      btn("lib-btn strong", FR.cta[inActivity() ? "firstrun-primary-activity" : "firstrun-primary-discord"], frPrimary, { id: "nx-fr2-go" }),
      h("a", { class: "nx-link nx-fr2-look", id: "nx-fr2-look", href: "#tonight", onclick: (e) => { e.preventDefault(); FR.peek = true; sfx("page"); firstRun(); render(); try { document.dispatchEvent(new CustomEvent("board:first-value")); } catch (err) {} /* one tap: close the entry card and show the wall; the name picker stays one tap away under Next steps */ const x = $("#scene-close"); if (x && K.SC && K.SC.open) x.click(); } }, FR.cta["firstrun-look"]));
  }
  if (el.nextSibling !== meBox) panel.insertBefore(el, meBox);
}

function say(s) { NX.say = s; const p = $("#nx-say"); if (p && p.textContent !== s) p.textContent = s; }
function go(tok) {
  const k = tok.split(".")[0], sub = tok.slice(k.length + 1);
  if (!K.SCENES.includes(k) || k === "library") { location.hash = `#${tok}`; return; }
  const open = () => { if (sub) K.SC.land = { key: k, sub, from: null }; if (K.SC.open === k) { if (sub) K.setHash(tok, false); } else K.goScene(k); };
  if (k === "decide" && window.__scenes && typeof window.__scenes.load === "function") window.__scenes.load("decide").then(open, open); else open();
}
function run(step, a) {
  NX.extFor = a.write && a.write.client && a.write.client !== "tick" && !keyed(brain()) ? step.id : null;
  if (a.write && a.write.client) { write(a.write); return; }
  const href = String(a.href || ""); if (!href) return;
  sfx("page");
  if (href.charAt(0) === "#") go(href.slice(1)); else if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noopener");
}
function settled(r) {
  if (r && (r.ok || r.state === "waiting")) { hap("confirm"); say(SENT); render(); return; }
  const w = r && r.why;
  say(w === "no key" ? NO_KEY : w === "nowhere to send" ? NO_BASE : w === "not-yet" ? NOT_YET : FAILED);
}
function write(w) {
  const B = brain(), slug = meSlug();
  if (w.client === "tick") {
    if (!slug) return;
    let t = []; try { t = JSON.parse(MEM.get(`before-${slug}`) || "[]"); } catch (e) {}
    MEM.set(`before-${slug}`, JSON.stringify([...new Set([].concat(t, String(w.value)))])); hap("confirm"); sfx("latch"); render(); return;
  }
  if (!keyed(B)) { say(NO_KEY); sfx("chip"); if (!signupHref()) go("signups"); else draw(NX.out); return; }
  if (typeof B[w.client] !== "function") { go("signups"); return; }
  sfx("latch");
  Promise.resolve(B[w.client](w.value)).then(settled, () => say(FAILED));
}
function launchSet(k) {
  const B = brain(); MEM.set(`launch-${meSlug() || "just-looking"}`, k); sfx("stamp");
  const sent = B && B.setLaunch ? B.setLaunch(k) : Promise.resolve({ ok: false, local: true });
  render();
  Promise.resolve(sent).then((r) => { if (r && (r.ok || r.state === "waiting")) hap("confirm"); else if (r && r.local) say("Saved on this device."); render(); }, render);
}
function snooze(id) { const o = snoozeMap(); o[id] = Date.now() + DAY; MEM.set("snooze", JSON.stringify(o)); NX.say = ""; sfx("page"); return render(); }
function expand(on) { NX.open = on === undefined ? !NX.open : !!on; sfx("page"); markSet(); draw(NX.out); try { if (NX.open) $("#nx-trails").scrollIntoView({ block: "nearest" }); } catch (e) {} return NX.open; }


/* Guided shows four ribbon tabs and a More tab; Curious and Everything keep all twelve. The open scene's tab, and any tab opened since the scene layer opened, stay in view. No scene is removed. */
const CORE_TABS = ["tonight", "five", "signups", "librarian"], TB = { more: false, seen: new Set(), sig: null };
function tabFold() {
  const tabs = $("#tabs"); if (!tabs) return;
  const g = journey() === "guided", open = K.SC && K.SC.open, ton = $("#tab-tonight"), ind = $("#tab-ind");
  if (g && open && !CORE_TABS.includes(open)) TB.seen.add(open);
  let more = $("#tab-more");
  const els = Array.from(tabs.querySelectorAll(".tab[data-tab]"));
  if (!g) {
    for (const t of els) t.removeAttribute("data-nx-fold");
    if (ton && ind && ton.nextElementSibling !== ind) tabs.insertBefore(ton, ind);
    rm(more); TB.more = false;
  } else {
    if (ton && tabs.firstElementChild !== ton) tabs.insertBefore(ton, tabs.firstElementChild);
    for (const t of els) { const k = t.getAttribute("data-tab"); t.toggleAttribute("data-nx-fold", !TB.more && !CORE_TABS.includes(k) && !TB.seen.has(k)); }
    if (!more) { more = h("button", { type: "button", class: "lib-tool tabs-more", id: "tab-more", role: "tab", "aria-selected": "false", "aria-controls": "tabs", onclick: () => { TB.more = !TB.more; sfx("page"); tabFold(); } }); tabs.append(more); }
    more.setAttribute("aria-expanded", String(TB.more)); more.textContent = TB.more ? "Fewer" : "More";
  }
  const sig = `${g}|${els.filter((t) => !t.hasAttribute("data-nx-fold")).length}`;
  if (sig !== TB.sig) { const first = TB.sig === null; TB.sig = sig; if (!first) { try { window.dispatchEvent(new Event("resize")); } catch (e) {} } } /* the ribbons (cloth) and the tab indicator re-measure on resize */
}

markSet();
tabFold();
firstRun();
const tnOpen = (k) => root.classList.toggle("nx-tn", k === "tonight");
tnOpen(K.SC && K.SC.open);
K.on("scene", (k) => { tnOpen(k); tabFold(); });
K.on("closed", () => { tnOpen(null); TB.seen.clear(); TB.more = false; tabFold(); });
document.addEventListener("pointerdown", () => root.classList.add("nx-ptr"), true);
document.addEventListener("keydown", () => root.classList.remove("nx-ptr"), true);
K.on("tonight", () => { render(); });
document.addEventListener("click", (e) => { const t = e && e.target; if (!t || typeof t.closest !== "function" || !t.closest("[data-journey]")) return; setTimeout(() => { if (root.classList.contains("jr-set") !== JOURNEYS.includes(MEM.get("journey"))) render(); }, 0); }, true);
K.on("signups", () => { render(); });
K.on("forget", () => { MEM.set("snooze", null); NX.open = false; FR.peek = false; YOU.no = false; YOU.empty = false; markSet(); firstRun(); });
const B0 = brain();
if (B0 && typeof B0.on === "function") for (const n of ["launch", "party", "pending", "launchPending"]) B0.on(n, () => { if (NX.out) render(); });
if (typeof MutationObserver === "function") {
  let was = journey();
  new MutationObserver(() => { const j = journey(); if (j === was) return; was = j; if (j !== "guided") NX.open = false; tabFold(); render(); }).observe(root, { attributes: true, attributeFilter: ["data-journey"] });
}
window.__next = Object.freeze({ render, expand, input: buildInput, wall: () => { NX.wall = true; markSet(); },
  status: () => ({ journey: journey(), stepId: NX.out && NX.out.step ? NX.out.step.id : null, words: panelWords(), buttons: NX.buttons, open: NX.open, engine: NX.engine, snoozed: Object.keys(snoozeMap()) }) });
})();
