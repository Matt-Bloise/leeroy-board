// The Atlas engine (contract 3). createAtlas(opts) wires geo, view, layers, gestures, routes, cards, tokens and foley around
// one Canvas 2D element inside the host the hook made. The draw loop runs only while something moves or changed; a hidden
// page or a closed scene stops it. All maths sits in geo.js, view.js and routes.js; this file only decides what to draw.
import * as geo from "./geo.js?v=eb6dd67b63";
import { createView, createTiles, defaultLoader, createFrames } from "./view.js?v=e7678982c4";
import { createLayers, LAYERS, FALLBACK, ICON } from "./layers.js?v=dbe2934de6";
import { bindGestures } from "./gestures.js?v=6bfa13bc52";
import { buildGraph, makePlan, buildTimeline, timelineAt, slicePath, meetOf } from "./routes.js?v=1b698e7e6d";
import { createCards } from "./cards.js?v=5a423a74d2";
import * as T from "./tokens.js?v=c2a525a5c5";
import { createFoley } from "./foley.js?v=b3098ff2d2";

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const ease = (t) => 1 - Math.pow(1 - t, 3);

export async function createAtlas(opts) {
  const K = opts.kit || {}, h = K.h, host = opts.host, base = opts.base || "", doc = host.ownerDocument;
  const emit = (type, detail) => { try { if (opts.on) opts.on(type, detail); } catch (e) { /* the hook's handler never breaks the engine */ } };
  const reduced = () => !!(K.reduceMQ && K.reduceMQ.matches);
  const motion = (k) => (typeof K.motionMs === "function" ? K.motionMs(k) : reduced() ? 0 : 520);
  const coarse = () => { try { return !!matchMedia("(pointer: coarse)").matches; } catch (e) { return false; } };
  const dataUrl = (n) => base + (opts.dataDir || "data/atlas/") + n;
  const getJSON = async (n, required) => {
    try {
      const r = await fetch(dataUrl(n), { cache: "no-store" });
      if (!r.ok) throw new Error(`${n} ${r.status}`);
      return await r.json();
    } catch (e) { if (required) throw e; return null; }
  };
  let world, places, routes, links, tidx;
  try {
    [world, places, routes, links, tidx] = await Promise.all([
      getJSON("world.json", true), getJSON("places.json", true), getJSON("routes.json", true), getJSON("links.json", false),
      (async () => { try { const r = await fetch(opts.tilesIndex || `${base}atlas/tiles/index.json`, { cache: "no-store" }); return r.ok ? await r.json() : null; } catch (e) { return null; } })(),
    ]);
  } catch (e) { emit("error", { what: "data", message: String((e && e.message) || e) }); throw e; }
  if (typeof geo.setWorld === "function") geo.setWorld(world); // node D's geo.js may read world.json its own way
  const party = (opts.data && opts.data.party) || { members: [] }, signups = (opts.data && opts.data.signups) || {};
  const graph = buildGraph(routes);

  // ---------- DOM: the canvas, the controls, the ornament ----------
  const prior = { tabindex: host.getAttribute("tabindex"), role: host.getAttribute("role"), label: host.getAttribute("aria-label") };
  host.classList.add("atlas-root");
  host.setAttribute("tabindex", "0"); host.setAttribute("role", "group");
  host.setAttribute("aria-label", "The Atlas. Plus and minus zoom, arrow keys move, zero shows the whole world, Tab walks the places in view, Escape closes.");
  const canvas = doc.createElement("canvas"); canvas.setAttribute("class", "atlas-canvas"); canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext ? canvas.getContext("2d") : null;
  // sheet-cell names (icons-, ornament-, travellers-) to the cropped files node A shipped (img/atlas/CREDITS.md: C-, D-, E-)
  const artFile = (cell) => cell.replace(/^icons-/, "C-").replace(/^ornament-corner-flourish-/, "D-corner-").replace(/^ornament-/, "D-").replace(/^travellers-zeppelin-frame-/, "E-zeppelin-");
  const art = (cell) => `${base}img/atlas/${artFile(cell)}.webp`;
  const orn = (cls, cell) => h("img", { class: `atlas-orn ${cls}`, src: art(cell), alt: "", "aria-hidden": "true", decoding: "async" });
  const shapesLine = world.shapes && world.shapes.source === "zmp" ? "shapes from the client's zone grid" : "zone plates; coasts to come";
  // the frame holds the title only; the shapes line sits on its own label under it, where the scrollwork cannot clip it
  const cartouche = h("div", { class: "atlas-cartouche" }, h("div", { class: "atlas-cart" }, orn("orn-frame", "ornament-cartouche-frame"), h("div", { class: "atlas-title" }, h("strong", { text: "The Atlas" }))), opts.shapesNote === false ? null : h("span", { class: "atlas-shapes", text: shapesLine }));
  const scaleBar = h("div", { class: "atlas-scale", "aria-hidden": "true" }, orn("orn-scale", "ornament-scale-bar"), h("i", { class: "atlas-bar" }), h("span", { class: "atlas-scale-t", text: "" }));
  const mkBtn = (cls, label, text, f) => { const b = h("button", { type: "button", class: `atlas-b ${cls}`, "aria-label": label, title: label, text }); b.addEventListener("click", f); return b; };
  const toast = h("div", { id: "atlas-toast", class: "atlas-toast", role: "status", "aria-live": "polite" });
  const ctl = h("div", { id: "atlas-ctl", class: "atlas-ctl", role: "group", "aria-label": "Atlas controls" });
  const chrome = [canvas, orn("orn-compass", "ornament-compass-rose"), orn("orn-nw", "ornament-corner-flourish-nw"), orn("orn-ne", "ornament-corner-flourish-ne"), orn("orn-sw", "ornament-corner-flourish-sw"), orn("orn-se", "ornament-corner-flourish-se"), cartouche, scaleBar, ctl, toast];
  host.append(...chrome);

  // ---------- state ----------
  const view = createView({ w: 600, h: 400, dpr: 1 });
  const frames = createFrames();
  const tilesLog = [];
  const tiles = createTiles({ dir: opts.tilesDir || `${base}atlas/tiles/`, loadImage: opts.loadImage || defaultLoader(), log: tilesLog, onTile: () => invalidate() });
  tiles.setIndex(tidx);
  const layers = createLayers({ world, places, routes });
  const S = { colors: {}, sprites: {}, focus: null, hover: null, pinned: null, zoneHot: null, plan: null, planWho: null, tl: null, t0: 0, playing: false, planEdges: [], edgeDir: new Map(), fired: new Set(), crossed: new Set(), planPlaces: new Set(), party: [], zep: null, tilesLoaded: 0, base: null, anim: null, dirty: true, raf: 0, running: true, paused: false, lastView: "", subLoaded: false, destroyed: false, card: null };
  const placeById = new Map(places.places.map((p) => [p.id, p]));
  const zoneById = new Map(world.zones.map((z) => [z.id, z]));

  // ---------- colours and sprites ----------
  const cssVar = (n) => { try { return (getComputedStyle(doc.documentElement).getPropertyValue(n) || "").trim(); } catch (e) { return ""; } };
  const refreshColors = () => {
    const pick = (n, f) => cssVar(n) || f;
    S.colors = { ink: pick("--ink", FALLBACK.ink), inkSoft: pick("--ink-soft", FALLBACK.inkSoft), parchment: pick("--parchment", FALLBACK.parchment), parchment2: pick("--parchment-2", FALLBACK.parchment2), brass: pick("--brass", FALLBACK.brass), brassDim: pick("--brass-dim", FALLBACK.brassDim), land: pick("--parchment-2", FALLBACK.land), sea: pick("--atlas-sea", FALLBACK.sea), horde: pick("--atlas-horde", FALLBACK.horde), alliance: pick("--atlas-alliance", FALLBACK.alliance), contested: pick("--atlas-contested", FALLBACK.contested), plan: pick("--atlas-plan", FALLBACK.plan), font: `Cinzel, ${cssVar("--font-ui") || FALLBACK.font}` };
    invalidate();
  };
  const loadSprite = (key, url, fallback) => {
    if (opts.noArt || typeof Image !== "function") return;
    const im = new Image();
    im.onload = () => { S.sprites[key] = im; invalidate(); };
    im.onerror = () => { if (fallback) loadSprite(key, fallback); };
    im.src = url;
    // the fake DOM never fires onload: its Image fills naturalWidth after a tick
    if (im.naturalWidth === 0 && opts.pollSprites) { let n = 0; const t = setInterval(() => { if (im.naturalWidth) { clearInterval(t); S.sprites[key] = im; invalidate(); } else if (++n > 20) clearInterval(t); }, 25); }
  };
  const loadArt = () => {
    for (const cell of new Set([...Object.values(ICON), "alliance-city"])) loadSprite(cell, art(`icons-${cell}`));
    loadSprite("pin", `${base}img/map/pin-blank.webp`);
    loadSprite("zeppelin", art("travellers-zeppelin-frame-1"), `${base}img/map/zeppelin.png`);
    for (const m of party.members || []) loadSprite(`crest-${m.class_key}`, `${base}img/crests/${m.class_key}.png`);
  };

  // ---------- sizing ----------
  const dprNow = () => Math.min(window.devicePixelRatio || 1, coarse() ? 2 : 3);
  const resize = () => {
    const r = host.getBoundingClientRect ? host.getBoundingClientRect() : { width: 0, height: 0 };
    const w = Math.round(r.width || host.clientWidth || 600), hh = Math.round(r.height || host.clientHeight || 400), dpr = dprNow();
    if (w === view.w && hh === view.h && dpr === view.dpr && canvas.width) return;
    view.resize(w, hh, dpr);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr);
    invalidate();
  };

  // ---------- the loop ----------
  function invalidate() {
    S.dirty = true;
    if (S.destroyed || S.paused || S.raf || doc.hidden) return;
    S.raf = requestAnimationFrame(frame);
  }
  const animating = () => !!(S.anim || S.oyAnim || S.playing || (G && G.inertia));
  function frame(now) {
    S.raf = 0;
    if (S.destroyed || S.paused) return;
    if (doc.hidden) { frames.idle(); return; }
    frames.tick(now);
    if (S.anim) stepAnim(now);
    if (S.oyAnim) { const o = S.oyAnim, t = clamp((now - o.t0) / 260, 0, 1); view.oy = o.f + (o.to - o.f) * ease(t); if (t >= 1) S.oyAnim = null; S.dirty = true; }
    if (S.playing) stepPlan();
    const moving = !!(S.anim || S.oyAnim || (G && G.inertia)) || now - (S.lastMove || 0) < 140;
    if (S.moving && !moving) S.dirty = true; // settle: one more frame with the dashes back
    S.moving = moving;
    if (ctx && (S.dirty || animating())) draw();
    S.dirty = false;
    const sig = `${view.cx.toFixed(0)},${view.cy.toFixed(0)},${view.z.toFixed(2)}`;
    if (sig !== S.lastView) { S.lastView = sig; onViewChange(); }
    if (animating() || S.dirty || S.moving) S.raf = requestAnimationFrame(frame); else frames.idle();
  }
  function draw() {
    const k = view.dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = S.colors.sea || FALLBACK.sea; ctx.fillRect(0, 0, view.w, view.h);
    // one bad layer never ends the loop: the frame keeps its tiles and the next change draws again
    try { S.tilesLoaded = tiles.draw(ctx, view); zepAt(); layers.draw(ctx, view, S); } catch (e) { if (!S.drawErr) { S.drawErr = true; emit("error", { what: "draw", message: String((e && e.message) || e) }); } }
    S.drawn = (S.drawn || 0) + 1;
  }
  const narrow = () => { try { return !!matchMedia("(max-width: 699px)").matches; } catch (e) { return false; } };
  // panels in host pixels; null when hidden or not laid out (the fake DOM)
  const relRect = (el) => {
    if (!el || el.hidden || !el.getBoundingClientRect || !host.getBoundingClientRect) return null;
    const hr = host.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!hr || !r || !r.width || !r.height || !hr.width) return null;
    return { l: r.left - hr.left, t: r.top - hr.top, r: r.right - hr.left, b: r.bottom - hr.top, w: r.width, h: r.height };
  };
  // on phones the card is a bottom sheet: the focus sits in the middle of the map left above it
  const sheetOy = () => { if (!narrow() || !S.card) return 0; const c = relRect(cards.card); return Math.round(Math.min(c ? c.h : view.h * 0.46, view.h * 0.6) / 2); };
  const oyT = () => (S.oyAnim ? S.oyAnim.to : view.oy);
  // the free parts of the box: under the cartouche, beside or above the plan panel, beside or above the card
  function freeBoxes() {
    const base = { l: 0, t: 0, r: 0, b: 0 }, ca = relRect(cartouche);
    if (ca && ca.b < view.h * 0.3) base.t = Math.max(0, ca.b + 4);
    let out = [base];
    const cut = (el) => {
      const p = relRect(el); if (!p) return;
      const next = [];
      for (const b of out) {
        if (narrow()) { next.push({ ...b, b: Math.max(b.b, view.h - p.t + 8) }); continue; }
        // a side panel: either the strip beside it or the band above or below it stays free
        if (p.l < view.w * 0.25) next.push({ ...b, l: Math.max(b.l, p.r + 8) }); else next.push({ ...b, r: Math.max(b.r, view.w - p.l + 8) });
        if (p.t < view.h * 0.25) next.push({ ...b, t: Math.max(b.t, p.b + 8) }); else next.push({ ...b, b: Math.max(b.b, view.h - p.t + 8) });
      }
      out = next;
    };
    cut(cards.plan); cut(cards.card); if (narrow()) cut(ctl);
    return out;
  }
  // the best fit of a rectangle over the free parts (the one that shows it largest)
  function fitFree(r, pad, zcap) {
    let best = null;
    for (const I of freeBoxes()) { const f = view.fitIn(r, I, pad, zcap, oyT()); if (!best || f.z > best.z) best = f; }
    return best;
  }
  function syncSheet() { const want = sheetOy(); if (want === view.oy) return; if (reduced() || !ctx) { view.oy = want; invalidate(); } else S.oyAnim = { t0: performance.now(), f: view.oy, to: want }; invalidate(); }
  const stepAnim = (now) => {
    const a = S.anim, t = clamp((now - a.t0) / a.dur, 0, 1), e = ease(t);
    view.set(a.f.cx + (a.to.cx - a.f.cx) * e, a.f.cy + (a.to.cy - a.f.cy) * e, a.f.z + (a.to.z - a.f.z) * e);
    if (t >= 1) { S.anim = null; }
    S.dirty = true;
  };
  function onViewChange() {
    if (!S.subLoaded && view.z >= 3) loadSubzones();
    const list = layers.placesInView(view, S);
    cards.places(list, (p) => { S.focus = p.id; ensureVisible(p); invalidate(); });
    updateScale(); updateFoley(); placeAway();
    emit("view", { zoom: view.z, center: [view.cx, view.cy] });
  }
  async function loadSubzones() {
    S.subLoaded = true;
    const sz = await getJSON("subzones.json", false);
    if (sz && sz.subzones) { layers.setSubzones(sz.subzones); invalidate(); }
  }
  const NICE = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  function updateScale() {
    const ypp = 1.496 / view.scale(); let n = NICE[0];
    for (const c of NICE) if (c / ypp <= 140) n = c;
    const bar = scaleBar.querySelector(".atlas-bar"), t = scaleBar.querySelector(".atlas-scale-t");
    if (bar) bar.style.width = `${Math.round(n / ypp)}px`;
    if (t) { const txt = `${n >= 1000 ? `${n / 1000} thousand` : n} yards`; if (t.textContent !== txt) t.textContent = txt; }
  }
  let lastFoley = 0;
  function updateFoley() {
    if (!foley.state().active) return;
    const now = performance.now(); if (now - lastFoley < 250) return; lastFoley = now;
    const hit = layers.hit(view, view.w / 2, view.h / 2, false, S), zid = hit && hit.zone ? hit.zone.id : null;
    const land = world.continents.some((c) => c.a_rect[0] <= view.cx && c.a_rect[2] >= view.cx && c.a_rect[1] <= view.cy && c.a_rect[3] >= view.cy);
    const dry = zid === "the-barrens" || zid === "durotar" ? 1 : zid ? 0.55 : land ? 0.4 : 0;
    foley.update({ wind: dry, surf: coastNear() });
  }
  function coastNear() {
    let best = Infinity;
    for (const c of world.continents) for (const ring of c.land || []) for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = clamp(((view.cx - a[0]) * dx + (view.cy - a[1]) * dy) / l2, 0, 1), d = Math.hypot(view.cx - (a[0] + dx * t), view.cy - (a[1] + dy * t)); if (d < best) best = d; }
    return clamp(1 - (best * 1.496) / 1500, 0, 1);
  }

  // ---------- view moves ----------
  const target = (cx, cy, z) => { const s = { cx: view.cx, cy: view.cy, z: view.z }; view.set(cx, cy, z); const to = { cx: view.cx, cy: view.cy, z: view.z }; view.set(s.cx, s.cy, s.z); return to; };
  function moveTo(cx, cy, z, o) {
    const to = target(cx, cy, z), dur = motion("move");
    if (o && o.animate && dur > 0 && !reduced()) { S.anim = { t0: performance.now(), dur, f: { cx: view.cx, cy: view.cy, z: view.z }, to }; invalidate(); }
    else { S.anim = null; view.set(to.cx, to.cy, to.z); S.dirty = true; invalidate(); }
    return to;
  }
  function animateZoom(n, x, y) {
    const s = { cx: view.cx, cy: view.cy, z: view.z };
    view.zoomAbout(n, x, y); const to = { cx: view.cx, cy: view.cy, z: view.z }; view.set(s.cx, s.cy, s.z);
    S.anim = { t0: performance.now(), dur: Math.min(motion("move"), 300), f: s, to }; invalidate();
  }
  const rectOf = (ids) => {
    let r = null;
    const add = (a) => { r = r ? [Math.min(r[0], a[0]), Math.min(r[1], a[1]), Math.max(r[2], a[2]), Math.max(r[3], a[3])] : a.slice(); };
    for (const id of ids) { const p = placeById.get(id), z = zoneById.get(id); if (p) add([p.a[0], p.a[1], p.a[0], p.a[1]]); else if (z) add(z.a_rect); }
    return r;
  };
  const dayOneIds = () => {
    const starts = (routes.day_one && routes.day_one.starts) || {}, m = meetOf(routes), ids = new Set(Object.values(starts));
    ids.add(m.place || openMeet()); return [...ids];
  };
  const openMeet = () => (placeById.has("valley-of-strength") ? "valley-of-strength" : (routes.nodes || [])[0]);
  function fitIds(ids, o) {
    const r = rectOf(ids); if (!r) return null;
    if (r[2] - r[0] < 400) { r[0] -= 600; r[2] += 600; } if (r[3] - r[1] < 400) { r[1] -= 400; r[3] += 400; }
    const f = fitFree(r, 0.12, 4);
    return moveTo(f.cx, f.cy, f.z, o);
  }
  // places of a plan grouped by continent: the meeting point's continent is home, the rest are away. Fitting all of them
  // shows mostly sea (the five start on two continents), so the view fits home and points at the rest from the edge.
  const contOf = (id) => { const p = placeById.get(id); return p ? p.map_id : null; };
  function clustersOf(ids, meet) {
    const g = new Map();
    for (const id of ids) { const c = contOf(id); if (!g.has(c)) g.set(c, []); g.get(c).push(id); }
    const mc = contOf(meet), out = [];
    for (const [c, list] of g) out.push({ home: c === mc, ids: list });
    return out.sort((a, b) => (b.home ? 1 : 0) - (a.home ? 1 : 0));
  }
  const homeIds = (ids, meet) => { const cl = clustersOf(ids, meet); return cl.length && cl[0].home ? cl[0].ids : ids; };
  const NUM = ["no one", "one", "two", "three", "four", "five", "six"];
  function setAway(ids, meet, who) {
    const cl = clustersOf(ids, meet);
    S.away = cl.length > 1 ? cl.map((c) => {
      const starts = (who || []).filter((w) => c.ids.includes(w.from)), sp = starts.length ? placeById.get(starts[0].from) : null, z = sp ? zoneById.get(sp.zone) : null;
      const label = c.home ? (placeById.get(meet) || {}).name || meet : z ? z.name : (placeById.get(c.ids[0]) || {}).name || c.ids[0];
      const say = c.home ? `Show ${label}, the meeting point` : `Show ${label}, where ${NUM[starts.length] || starts.length} of the party start`;
      return { ids: c.ids, label, say };
    }) : [];
    placeAway();
  }
  function fitPlan(o) {
    const pl = S.plan; if (!pl) return null;
    const ids = [...S.planPlaces], many = pl.who.length > 1;
    setAway(many ? ids : [], pl.meet, pl.who);
    return fitIds(many ? homeIds(ids, pl.meet) : ids, o);
  }
  // the edge pointers to the away clusters: one button each, on the line from the free centre toward the cluster
  function placeAway() {
    S.awayEls = S.awayEls || new Map();
    const want = new Set((S.plan && S.away) || []);
    for (const [c, b] of S.awayEls) if (!want.has(c)) { if (b.parentNode) b.parentNode.removeChild(b); S.awayEls.delete(c); }
    if (!want.size) return;
    const vr = view.rect(), m = 56, panels = [relRect(cards.plan), relRect(cards.card), relRect(ctl)].filter(Boolean);
    // the pointer sits on the box's own edge toward the cluster; where a panel covers that spot, on the free part's edge
    const edge = (I, sx, sy) => {
      const x0 = I.l + m + 40, x1 = view.w - I.r - m - 40, y0 = I.t + m, y1 = view.h - I.b - m, fx = (I.l + view.w - I.r) / 2, fy = (I.t + view.h - I.b) / 2, dx = sx - fx, dy = sy - fy;
      if (x1 <= x0 || y1 <= y0) return null;
      let k = 1;
      if (dx > 0) k = Math.min(k, (x1 - fx) / dx); if (dx < 0) k = Math.min(k, (x0 - fx) / dx);
      if (dy > 0) k = Math.min(k, (y1 - fy) / dy); if (dy < 0) k = Math.min(k, (y0 - fy) / dy);
      return [fx + dx * k, fy + dy * k, Math.atan2(dy, dx)];
    };
    const under = (q) => q && panels.some((p) => q[0] > p.l - 90 && q[0] < p.r + 90 && q[1] > p.t - 30 && q[1] < p.b + 30);
    for (const c of want) {
      let b = S.awayEls.get(c);
      if (!b) {
        b = h("button", { type: "button", class: "atlas-away", "aria-label": c.say, title: c.say }, h("span", { class: "atlas-away-arrow", "aria-hidden": "true", text: "→" }), h("span", { text: c.label }));
        b.addEventListener("click", () => fitIds(c.ids, { animate: true }));
        host.append(b); S.awayEls.set(c, b);
      }
      const r = rectOf(c.ids), seen = r && !(r[2] < vr[0] || r[0] > vr[2] || r[3] < vr[1] || r[1] > vr[3]);
      const sp = r ? view.toScreen((r[0] + r[2]) / 2, (r[1] + r[3]) / 2) : null;
      let q = sp && edge({ l: 0, t: 0, r: 0, b: 0 }, sp[0], sp[1]);
      if (under(q)) q = edge(freeBoxes()[0], sp[0], sp[1]);
      if (!r || seen || !q || (narrow() && S.card)) { b.hidden = true; continue; }
      b.hidden = false;
      b.style.left = `${Math.round(q[0])}px`; b.style.top = `${Math.round(q[1])}px`;
      const arrow = b.firstChild; if (arrow && arrow.style) arrow.style.transform = `rotate(${Math.round((q[2] * 180) / Math.PI)}deg)`;
    }
  }
  const ensureVisible = (p) => {
    const [x, y] = view.toScreen(p.a[0], p.a[1]), m = 40;
    if (x < m || y < m || x > view.w - m || y > view.h - m) moveTo(p.a[0], p.a[1], view.z, { animate: false });
  };
  // after a pick opens a card: a place the card now covers moves to the free middle
  function reveal(p, o) {
    const s = view.scale(), x = view.w / 2 + (p.a[0] - view.cx) * s, y = view.h / 2 - oyT() + (p.a[1] - view.cy) * s, m = 28;
    let hid = y < m || y > view.h - m || x < m || x > view.w - m;
    const c = relRect(cards.card);
    if (c && x > c.l - m && x < c.r + m && y > c.t - m && y < c.b + m) hid = true;
    if (!hid) return false;
    const f = fitFree([p.a[0], p.a[1], p.a[0], p.a[1]], 0, view.z);
    moveTo(f.cx, f.cy, view.z, o);
    return true;
  }

  // ---------- cards and acts ----------
  const act = {
    close: () => closeCard(), closePlan: () => atlas.clearPlan(),
    openPlace: (id) => atlas.open(id, { card: true, animate: true }),
    plan: (id) => { atlas.showPlan(atlas.plan({ meet: id }), { animate: true, fit: true }); },
    planWho: (meet, ck) => { S.planWho = ck; atlas.showPlan(atlas.plan({ meet, who: ck }), { animate: true, fit: true }); },
    folded: () => { placeAway(); invalidate(); },
    send: (meet) => copy(`/map plan:${meet}`, `Copied /map plan:${meet}. Paste it in Discord and the card is posted there when you tap Post to channel.`),
  };
  const cards = createCards({ host, h, places, world, links, routes, party, foldFirst: () => narrow() || (coarse() && view.w < 1000), /* phones and tablets: the plan opens as a title bar */ journey: () => (K.JR || K.journey || (() => "curious"))(), copy: (t) => copy(t), act });
  const toastSay = (txt) => { toast.textContent = txt; clearTimeout(S.toastT); S.toastT = setTimeout(() => { toast.textContent = ""; }, 2400); };
  function copy(text, say) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* the toast still shows */ }
    toastSay(say || `Copied ${text}`); emit("copy", { text });
  }
  function closeCard() {
    const was = cards.hideCard(); S.pinned = null; S.card = null; S.focus = null; S.zoneHot = null; invalidate();
    syncSheet(); placeAway();
    if (was) emit("card", { id: null });
    return !!was;
  }
  function openCard(kind, id) {
    if (kind === "place") { cards.showPlace(placeById.get(id)); S.pinned = id; S.zoneHot = null; }
    else { cards.showZone(zoneById.get(id)); S.pinned = null; S.zoneHot = id; }
    S.card = id; syncSheet(); placeAway(); invalidate(); emit("card", { id });
  }

  // ---------- plan ----------
  function partyMarkers(placeIdFor) {
    const out = [], byPlace = {};
    for (const m of party.members || []) {
      const pid = placeIdFor(m.class_key); const p = pid && placeById.get(pid); if (!p) continue;
      (byPlace[pid] ||= []).push({ class_key: m.class_key, color: m.color, name: m.name, pos: p.a.slice() });
    }
    for (const list of Object.values(byPlace)) list.forEach((m, i) => { m.dx = (i - (list.length - 1) / 2) * 16; out.push(m); });
    return out;
  }
  const startsOf = (ck) => ((routes.day_one && routes.day_one.starts) || {})[ck];
  const standing = () => { S.party = partyMarkers(startsOf); };
  function setPlanEdges(prog) {
    S.planEdges = [];
    for (const [id, p] of Object.entries(prog)) {
      const e = graph.edges.get(id), path = S.edgeDir.get(id) ? e.a_path : e.a_path.slice().reverse();
      S.planEdges.push({ id, progress: p, pts: slicePath(path, p) });
    }
  }
  function stepPlan() {
    const t = performance.now() - S.t0, st = timelineAt(graph, S.plan, S.tl, t);
    setPlanEdges(st.prog);
    for (const [id, p] of Object.entries(st.prog)) if (p >= 1 && !S.fired.has(id)) { S.fired.add(id); emit("route-drawn", { edge: id }); if (foley) foley.cue("quill"); }
    for (const c of S.tl.chains) for (const sg of c.segs) if (sg.transport && t >= sg.t0 && !S.crossed.has(sg.transport)) { S.crossed.add(sg.transport); emit("crossing", { transport: sg.transport }); if (foley) foley.cue("horn"); }
    const marks = st.marks, out = [];
    const groups = {};
    for (const m of partyMarkers(startsOf)) {
      const mk = marks[m.class_key]; if (mk) m.pos = mk.pos;
      m.walk = !!mk && !mk.done; (groups[`${Math.round(m.pos[0] / 40)},${Math.round(m.pos[1] / 40)}`] ||= []).push(m); out.push(m);
    }
    for (const g of Object.values(groups)) g.forEach((m, i) => { m.dx = (i - (g.length - 1) / 2) * 16; });
    S.party = out;
    S.zep = null;
    for (const c of S.tl.chains) for (const sg of c.segs) if (sg.transport && t >= sg.t0 && t < sg.t1) { const mk = marks[c.class_key]; if (mk) S.zep = { pos: mk.pos, flip: !sg.fwd }; }
    if (t >= S.tl.total) { S.playing = false; S.zep = null; }
    S.dirty = true;
  }
  function dayZep() {
    const t = (routes.transports || [])[0]; if (!t) return null;
    const p = placeById.get(t.stops[0]); return p ? { pos: p.a.slice(), flip: false } : null;
  }
  function zepAt() { if (!S.zep && !S.playing) S.zep = dayZep(); }

  // ---------- the public surface ----------
  const lay = { set: (n, on) => { if (LAYERS.includes(n)) { layers.on[n] = !!on; invalidate(); } }, get: (n) => !!layers.on[n], list: () => LAYERS.slice() };
  const atlas = {
    ready: null, layers: lay, view,
    open(t, o = {}) {
      if (typeof t === "string" && /^atlas/.test(t)) return atlas.openToken(t, o);
      if (placeById.has(t) && !(placeById.get(t).kind === "zone" && zoneById.has(t))) { const p = placeById.get(t); S.base = { token: `atlas.${p.id}`, v: null }; moveTo(p.a[0], p.a[1], Math.max(view.z, 3), o); S.base.v = target(p.a[0], p.a[1], Math.max(view.z, 3)); if (o.card !== false) openCard("place", p.id); return true; }
      if (zoneById.has(t)) { const z = zoneById.get(t); S.base = { token: `atlas.z.${z.id}` }; const f = view.fit(z.a_rect, 0.12, 4); moveTo(f.cx, f.cy, f.z, o); S.base.v = target(f.cx, f.cy, f.z); if (o.card !== false) openCard("zone", z.id); return true; }
      return false;
    },
    goto(v, o = {}) { return moveTo(v.au, v.av, v.zoom, o); },
    fit(ids, o = {}) { return fitIds(ids, o); },
    plan(o = {}) { return makePlan(graph, o); },
    showPlan(plan, o = {}) {
      if (!plan || !plan.who.length) return false;
      closeCard();
      S.plan = plan; S.tl = buildTimeline(graph, plan); S.fired = new Set(); S.crossed = new Set(); S.edgeDir = new Map();
      for (const c of S.tl.chains) for (const sg of c.segs) if (!S.edgeDir.has(sg.edge)) S.edgeDir.set(sg.edge, sg.fwd);
      S.planPlaces = new Set(plan.who.flatMap((w) => w.route)); S.planPlaces.add(plan.meet);
      const m = meetOf(routes), meta = { status: plan.meet_status || m.status };
      cards.showPlan(plan, graph, meta);
      if (reduced() || o.animate === false) {
        S.playing = false; setPlanEdges(Object.fromEntries([...S.edgeDir.keys()].map((id) => [id, 1])));
        for (const id of S.edgeDir.keys()) { S.fired.add(id); emit("route-drawn", { edge: id }); if (foley) foley.cue("quill"); }
        S.party = partyMarkers(startsOf);
      } else { S.playing = true; S.t0 = performance.now(); setPlanEdges(Object.fromEntries([...S.edgeDir.keys()].map((id) => [id, 0]))); }
      syncSheet();
      if (o.fit) fitPlan({ animate: !!o.animate }); else setAway(plan.who.length > 1 ? [...S.planPlaces] : [], plan.meet, plan.who);
      invalidate(); emit("plan", { plan });
      return true;
    },
    clearPlan() {
      const was = cards.hidePlan();
      S.plan = null; S.tl = null; S.playing = false; S.planEdges = []; S.planPlaces = new Set(); S.planWho = null; S.away = []; placeAway(); standing(); S.zep = null; syncSheet(); invalidate();
      if (was) emit("plan", { plan: null });
      return was;
    },
    hitTest(cx, cy) {
      const r = host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0 };
      return layers.hit(view, cx - (r.left || 0), cy - (r.top || 0), coarse(), S);
    },
    token() {
      const b = S.base, here = { cx: view.cx, cy: view.cy, z: view.z };
      if (b && b.v && Math.abs(b.v.cx - here.cx) * view.scale() < 4 && Math.abs(b.v.cy - here.cy) * view.scale() < 4 && Math.abs(b.v.z - here.z) < 0.02 && baseValid(b)) return b.token;
      return T.make({ kind: "view", au: view.cx, av: view.cy, zoom: view.z });
    },
    openToken(token, o = {}) {
      const p = T.parse(token); if (!p) return false;
      if (p.kind === "home") { closeCard(); atlas.showPlan(atlas.plan({}), { animate: o.animate !== false && !!o.animate }); const to = fitPlan(o) || fitIds(dayOneIds(), o); S.base = { token: "atlas", v: to, plan: true }; return true; }
      if (p.kind === "place") return placeById.has(p.id) ? atlas.open(p.id, o) : false;
      if (p.kind === "zone") return zoneById.has(p.id) ? atlas.open(p.id, o) : false;
      if (p.kind === "plan") {
        if (!placeById.has(p.meet)) return false;
        atlas.showPlan(atlas.plan(p.who ? { meet: p.meet, who: p.who } : { meet: p.meet }), { animate: !!o.animate });
        const to = fitPlan(o) || fitIds([...new Set([...dayOneIds(), p.meet])], o);
        S.planWho = p.who || null; S.base = { token: T.make(p), v: to, plan: true }; return true;
      }
      if (p.kind === "view") { closeCard(); const to = moveTo(p.au, p.av, p.zoom, o); S.base = { token: T.make(p), v: to }; return true; }
      return false;
    },
    status() {
      const l = {}; for (const n of LAYERS) l[n] = !!layers.on[n];
      return { ready: true, zoom: view.z, center: [view.cx, view.cy], tiles: tiles.stats(), layers: l, reduced: reduced(), plan: S.plan ? S.plan.meet : null, card: S.card, frames: { p95: frames.p95() }, hit: coarse() ? 48 : 24, labels: layers.lastLabels || 0, running: !S.paused && !doc.hidden };
    },
    refreshColors, resize,
    pause() { S.paused = true; if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } frames.idle(); foley.stop(); },
    resume() { if (S.destroyed) return; S.paused = false; refreshColors(); resize(); foley.start(); invalidate(); },
    zoomBy(n) { animateZoom(n, view.w / 2, view.h / 2); },
    dayOne() { const to = (S.plan && fitPlan({ animate: true })) || fitIds(homeIds(dayOneIds(), meetOf(routes).place || openMeet()), { animate: true }); S.base = { token: "atlas", v: to, plan: !!S.plan }; return to; },
    debug: { tilesLog, state: S, graph, layers },
    destroy() {
      S.destroyed = true; if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; clearTimeout(S.toastT);
      G.destroy(); foley.destroy(); tiles.clear(); cards.destroy(); S.away = []; S.plan = null; placeAway();
      if (canvas.removeEventListener) canvas.removeEventListener("contextrestored", onRestore);
      window.removeEventListener("resize", onResize); if (doc.removeEventListener) doc.removeEventListener("visibilitychange", onVis);
      if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
      for (const e of chrome) if (e.parentNode) e.parentNode.removeChild(e);
      host.classList.remove("atlas-root");
      for (const [k, v] of [["tabindex", prior.tabindex], ["role", prior.role], ["aria-label", prior.label]]) { if (v == null) host.removeAttribute(k); else host.setAttribute(k, v); }
    },
  };
  const baseValid = (b) => {
    if (b.plan) return !!S.plan && !S.card;
    if (b.token.startsWith("atlas.z.")) return S.card === b.token.slice(8);
    if (b.token === "atlas") return !S.card;
    return b.token.startsWith("atlas.v.") || S.card === b.token.slice(6);
  };

  // ---------- controls, input, lifecycle ----------
  ctl.append(
    mkBtn("a-in", "Zoom in", "+", () => atlas.zoomBy(1)),
    mkBtn("a-out", "Zoom out", "−", () => atlas.zoomBy(-1)),
    mkBtn("a-fit", "Show the day-one view", "0", () => atlas.dayOne()),
    mkBtn("a-back", "Back to the sketch", "Back to the sketch", () => emit("close", {})));
  const foley = createFoley({ sound: opts.sound, reduced, soundOn: () => { try { return !!(window.__board && window.__board.sound && window.__board.sound()); } catch (e) { return false; } } });
  const keys = {
    fit: () => atlas.dayOne(),
    enter: () => { if (S.focus && placeById.has(S.focus)) { openCard("place", S.focus); return true; } return false; },
    escape: () => { if (closeCard()) return true; if (cards.hidePlan()) { atlas.clearPlan(); return true; } emit("close", {}); return true; },
  };
  const hoverAt = (x, y) => {
    const hit = layers.hit(view, x, y, false, S), id = hit && hit.place ? hit.place.id : null, zid = !id && hit && hit.zone ? hit.zone.id : null;
    if (id !== S.hover || (S.card === null && zid !== S.zoneHot)) { S.hover = id; if (!S.card) S.zoneHot = zid; canvas.style.cursor = id || zid ? "pointer" : ""; invalidate(); }
  };
  const G = bindGestures({
    el: canvas, host, view, reduced, keys, animateZoom,
    onChange: () => { S.anim = null; S.lastMove = performance.now(); invalidate(); },
    onDown: () => { S.anim = null; },
    onHover: hoverAt,
    onPick: (x, y, e) => {
      const hit = layers.hit(view, x, y, coarse() || (e && e.pointerType === "touch"), S);
      if (hit && hit.place) { openCard("place", hit.place.id); reveal(hit.place, { animate: !reduced() }); emit("pick", { place: hit.place }); }
      else if (hit && hit.zone) { openCard("zone", hit.zone.id); emit("pick", { zone: hit.zone }); }
      else { closeCard(); }
    },
  });
  const onResize = () => resize();
  const onVis = () => { if (!doc.hidden) invalidate(); else frames.idle(); };
  // a 2D canvas whose context the browser dropped and gave back comes back blank: draw it again (likely cause of the one
  // flat-sea first open the verifier saw; unconfirmed)
  const onRestore = () => { S.dirty = true; invalidate(); };
  if (canvas.addEventListener) canvas.addEventListener("contextrestored", onRestore);
  window.addEventListener("resize", onResize); if (doc.addEventListener) doc.addEventListener("visibilitychange", onVis);
  let ro = null;
  if (typeof ResizeObserver === "function") { try { ro = new ResizeObserver(() => resize()); ro.observe(host); } catch (e) { ro = null; } }

  refreshColors(); loadArt(); resize(); standing();
  const home = fitIds(homeIds(dayOneIds(), meetOf(routes).place || openMeet()), { animate: false }); S.base = { token: "atlas", v: home };
  foley.start();
  if (ctx) draw();
  S.dirty = false; S.lastView = `${view.cx.toFixed(0)},${view.cy.toFixed(0)},${view.z.toFixed(2)}`; onViewChange();
  atlas.ready = Promise.resolve(atlas);
  emit("ready", {});
  return atlas;
}
