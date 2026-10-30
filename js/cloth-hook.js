/* Cloth banners for the tab rail (mobile contract section 8). Full note: board/MOBILE-NOTES.md, file notes. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const rail = document.getElementById("tabs"); if (!rail) return;
const PHONE_MQ = "(max-width: 699px), ((max-height: 500px) and (orientation: landscape) and (pointer: coarse))";
/* scene to banner colour (mirrored in css/cloth.css) */
const CLOTH_COLOURS = { timeline: "indigo", five: "royal", roads: "burnt-orange", racials: "crimson", legacy: "copper", buffs: "plum", ledger: "wine", signups: "forest", decide: "olive", library: "ochre", librarian: "slate", tonight: "teal" };
const SPARE = Object.values(CLOTH_COLOURS);
const mq = (q) => { try { return window.matchMedia(q); } catch (e) { return { matches: false, addEventListener() {} }; } };
const reduceMQ = mq("(prefers-reduced-motion: reduce)"), phoneMQ = mq(PHONE_MQ), forcedMQ = mq("(forced-colors: active)");
const root = document.documentElement;
let ctl = null, canvas = null, loading = false, gen = 0, ro = null, px = null;

const stub = { status: () => ({ on: false, gl: null, textures: 0, running: false, frame: { last: 0, p95: 0 }, kicks: 0, banners: [] }), kick() {}, destroy() { stop(); } };
window.__cloth = { status: () => (ctl || stub).status(), kick: (k, p, d) => (ctl || stub).kick(k, p, d), destroy: () => (ctl ? ctl.destroy() : stop()) };

const allowed = () => !reduceMQ.matches && !phoneMQ.matches && !forcedMQ.matches && document.hidden !== true;
const tabList = () => Array.from(rail.querySelectorAll(".tab")).map((el, i) => { const key = el.getAttribute("data-tab") || String(i); return { key, el, colour: CLOTH_COLOURS[key] || SPARE[i % SPARE.length] }; });
const idle = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 2500 }) : setTimeout(f, 300));
const loadImg = (name) => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error(name)); im.src = `img/banners/${name}.webp`; });
const decoded = (name) => loadImg(name).then((im) => (im.decode ? im.decode().catch(() => {}).then(() => im) : im));

function start() {
  if (ctl || loading || !allowed()) return;
  loading = true; const my = ++gen;
  if (!canvas) { canvas = document.createElement("canvas"); canvas.setAttribute("id", "tab-cloth"); canvas.setAttribute("aria-hidden", "true"); canvas.style.pointerEvents = "none"; rail.insertBefore(canvas, rail.firstChild); }
  const tabs = tabList(), names = Array.from(new Set(tabs.map((t) => t.colour)));
  const mod = import("../cloth/cloth.js?v=a87244af88");
  Promise.all([mod, Promise.all(names.map(decoded))]).then(([m, ims]) => {
    loading = false; if (my !== gen || !allowed()) return;
    const byName = {}; names.forEach((n, i) => { byName[n] = ims[i]; });
    const images = {}; tabs.forEach((t) => { images[t.key] = byName[t.colour]; });
    const c = m.createCloth({ canvas, rail, tabs, images, tokens: { warm: getComputedStyle(root).getPropertyValue("--light-warm") }, onLost: () => { ctl = null; root.classList.remove("cloth-gl"); } });
    if (!c) throw new Error("no webgl");
    ctl = c; root.classList.add("cloth-gl"); watch();
  }).catch(() => { loading = false; ctl = null; root.classList.remove("cloth-gl"); });
}
function stop() { gen++; loading = false; if (ctl) { try { ctl.destroy(); } catch (e) {} ctl = null; } root.classList.remove("cloth-gl"); if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; } }

let watching = false, relayRaf = 0;
const relay = () => { if (relayRaf) return; relayRaf = requestAnimationFrame(() => { relayRaf = 0; if (ctl) ctl.layout(); }); };
function watch() {
  if (typeof ResizeObserver === "function" && !ro) { ro = new ResizeObserver(relay); ro.observe(rail); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relay);
  if (watching) return; watching = true;
  window.addEventListener("resize", relay);
  rail.addEventListener("pointermove", (e) => {
    if (!ctl || e.pointerType === "touch") return;
    const r = rail.getBoundingClientRect(), x = e.clientX - r.left + rail.scrollLeft, y = e.clientY - r.top, n = performance.now();
    let vx = 0; if (px) { vx = ((x - px.x) / Math.max(8, n - px.n)) * 1000; } ctl.pointer(x, y, vx, px ? px.x : null); px = { x, n };
  });
  rail.addEventListener("pointerleave", () => { px = null; if (ctl) ctl.leave(); });
  rail.addEventListener("focusin", (e) => { const t = e.target; if (!ctl || !t || !t.closest) return; const tab = t.closest(".tab"); if (!tab) return; let vis = true; try { vis = tab.matches(":focus-visible"); } catch (x) {} ctl.focus(tab.getAttribute("data-tab"), vis); });
  rail.addEventListener("focusout", () => { if (ctl) ctl.blur(); });
  K.on("scene", (key, prev) => { if (ctl) ctl.scene(key, prev); });
}
const change = () => { if (allowed()) idle(start); else stop(); };
for (const q of [reduceMQ, phoneMQ, forcedMQ]) { if (q.addEventListener) q.addEventListener("change", change); }
document.addEventListener("visibilitychange", () => { if (!document.hidden && !ctl) change(); });
idle(start);
})();
