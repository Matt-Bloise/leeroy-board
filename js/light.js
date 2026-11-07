/* Cinematic slice 4: Light. One soft warm lamp that follows the pointer (or the phone's tilt) and a warm specular rim on the crests.
   Pure math lives in BoardLight.math (unit tested). The lamp is a single fixed element moved with transform only; rAF runs only while the light is still travelling to the pointer,
   and stops when it arrives or the tab is hidden. Off (element absent) under prefers-reduced-motion, html.calm/still/play, or the user's Calm light switch
   (localStorage "board-light-calm", read and written inside try/catch). OLED: the lamp is candle gold at low alpha, never a large bright field. */
(() => {
"use strict";
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const math = {
  clamp,
  // pointer in px -> light vector in [-1, 1] on both axes (centre = 0)
  vector(px, py, w, h) { w = Math.max(1, num(w)); h = Math.max(1, num(h)); return { x: clamp((num(px) / w) * 2 - 1, -1, 1), y: clamp((num(py) / h) * 2 - 1, -1, 1) }; },
  // device orientation (degrees, relative to the resting pose) -> vector; same scale as js/tilt.js (18 deg across, 14 deg down)
  fromTilt(gamma, beta, g0, b0) { return { x: clamp((num(gamma) - num(g0)) / 18, -1, 1), y: clamp((num(beta) - num(b0)) / 14, -1, 1) }; },
  // vector -> lamp centre in px, always inside the viewport
  lampAt(v, w, h) { return { x: clamp((num(v.x) + 1) / 2, 0, 1) * num(w), y: clamp((num(v.y) + 1) / 2, 0, 1) * num(h) }; },
  // frame-rate independent ease; k = fraction closed per 16.7 ms
  ease(cur, target, dtMs, k) { const f = 1 - Math.pow(1 - clamp(num(k), 0, 1), clamp(num(dtMs), 1, 100) / 16.7); return cur + (target - cur) * f; },
  quant(v, step) { return Math.round(num(v) / step) * step; },
  // is the moving light allowed at all
  active(s) { return !(s && (s.reduced || s.calmUser || s.calmHtml || s.hidden)); },
};
if (typeof module !== "undefined" && module.exports) module.exports = { math };
if (typeof window === "undefined" || typeof document === "undefined") return;

const KEY = "board-light-calm", html = document.documentElement;
const get = () => { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } };
const put = (on) => { try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch (e) {} };
const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const S = { calmUser: get(), lamp: null, raf: 0, last: 0, tx: 0.3, ty: 0.2, x: 0.3, y: 0.2, qx: 0, qy: 0, tilt: false, tiltMoved: false, linked: false };
const state = () => ({ reduced: !!(mq && mq.matches), calmUser: S.calmUser, calmHtml: /(^|\s)(calm|still|play)(\s|$)/.test(html.className), hidden: false });
const allowed = () => math.active(state());

function setVars(v) {
  const qx = math.quant(v.x, 0.1), qy = math.quant(v.y, 0.1);
  if (qx === S.qx && qy === S.qy) return;
  S.qx = qx; S.qy = qy;
  html.style.setProperty("--lx", qx.toFixed(1)); html.style.setProperty("--ly", qy.toFixed(1));
}
function paint() {
  S.raf = 0;
  if (!S.lamp || !allowed() || document.hidden) return;
  const t = performance.now(), dt = S.last ? t - S.last : 16.7; S.last = t;
  S.x = math.ease(S.x, S.tx, dt, 0.18); S.y = math.ease(S.y, S.ty, dt, 0.18);
  const p = math.lampAt({ x: S.x, y: S.y }, innerWidth, innerHeight);
  S.lamp.style.transform = "translate3d(" + (p.x - 160).toFixed(1) + "px," + (p.y - 160).toFixed(1) + "px,0)";
  setVars({ x: S.x, y: S.y });
  if (Math.abs(S.tx - S.x) > 0.002 || Math.abs(S.ty - S.y) > 0.002) S.raf = requestAnimationFrame(paint); else S.last = 0;
}
function wake() { if (!S.raf && S.lamp && allowed() && !document.hidden) { S.last = 0; S.raf = requestAnimationFrame(paint); } }
function aim(v) { S.tx = v.x; S.ty = v.y; if (S.lamp) S.lamp.classList.add("lit"); wake(); }
function stop() { if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } S.last = 0; }

function sync() {
  const ok = allowed();
  html.classList.toggle("light-off", !ok);
  if (!ok) { stop(); if (S.lamp) { S.lamp.remove(); S.lamp = null; } html.style.removeProperty("--lx"); html.style.removeProperty("--ly"); S.qx = S.qy = 0; return; }
  if (!S.lamp && document.body) {
    const d = document.createElement("div"); d.id = "lamp"; d.setAttribute("aria-hidden", "true");
    document.body.appendChild(d); S.lamp = d;
    const p = math.lampAt({ x: S.x, y: S.y }, innerWidth, innerHeight); d.style.transform = "translate3d(" + (p.x - 160) + "px," + (p.y - 160) + "px,0)";
  }
  if (document.hidden) stop();
}
function button() {
  const b = document.getElementById("light-calm"); if (!b) return;
  const paintBtn = () => { b.setAttribute("aria-pressed", String(S.calmUser)); b.textContent = S.calmUser ? "Light: calm" : "Light: warm"; };
  paintBtn();
  b.addEventListener("click", () => { S.calmUser = !S.calmUser; put(S.calmUser); paintBtn(); sync(); });
}
function link() {
  const BT = window.BoardTilt; if (!BT || S.linked) return; S.linked = true;
  BT.on((d) => { const on = !!BT.status().on; if (!on) { S.tilt = false; S.tiltMoved = false; return; } if (!S.tiltMoved && !d.x && !d.y) return; S.tilt = S.tiltMoved = true; if (allowed()) aim({ x: clamp(d.x, -1, 1), y: clamp(d.y, -1, 1) }); });
}
function boot() {
  sync(); button();
  addEventListener("pointermove", (e) => { if (!allowed()) return; if (e.pointerType === "mouse") { S.tilt = S.tiltMoved = false; } else if (S.tilt) return; aim(math.vector(e.clientX, e.clientY, innerWidth, innerHeight)); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  if (mq) { try { mq.addEventListener("change", sync); } catch (e) {} }
  if (typeof MutationObserver === "function") new MutationObserver(sync).observe(html, { attributes: true, attributeFilter: ["class"] });
  link(); addEventListener("load", link);
}
window.BoardLight = Object.freeze({ math, calm: (v) => { if (typeof v === "boolean") { S.calmUser = v; put(v); sync(); } return S.calmUser; } });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
