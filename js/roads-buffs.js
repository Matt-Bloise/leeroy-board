/* Cinematic slice 6: Buffs and roads. A hook on the board kit; board.js is not edited.
   Roads: name cards under the emblems and quieter lines are CSS (css/roads-buffs.css); the road card is scenes/place.js, fixed there.
   Buffs: a plain "who buffs whom" list sits above the long list, and a level change gives a light haptic tick (only when the person has Haptics on in Sensory;
   js/haptics.js already stays silent under reduced motion unless they switched it on themselves).
   The pure parts are in roads-buffs-core.js (unit-tested). Nothing here animates. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const root = document.documentElement;
let core = null;
const loadCore = () => (core ? Promise.resolve(core) : import("./roads-buffs-core.js?v=beb92990cb").then((m) => (core = m)).catch(() => null));
const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "text") n.textContent = v; else n.setAttribute(k, v); } for (const c of kids) if (c) n.append(c); return n; };

/* ---------- Roads ----------
   The road card itself is scenes/place.js (hover, focus, tap; placed beside its anchor). This file only marks the map so the CSS can quiet the lines. */
K.on("map", (ctx) => { K.lastMap = ctx; root.classList.add("rb-roads"); });

/* ---------- Buffs ---------- */
let lastLevel = null;
const box = () => document.getElementById("buffs-deep");
function glanceBlock() {
  const b = box(), D = K.D; if (!b || !core || !D || !D.client || !D.client.buffs || !D.party) return;
  const lvl = b.querySelector("#deep-level"), L = lvl ? Number(lvl.value) : 60;
  const sixth = !!(b.querySelector("#deep-sixth") || {}).checked;
  const list = D.client.buffs.list.filter((x) => x.at && x.at[L - 1]);
  const rows = core.glance(list, D.party.members, { sixth });
  const old = b.querySelector(".bw-glance"); if (old) old.remove();
  const ul = el("ul", { class: "bw-rows" }, ...rows.map((r) => el("li", { class: "bw-row", style: `--bc: var(--c-${r.cls}, var(--brass))` },
    el("b", { class: "bw-giver", text: r.giver }), el("span", { class: "bw-arrow", "aria-hidden": "true", text: "buffs" }), el("b", { class: "bw-to", text: r.to }), el("span", { class: "bw-what", text: r.buffs.join(", ") }))));
  const sec = el("section", { class: "bw-glance", "aria-labelledby": "bw-h" }, el("h4", { id: "bw-h", text: `Who buffs whom at level ${L}` }), rows.length ? ul : el("p", { class: "bw-none", text: "Nobody has a buff to give yet at this level." }));
  const anchor = b.querySelector(".deep-key");
  if (anchor) anchor.after(sec); else b.append(sec);
}
function watchBuffs() {
  const b = box(); if (!b || b.dataset.rbWired) return; b.dataset.rbWired = "1";
  const mo = new MutationObserver(() => { mo.disconnect(); try { glanceBlock(); } finally { mo.observe(b, { childList: true }); } });
  loadCore().then(() => { mo.observe(b, { childList: true }); glanceBlock(); const s = b.querySelector("#deep-level"); lastLevel = s ? Number(s.value) : null; });
  const tick = (next) => {
    if (!core) return;
    const w = core.hapticFor(lastLevel, next, (K.D && K.D.client && K.D.client.buffs.marks) || [20, 40, 60]);
    lastLevel = next;
    if (w) { try { if (window.BoardHaptics) window.BoardHaptics.fire(w); } catch (e) {} }
  };
  b.addEventListener("input", (e) => { if (e.target && e.target.id === "deep-level") tick(Number(e.target.value)); });
  b.addEventListener("click", (e) => { const m = e.target.closest && e.target.closest(".deep-marks button"); if (m) tick(Number(m.textContent)); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchBuffs); else watchBuffs();
K.on("scene", (key) => { if (key === "buffs") watchBuffs(); });
})();
