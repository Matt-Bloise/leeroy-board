/* The Hades room (notes/companion/HADES-ROOM.md; lane H, 2026-10-30). scenes/chamber.js opens the Leeroy chamber and tells this file what
   happens (chamber-mood, -state, -typing, -line, -send, and "chamber" open or shut through the board's kit). It stages the bar: a counter
   across the stage, Leeroy's painted bust rising behind it on the right, the asker's card on the left, one text box between them. Classes
   do the moving (scenes/hades.css, transform and opacity only). Sound only when it is on and motion is not reduced. The busts are
   img/chamber/leeroy-bar-<mood>.webp; until those exist the round head shots stand in, and a bust that loads neither leaves the chamber as it was. */
(() => {
"use strict";
const K = window.__boardKit, C = window.__chamber; if (!K || !C || window.__hades) return;
const room = K.$("#chamber"); if (!room) return;
const stage = room.querySelector(".ch-stage"), lee = room.querySelector(".ch-lee"), you = room.querySelector(".ch-you");
const frame = lee && lee.querySelector(".ch-frame"); if (!stage || !frame || !you) return;
const ALT = { smug: "Leeroy at the bar, pleased with himself", delighted: "Leeroy at the bar, laughing out loud", sheepish: "Leeroy at the bar, wincing with a crooked smile", thinking: "Leeroy at the bar, looking down at the counter" };
const H = { on: false, dead: false, front: 0, seq: 0, busy: false, scr: null, thunk: null, nod: null, bob: null };
const calm = () => { try { return !!(K.reduceMQ && K.reduceMQ.matches) || document.documentElement.classList.contains("play"); } catch (e) { return false; } };
const snd = (n, o) => { try { const S = window.BoardSound; if (!calm() && S && (!S.status || S.status().on)) return S.play(n, o); } catch (e) {} return false; };

/* the room's parts, built once */
const counter = K.h("div", { class: "hd-counter", "aria-hidden": "true" });
const imgs = [0, 1].map(() => { const i = K.h("img", { class: "hd-img", alt: "", width: 1024, height: 1536, decoding: "async" }); return i; });
const bust = K.h("div", { class: "hd-bust" }, ...imgs), pose = K.h("div", { class: "hd-pose" }, bust);

const seen = {};
function probe(url) {
  if (seen[url]) return seen[url];
  return (seen[url] = new Promise((res) => {
    if (typeof Image !== "function") { res(true); return; }
    const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = url;
  }));
}
/* the face for a mood: the bar painting when it exists, else the round head shot; neither gives the chamber back its own portraits */
async function swap(m) {
  const my = ++H.seq; let url = `img/chamber/leeroy-bar-${m}.webp`, head = false;
  if (!(await probe(url))) { url = `img/chamber/leeroy-${m}.webp`; head = true; if (!(await probe(url))) { if (my === H.seq) { H.dead = true; unstage(); } return; } }
  if (my !== H.seq || !H.on) return;
  const back = imgs[1 - H.front], was = imgs[H.front];
  back.setAttribute("src", url); back.setAttribute("alt", ALT[m] || ""); bust.classList.toggle("is-head", head);
  back.classList.add("on"); was.classList.remove("on"); was.setAttribute("alt", ""); H.front = 1 - H.front;
}

/* a short bump of one element: the class off, a reflow, on, and off again when it is done */
function pulse(el, cls, key, ms) {
  if (!el || calm()) return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  clearTimeout(H[key]); H[key] = setTimeout(() => el.classList.remove(cls), ms);
}
/* while he writes: a soft scratch every second or two, with sound on and motion not reduced */
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
  you.classList.add("hd-card");
  room.classList.add("hades");
  swap(room.dataset.mood || "smug");
  state(room.dataset.state || "idle");
  probe("img/chamber/bar-counter.webp").then((good) => { if (good) counter.setAttribute("style", "background-image: url(img/chamber/bar-counter.webp)"); counter.classList.toggle("is-art", !!good); });
  if (!calm()) { clearTimeout(H.thunk); H.thunk = setTimeout(() => snd("thunk"), 700); }
}
function unstage() {
  H.on = false; H.seq++; H.busy = false;
  for (const k of ["scr", "thunk", "nod", "bob"]) { clearTimeout(H[k]); H[k] = null; }
  room.classList.remove("hades", "is-thinking", "is-typing", "bob");
  you.classList.remove("hd-card", "hd-nod");
}

K.on("chamber", (on) => { if (on) stagePut(); else unstage(); });
K.on("chamber-mood", (m) => { if (H.on) swap(m); });
K.on("chamber-state", (st) => state(st));
K.on("chamber-typing", (v) => { room.classList.toggle("is-typing", !!v && H.on); });
K.on("chamber-line", () => { if (H.on) pulse(room, "bob", "bob", 220); });
K.on("chamber-send", () => { if (H.on) pulse(you, "hd-nod", "nod", 240); });
window.__hades = Object.freeze({ status: () => ({ on: H.on, dead: H.dead, head: bust.classList.contains("is-head") }) });
if (C.status().on) stagePut(); /* the room was already open when this file arrived */
})();
