/* Companion N3 (COMPANION-CONTRACT.md 3): one card, #nx-card, from board/next/rules.js after renderTonight. Guided: the card alone
   until "Show me more", the only coach voice; Curious adds trails, Everything the queue. No engine: the panel as drawn. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h, D, MEM } = K;
const root = document.documentElement, JOURNEYS = ["guided", "curious", "everything"], DAY = 86400000, CAP = 60;
const NX = { engine: "none", out: null, open: false, seq: 0, say: "", buttons: 0 };
/* what the sign-up buttons say today (v13d.js suControls, mine.js), verbatim */
const NO_KEY = "To answer here, tap My board link on the Sign-ups card in Discord. It opens this board as you.";
const NO_BASE = "Answers from this view go through Discord: the Sign-ups card.";
const NOT_YET = "Not switched on yet; your answer stays on this device.";
const SENT = "Sent. Waiting for Discord.", FAILED = "Not sent.";
const LAUNCH = [["queue", "In the queue"], ["in", "In the game"], ["done", "Done for tonight"]]; /* sheet.js's labels */
const SOURCE = { board: "From the board's records.", blizzard: "From Blizzard.", library: "From the library.", discord: "From the group's Discord." };
/* Guided folds these (next.css; hidden for the fake DOM and assistive tech) */
const FOLD = ["#tn-cards", "#tn-before", "#tn-how", "#tn-actions", "#tn-left", ".jr-path"];
const sfx = (n) => { try { K.sfx(n); } catch (e) {} };
const hap = (n) => { try { if (window.BoardHaptics) window.BoardHaptics.fire(n); } catch (e) {} };
const rm = (el) => { if (el && el.parentNode) el.parentNode.removeChild(el); };
const focus = (el) => { try { if (el) el.focus({ preventScroll: true }); } catch (e) {} };
const btn = (cls, label, fn, a = {}) => h("button", { type: "button", class: cls, ...a, onclick: fn }, label);
const journey = () => (JOURNEYS.includes(root.dataset.journey) ? root.dataset.journey : "curious");
const brain = () => window.BoardBrain || null;
const keyed = (B) => !!(B && B.hasKey && B.hasKey());
const rules = () => window.__nextRules ? Promise.resolve(window.__nextRules) : (NX.p ||= import("../next/rules.js?v=2f4b35b3d0").catch(() => null));

const meSlug = () => { const m = MEM.member(); return m ? MEM.slug(m.name) : null; };
const ticksOf = (slug) => (slug && typeof K.beforeTicks === "function" ? K.beforeTicks(slug) : []); /* the integrator exports beforeTicks */
function snoozeMap() {
  const out = {}; try { for (const [k, v] of Object.entries(JSON.parse(MEM.get("snooze") || "{}") || {})) if (typeof v === "number" && v > Date.now()) out[k] = v; } catch (e) {} return out;
}
function buildInput() {
  const B = brain(), m = MEM.member(), me = m ? { class_key: m.class_key, name: m.name, slug: MEM.slug(m.name) } : null;
  return { party: D.party, timeline: D.timeline, tonight: D.tonight, signups: D.signups || null, decide: window.__decide && window.__decide.data ? window.__decide.data : null,
    launch: B && B.launch ? B.launch() : [], partyRows: B && B.party ? B.party() : [], me, journey: journey(), key: keyed(B), ticks: ticksOf(me && me.slug), snoozed: snoozeMap(), cleanName: K.cleanName };
}

/* visible words: not hidden, in the journey's depth, laid out */
function words(box, layout) {
  const L = journey().charAt(0), dj = (el) => (el.getAttribute("data-j") || L).split(" ").includes(L); let n = 0;
  const walk = (el) => { for (const c of el.childNodes) { if (c.nodeType !== 1) n += c.nodeType === 3 || c.nodeType === undefined ? String(c.textContent).split(/\s+/).filter(Boolean).length : 0; else if (!c.hidden && dj(c) && !/^(script|style)$/.test(c.localName) && (!layout || c.getClientRects().length)) walk(c); } };
  if (box && dj(box)) walk(box);
  return n;
}
const panelWords = () => { const p = $("#panel-tonight"); return p && !p.hidden ? words(p, p.getClientRects().length > 0) : 0; };

/* folding: only what this file hid is shown again */
function setHidden(el, on) {
  if (on) { if (!el.hasAttribute("hidden")) { el.setAttribute("hidden", ""); el.setAttribute("data-nx-hid", ""); } }
  else if (el.hasAttribute("data-nx-hid")) { el.removeAttribute("hidden"); el.removeAttribute("data-nx-hid"); }
}
/* html classes (next.css): jr-set = a journey is stored; nx-first = none is stored and the seals are drawn, so the seals are the one
   decision on screen; nx-solo = Guided with the card folded, the card's two buttons are the one decision (the scene head's rail, the
   journey plate, Look at the room, the close and the phone's bottom bar wait for "Show me more"; Escape still closes); nx-tn = the
   Next steps scene is open (the chrome rules apply only there) */
function markSet() {
  const set = JOURNEYS.includes(MEM.get("journey"));
  root.classList.toggle("jr-set", set);
  /* fix round A3: "Just look at the wall for now" (NX.wall) clears the chooser for this visit and stores no journey */
  root.classList.toggle("nx-first", !set && !NX.wall && !!$("#tn-seals"));
  root.classList.toggle("nx-solo", set && journey() === "guided" && !NX.open && NX.solo !== false);
}
function fold(panel, j, on) {
  const g = on && j === "guided", seals = $("#tn-seals"), meBox = $("#tn-me");
  if (seals) setHidden(seals, root.classList.contains("jr-set") || !!NX.wall);
  for (const q of FOLD) for (const el of panel.querySelectorAll(q)) setHidden(el, g && !(NX.open && q === "#tn-cards"));
  for (const el of panel.querySelectorAll("#tn-me .ps-mine")) setHidden(el, g && !NX.open);
  for (const el of panel.querySelectorAll("#tn-me .tn-why, #tn-me .tn-pick .tn-who")) setHidden(el, on); /* the card says it (every journey since integrator pass 3) */
  if (meBox) meBox.classList.toggle("nx-compact", g && !!MEM.me());
  panel.classList.toggle("nx-open", g && NX.open);
}

const minutes = (n) => (!(n > 0) ? "" : n <= 1 ? "About a minute." : `About ${Math.round(n)} minutes.`);
function tonightLine(t, short) {
  if (!t || !t.label) return null;
  /* integrator pass 3: the event's own date, as the wall shows it (the names window's close read "Launch: open until Nov 4, 3 AM ET") */
  const when = Number.isFinite(t.epoch) ? K.fmtWhen(t.epoch, { rel: true }) : t.open && t.untilEpoch ? `open until ${K.fmtWhen(t.untilEpoch, { rel: true })}` : "";
  let s = `${String(t.label).split(":")[0].trim()}${when ? `: ${when}` : ""}.`;
  if (!short) {
    /* fix round A10: the count out of the five, then the rest only when there is any */
    const c = t.coming || {}, n = c.in || 0, rest = [[c.maybe, "tentative"], [c.late, "running late"], [c.out, "out"]].filter(([k]) => k > 0), none = ((D.party && D.party.members.length) || 5) - n - rest.reduce((x, [k]) => x + k, 0);
    s += n ? ` ${n} of the five ${n === 1 ? "has" : "have"} said they're in for launch night.` : " Nobody has said they're in for launch night yet.";
    if (rest.length) s += ` ${K.andList(rest.map(([k, w]) => `${k} ${w}`))}.`;
    if (none > 0) s += ` ${none} ${none === 1 ? "has" : "have"} not answered yet.`;
  }
  return h("p", { class: "nx-line", id: "nx-tonight", text: s });
}
/* the step's wax seal (contract 13, painted sheet 2): next, done (nothing left to do) or waiting (an answer on its way, a date to
   come). A painting that does not load gives way to the board's own emblem (pin, laurel, hourglass) */
const SEAL_EMB = { next: "pin", done: "laurel", wait: "hourglass" };
function seal(step) {
  const k = step.id === "rest" ? "done" : NX.say === SENT || step.kind === "date" ? "wait" : "next";
  const im = h("img", { class: "nx-seal", src: `img/companion/seal-${k}.webp`, alt: "", width: 32, height: 32, decoding: "async", "data-seal": k });
  im.addEventListener("error", () => { const e = K.emb && K.emb(SEAL_EMB[k], "emblem nx-seal"); if (e && im.parentNode) im.parentNode.replaceChild(e, im); });
  return im;
}
const launchNow = () => { try { return window.__v15.status().state; } catch (e) { return null; } };
/* a write with no personal key cannot land from this view: the primary opens the Sign-ups card in Discord instead (a link, so the
   Activity's openExternalLink handler takes it), and the status line says how to answer here next time */
const signupHref = () => { const L = (D.tonight && D.tonight.links) || {}; return /^https:\/\/discord\.com\//.test(String(L.signup || "")) ? L.signup : null; };
/* fix round A5: Guided folded hides the chip's Change person (nx-solo), so the card carries its own, before Show me more */
const more = (box, g) => { if (g && !NX.open && MEM.me()) box.append(btn("lib-tool nx-who", "Change person", () => { const c = $("#tn-change"); if (c) c.click(); }, { id: "nx-who" })); if (g) box.append(btn("lib-tool nx-more", NX.open ? "Show less" : "Show me more", () => expand(), { id: "nx-more", "aria-expanded": String(NX.open) })); };
function actions(step, g) {
  const a = step.action || {}, box = h("div", { class: "nx-act", role: "group", "aria-label": "Your next step" });
  if (step.id === "launch-state") {
    /* Guided folded (integrator pass 2): two buttons, the answer that comes next (none, then the queue, the game, done) and Show me
       more; the other answers come with the rest */
    const cur = launchNow(), fold = g && !NX.open, nxt = { queue: "in", in: "done", done: "in" }[cur] || "queue";
    for (const [k, label] of LAUNCH) if (!fold || k === nxt) box.append(btn(`lib-btn${(fold ? k === nxt : cur === k) ? " strong" : ""}`, label, () => launchSet(k), { "data-state": k, "aria-pressed": String(cur === k) }));
    more(box, g);
    return box;
  }
  /* nobody picked: the name picker under the card is the answer, so the card adds no button of its own (every journey since fix
     round A14: Curious and Everything had shown "Pick your name" over the picker's own row) */
  const pickHere = step.id === "pick-name";
  if (!pickHere && a.label && (a.href || a.write)) box.append(h("button", { type: "button", class: "lib-btn strong", id: "nx-go", onclick: () => run(step, a) }, a.label));
  /* Guided folded: two buttons at most, the step and Show me more; Not now comes with the rest */
  if (a.alt && (!g || NX.open)) box.append(h("button", { type: "button", class: "lib-btn", id: "nx-alt", onclick: () => snooze(step.id) }, a.alt));
  if (!pickHere) more(box, g);
  return box.childNodes.length ? box : null;
}
/* "Worth a look next": the class page, the next date, the roads for a place */
function trails(step, out) {
  const q = (out && out.queue) || [], rows = [], add = (href, label) => { if (href && label && rows.length < 3 && !rows.some((r) => r[0] === href)) rows.push([href, label]); };
  const learn = q.find((s) => s.id === "learn-role"), date = q.find((s) => s.id === "next-date");
  if (learn && learn.action) add(learn.action.href, `${String(learn.title).replace(/\.$/, "")}${learn.minutes ? `: ${learn.minutes} minutes` : ""}`);
  if (date && date.action && step.id !== "next-date") add(date.action.href, String(date.title).replace(/,\s*[A-Z][a-z]+ time\.?$/, "")); /* polish: the chip drops the zone (the queue row and the card keep it) */
  if (step.id === "meet" || step.place) add("#roads", "The roads to the meeting point");
  return rows.length ? h("div", { class: "nx-trails", id: "nx-trails", role: "group", "aria-labelledby": "nx-trails-h" }, h("h4", { class: "nx-trails-h", id: "nx-trails-h", text: "Worth a look next" }),
    ...rows.map(([href, label]) => h("a", { class: "lib-tool nx-trail", href }, label))) : null;
}
/* Everything's queue (fix round A1): each step as a fact with its source and minutes, no weights */
const queueEl = (out) => h("ol", { class: "nx-queue", id: "nx-queue", "aria-label": "Every next step, in order" }, ...((out && out.queue) || []).map((s) => h("li", { class: "nx-q", "data-step": s.id },
  s.action && /^#[a-z]/.test(String(s.action.href || "")) ? h("a", { class: "nx-q-go", href: s.action.href }, h("b", { text: s.fact })) : h("b", { text: s.fact }), s.why ? ` ${s.why}` : null, h("small", { text: ` ${SOURCE[s.source] || SOURCE.board} ${minutes(s.minutes)}` }))));
function draw(out) {
  const panel = $("#panel-tonight"), meBox = $("#tn-me"); if (!panel || !meBox) return;
  const j = journey(), step = out && out.step, g = j === "guided";
  markSet();
  /* no journey stored yet: the seals are the one decision on screen, and the card comes once one is picked (integrator, 2026-10-30:
     the card under the seals ran a first visit's Next steps to 2.9 phone screens, over the 2.5 budget) */
  if (!step || !(root.classList.contains("jr-set") || NX.wall)) { NX.solo = !!step; markSet(); root.classList.remove("nx-on"); rm(NX.card); rm(NX.queue); fold(panel, j, false); NX.buttons = 0; return; }
  NX.solo = true; markSet();
  root.classList.add("nx-on");
  if (NX.sayFor !== step.id) { NX.say = ""; NX.sayFor = step.id; }
  const card = NX.card || (NX.card = h("section", { class: "nx", id: "nx-card", "aria-labelledby": "nx-t" }));
  /* under the name chip; with no name, above the picker (its answer) */
  const kids = [...panel.children], at = step.id === "pick-name" && !MEM.me() ? meBox : kids[kids.indexOf(meBox) + 1] || null;
  if (at !== card && kids[kids.indexOf(at) - 1] !== card) panel.insertBefore(card, at);
  const had = card.contains(document.activeElement) ? document.activeElement.id : null, deep = !g || NX.open;
  card.classList.toggle("nx-open", g && NX.open);
  card.setAttribute("data-voice", g && step.voice === "coach" ? "coach" : "library");
  /* the minutes and, at depth, the source share one line (the Curious card fits a 1366x768 laptop) */
  const meta = [minutes(step.minutes), deep ? SOURCE[step.source] || SOURCE.board : ""].filter(Boolean).join(" "), all = j === "everything";
  /* Everything (integrator pass 2): the step's date on the card itself, and the whole queue straight under the card in place of
     Curious's three trails. Fix round A1: no rank or weight; Curious and Everything read the step's fact, only Guided its title */
  const facts = all && Number.isFinite(step.due) && step.kind !== "date" ? `Open until ${K.fmtWhen(step.due, { rel: true })}.` : "";
  card.replaceChildren(...[h("div", { class: "nx-k" }, seal(step), "Next"), h("h3", { id: "nx-t", text: g ? step.title : step.fact || step.title }),
    step.why ? h("p", { class: "nx-why", text: step.why }) : null, meta ? h("p", { class: deep ? "nx-min nx-source" : "nx-min", text: meta }) : null, facts ? h("p", { class: "nx-min nx-facts", id: "nx-facts", text: facts }) : null, actions(step, g),
    h("p", { class: "nx-say", id: "nx-say", role: "status", "aria-live": "polite", text: NX.say }),
    /* integrator pass 3: with no board key the step's own button stays on the board; once tapped, the Sign-ups card in Discord is
       offered as a link under the status line (the Activity's openExternalLink handler takes it) */
    NX.extFor === step.id && NX.say === NO_KEY && signupHref() ? h("div", { class: "nx-ext" }, h("a", { class: "tn-link", id: "nx-ext", href: signupHref(), target: "_blank", rel: "noopener" }, "Open the Sign-ups card in Discord")) : null,
    deep && !all ? trails(step, out) : null, tonightLine(out.tonight, false)].filter(Boolean));
  /* Everything: the card, then the queue under it (contract 3.3), so the card itself fits the first screen */
  if (j === "everything") { const q = queueEl(out); rm(NX.queue); panel.insertBefore(q, card.nextSibling || null); NX.queue = q; }
  else { rm(NX.queue); NX.queue = null; }
  fold(panel, j, true);
  /* Guided: under 60 words; the tonight line shortens, then goes */
  const line = $("#nx-tonight");
  if (g && !NX.open && line && words(panel, false) >= CAP) { const short = tonightLine(out.tonight, true); card.insertBefore(short, line); rm(line); if (words(panel, false) >= CAP) rm(short); }
  if (had) focus(document.getElementById(had));
  NX.buttons = card.querySelectorAll(".nx-act button").length;
}
function render() {
  const seq = ++NX.seq;
  return rules().then((R) => {
    if (seq !== NX.seq) return NX.out;
    NX.engine = !R ? "none" : R === window.__nextRules ? "injected" : "imported";
    let out = null;
    if (R && typeof R.nextSteps === "function" && D.party && D.timeline && D.tonight) { try { out = R.nextSteps(buildInput(), Date.now()); } catch (e) { console.error("next", e); } }
    NX.out = out; draw(out); return out;
  });
}

function say(s) { NX.say = s; const p = $("#nx-say"); if (p && p.textContent !== s) p.textContent = s; }
function go(tok) {
  const k = tok.split(".")[0], sub = tok.slice(k.length + 1);
  if (!K.SCENES.includes(k) || k === "library") { location.hash = `#${tok}`; return; }
  const open = () => { if (sub) K.SC.land = { key: k, sub, from: null }; if (K.SC.open === k) { if (sub) K.setHash(tok, false); } else K.goScene(k); };
  /* lazy once js/scenes.js lands (10.2) */
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
  if (w.client === "tick") { /* a Before-launch tick on this device ("I made mine") */
    if (!slug) return;
    let t = []; try { t = JSON.parse(MEM.get(`before-${slug}`) || "[]"); } catch (e) {}
    MEM.set(`before-${slug}`, JSON.stringify([...new Set([].concat(t, String(w.value)))])); hap("confirm"); sfx("latch"); render(); return;
  }
  if (!keyed(B)) { say(NO_KEY); sfx("chip"); if (!signupHref()) go("signups"); else draw(NX.out); return; } /* never a dead end: no card link, the Sign-ups scene */
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
function expand(on) { NX.open = on === undefined ? !NX.open : !!on; sfx("page"); markSet(); draw(NX.out); try { if (NX.open) $("#nx-trails").scrollIntoView({ block: "nearest" }); } catch (e) {} return NX.open; } /* fix round A5: a 375x667 phone opened the trails under the fold */

/* after every Tonight render, on the brain's rows, on a journey switch */
markSet();
const tnOpen = (k) => root.classList.toggle("nx-tn", k === "tonight");
tnOpen(K.SC && K.SC.open);
K.on("scene", (k) => tnOpen(k));
K.on("closed", () => tnOpen(null));
/* a panel focused by a pointer (WebKit focuses the nearest focusable ancestor of a pressed button, here the whole panel) draws no
   ring; a key press brings the keyboard rings back */
document.addEventListener("pointerdown", () => root.classList.add("nx-ptr"), true);
document.addEventListener("keydown", () => root.classList.remove("nx-ptr"), true);
K.on("tonight", () => { render(); });
/* picking the journey the page already shows changes no attribute (v13d setJourney only stores it): redraw after any journey button */
document.addEventListener("click", (e) => { const t = e && e.target; if (!t || typeof t.closest !== "function" || !t.closest("[data-journey]")) return; setTimeout(() => { if (root.classList.contains("jr-set") !== JOURNEYS.includes(MEM.get("journey"))) render(); }, 0); }, true);
K.on("signups", () => { render(); });
K.on("forget", () => { MEM.set("snooze", null); NX.open = false; markSet(); });
const B0 = brain();
if (B0 && typeof B0.on === "function") for (const n of ["launch", "party", "pending", "launchPending"]) B0.on(n, () => { if (NX.out) render(); });
if (typeof MutationObserver === "function") {
  let was = journey();
  new MutationObserver(() => { const j = journey(); if (j === was) return; was = j; if (j !== "guided") NX.open = false; render(); }).observe(root, { attributes: true, attributeFilter: ["data-journey"] });
}
window.__next = Object.freeze({ render, expand, input: buildInput, wall: () => { NX.wall = true; markSet(); },
  status: () => ({ journey: journey(), stepId: NX.out && NX.out.step ? NX.out.step.id : null, words: panelWords(), buttons: NX.buttons, open: NX.open, engine: NX.engine, snoozed: Object.keys(snoozeMap()) }) });
})();
