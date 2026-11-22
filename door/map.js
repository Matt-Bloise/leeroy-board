// The roads on a Canvas 2D map, drawn from the board's own vector data: land and zone outlines from data/atlas/world.json, the roads from
// data/atlas/routes.json through the board's own planner (atlas/routes.js) and coast smoothing (atlas/shape.js). No map tiles: about 120 KB of JSON
// (raw, before compression) instead of the 6 MB of tiles the full Atlas pans over.
// Layout: the roads on the meeting place's side of the sea fill the map; a start across the sea (before a zeppelin or boat leg) is drawn in a framed
// inset in the corner it lies towards, joined to the main map by the crossing, so every road is legible at phone size without distorting either side.
// Semantic equivalent: the canvas is role="img" with a one-line label, and every road is written out in the list under it (door/index.html #rd-list).
// Motion: the first time the card comes into view the roads draw themselves once (about a second of animation frames, then none); under reduced motion
// they are drawn at once. A resize redraws once. Nothing runs while the page is idle.
import { buildGraph, makePlan, slicePath } from "../atlas/routes.js?v=3047650a27";
import { smoothRing } from "../atlas/shape.js?v=fa8a9c9ac7";
import { roadGroups, roadLine, zoneAt, word, cap, placeName, andList } from "./model.js?v=231bef223f";

const CLASS = { druid: "#ff7c0a", priest: "#ffffff", paladin: "#f48cba", mage: "#3fc7eb", warlock: "#8788ee", hunter: "#aad372", rogue: "#fff468", shaman: "#0070dd", warrior: "#c69b6d" };
const INK = "#1d140d", BRASS = "#eecd8c", CREAM = "#fbf4e4", LAND = "#3a2c1c", COAST = "rgba(238, 205, 140, .45)", ZONE = "rgba(238, 205, 140, .14)";
const REVEAL_MS = 1100, FONT = '700 13px "Alegreya Sans SC", Georgia, serif', FONT_S = '700 12px "Alegreya Sans SC", Georgia, serif';
const TRANSIT = new Set(["zeppelin", "boat"]);

const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} answered ${r.status}`); return r.json(); };
const ease = (t) => 1 - Math.pow(1 - t, 3);
const bbox = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return { x0, y0, x1, y1 }; };
const pad = (b, f, min) => { const px = Math.max((b.x1 - b.x0) * f, min), py = Math.max((b.y1 - b.y0) * f, min); return { x0: b.x0 - px, y0: b.y0 - py, x1: b.x1 + px, y1: b.y1 + py }; };
// a view maps atlas units into a rectangle of the canvas (CSS pixels), keeping proportions, centred
function view(b, rect) {
  const k = Math.min(rect.w / (b.x1 - b.x0), rect.h / (b.y1 - b.y0));
  const ox = rect.x + (rect.w - (b.x1 - b.x0) * k) / 2, oy = rect.y + (rect.h - (b.y1 - b.y0) * k) / 2;
  return { rect, X: (p) => ox + (p[0] - b.x0) * k, Y: (p) => oy + (p[1] - b.y0) * k };
}

export async function drawRoads({ canvas, list, caption, heading, party, reduce }) {
  const dir = new URL("../data/atlas/", import.meta.url);
  const [world, routes] = await Promise.all([json(new URL("world.json", dir)), json(new URL("routes.json", dir))]);
  const graph = buildGraph(routes), plan = makePlan(graph);
  // where each node sits: the ends of the edges that touch it (a_path runs from `from` to `to`, atlas units)
  const pos = new Map();
  for (const e of graph.edges.values()) { const p = e.a_path; if (Array.isArray(p) && p.length) { if (!pos.has(e.from)) pos.set(e.from, p[0]); if (!pos.has(e.to)) pos.set(e.to, p[p.length - 1]); } }
  const zoneOf = (id) => (pos.has(id) ? zoneAt(world.zones, pos.get(id)) : "");
  const groups = roadGroups(plan, graph, party, zoneOf);
  if (!groups.length) throw new Error("no roads in the plan");
  const end = zoneOf(plan.meet) || placeName(plan.meet), open = plan.meet_status === "open";

  // ---- the words: heading, caption and one list item per road (what the canvas shows, for everyone and for assistive technology) ----
  heading.textContent = groups.length <= 10 ? `${cap(word(groups.length))} road${groups.length === 1 ? "" : "s"}` : "The roads";
  const color = (g) => (g.shown.length === 1 && CLASS[g.shown[0]]) || BRASS;
  list.replaceChildren(...groups.map((g) => {
    const li = document.createElement("li"); li.className = "road"; li.style.setProperty("--rc", color(g));
    const b = document.createElement("b"); b.textContent = `From ${g.name}${g.zone ? `, ${g.zone}` : ""}.`;
    const who = document.createElement("span"); who.className = "road-who";
    who.textContent = !g.known ? "" : g.people.length ? `${andList(g.people)} ${g.people.length === 1 ? "starts" : "start"} here.` : "Nobody on the board starts here.";
    li.append(b, ` ${roadLine(g, end)}`, who);
    return li;
  }));
  caption.textContent = `Every road ends in ${end}. Meeting point: ${open ? "not picked yet" : placeName(plan.meet)}.`;
  canvas.setAttribute("aria-label", `Map: ${word(groups.length)} road${groups.length === 1 ? "" : "s"} to ${end}, from ${andList(groups.map((g) => g.zone || g.name))}. Every road is written out in the list below the map.`);

  // ---- the geometry: every leg split at its first crossing into the far part (across the sea) and the near part (the meeting side) ----
  const legs = groups.map((g) => {
    const route = plan.who.find((w) => w.from === g.from).route;
    const segs = g.edges.map((id, i) => { const e = graph.edges.get(id), fwd = e.from === route[i]; return { pts: fwd ? e.a_path : e.a_path.slice().reverse(), transit: TRANSIT.has(e.mode), mode: e.mode }; });
    const ti = segs.findIndex((s) => s.transit);
    segs.forEach((s, i) => { s.side = ti < 0 || i > ti ? "near" : i < ti ? "far" : "cross"; });
    return { g, segs, start: pos.get(g.from), far: ti > 0, color: color(g) };
  });
  const nearPts = legs.flatMap((l) => l.segs.flatMap((s) => (s.side === "near" ? s.pts : s.side === "cross" ? [s.pts[s.pts.length - 1]] : [])));
  const farPts = legs.flatMap((l) => l.segs.flatMap((s) => (s.side === "far" ? s.pts : s.side === "cross" ? [s.pts[0]] : [])));
  for (const l of legs) (l.far ? farPts : nearPts).push(l.start);
  const meet = pos.get(plan.meet); if (meet) nearPts.push(meet);
  const nearB = pad(bbox(nearPts), 0.18, 500), farB = farPts.length ? pad(bbox(farPts), 0.25, 600) : null;
  const land = (world.continents || []).flatMap((c) => (c.land || []).map(smoothRing));
  const zoneNames = new Set(groups.map((g) => g.zone).filter(Boolean));
  const zones = (world.zones || []).filter((z) => zoneNames.has(z.name)).flatMap((z) => (z.rings || []).map(smoothRing));
  if (document.fonts && document.fonts.load) { try { await Promise.race([document.fonts.load(FONT), new Promise((r) => setTimeout(r, 1500))]); } catch (e) {} }

  // ---- drawing: a cached background (sea, land, zones, the inset frame) and the roads and labels over it ----
  const g2 = canvas.getContext("2d", { alpha: false }), bg = document.createElement("canvas"), bgc = bg.getContext("2d");
  let W = 0, H = 0, dpr = 1, near = null, far = null;
  const ring = (c, v, r) => { c.beginPath(); r.forEach((p, i) => (i ? c.lineTo(v.X(p), v.Y(p)) : c.moveTo(v.X(p), v.Y(p)))); c.closePath(); };
  const sea = (c, r) => { const s = c.createRadialGradient(r.x + r.w * 0.3, r.y + r.h * 0.3, 0, r.x + r.w * 0.5, r.y + r.h * 0.5, Math.max(r.w, r.h) * 0.85); s.addColorStop(0, "#162633"); s.addColorStop(1, "#091017"); c.fillStyle = s; c.fillRect(r.x, r.y, r.w, r.h); };
  const terrain = (c, v) => {
    c.lineJoin = "round";
    for (const r of land) { ring(c, v, r); c.fillStyle = LAND; c.fill(); }
    c.strokeStyle = COAST; c.lineWidth = 1.2; for (const r of land) { ring(c, v, r); c.stroke(); }
    for (const r of zones) { ring(c, v, r); c.fillStyle = ZONE; c.fill(); c.setLineDash([3, 4]); c.strokeStyle = "rgba(238, 205, 140, .42)"; c.lineWidth = 1; c.stroke(); c.setLineDash([]); }
  };
  const layout = () => {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height)); dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [canvas, bg]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const gap = 8;
    if (farB) {
      // the inset sits in the corner the far side lies towards; the near map keeps the rest of the width
      const fc = [(farB.x0 + farB.x1) / 2, (farB.y0 + farB.y1) / 2], nc = [(nearB.x0 + nearB.x1) / 2, (nearB.y0 + nearB.y1) / 2];
      const right = fc[0] >= nc[0], top = fc[1] <= nc[1];
      const iw = Math.round(Math.min(W * 0.38, 240)), ih = Math.round(Math.min(H * 0.56, iw * Math.max(0.6, Math.min(1.3, (farB.y1 - farB.y0) / (farB.x1 - farB.x0)))));
      const ir = { x: right ? W - iw - gap : gap, y: top ? gap : H - ih - gap, w: iw, h: ih };
      far = view(farB, ir);
      near = view(nearB, { x: right ? 0 : iw + 2 * gap, y: 0, w: W - iw - 2 * gap, h: H });
    } else { far = null; near = view(nearB, { x: 0, y: 0, w: W, h: H }); }
    const c = bgc; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    sea(c, { x: 0, y: 0, w: W, h: H }); terrain(c, near);
    if (far) {
      const r2 = far.rect; c.save(); c.shadowColor = "rgba(0, 0, 0, .6)"; c.shadowBlur = 14; c.fillStyle = "#091017"; c.fillRect(r2.x, r2.y, r2.w, r2.h); c.restore();
      c.save(); c.beginPath(); c.rect(r2.x, r2.y, r2.w, r2.h); c.clip(); sea(c, r2); terrain(c, far); c.restore();
      c.strokeStyle = "rgba(238, 205, 140, .75)"; c.lineWidth = 1.5; c.strokeRect(r2.x + 0.75, r2.y + 0.75, r2.w - 1.5, r2.h - 1.5);
    }
  };
  const line = (c, v, p) => { c.beginPath(); p.forEach((q, i) => (i ? c.lineTo(v.X(q), v.Y(q)) : c.moveTo(v.X(q), v.Y(q)))); };
  // labels never overlap each other: each map has its own list of placed boxes, and the near map treats the inset as taken
  const placedNear = [], placedFar = [];
  const label = (text, x, y, prefer, bounds, placed, font = FONT) => {
    const c = g2; c.font = font; const w = c.measureText(text).width, hh = 15;
    const tries = { right: [x + 12, y + 4], left: [x - 12 - w, y + 4], below: [x - w / 2, y + 22], above: [x - w / 2, y - 12], belowRight: [x + 6, y + 20], aboveLeft: [x - w - 6, y - 10] };
    for (const o of [prefer, "right", "left", "below", "above", "belowRight", "aboveLeft"]) {
      const [tx, ty] = tries[o], b = [tx - 3, ty - hh + 2, w + 6, hh + 3];
      if (b[0] < bounds.x + 2 || b[0] + b[2] > bounds.x + bounds.w - 2 || b[1] < bounds.y + 2 || b[1] + b[3] > bounds.y + bounds.h - 2) continue;
      if (placed.some((q) => !(q[0] + q[2] < b[0] || b[0] + b[2] < q[0] || q[1] + q[3] < b[1] || b[1] + b[3] < q[1]))) continue;
      placed.push(b); c.lineJoin = "round"; c.lineWidth = 3.5; c.strokeStyle = "rgba(8, 5, 3, .92)"; c.strokeText(text, tx, ty); c.fillStyle = CREAM; c.fillText(text, tx, ty);
      return;
    }
  };
  const frame = (t) => {
    const c = g2; c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(bg, 0, 0); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineCap = "round"; c.lineJoin = "round";
    for (const l of legs) {
      const n = l.segs.length;
      l.segs.forEach((s, i) => {
        const f = Math.max(0, Math.min(1, t * n - i)); if (f <= 0) return;
        if (s.side === "cross" && far) {
          // the crossing joins the inset to the near map: a straight dashed line between its two ends, drawn in each map's own scale
          const a = [far.X(s.pts[0]), far.Y(s.pts[0])], z = [near.X(s.pts[s.pts.length - 1]), near.Y(s.pts[s.pts.length - 1])];
          c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(a[0] + (z[0] - a[0]) * f, a[1] + (z[1] - a[1]) * f);
          c.setLineDash([2, 7]); c.strokeStyle = "rgba(238, 205, 140, .9)"; c.lineWidth = 2.2; c.stroke(); c.setLineDash([]); return;
        }
        const v = s.side === "far" && far ? far : near, p = slicePath(s.pts, f); if (p.length < 2) return;
        c.save(); if (v === far) { c.beginPath(); c.rect(far.rect.x, far.rect.y, far.rect.w, far.rect.h); c.clip(); }
        if (s.transit) { line(c, v, p); c.setLineDash([2, 7]); c.strokeStyle = "rgba(238, 205, 140, .9)"; c.lineWidth = 2.2; c.stroke(); c.setLineDash([]); c.restore(); return; }
        line(c, v, p); c.strokeStyle = l.color; c.globalAlpha = 0.25; c.lineWidth = 10; c.stroke(); c.globalAlpha = 1;
        line(c, v, p); c.strokeStyle = INK; c.lineWidth = 5; c.stroke();
        line(c, v, p); c.strokeStyle = l.color; c.lineWidth = 2.8; c.stroke();
        c.restore();
      });
    }
    // markers: a dot per class at each start, and the meeting place as a brass star
    for (const l of legs) {
      const v = l.far && far ? far : near, x = v.X(l.start), y = v.Y(l.start), cls = l.g.shown.length ? l.g.shown : [null];
      cls.forEach((ck, i) => { const dx = (i - (cls.length - 1) / 2) * 10; c.beginPath(); c.arc(x + dx, y, 5.5, 0, Math.PI * 2); c.fillStyle = CLASS[ck] || BRASS; c.fill(); c.lineWidth = 2; c.strokeStyle = INK; c.stroke(); });
    }
    if (meet && t >= 1) {
      const x = near.X(meet), y = near.Y(meet); c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 4.4 : 10; c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); } c.closePath();
      c.fillStyle = BRASS; c.fill(); c.lineWidth = 2; c.strokeStyle = INK; c.stroke();
    }
    if (t >= 1) {
      placedNear.length = 0; placedFar.length = 0;
      const all = { x: 0, y: 0, w: W, h: H };
      if (far) placedNear.push([far.rect.x - 4, far.rect.y - 4, far.rect.w + 8, far.rect.h + 8]);
      // the markers are obstacles too: no label sits on the star or on a start's dots
      for (const l of legs) if (!(l.far && far)) { const half = ((Math.max(1, l.g.shown.length) - 1) / 2) * 10; placedNear.push([near.X(l.start) - half - 7, near.Y(l.start) - 7, 2 * half + 14, 14]); }
      if (meet) { label(end, near.X(meet), near.Y(meet), "below", all, placedNear); placedNear.push([near.X(meet) - 11, near.Y(meet) - 11, 22, 22]); }
      for (const l of legs) {
        if (l.far && far) continue;
        const x = near.X(l.start), y = near.Y(l.start), half = ((Math.max(1, l.g.shown.length) - 1) / 2) * 10;
        label(l.g.zone || l.g.name, x + (x > W * 0.6 ? -half : half), y, x > W * 0.6 ? "left" : "right", all, placedNear);
      }
      if (far) {
        // the inset is titled with the zone(s) it shows, inside its frame
        const names = [...new Set(legs.filter((l) => l.far).map((l) => l.g.zone || l.g.name))].join(" · "), r = far.rect;
        c.font = FONT_S; c.lineJoin = "round"; c.lineWidth = 3.5; c.strokeStyle = "rgba(8, 5, 3, .92)"; c.strokeText(names, r.x + 7, r.y + 16, r.w - 14); c.fillStyle = CREAM; c.fillText(names, r.x + 7, r.y + 16, r.w - 14);
        const cross = legs.flatMap((l) => l.segs.filter((s) => s.side === "cross"))[0];
        if (cross) {
          // the crossing's label goes at the middle of the part of the line outside the inset
          const a = [far.X(cross.pts[0]), far.Y(cross.pts[0])], z = [near.X(cross.pts[cross.pts.length - 1]), near.Y(cross.pts[cross.pts.length - 1])]; let t = 0; for (let i = 1; i <= 24; i++) { const u = i / 24, x = z[0] + (a[0] - z[0]) * u, y = z[1] + (a[1] - z[1]) * u; if (x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4) break; t = u; }
          const q = [z[0] + (a[0] - z[0]) * t / 2, z[1] + (a[1] - z[1]) * t / 2]; label(cross.mode === "boat" ? "boat" : "zeppelin", q[0], q[1], "above", all, placedNear, FONT_S);
        }
      }
    }
  };

  layout();
  let raf = 0;
  if (reduce()) frame(1);
  else { const t0 = performance.now(); const step = (now) => { const t = Math.min(1, (now - t0) / REVEAL_MS); frame(ease(t)); raf = t < 1 ? requestAnimationFrame(step) : 0; }; raf = requestAnimationFrame(step); }
  // a resize lays out and draws the finished map once (no reveal again)
  let lastW = W, lastH = H, rz = 0;
  if ("ResizeObserver" in window) new ResizeObserver(() => { if (rz) return; rz = requestAnimationFrame(() => { rz = 0; const r = canvas.getBoundingClientRect(); if (Math.round(r.width) === lastW && Math.round(r.height) === lastH) return; if (raf) { cancelAnimationFrame(raf); raf = 0; } layout(); lastW = W; lastH = H; frame(1); }); }).observe(canvas);
  return { groups, end, open };
}
