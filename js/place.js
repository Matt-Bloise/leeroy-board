/* One hover language for the whole board (owner, 2026-10-29: cards must never cover what you are pointing at).
   Runs after js/board.js and js/v13d.js through window.__boardKit. Everything a pointer, a finger or the keyboard can reveal goes through here:
   1. focus plus context: the item you point at stays fully lit and lifts, its siblings dim a little, connected items light together (hover.css)
   2. details open after a short intent delay (120 ms in, 200 ms out), in a spot chosen from candidates (right, left, below, above, corners, then
      the emptiest free spot) that never meets the trigger, its row or its neighbours, and prefers empty space over text and buttons
   3. keyboard focus does what hover does; a tap pins the card, a second tap, a tap elsewhere or Escape closes it
   4. the pointer may travel from the trigger to its card (a safe hull between them keeps the card open)
   5. prefers-reduced-motion: the cards fade, nothing slides (hover.css)
   Spec and audit: board/tools/harness/hover-audit.mjs */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h } = K;
const IN = 120, OUT = 200, SWITCH = 80;
const reduced = () => K.reduceMQ.matches;
const coarse = () => innerWidth < 700 || matchMedia("(pointer: coarse)").matches;

/* ---------------- geometry ---------------- */
const box = (x, y, w, ht) => ({ x, y, w, h: ht, r: x + w, b: y + ht });
const R = (el) => { const r = el.getBoundingClientRect(); return box(r.left, r.top, r.width, r.height); };
const grow = (a, p) => box(a.x - p, a.y - p, a.w + 2 * p, a.h + 2 * p);
const lap = (a, b) => { const ox = Math.min(a.r, b.r) - Math.max(a.x, b.x), oy = Math.min(a.b, b.b) - Math.max(a.y, b.y); return ox > 0 && oy > 0 ? ox * oy : 0; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
const isShown = (el) => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

/* the trigger's row: the whole line of text a word sits in, else the list row, else the trigger itself */
function rowRect(t) {
  const r = R(t);
  if (typeof SVGElement !== "undefined" && t instanceof SVGElement) return r;
  if (getComputedStyle(t).display === "inline") {
    let blk = t.parentElement; while (blk && getComputedStyle(blk).display === "inline") blk = blk.parentElement;
    const rs = [...t.getClientRects()], top = Math.min(...rs.map((q) => q.top)), bot = Math.max(...rs.map((q) => q.bottom));
    if (blk) { const b = R(blk); return box(b.x, top, b.w, bot - top); }
  }
  const li = t.closest("li, tr, .bq"); if (li && li !== t) { const l = R(li); if (l.w < innerWidth * 0.92) return l; }
  return r;
}

/* what a reader may want to see under a card: text blocks, buttons, links, cards, the map. Leaves only, so nothing counts twice. */
const CONTENT = "p, li, h1, h2, h3, h4, h5, summary, label, input, select, textarea, button, a[href], .tt, .gl, .sp-tt, .card, figure, img, td, dt, dd, svg, canvas";
function contentRects(scope, bounds, skip) {
  const all = [...scope.querySelectorAll(CONTENT)], parent = new Set();
  for (const el of all) { const p = el.parentElement && el.parentElement.closest(CONTENT); if (p && !p.matches("svg, canvas")) parent.add(p); }
  const out = [];
  for (const el of all) {
    if (parent.has(el)) continue;
    if (skip && (skip === el || skip.contains(el) || el.contains(skip))) continue;
    if (el.closest("svg") && !el.matches("svg")) continue;
    const q = R(el); if (q.w < 4 || q.h < 4 || lap(q, bounds) <= 0) continue;
    out.push({ ...q, wt: el.matches("svg, canvas, img") ? 0.6 : 1 });
  }
  return out;
}

const SIDES = ["right", "left", "below", "above", "below-right", "below-left", "above-right", "above-left"];
/* choose(w, h, trigger rect, opts): the best x, y for a card of w by h in viewport coordinates.
   opts: bounds (rect the card must stay in), row (trigger's row), avoid (rects that must stay clear), anchors (extra rects to place around),
   content (rects to cover as little as possible), gap, margin */
function choose(w, ht, tr, o) {
  const B = o.bounds, g = o.gap == null ? 10 : o.gap, row = o.row || tr;
  const hard = [grow(tr, 4), grow(row, 2), ...(o.avoid || []).map((a) => grow(a, 2))];
  const content = o.content || [];
  const cx = tr.x + tr.w / 2, cy = tr.y + tr.h / 2;
  const cost = (c, pri, shift) => {
    let hardLap = 0; for (const a of hard) hardLap += lap(c, a);
    let soft = 0; for (const q of content) soft += lap(c, q) * (q.wt || 1);
    const d = Math.hypot(c.x + c.w / 2 - cx, c.y + c.h / 2 - cy);
    return { hardLap, soft, total: hardLap * 1000 + soft + shift * 30 + d * 0.4 + pri * 40 };
  };
  const tries = [];
  const around = (a, tag) => {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const pos = [[a.r + g, ay - ht / 2], [a.x - g - w, ay - ht / 2], [a.x, a.b + g], [a.x, a.y - g - ht], [a.r + g, a.b + g], [a.x - g - w, a.b + g], [a.r + g, a.y - g - ht], [a.x - g - w, a.y - g - ht], [ax - w / 2, a.b + g], [ax - w / 2, a.y - g - ht]];
    pos.forEach(([x, y], i) => tries.push({ side: SIDES[i] || "center", x, y, pri: i + (tag ? 1 : 0) }));
  };
  around(row); for (const a of o.anchors || []) around(a, 1);
  let best = null;
  const consider = (t) => {
    const x = clamp(t.x, B.x, B.r - w), y = clamp(t.y, B.y, B.b - ht), c = box(x, y, w, ht);
    const k = cost(c, t.pri, Math.abs(x - t.x) + Math.abs(y - t.y));
    if (!best || k.total < best.total) best = { x, y, side: t.side, ...k };
  };
  tries.forEach(consider);
  /* nothing clean next to it: scan the bounds for the emptiest spot nearest the trigger */
  if (!best || best.hardLap > 0 || best.soft > 900) {
    const step = Math.max(12, Math.round(Math.min(B.w, B.h) / 40));
    for (let y = B.y; y <= B.b - ht + 0.5; y += step) for (let x = B.x; x <= B.r - w + 0.5; x += step) consider({ side: "free", x, y, pri: 6 });
  }
  return best || { x: B.x, y: B.y, side: "none", hardLap: 0, soft: 0 };
}

/* the card sits in .sheet (absolute) or on the page (fixed); put it where choose() says, in the host's own coordinates */
function setPos(card, x, y) {
  const host = getComputedStyle(card).position === "fixed" ? { x: 0, y: 0 } : (card.offsetParent ? R(card.offsetParent) : { x: 0, y: 0 });
  card.style.left = `${Math.round(x - host.x)}px`; card.style.top = `${Math.round(y - host.y)}px`;
}
/* the siblings a card must also stay off: other triggers of the same family in the same list or map */
function siblingsOf(t, sel) {
  const c = t.closest("ul, ol, .spells, .map-box, .roads-legend, .wheel, .cal-col, .races, .tn-cards, .bclass") || t.parentElement;
  return c ? [...c.querySelectorAll(sel)].filter((e) => e !== t && !e.contains(t) && !t.contains(e) && isShown(e)).map(R) : [];
}
function visibleBounds(pad = 8) {
  const body = $("#sheet-body"), sheet = $(".sheet");
  const inScene = sheet && !$("#scene").hidden;
  const b = inScene ? R(body || sheet) : box(0, 0, innerWidth, innerHeight);
  const lib = inScene && $("#lib-q") && $("#panel-library") && !$("#panel-library").hidden ? $("#lib-q").closest(".lib-bar") : null;
  const top = lib ? Math.max(b.y, R(lib).b + 6) : b.y;
  const x = Math.max(0, b.x) + pad, y = Math.max(0, top) + pad, r = Math.min(innerWidth, b.r) - pad, bt = Math.min(innerHeight, b.b) - pad;
  return box(x, y, r - x, bt - y);
}

/* a bottom (or top) dock for small screens and touch: the side that leaves the trigger and its neighbours clear, scrolling the list when it must */
function dock(card, t, avoid) {
  const body = $("#sheet-body"), sh = $(".sheet");
  if (!body || !sh) return;
  const bb = R(body), ch = card.offsetHeight, tr = R(t);
  const dockTop = bb.y + 6;
  card.classList.add("sheetmode"); card.style.left = ""; card.style.right = "";
  const bottomBox = box(bb.x, R(sh).b - ch, bb.w, ch), topBox = box(bb.x, dockTop, bb.w, ch);
  const hitB = lap(grow(tr, 6), bottomBox) + (avoid || []).reduce((n, a) => n + lap(a, bottomBox), 0), hitT = lap(grow(tr, 6), topBox) + (avoid || []).reduce((n, a) => n + lap(a, topBox), 0);
  const up = hitT < hitB && hitB > 0;
  card.classList.toggle("dock-top", up);
  if (up) { card.style.top = `${Math.round(dockTop - R(sh).y)}px`; card.style.bottom = "auto"; } else { card.style.top = ""; card.style.bottom = ""; }
  /* the trigger must stay in sight on the open side of the screen */
  const room = up ? { lo: dockTop + ch + 10, hi: bb.b - 10 } : { lo: bb.y + 10, hi: R(sh).b - ch - 10 };
  let dy = 0; if (tr.b > room.hi) dy = tr.b - room.hi; else if (tr.y < room.lo) dy = tr.y - room.lo;
  if (dy) body.scrollTo({ top: body.scrollTop + dy, behavior: "auto" });
}

/* ---------------- the cards the board already has ---------------- */
/* #ttc: the spell, item and glossary card of the library and the five */
function placeCard(card, t) {
  const sheet = $(".sheet");
  card.classList.toggle("sheetmode", coarse());
  card.classList.remove("dock-top");
  if (coarse()) { card.style.left = ""; card.style.top = ""; dock(card, t, siblingsOf(t, ".tt, .gl, .sp-tt")); return; }
  card.style.bottom = "";
  const B = visibleBounds(10), w = card.offsetWidth, ht = card.offsetHeight;
  const scope = $("#sheet-body") || sheet;
  const pos = choose(w, ht, R(t), { bounds: B, row: rowRect(t), avoid: siblingsOf(t, ".sp-tt, .tt, .gl"), content: contentRects(scope, B, card) });
  setPos(card, pos.x, pos.y);
  card.dataset.side = pos.side;
}
K.placeCard = placeCard;

/* #glpop: the plain-word card outside the library */
K.placePop = (pop, t) => {
  const B = visibleBounds(10), w = pop.offsetWidth, ht = pop.offsetHeight;
  const scope = $("#scene .sheet") || document.body;
  const pos = choose(w, ht, R(t), { bounds: box(8, 8, innerWidth - 16, innerHeight - 16), row: rowRect(t), avoid: siblingsOf(t, ".gl"), content: contentRects(scope, B, pop) });
  pop.style.left = `${Math.round(pos.x)}px`; pop.style.top = `${Math.round(pos.y)}px`;
};

/* ---------------- intent controller ---------------- */
const pt = { x: -1, y: -1 };
/* a card opens on focus only for a keyboard user: script focus (a tab opening a scene) and a click's focus stay quiet */
let keyMode = false;
addEventListener("keydown", () => { keyMode = true; }, true);
addEventListener("pointerdown", () => { keyMode = false; }, true);
addEventListener("pointermove", (e) => { pt.x = e.clientX; pt.y = e.clientY; }, { passive: true, capture: true });
function hull(points) { /* convex hull, monotone chain */
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y), cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x), lo = [], up = [];
  for (const q of p) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length > 1 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function inside(poly, q) { for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if ((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) < -6) return false; } return true; }
/* hover({root, sel, open(t, via), close(), card(), pinned(), isOpen(), enter(t), leave(t)}) */
function hover(c) {
  let inT = 0, outT = 0, cur = null, left = null;
  const cardEl = () => (c.card ? c.card() : null);
  const finish = () => { outT = 0; if (c.pinned && c.pinned()) return; const el = cardEl(); if (el && !el.hidden) { if (el.matches(":hover")) return; if (left && Date.now() - left.t < 900 && inside(hull([left.p, ...corners(R(el))]), pt)) { arm(110); return; } } cur = null; c.leave && c.leave(null); c.close(); };
  const corners = (r) => [{ x: r.x, y: r.y }, { x: r.r, y: r.y }, { x: r.x, y: r.b }, { x: r.r, y: r.b }];
  const arm = (ms) => { clearTimeout(outT); outT = setTimeout(finish, ms); };
  c.root.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const t = e.target.closest && e.target.closest(c.sel); if (!t) return;
    clearTimeout(outT); outT = 0; clearTimeout(inT); left = null;
    if (c.enter) c.enter(t);
    if (cur === t) return;
    inT = setTimeout(() => { if (!t.isConnected || !t.matches(":hover")) return; cur = t; c.open(t, "hover"); }, c.isOpen && c.isOpen() ? SWITCH : IN);
  });
  c.root.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const t = e.target.closest && e.target.closest(c.sel); if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return;
    clearTimeout(inT); left = { p: { x: e.clientX, y: e.clientY }, t: Date.now() };
    if (cur === t || (c.isOpen && c.isOpen())) arm(OUT); else if (c.leave) c.leave(t);
  });
  c.root.addEventListener("focusin", (e) => { const t = e.target && e.target.closest && e.target.closest(c.sel); if (!t || !(keyMode || c.focusAlways)) return; clearTimeout(outT); clearTimeout(inT); if (c.enter) c.enter(t); cur = t; c.open(t, "focus"); });
  c.root.addEventListener("focusout", (e) => { const t = e.target && e.target.closest && e.target.closest(c.sel); if (!t) return; const el = cardEl(); if (el && el.contains(e.relatedTarget)) return; left = null; if (!(c.pinned && c.pinned())) arm(OUT); });
  const el0 = () => { const el = cardEl(); if (el && !el.dataset.hb) { el.dataset.hb = "1"; el.addEventListener("pointerenter", () => { clearTimeout(outT); outT = 0; }); el.addEventListener("pointerleave", (e) => { if (e.pointerType === "touch") return; left = null; if (!(c.pinned && c.pinned())) arm(OUT); }); } };
  const o0 = c.open; c.open = (t, via) => { el0(); return o0(t, via); };
  return { cancel() { clearTimeout(inT); clearTimeout(outT); cur = null; } };
}

/* ---------------- spell, item and glossary cards (library, the five) ---------------- */
function tooltips() {
  const lib = $("#panel-library"), five = $("#panel-five"), ttc = $("#ttc"); if (!ttc) return;
  const TT = K.TT;
  /* the old mouseover/out handlers are replaced by this controller: stop them before they run */
  for (const p of [lib, five].filter(Boolean)) for (const ev of ["mouseover", "mouseout"]) p.addEventListener(ev, (e) => { if (e.target.closest && e.target.closest(".tt, .gl, .sp-tt")) e.stopImmediatePropagation(); }, true);
  if (lib) hover({ focusAlways: true, root: lib, sel: ".tt, .gl", card: () => ttc, open: (t, via) => { if (K.ttShow) K.ttShow(t, false); }, close: () => { if (!TT.pinned) K.ttClose(); }, pinned: () => TT.pinned, isOpen: () => TT.open });
  if (five && K.spellShow) hover({ focusAlways: true, root: five, sel: ".sp-tt", card: () => ttc, open: (t) => K.spellShow(t, false), close: () => { if (!TT.pinned) K.ttClose(); }, pinned: () => TT.pinned, isOpen: () => TT.open });
}

/* the plain-word card outside the library (#glpop): hover and focus open it, a click pins it */
function glossary() {
  const pop = $("#glpop"); if (!pop || !K.glShow || !K.GL) return;
  let pinned = false;
  const sel = ".gl[data-term]";
  const scope = document.body;
  hover({ root: scope, sel, card: () => pop, open: (t, via) => { if (K.GL.open !== t) { pinned = false; K.glShow(t); } }, close: () => { if (!pinned) K.glClose(); }, pinned: () => pinned, isOpen: () => !pop.hidden });
  /* a click on a word its hover already opened pins it instead of closing it */
  addEventListener("click", (e) => { const b = e.target && e.target.closest && e.target.closest(sel); if (!b || pop.hidden) return; if (K.GL.open === b && !pinned) { pinned = true; e.stopImmediatePropagation(); e.preventDefault(); return; } pinned = false; }, true);
  K.sceneHooks.push(() => { pinned = false; });
}

/* ---------------- Three roads ---------------- */
/* renderMap draws again on a resize; the listeners are set once and read the current map from RM */
const RM = { M: null, wired: false };
function roads(M) {
  const svg = M.svg, panel = $("#panel-roads"), legend = $("#roads-legend"), sheet = $(".sheet"); if (!panel || !legend || !sheet) return;
  RM.M = M;
  /* no native tooltips on the pins: the card below says it, and a title tooltip lands wherever the browser likes */
  svg.querySelectorAll(".map-pin").forEach((p) => { const t = Array.from(p.children).find((c) => c.tagName.toLowerCase() === "title"); if (t) { p.setAttribute("data-who", t.textContent); (t.parentNode && t.parentNode.removeChild(t)); } });
  /* Orgrimmar, the Crossroads and the zeppelin take pointers too (they sat under the pins as plain pictures) */
  svg.querySelectorAll(".map-town, .map-mark, .map-zep-g, .route-plate").forEach((e) => { e.style.pointerEvents = "all"; e.classList.add("place-target"); if (e.matches(".map-mark") && Number(e.getAttribute("x")) === 382) e.classList.add("map-cross"); });
  /* the pins are reached from the keyboard through their zone (a focusable group); the group lists the names for a screen reader */
  svg.querySelectorAll(".road-g").forEach((g) => { const pins = [...g.querySelectorAll(".map-pin")].map((p) => p.getAttribute("data-who")).filter(Boolean); if (pins.length) g.setAttribute("aria-description", pins.join("; ")); });
  let card = $("#road-card");
  if (!card) { card = h("div", { class: "place-card road-card", id: "road-card", role: "tooltip", hidden: "" }); sheet.append(card); }
  if (RM.wired) return;
  RM.wired = true;
  const SEL = ".map-pin, .road-btn, .road-g, .map-town, .map-mark, .map-zep-g, .route-plate";
  const P = K.D.party;
  const who = (name) => P.members.find((m) => m.name === name);
  const idOf = (t) => {
    if (t.matches(".map-pin")) { const g = t.closest(".road-g"), m = who((t.getAttribute("data-who") || "").split(",")[0]); return { key: g ? g.dataset.road : null, member: m, kind: "pin" }; }
    if (t.matches(".road-btn, .road-g")) return { key: t.dataset.road, kind: "road" };
    if (t.matches(".map-zep-g, .route-plate")) return { key: "air", kind: "zep" };
    if (t.matches(".map-cross")) return { key: "mulgore", kind: "cross" };
    return { key: "all", kind: "end" };
  };
  const names = (list) => K.andList(list.map((m) => m.name));
  const body = (id) => {
    const M = RM.M, byKey = Object.fromEntries(M.roads.map((r) => [r.key, r])), r = byKey[id.key], ms = r ? P.members.filter((m) => m.start_zone === r.zone) : [];
    if (id.kind === "end") return { rc: "var(--brass)", title: "Orgrimmar", lines: ["Where all three roads end.", `${M.roads.map((x) => `${x.zone}: ${x.how.replace(/^the /, "")}`).join("; ")}.`] };
    if (id.kind === "zep") return { rc: "var(--wax)", title: "The Undercity zeppelin", lines: [`Flies from ${r.zone} to Orgrimmar.`, ms.length ? `${names(ms)} start${ms.length === 1 ? "s" : ""} in ${r.zone}.` : ""] };
    if (id.kind === "cross") return { rc: "var(--brass)", title: "The Crossroads", lines: [`${r.zone}'s road runs past it on the way to Orgrimmar.`, ms.length ? `${names(ms)} start${ms.length === 1 ? "s" : ""} in ${r.zone}.` : ""] };
    const m = id.member, others = ms.filter((x) => x !== m);
    const lines = m ? [`Wakes in ${r.zone}.`, `To Orgrimmar: ${r.how}.`, others.length ? `Same road: ${names(others)}.` : "Nobody else starts here."]
      : [ms.length ? `${names(ms)} wake${ms.length === 1 ? "s" : ""} here.` : "Nobody starts here.", `To Orgrimmar: ${r.how}.`];
    return { rc: K.classVar((m || ms[0] || {}).class_key), title: m ? m.name : r.zone, sub: m ? `${m.race} ${m.class}` : "", crest: m ? m.class_key : null, lines };
  };
  const sticky = () => legend.querySelector('.road-btn[aria-pressed="true"]');
  let cur = null, pinned = null;
  const setCtx = (id) => {
    const M = RM.M, all = id.key === "all", k = id.key;
    M.svg.classList.add("focusing");
    M.groups.forEach((g) => g.classList.toggle("on", all || g.dataset.road === k));
    panel.dataset.ctx = "road";
    legend.querySelectorAll(".road-btn").forEach((b) => { const on = all || b.dataset.road === k; b.parentElement.classList.toggle("ctx-on", on); b.parentElement.classList.toggle("ctx-dim", !on); });
    RM.M.svg.querySelectorAll(".map-pin").forEach((p) => p.classList.toggle("ctx-on", !!cur && cur.t === p));
  };
  const clearCtx = () => {
    delete panel.dataset.ctx; legend.querySelectorAll("li").forEach((li) => li.classList.remove("ctx-on", "ctx-dim")); RM.M.svg.querySelectorAll(".map-pin.ctx-on").forEach((p) => p.classList.remove("ctx-on"));
    if (!sticky()) { RM.M.svg.classList.remove("focusing"); RM.M.groups.forEach((g) => g.classList.remove("on")); }
  };
  const fill = (id) => {
    const b = body(id);
    card.style.setProperty("--rc", b.rc);
    card.replaceChildren(h("div", { class: "pc-top" }, b.crest ? h("img", { src: `img/crests/${b.crest}.png`, alt: "", width: 28, height: 28 }) : null, h("b", { text: b.title }), b.sub ? h("span", { text: b.sub }) : null), ...b.lines.filter(Boolean).map((l) => h("p", { text: l })));
  };
  const place = (t) => {
    const svg = RM.M.svg;
    if (coarse()) { card.classList.add("sheetmode"); dock(card, t, [...svg.querySelectorAll(".map-pin")].map(R).concat([...legend.querySelectorAll(".road-btn")].map(R))); return; }
    card.classList.remove("sheetmode", "dock-top"); card.style.bottom = "";
    const B = visibleBounds(10), w = card.offsetWidth, ht = card.offsetHeight, mb = R($("#map") || svg);
    const avoid = [...svg.querySelectorAll(".map-pin, .pin-banner, .map-town, .map-zep-g")].map(R).concat([...legend.querySelectorAll(".road-btn")].map(R));
    const pos = choose(w, ht, R(t), { bounds: B, row: rowRect(t), avoid, anchors: [mb], content: contentRects(panel, B, card).map((q) => (lap(q, mb) > 0 && q.w > mb.w * 0.8 ? { ...q, wt: 0.5 } : q)) });
    setPos(card, pos.x, pos.y); card.dataset.side = pos.side;
  };
  const show = (t, via) => {
    if (!t.isConnected || $("#scene").hidden) return;
    const id = idOf(t); if (!id.key) return;
    cur = { t, id }; setCtx(id); fill(id);
    card.hidden = false; t.setAttribute("aria-describedby", "road-card");
    place(t);
    card.classList.remove("flipin"); void card.offsetWidth; card.classList.add("flipin");
  };
  const hide = () => { cur = null; pinned = null; card.hidden = true; clearCtx(); panel.querySelectorAll("[aria-describedby=road-card]").forEach((e) => e.removeAttribute("aria-describedby")); };
  hover({ root: panel, sel: SEL, card: () => card, open: show, close: () => { if (!pinned) hide(); }, pinned: () => !!pinned, isOpen: () => !card.hidden,
    enter: (t) => { const id = idOf(t); if (id.key) { cur = { t, id }; setCtx(id); } }, leave: () => { if (!pinned && card.hidden) clearCtx(); } });
  /* a tap or click pins the card; the same tap again, a tap elsewhere or Escape closes it (the legend rows keep their own pressed state) */
  panel.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest(SEL); if (!t || e.target.closest("#road-card")) return;
    if (t.matches(".road-btn")) { if (t.getAttribute("aria-pressed") === "true") { pinned = t; show(t, "tap"); } else hide(); return; }
    if (pinned === t) { hide(); return; }
    pinned = t; show(t, "tap");
  });
  addEventListener("pointerdown", (e) => { if (!card.hidden && pinned && !e.target.closest("#road-card") && !e.target.closest(SEL)) hide(); }, true);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !card.hidden) { hide(); e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  K.sceneHooks.push((on) => { if (!on) hide(); });
  const bodyEl = $("#sheet-body"); if (bodyEl) bodyEl.addEventListener("scroll", () => { if (!card.hidden && !coarse()) hide(); }, { passive: true });
}

/* ---------------- Who buffs whom, the tiles on the wall ---------------- */
function context() {
  /* a hovered or focused buff row stays lit; its siblings and the wheel's other threads dim (hover.css); nothing opens over the row */
  const deep = $("#buffs-deep");
  const mark = (on, row) => { const box = row && row.closest(".bq-list, .bclass, .deep-cols"); document.querySelectorAll("#buffs-deep .ctx-on").forEach((e) => e.classList.remove("ctx-on")); const d = $("#buffs-deep"); if (d) d.classList.toggle("ctx", on); if (on && row) row.classList.add("ctx-on"); };
  if (deep) {
    deep.addEventListener("pointerover", (e) => { if (e.pointerType === "touch") return; const r = e.target.closest && e.target.closest("li.bq"); mark(!!r, r); });
    deep.addEventListener("pointerleave", () => mark(false));
    deep.addEventListener("focusin", (e) => { const r = e.target && e.target.closest && e.target.closest("li.bq"); if (r) mark(true, r); });
    deep.addEventListener("focusout", () => mark(false));
  }
  const wall = $("#wall");
  if (wall) {
    const on = (t) => { wall.classList.add("ctx"); wall.querySelectorAll(".ctx-on").forEach((e) => e.classList.remove("ctx-on")); const li = t.closest("li"); if (li) li.classList.add("ctx-on"); };
    const off = () => { wall.classList.remove("ctx"); wall.querySelectorAll(".ctx-on").forEach((e) => e.classList.remove("ctx-on")); };
    wall.addEventListener("pointerover", (e) => { if (e.pointerType === "touch") return; const t = e.target.closest && e.target.closest(".tile, .lib-tile"); if (t) on(t); });
    wall.addEventListener("pointerleave", off);
    wall.addEventListener("focusin", (e) => { const t = e.target && e.target.closest && e.target.closest(".tile, .lib-tile"); if (t) on(t); });
    wall.addEventListener("focusout", (e) => { if (!wall.contains(e.relatedTarget)) off(); });
  }
}

/* ---------------- native titles become cards ---------------- */
function tips() {
  let card = $("#place-tip"); if (!card) { card = h("div", { class: "place-card place-tip", id: "place-tip", role: "tooltip", hidden: "" }); document.body.append(card); }
  /* a title attribute opens a native tooltip wherever the browser likes; the text moves to data-tip and shows in a card of ours */
  const strip = (root) => {
    const list = root.nodeType === 1 ? [root, ...root.querySelectorAll("[title]")] : [];
    for (const e of list) {
      if (!e.hasAttribute || !e.hasAttribute("title") || e.tagName === "IFRAME") continue;
      const t = e.getAttribute("title"); e.removeAttribute("title");
      if (!t) continue;
      e.setAttribute("data-tip", t);
      if (!(e.textContent || "").trim() && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby")) e.setAttribute("aria-label", t);
    }
    if (root.nodeType === 1) root.querySelectorAll("svg title").forEach((x) => { const p = x.parentElement; if (p && !p.getAttribute("data-tip")) p.setAttribute("data-tip", x.textContent); x.remove(); });
  };
  strip(document.body);
  if (typeof MutationObserver === "function") new MutationObserver((ms) => { for (const m of ms) { if (m.type === "attributes") strip(m.target); else m.addedNodes.forEach((n) => { if (n.nodeType === 1) strip(n); }); } }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
  let cur = null;
  const open = (t) => {
    cur = t; card.replaceChildren(h("span", { text: t.getAttribute("data-tip") })); card.hidden = false; t.setAttribute("aria-describedby", "place-tip");
    const B = box(8, 8, innerWidth - 16, innerHeight - 16), scope = $("#scene:not([hidden]) .sheet") || $("#board") || document.body;
    const pos = choose(card.offsetWidth, card.offsetHeight, R(t), { bounds: B, row: R(t), gap: 8, content: contentRects(scope, B, card) });
    card.style.left = `${Math.round(pos.x)}px`; card.style.top = `${Math.round(pos.y)}px`;
  };
  const close = () => { card.hidden = true; if (cur) cur.removeAttribute("aria-describedby"); cur = null; };
  hover({ root: document.body, sel: "[data-tip]", card: () => card, open, close, isOpen: () => !card.hidden });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !card.hidden) { close(); e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  addEventListener("pointerdown", () => { if (!card.hidden) close(); }, true);
}

K.place = { choose, rowRect, contentRects, hover, dock, visibleBounds, IN, OUT };
K.on("map", roads);
const boot = () => { try { tooltips(); glossary(); context(); tips(); } catch (e) { console.error("place", e); } };
if (K.booted) boot(); else K.on("booted", boot);
})();
