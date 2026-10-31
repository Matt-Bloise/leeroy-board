/* Companion N7 (contract 7): the first-open walk; no card waits, never twice (board-walked) */
(() => {
"use strict";
const K = window.__boardKit, D = document; if (!K) return;
const KEY = "board-walked", get = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
/* walk.css needs a head: the fake DOM's default path has none */
const OFF = !!get() || !D.head || /[?&](render|brain)=/.test(location.search || "");
const { $, h } = K, phone = () => D.documentElement.classList.contains("phone-shell");
const CARDS = [
  ["This board is the tavern for the five of you: start with who you are.", ["#tn-me"], "door"],
  ["Pick how deep you want to go; change it any time up here.", ["#journey-scene", ".journey-scene", "#journey"], "signpost"],
  ["Your next step lives on this card; one tap does it.", ["#nx-card", "#tn-cards"], "note"],
  ["Leeroy answers questions here, and in Discord.", ['.pl[data-place="librarian"]', "#tab-librarian"], "alcove"],
];
const W = { done: !!get(), plan: [], i: 0 }, ART = {}, cur = () => CARDS[W.plan[W.i]];
window.__walk = Object.freeze({ status: () => ({ shown: !!W.on, card: W.on ? W.i + 1 : null, done: W.done }), skip: () => end(), next });
if (OFF) return;
/* a target holds something (an empty #tn-me had passed) */
const vis = (el) => !!el && el.isConnected && !el.closest("[hidden], [inert]") && el.getClientRects().length > 0 && !!String(el.textContent || "").trim();
const find = (c) => c[1].map((s) => $(s)).find(vis) || null;
const src = (n) => `img/companion/walk-${n}.webp`, focus = (el) => { try { el.focus({ preventScroll: true }); } catch (e) {} };
/* paintings one by one; the first missing stops the rest */
(function probe(n) { if (!n.length || !window.Image) return; const im = new Image(); im.onload = () => { ART[n[0]] = 1; if (W.on && cur()[2] === n[0]) show(); probe(n.slice(1)); }; im.src = src(n[0]); })(CARDS.map((c) => c[2]));

function begin(only) {
  const sheet = $("#scene .sheet"), a = D.activeElement;
  /* never over the seals: the walk starts once a journey is chosen */
  if (W.go || get() || !sheet || !K.SC.open || D.documentElement.classList.contains("nx-first")) return;
  /* a stored name skips card 1 */
  const plan = [0, 1, 2, 3].filter((i) => (!only || only.includes(i)) && !(i === 0 && K.MEM.me()) && find(CARDS[i])); if (!plan.length) return; /* a step whose target has no box is skipped and the count follows */
  Object.assign(W, { go: 1, on: 1, plan, scene: K.SC.open, back: a !== D.body && a, veil: h("div", { class: "walk-veil" }), card: h("section", { class: "walk-card" }) });
  W.el = h("div", { class: "walk", id: "walk", role: "dialog", "aria-modal": "true", "aria-labelledby": "walk-s" }, W.veil, W.card);
  W.el.addEventListener("keydown", onKey); sheet.appendChild(W.el);
  addEventListener("resize", queue); addEventListener("scroll", queue, true); setTimeout(queue, 600);
  show();
}
function show() {
  const n = W.plan.length; if (W.i >= n) return end();
  const c = cur(), b = (id, t, f) => h("button", { type: "button", class: id === "walk-next" ? "lib-btn strong" : "lib-btn", id, "aria-describedby": n > 1 ? "walk-s walk-n" : "walk-s", onclick: f }, t);
  W.card.replaceChildren(...[ART[c[2]] && h("img", { class: "walk-pic", src: src(c[2]), alt: "" }), h("p", { class: "walk-s", id: "walk-s", text: c[0] }),
    n > 1 && h("p", { class: "walk-n", id: "walk-n", text: `${W.i + 1} of ${n}` }), h("div", { class: "walk-act" }, b("walk-next", W.i < n - 1 ? "Next" : "Done", next), b("walk-skip", "Skip", () => end()))].filter(Boolean));
  place(); reveal(find(c)); focus($("#walk-next"));
}
function next() { if (!W.on) return; try { BoardHaptics.fire("select"); } catch (e) {} if (W.i >= W.plan.length - 1) return end(); W.i++; show(); }
function end(quiet) {
  if (!W.on) return;
  W.on = 0; W.done = true;
  try { localStorage.setItem(KEY, "1"); } catch (e) {}
  removeEventListener("resize", queue); removeEventListener("scroll", queue, true);
  const a = D.activeElement, had = W.el.contains(a); W.el.remove();
  if (K.sfx) K.sfx("latch");
  if (!quiet && (had || !a || a === D.body)) focus(W.back && vis(W.back) ? W.back : $("#sheet-body"));
}
function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return end(); }
  e.stopPropagation();
  if (e.key !== "Tab") return;
  e.preventDefault(); const l = [$("#walk-next"), $("#walk-skip")], i = l.indexOf(D.activeElement); focus(l[i < 0 ? +!!e.shiftKey : 1 - i]);
}
function queue() { if (!W.raf) W.raf = requestAnimationFrame(() => { W.raf = 0; place(); }); }
function place() {
  if (!W.on) return;
  const t = find(cur()), x = W.el.getBoundingClientRect(), r = t && t.getBoundingClientRect(), cs = W.card.style, m = 12, X = x.width, Y = x.height;
  const ok = r && r.width && r.height, L = ok && r.left - x.left - 6, T = ok && r.top - x.top - 6, R = ok && r.right - x.left + 6, B = ok && r.bottom - x.top + 6;
  /* the cutout keeps the target's rounded corners */
  const k = ok ? Math.min((parseFloat(getComputedStyle(t).borderTopLeftRadius) || 0) + 6, (R - L) / 2, (B - T) / 2) : 0, a = `A${k} ${k} 0 0 1`;
  W.veil.style.clipPath = ok ? `path(evenodd, "M0 0H${X}V${Y}H0Z M${L + k} ${T}H${R - k}${a} ${R} ${T + k}V${B - k}${a} ${R - k} ${B}H${L + k}${a} ${L} ${B - k}V${T + k}${a} ${L + k} ${T}Z")` : "";
  /* phone: the card at the foot, or at the top when its target sits there (no scroll room is added) */
  if (phone()) {
    cs.top = cs.left = cs.width = "";
    const ch = W.card.getBoundingClientRect().height || 0;
    const dn = [x.bottom - 64 - ch - 8, x.bottom - 64], up = [x.top + 8, x.top + 8 + ch], hit = (z) => ok && r.bottom > z[0] && r.top < z[1];
    W.card.classList.toggle("walk-up", hit(dn) && !hit(up));
    return;
  }
  /* fix round A6: beside the target (right or left, narrowed to the room), else below, else above; never over it */
  const rR = X - R - 2 * m, rL = L - 2 * m, room = ok ? Math.max(rR, rL) : 0, by = room >= 180;
  cs.width = by && room < 420 ? `${Math.floor(room)}px` : ""; W.card.classList.toggle("walk-slim", by && room < 320);
  const c = W.card.getBoundingClientRect(), cw = c.width || 0, ch = c.height || 0, mid = (v) => Math.max(m, Math.min(v, Y - ch - m));
  const side = by ? (rR >= rL ? R + m : L - m - cw) : null;
  cs.left = `${side != null ? side : Math.max(m, Math.min(L || 0, X - cw - m))}px`;
  cs.top = `${!ok ? m : side != null ? mid(T) : B + m + ch <= Y - m ? B + m : T - m - ch >= m ? T - m - ch : Math.max(m, Y - ch - m)}px`;
}
/* under the fold or the phone card: scroll up */
function reveal(t) {
  const y = $("#sheet-body"); if (!t || !y || !y.contains(t)) return;
  const b = y.getBoundingClientRect(), r = t.getBoundingClientRect();
  if (r.top < b.top || r.bottom > (phone() && !W.card.classList.contains("walk-up") ? W.card.getBoundingClientRect().top : b.bottom)) y.scrollTop += r.top - b.top - 8;
}

const soon = (f) => requestAnimationFrame(() => setTimeout(() => (K.hold ? K.hold.then(f, f) : f()), 0)); /* a seal still flying to its card (K.hold) finishes first */
/* a deep link: no Next steps 2 s after boot, so cards 2 and 4 */
K.on("booted", () => setTimeout(() => { W.late = 1; const k = K.SC.open; if (k && k !== "tonight") begin([1, 3]); }, 2000));
/* a scene change ends the walk */
K.on("scene", (k) => (W.on ? (k !== W.scene ? end(true) : queue()) : k === "tonight" ? soon(begin) : W.late && soon(() => begin([1, 3]))));
K.on("tonight", () => { const a = D.activeElement; if (W.on) { queue(); if (!a || a === D.body || !a.isConnected) focus($("#walk-next")); } else if (K.SC.open === "tonight") soon(begin); });
K.on("closed", () => end(true));
})();
