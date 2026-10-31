
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
const rules = () => window.__nextRules ? Promise.resolve(window.__nextRules) : (NX.p ||= import("../next/rules.js?v=0fd7465535").catch(() => null));

const meSlug = () => { const m = MEM.member(); return m ? MEM.slug(m.name) : null; };
const ticksOf = (slug) => (slug && typeof K.beforeTicks === "function" ? K.beforeTicks(slug) : []);
function snoozeMap() {
  const out = {}; try { for (const [k, v] of Object.entries(JSON.parse(MEM.get("snooze") || "{}") || {})) if (typeof v === "number" && v > Date.now()) out[k] = v; } catch (e) {} return out;
}
function buildInput() {
  const B = brain(), m = MEM.member(), me = m ? { class_key: m.class_key, name: m.name, slug: MEM.slug(m.name) } : null;
  return { party: D.party, timeline: D.timeline, tonight: D.tonight, signups: D.signups || null, decide: window.__decide && window.__decide.data ? window.__decide.data : null,
    launch: B && B.launch ? B.launch() : [], partyRows: B && B.party ? B.party() : [], me, journey: journey(), key: keyed(B), ticks: ticksOf(me && me.slug), snoozed: snoozeMap(), cleanName: K.cleanName };
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
    s += n ? ` ${n} of the five ${n === 1 ? "has" : "have"} said they're in for launch night.` : " Nobody has said they're in for launch night yet.";
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
  if (!step) { NX.solo = false; markSet(); root.classList.remove("nx-on"); rm(NX.card); rm(NX.queue); rm(NX.lead); fold(panel, j, false); NX.buttons = 0; return; }
  NX.solo = true; markSet();
  root.classList.add("nx-on");
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
    links(g), week, deep && !all ? trails(step, out) : null, g ? null : tonightLine(out.tonight, false)].filter(Boolean));
  rm(NX.lead); NX.lead = null;
  if (g) { NX.lead = tonightLine(out.tonight, true); if (NX.lead) panel.insertBefore(NX.lead, card); }
  if (j === "everything") { const q = queueEl(out); rm(NX.queue); panel.insertBefore(q, card.nextSibling || null); NX.queue = q; }
  else { rm(NX.queue); NX.queue = null; }
  fold(panel, j, true); restFold(panel, j);
  if (g && !NX.open && NX.lead && words(card, false) + words(NX.lead, false) >= 44) { rm(NX.lead); NX.lead = null; }
  const sq = $("#tn-seals .tn-seals-q"); if (sq) sq.textContent = "Change how much the board shows you.";
  for (const x of document.querySelectorAll("#tn-seals .wx-line, #tn-seals .tn-wall")) x.hidden = true;
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

markSet();
const tnOpen = (k) => root.classList.toggle("nx-tn", k === "tonight");
tnOpen(K.SC && K.SC.open);
K.on("scene", (k) => tnOpen(k));
K.on("closed", () => tnOpen(null));
document.addEventListener("pointerdown", () => root.classList.add("nx-ptr"), true);
document.addEventListener("keydown", () => root.classList.remove("nx-ptr"), true);
K.on("tonight", () => { render(); });
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
