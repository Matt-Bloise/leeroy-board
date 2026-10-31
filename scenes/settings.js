(() => {
"use strict";
const K = window.__boardKit; if (!K || typeof document === "undefined") return;
const { h } = K, root = document.documentElement;
const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const put = (k, v) => { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
const keys = () => { try { const L = localStorage, out = []; if (typeof L.key === "function" && typeof L.length === "number") { for (let i = 0; i < L.length; i++) out.push(L.key(i)); return out; } return Object.keys(L); } catch (e) { return []; } };
const fire = (n) => { try { if (typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(n)); } catch (e) {} };
const B = () => window.__board || null, M = () => window.__mode || null;
const sound = (on) => { try { const b = B(); return b && b.sound ? !!b.sound(on) : false; } catch (e) { return false; } };
const play = (on) => { try { const m = M(); if (!m) return false; if (on !== undefined) m.set(on); return !!m.play(); } catch (e) { return false; } };
const DENSITY = [["guided", "Short", "One sentence and one button per step"], ["curious", "Standard", "The card and a few trails"], ["everything", "Everything", "Every fold and the facts behind each step"]];
const PROFILES = ["P1", "P2", "P3"];
const SCOPED = ["board-journey", "board-depth", "board-mode", "board-mode-sound", "board-seen", "board-me", "board-expert", "board-walked", "board-calm", "board-calm-prior", "board-still", "board-screencare", "board-sense"];
const stash = (id, k) => `board-pf-${id}-${k.slice(6)}`;
const profile = () => { const p = get("board-profile"); return PROFILES.includes(p) ? p : "P1"; };

const calmOn = () => get("board-calm") === "1";
const stillOn = () => get("board-still") === "1";
const careOn = () => get("board-screencare") === "1";
const density = () => { const j = get("board-journey"); return DENSITY.some((d) => d[0] === j) ? j : (root.dataset && root.dataset.journey) || "curious"; };

function applyStill(on) { root.classList.toggle("still", on); put("board-still", on ? "1" : null); fire("board-still"); }
function setCalm(on) {
  on = !!on; if (on === calmOn()) { paint(); return on; }
  if (on) {
    put("board-calm-prior", JSON.stringify({ sound: sound(), play: play(), still: stillOn() }));
    put("board-calm", "1"); root.classList.add("calm");
    play(true); sound(false); applyStill(true);
  } else {
    let p = {}; try { p = JSON.parse(get("board-calm-prior") || "{}") || {}; } catch (e) {}
    put("board-calm", null); put("board-calm-prior", null); root.classList.remove("calm");
    if (!p.play) play(false);
    if (p.sound) sound(true); else sound(false);
    applyStill(!!p.still);
  }
  fire("board-calm"); paint(); return on;
}
function setSound(on) { sound(!!on); paint(); }
function setCare(on) {
  put("board-screencare", on ? "1" : null);
  if (!on) for (const c of ["oled-care", "idle-dim"]) root.classList.remove(c);
  fire("board-screencare"); paint();
}
function setDensity(j) {
  if (!DENSITY.some((d) => d[0] === j)) return false;
  put("board-journey", j);
  try { if (window.__v13d && window.__v13d.setJourney) window.__v13d.setJourney(j, "force"); else if (root.dataset) root.dataset.journey = j; } catch (e) { console.error(e); }
  paint(); return true;
}
function reload() { try { if (typeof location !== "undefined" && typeof location.reload === "function") location.reload(); } catch (e) {} }
function setProfile(to) {
  if (!PROFILES.includes(to) || to === profile()) return false;
  const from = profile();
  for (const k of SCOPED) { put(stash(from, k), get(k)); put(k, get(stash(to, k))); put(stash(to, k), null); }
  put("board-profile", to === "P1" ? null : to);
  reload(); return true;
}
function clearTraces() {
  const me = profile();
  for (const k of keys()) {
    if (!k.startsWith("board-") || k === "board-profile") continue;
    const m = /^board-pf-(P\d)-/.exec(k);
    if (m && m[1] !== me) continue;
    put(k, null);
  }
  try { sessionStorage.clear(); } catch (e) {}
  reload();
}

const S = { el: null, rows: {}, opener: null, say: null };
const btn = (label, onclick, extra) => h("button", Object.assign({ type: "button", class: "st-btn", onclick }, extra || {}), label);
function row(id, title, note, ...controls) {
  const r = h("div", { class: "st-row", id: `st-${id}`, role: "group", "aria-labelledby": `st-${id}-t` },
    h("div", { class: "st-text" }, h("h3", { class: "st-t", id: `st-${id}-t`, text: title }), note ? h("p", { class: "st-note", id: `st-${id}-n`, text: note }) : null),
    h("div", { class: "st-ctl" }, ...controls));
  S.rows[id] = r; return r;
}
function build() {
  if (S.el) return S.el;
  const calm = btn("", () => setCalm(!calmOn()), { id: "st-calm-b", "aria-describedby": "st-calm-n" });
  const still = btn("", () => { applyStill(!stillOn()); paint(); }, { id: "st-still-b", "aria-describedby": "st-still-n" });
  const snd = btn("", () => setSound(!sound()), { id: "st-sound-b", "aria-describedby": "st-sound-n" });
  const care = btn("", () => setCare(!careOn()), { id: "st-care-b", "aria-describedby": "st-care-n" });
  const dens = DENSITY.map(([j, name, sub]) => btn(name, () => setDensity(j), { "data-density": j, "aria-pressed": "false", title: sub }));
  const who = PROFILES.map((p, i) => btn(`Profile ${i + 1}`, () => setProfile(p), { "data-profile": p, "aria-pressed": "false" }));
  const clear = btn("Clear my traces and reload", () => clearTraces(), { id: "st-clear-b", "aria-describedby": "st-clear-n" });
  S.say = h("p", { class: "st-say", id: "st-say", role: "status", "aria-live": "polite" });
  S.el = h("section", { class: "st", id: "settings", role: "dialog", "aria-modal": "true", "aria-labelledby": "st-h", hidden: "" },
    h("div", { class: "st-veil", onclick: () => close() }),
    h("div", { class: "st-card", tabindex: "-1", id: "st-card" },
      h("div", { class: "st-head" }, h("h2", { id: "st-h", text: "Settings" }), btn("Close settings", () => close(), { id: "st-close", class: "st-btn st-x" })),
      row("calm", "Calm", "Text only, nothing moves, no sound, no popups. One tap on, one tap off. Density stays as it is.", calm),
      row("still", "Stop motion", "Stops every animation and transition on the page.", still),
      row("sound", "Sound", "Off until you turn it on. This is the same switch as the Sensory panel.", snd),
      row("care", "Screen care", "Off. When on, the page drifts a few pixels, dims after two minutes idle and shifts on OLED screens, to protect the display.", care),
      row("density", "Density", "How much each step shows. Changing it never closes what you have open.", ...dens),
      row("profile", "Who is using this", "Three nameless profiles on this device. Each keeps its own density, mode and what it has seen. Only changes what this page shows you.", ...who),
      row("clear", "Clear my traces", "Removes everything this page stored for the profile in use, then reloads. Other profiles are kept.", clear),
      S.say));
  S.el.addEventListener("keydown", onKey);
  document.body.appendChild(S.el);
  return S.el;
}
function paint() {
  if (!S.el) return;
  const set = (id, label, pressed) => { const b = S.el.querySelector(`#${id}`); if (!b) return; b.textContent = label; b.setAttribute("aria-pressed", String(pressed)); };
  set("st-calm-b", calmOn() ? "Turn Calm off" : "Turn Calm on", calmOn());
  set("st-still-b", stillOn() ? "Allow animation again" : "Stop every animation", stillOn());
  set("st-sound-b", sound() ? "Sound is on: turn it off" : "Sound is off: turn it on", sound());
  set("st-care-b", careOn() ? "Screen care is on: turn it off" : "Screen care is off: turn it on", careOn());
  const d = density(); for (const b of S.el.querySelectorAll("[data-density]")) b.setAttribute("aria-pressed", String(b.getAttribute("data-density") === d));
  const p = profile(); for (const b of S.el.querySelectorAll("[data-profile]")) b.setAttribute("aria-pressed", String(b.getAttribute("data-profile") === p));
}
const stops = () => [...S.el.querySelectorAll("button, input")].filter((b) => !b.disabled && !b.closest("[hidden]"));
function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== "Tab") return;
  const s = stops(); if (!s.length) return;
  const a = document.activeElement, i = s.indexOf(a);
  if (e.shiftKey && (i <= 0)) { e.preventDefault(); s[s.length - 1].focus(); } else if (!e.shiftKey && (i === s.length - 1)) { e.preventDefault(); s[0].focus(); }
}
function open(from) {
  build(); paint();
  S.opener = from || (document.activeElement !== document.body ? document.activeElement : null);
  S.el.hidden = false; root.classList.add("settings-open");
  const f = S.el.querySelector("#st-calm-b"); try { f.focus({ preventScroll: true }); } catch (e) {}
  try { if (location.hash !== "#settings") history.replaceState(history.state, "", `${location.pathname}${location.search}#settings`); } catch (e) {}
  return true;
}
function close() {
  if (!S.el || S.el.hidden) return false;
  S.el.hidden = true; root.classList.remove("settings-open");
  try { if (location.hash === "#settings") history.replaceState(history.state, "", `${location.pathname}${location.search}`); } catch (e) {}
  const o = S.opener; S.opener = null;
  const t = o && o.isConnected !== false ? o : document.getElementById("main") || document.querySelector("main");
  try { if (t) { if (t === o || t.hasAttribute("tabindex")) t.focus({ preventScroll: true }); else { t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); } } } catch (e) {}
  return true;
}
document.addEventListener("click", (e) => { const t = e.target && e.target.closest ? e.target.closest("[data-open-settings]") : null; if (t) { e.preventDefault(); open(t); } });
addEventListener("hashchange", () => { if (location.hash === "#settings") open(); else if (S.el && !S.el.hidden) close(); });
if (calmOn()) root.classList.add("calm");
if (stillOn()) root.classList.add("still");
window.BoardSettings = Object.freeze({ open, close, setCalm, setSound, setCare, setDensity, setProfile, clearTraces, status: () => ({ calm: calmOn(), still: stillOn(), sound: sound(), care: careOn(), density: density(), profile: profile(), open: !!(S.el && !S.el.hidden) }) });
if (location.hash === "#settings") open();
})();
