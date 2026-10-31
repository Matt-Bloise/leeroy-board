(() => {
"use strict";
const K = window.__boardKit, C = window.__chamber; if (!K || !C || window.__hades) return;
const room = K.$("#chamber"); if (!room) return;
const stage = room.querySelector(".ch-stage"), lee = room.querySelector(".ch-lee"), you = room.querySelector(".ch-you");
const frame = lee && lee.querySelector(".ch-frame"); if (!stage || !frame || !you) return;
const ALT = { smug: "Leeroy at the bar, pleased with himself", delighted: "Leeroy at the bar, laughing out loud", sheepish: "Leeroy at the bar, wincing with a crooked smile", thinking: "Leeroy at the bar, looking down at the counter" };
const logEl = room.querySelector(".ch-log"), panel = room.parentNode;
const H = { on: false, hold: false, grow: null, dead: false, front: 0, seq: 0, ent: 0, busy: false, scr: null, thunk: null, nod: null, bob: null };
const WAIT_MS = 1200;
const calm = () => { try { return !!(K.reduceMQ && K.reduceMQ.matches) || document.documentElement.classList.contains("play"); } catch (e) { return false; } };
const snd = (n, o) => { try { const S = window.BoardSound; if (!calm() && S && (!S.status || S.status().on)) return S.play(n, o); } catch (e) {} return false; };

const counter = K.h("div", { class: "hd-counter", "aria-hidden": "true" });
const imgs = [0, 1].map(() => { const i = K.h("img", { class: "hd-img", alt: "", width: 1024, height: 1536, decoding: "async" }); return i; });
const bust = K.h("div", { class: "hd-bust" }, ...imgs), pose = K.h("div", { class: "hd-pose" }, bust);

const down = K.h("button", { type: "button", class: "hd-more hd-down", hidden: true, "aria-label": "More below in the talk", onclick: () => nudge(1) });
const up = K.h("button", { type: "button", class: "hd-more hd-up", hidden: true, "aria-label": "Earlier in the talk", onclick: () => nudge(-1) });
function nudge(dir) {
  if (!logEl) return;
  H.hold = false;
  const d = Math.max(60, (logEl.clientHeight || 100) * 0.8) * dir;
  try { if (typeof logEl.scrollBy === "function") logEl.scrollBy({ top: d, behavior: calm() ? "auto" : "smooth" }); else logEl.scrollTop = (logEl.scrollTop || 0) + d; } catch (e) {}
}
function hold() {
  if (!H.hold || !logEl || !H.on) return;
  try {
    const qs = logEl.querySelectorAll(".ch-q"), q = qs[qs.length - 1]; if (!q) return;
    const top = Math.max(0, q.getBoundingClientRect().top - logEl.getBoundingClientRect().top + (logEl.scrollTop || 0) - 6);
    if (Math.abs((logEl.scrollTop || 0) - top) > 1) logEl.scrollTop = top;
  } catch (e) {}
}
function cue() {
  if (!logEl || !H.on) return;
  try {
    const t = logEl.scrollTop || 0, ch = logEl.clientHeight || 0, sh = logEl.scrollHeight || 0;
    down.hidden = !(sh > ch + 4 && t + ch < sh - 4); up.hidden = !(t > 4);
    const x = (logEl.offsetLeft || 0) + (logEl.offsetWidth || 0) / 2, y0 = logEl.offsetTop || 0, y1 = y0 + (logEl.offsetHeight || 0);
    down.setAttribute("style", `left: ${x}px; top: ${y1}px`); up.setAttribute("style", `left: ${x}px; top: ${y0}px`);
  } catch (e) {}
}
const grew = () => { hold(); later(); if (H.on) fit(true); };
const tick = () => { if (H.on) fit(true); cue(); };
const later = () => { try { if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick); else tick(); } catch (e) {} };
try { if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => { if (H.on) later(); }); for (const id of ["ch-next", "ch-form"]) { const e = document.getElementById(id); if (e) ro.observe(e); } } } catch (e) {}
function fit(on) {
  try {
    if (!panel || !panel.classList) return;
    panel.classList.toggle("hd-fit", !!on);
    if (!on) { if (room && room.style && room.style.removeProperty) room.style.removeProperty("--hd-fit"); return; }
    let body = panel; while (body && !(body.classList && body.classList.contains("sheet-body"))) body = body.parentNode;
    if (!body || !window.getComputedStyle || !stage || !stage.getBoundingClientRect) return;
    const pr = panel.getBoundingClientRect(), br = body.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const pb = parseFloat(window.getComputedStyle(body).paddingBottom) || 0;
    const above = pr.top - br.top + (body.scrollTop || 0), others = pr.height - sr.height;
    const avail = Math.floor(body.clientHeight - above - pb - others - 2);
    if (!Number.isFinite(avail) || body.clientHeight <= 0) return;
    const v = Math.max((window.innerWidth || 1000) < 700 ? 300 : 200, avail), cur = parseFloat(room.style.getPropertyValue("--hd-fit"));
    if (!(Math.abs(v - cur) < 2)) room.style.setProperty("--hd-fit", `${v}px`);
  } catch (e) {}
}

const seen = {};
function probe(url) {
  if (seen[url]) return seen[url];
  return (seen[url] = new Promise((res) => {
    if (typeof Image !== "function") { res(true); return; }
    const im = new Image();
    im.onload = () => { if (typeof im.decode === "function") { try { im.decode().then(() => res(true), () => res(true)); return; } catch (e) {} } res(true); };
    im.onerror = () => res(false); im.src = url;
  }));
}
const decoded = (el) => new Promise((res) => {
  const im = el && el.querySelector ? el.querySelector("img") : null;
  if (!im || !im.getAttribute("src") || typeof im.decode !== "function") { res(); return; }
  try { im.decode().then(res, res); } catch (e) { res(); }
});
async function swap(m) {
  const my = ++H.seq; let url = `img/chamber/leeroy-bar-${m}.webp`, head = false;
  if (!(await probe(url))) { url = `img/chamber/leeroy-${m}.webp`; head = true; if (!(await probe(url))) { if (my === H.seq) { H.dead = true; unstage(); } return; } }
  if (my !== H.seq || !H.on) return;
  const back = imgs[1 - H.front], was = imgs[H.front];
  back.setAttribute("src", url); back.setAttribute("alt", ALT[m] || ""); bust.classList.toggle("is-head", head);
  if (typeof back.decode === "function") { try { await Promise.race([back.decode(), new Promise((r) => setTimeout(r, 400))]); } catch (e) {} if (my !== H.seq || !H.on) return; }
  back.classList.add("on"); was.classList.remove("on"); was.setAttribute("alt", ""); H.front = 1 - H.front;
}

function pulse(el, cls, key, ms) {
  if (!el || calm()) return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  clearTimeout(H[key]); H[key] = setTimeout(() => el.classList.remove(cls), ms);
}
function scratch(on) {
  clearTimeout(H.scr); H.scr = null;
  if (!on || calm()) return;
  const go = (first) => { H.scr = setTimeout(() => { snd("quill", { rate: 0.9, db: -36 }); go(false); }, first ? 500 : 1400 + Math.random() * 800); };
  go(true);
}
function state(st) {
  if (!H.on) return;
  const busy = st === "sending" || st === "queued";
  room.classList.toggle("is-thinking", busy);
  scratch(busy);
  if (H.busy && st === "answered") snd("page");
  H.busy = busy;
}

function stagePut() {
  if (H.on || H.dead) return;
  H.on = true;
  if (counter.parentNode !== stage) stage.appendChild(counter);
  if (pose.parentNode !== frame) frame.appendChild(pose);
  if (down.parentNode !== stage) { stage.appendChild(up); stage.appendChild(down); }
  fit(true); later();
  you.classList.add("hd-card");
  room.classList.add("hades");
  const my = ++H.ent; room.classList.add("hd-wait");
  const first = swap(room.dataset.mood || "smug");
  state(room.dataset.state || "idle");
  const art = probe("img/chamber/bar-counter.webp").then((good) => { if (good) counter.setAttribute("style", "background-image: url(img/chamber/bar-counter.webp)"); counter.classList.toggle("is-art", !!good); });
  Promise.race([Promise.all([first, art, decoded(you)]), new Promise((r) => setTimeout(r, WAIT_MS))]).then(() => {
    if (my !== H.ent || !H.on) return;
    void room.offsetWidth;
    room.classList.remove("hd-wait");
    if (!calm()) { clearTimeout(H.thunk); H.thunk = setTimeout(() => snd("thunk"), 700); }
  });
}
function unstage() {
  H.on = false; H.seq++; H.ent++; H.busy = false;
  for (const k of ["scr", "thunk", "nod", "bob"]) { clearTimeout(H[k]); H[k] = null; }
  clearInterval(H.grow); H.grow = null;
  room.classList.remove("hades", "hd-wait", "is-thinking", "is-typing", "bob");
  you.classList.remove("hd-card", "hd-nod");
  fit(false); down.hidden = true; up.hidden = true;
}

K.on("chamber", (on) => { if (on) stagePut(); else unstage(); });
K.on("chamber-mood", (m) => { if (H.on) swap(m); });
K.on("chamber-state", (st) => state(st));
K.on("chamber-typing", (v) => { room.classList.toggle("is-typing", !!v && H.on); });
K.on("chamber-line", () => { if (H.on) pulse(room, "bob", "bob", 220); later(); });
K.on("chamber-state", grew);
K.on("chamber-typing", (v) => { clearInterval(H.grow); H.grow = null; if (v && H.on) H.grow = setInterval(grew, 120); grew(); });
K.on("chamber-latest", () => { H.hold = true; hold(); later(); });
if (logEl) { logEl.addEventListener("scroll", cue); for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) logEl.addEventListener(ev, () => { H.hold = false; }); }
try { window.addEventListener("resize", () => { if (H.on) { fit(true); later(); } }); } catch (e) {}
K.on("chamber-send", () => { if (H.on) pulse(you, "hd-nod", "nod", 240); });
window.__hades = Object.freeze({ status: () => ({ on: H.on, dead: H.dead, head: bust.classList.contains("is-head") }) });
if (C.status().on) stagePut();
})();
