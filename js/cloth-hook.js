(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const rail = document.getElementById("tabs"); if (!rail) return;
const PHONE_MQ = "(max-width: 699px), ((max-height: 500px) and (orientation: landscape) and (pointer: coarse))";
const CLOTH_COLOURS = { timeline: "indigo", five: "royal", roads: "burnt-orange", racials: "crimson", legacy: "copper", buffs: "plum", ledger: "wine", signups: "forest", decide: "olive", library: "ochre", librarian: "slate", tonight: "teal" };
const SPARE = Object.values(CLOTH_COLOURS);
const mq = (q) => { try { return window.matchMedia(q); } catch (e) { return { matches: false, addEventListener() {} }; } };
const reduceMQ = mq("(prefers-reduced-motion: reduce)"), phoneMQ = mq(PHONE_MQ), forcedMQ = mq("(forced-colors: active)");
const root = document.documentElement, lay = document.getElementById("scene");
let ctl = null, canvas = null, loading = false, gen = 0, ro = null, px = null, ptype = "";
const sheet = rail.closest(".sheet");

const stub = { status: () => ({ on: false, gl: null, textures: 0, running: false, frame: { last: 0, p95: 0 }, kicks: 0, banners: [] }), kick() {}, destroy() { stop(); } };
window.__cloth = { status: (q) => (ctl || stub).status(q), kick: (k, p, d) => (ctl || stub).kick(k, p, d), destroy: () => (ctl ? ctl.destroy() : stop()) };

const allowed = () => !reduceMQ.matches && !phoneMQ.matches && !forcedMQ.matches && document.hidden !== true && !root.classList.contains("play");
const tabList = () => Array.from(rail.querySelectorAll(".tab")).map((el, i) => { const key = el.getAttribute("data-tab") || String(i); return { key, el, label: el.textContent.trim(), colour: CLOTH_COLOURS[key] || SPARE[i % SPARE.length] }; });
const idle = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 2500 }) : setTimeout(f, 300));
const shut = () => !lay || lay.hidden || lay.classList.contains("closing");

const clear = () => {
  const b = document.getElementById("sheet-body"), t = rail.querySelector(".tab"), c = lay && getComputedStyle(lay), n = (k) => parseFloat(c.getPropertyValue(k)) || 0;
  if (!b || !t || lay.hidden || phoneMQ.matches) return lay.style.removeProperty("--rail-pad");
  lay.style.setProperty("--rail-pad", Math.ceil(t.getBoundingClientRect().top + n("--ribbon-rod") + n("--ribbon-rest") + 22 - b.getBoundingClientRect().top) + "px");
};
const show = () => { const on = !!ctl && ctl.layout() !== false; root.classList.toggle("cloth-gl", on); root.classList.toggle("cloth-paint", !on); root.classList.toggle("ribbons-on", !phoneMQ.matches && !forcedMQ.matches); clear(); };
function start() {
  if (ctl || loading || !allowed()) { show(); return; }
  loading = true; const my = ++gen;
  if (!canvas) { canvas = document.createElement("canvas"); canvas.setAttribute("id", "tab-cloth"); canvas.setAttribute("aria-hidden", "true"); canvas.style.pointerEvents = "none"; sheet.appendChild(canvas); }
  const mod = window.__clothModule ? Promise.resolve(window.__clothModule) : import("../cloth/cloth.js?v=1ed2bbf592");
  mod.then((m) => {
    loading = false; if (my !== gen || !allowed()) return;
    const c = m.createCloth({ canvas, rail, sheet, tabs: tabList(), onReady: relay, onLost: () => { ctl = null; show(); } });
    if (!c) throw new Error("no webgl");
    ctl = c; show(); watch();
  }).catch(() => { loading = false; ctl = null; show(); });
}
function stop() { gen++; loading = false; if (ctl) { try { ctl.destroy(); } catch (e) {} ctl = null; } show(); if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; } }

let watching = false, relayRaf = 0;
const relay = () => { if (relayRaf) return; relayRaf = requestAnimationFrame(() => setTimeout(() => { relayRaf = 0; if (ctl && !shut()) show(); })); };
function watch() {
  if (typeof ResizeObserver === "function" && !ro) { ro = new ResizeObserver(relay); ro.observe(rail); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relay);
  if (watching) return; watching = true;
  window.addEventListener("resize", relay);
  rail.addEventListener("pointerdown", (e) => { ptype = e.pointerType; });
  rail.addEventListener("pointermove", (e) => {
    if (!ctl || e.pointerType === "touch") return;
    const r = sheet.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, n = performance.now();
    let vx = 0; if (px) { vx = ((x - px.x) / Math.max(8, n - px.n)) * 1000; } ctl.pointer(x, y, vx, px ? px.x : null); px = { x, n };
  });
  rail.addEventListener("pointerleave", () => { px = null; if (ctl) ctl.leave(); });
  rail.addEventListener("focusin", (e) => { const t = e.target; if (!ctl || !t || !t.closest) return; const tab = t.closest(".tab"); if (!tab) return; let vis = true; try { vis = tab.matches(":focus-visible"); } catch (x) {} ctl.focus(tab.getAttribute("data-tab"), vis); });
  rail.addEventListener("focusout", () => { if (ctl) ctl.blur(); });
  rail.addEventListener("scroll", relay);
  K.on("scene", (key, prev) => {
    if (!ctl) return; ctl.scene(key, prev); relay();
    if (key && prev && key !== prev) { if (K.sfx) K.sfx("unfurl"); if (ptype === "touch" && window.BoardHaptics) window.BoardHaptics.fire("select"); }
    ptype = "";
  });
  if (typeof MutationObserver === "function") new MutationObserver(() => { if (ctl && shut()) ctl.scene(null); }).observe(lay, { attributes: true, attributeFilter: ["class", "hidden"] });
}
const change = () => { if (allowed()) idle(start); else stop(); };
for (const q of [reduceMQ, phoneMQ, forcedMQ]) { if (q.addEventListener) q.addEventListener("change", change); }
addEventListener("board-mode", change);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !ctl) change(); });
show(); idle(start);
})();
