// The vector layers and label culling (contract 2.1). Paths are kept in A-units and drawn under one transform, so a zoom
// never rebuilds them; line widths are written in screen pixels and divided by the scale. Culling is plain arrays and a
// cell grid, never pairwise. Colours arrive from the page's tokens through S.colors; the literals below are fallbacks only.
export const LAYERS = ["coasts", "zones", "subzones", "courses", "flights", "zeppelins", "dungeons", "hubs", "flightpoints", "party", "labels"];

// the sprite cell each kind of place uses on the icon sheet (img/atlas/icons-<cell>.webp)
export const ICON = { city: "horde-city", hub: "town", start: "start-star", meet: "meeting-banner", flight: "flight-point", zeppelin: "zeppelin-tower", dungeon: "dungeon-gate", raid: "raid-gate", subzone: "meeting-banner" };
export const iconOf = (p) => (p.kind === "city" && p.faction === "alliance" ? "alliance-city" : ICON[p.kind] || null);
export const layerOfPlace = (p) => (p.kind === "dungeon" || p.kind === "raid" ? "dungeons" : p.kind === "flight" ? "flightpoints" : p.kind === "zeppelin" ? "zeppelins" : "hubs");
// the zoom each kind appears at, and the one its name appears at (labels are also culled by collision)
const SHOW = { city: -9, raid: 1, meet: 1, hub: 1.5, dungeon: 1.5, zeppelin: 1.5, start: 2, flight: 2, subzone: 2.5 };
const NAME = { city: 1, raid: 2.5, meet: 2, hub: 2.5, dungeon: 3, zeppelin: 3, start: 3, flight: 3, subzone: 3 };
const PRIO = { zone: 6, city: 5, meet: 4.5, hub: 4, raid: 3.5, dungeon: 3, start: 2.5, zeppelin: 2, flight: 1, subzone: 1 };
export const FALLBACK = { ink: "#2b1d10", inkSoft: "#46331f", parchment: "#eadfc4", parchment2: "#d9c9a3", brass: "#d1a85a", brassDim: "#8a6c35", sea: "#b9c9bd", land: "#d9c9a3", horde: "#8c2f1b", alliance: "#2b4a7a", contested: "#6b5a2e", plan: "#b5471f", font: "Georgia, serif" };

const hasPath = typeof Path2D === "function";
const lineTo = (c, ring, close) => { c.moveTo(ring[0][0], ring[0][1]); for (let i = 1; i < ring.length; i++) c.lineTo(ring[i][0], ring[i][1]); if (close) c.closePath(); };
const bboxOf = (rings) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const r of rings) for (const q of r) { if (q[0] < b[0]) b[0] = q[0]; if (q[1] < b[1]) b[1] = q[1]; if (q[0] > b[2]) b[2] = q[0]; if (q[1] > b[3]) b[3] = q[1]; } return b; };
function pathOf(rings, close) {
  const bb = bboxOf(rings);
  if (!hasPath) return { rings, close, p: null, bb };
  const p = new Path2D();
  for (const r of rings) if (r.length > 1) lineTo(p, r, close);
  return { rings, close, p, bb };
}
// a stroke whose box misses the view is skipped. Dashes cost the GPU most of a frame (2026-10-30, the owner's pane at 2278 by
// 845 px: pan p50 22.8 ms dashed, 11.5 ms solid), so while the view moves (S.moving) strokes go solid and settle dashed.
const seen = (pp, r) => !!pp && !(pp.bb[2] < r[0] || pp.bb[0] > r[2] || pp.bb[3] < r[1] || pp.bb[1] > r[3]);
function strokePath(ctx, pp) {
  if (pp.p) { ctx.stroke(pp.p); return; }
  ctx.beginPath(); for (const r of pp.rings) if (r.length > 1) lineTo(ctx, r, pp.close); ctx.stroke();
}
function fillPath(ctx, pp) {
  if (pp.p) { ctx.fill(pp.p); return; }
  ctx.beginPath(); for (const r of pp.rings) if (r.length > 1) lineTo(ctx, r, pp.close); ctx.fill();
}
export function inRing(ring, x, y) {
  let in_ = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) in_ = !in_;
  }
  return in_;
}
const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
const textW = (ctx, t, px) => { const m = typeof ctx.measureText === "function" ? ctx.measureText(t) : null; return m && m.width ? m.width : t.length * px * 0.58; };

export function createLayers(data) {
  const L = { data, on: {}, zones: [], places: [], subzones: [], land: [], borders: null, edgePaths: new Map(), zoneRect: false, hidden: new Set() };
  for (const n of LAYERS) L.on[n] = true;
  const prep = () => {
    const w = data.world, rects = !!(w.shapes && w.shapes.source === "rectangles"), sh = !rects && data.shapes;
    L.zoneRect = rects;
    // the smoothed shapes (shape.js) where they were built: coasts, zone rings and the borders between zones, each drawn once
    L.land = (w.continents || []).map((c) => ({ id: c.id, path: pathOf((sh && sh.land.get(c.id)) || c.land || [], true) }));
    L.borders = sh && sh.borders.length ? pathOf(sh.borders, false) : null;
    L.zones = (w.zones || []).map((z) => {
      const own = sh && sh.zones.get(z.id);
      const rings = own && own.length ? own : !rects && z.rings && z.rings.length ? z.rings : [[[z.a_rect[0], z.a_rect[1]], [z.a_rect[2], z.a_rect[1]], [z.a_rect[2], z.a_rect[3]], [z.a_rect[0], z.a_rect[3]]]];
      return { z, rings, path: pathOf(rings, true), area: area(z.a_rect) };
    });
    L.zonesByArea = L.zones.slice().sort((a, b) => a.area - b.area);
    L.places = (data.places.places || []).map((p) => ({ p, layer: layerOfPlace(p), icon: iconOf(p) }));
    L.byId = new Map(L.places.map((x) => [x.p.id, x]));
    L.zoneById = new Map(L.zones.map((x) => [x.z.id, x]));
    L.zoneIds = new Set(L.zones.map((x) => x.z.id));
    L.placeIds = new Set(L.places.map((x) => x.p.id));
    for (const e of (data.routes && data.routes.edges) || []) L.edgePaths.set(e.id, pathOf([e.a_path], false));
    for (const t of (data.routes && data.routes.transports) || []) L.edgePaths.set(`t:${t.id}`, pathOf([t.a_path], false));
  };
  prep();
  L.setSubzones = (sz) => {
    L.subzones = (sz || []).map((s) => {
      const rings = s.rings && s.rings.length ? s.rings : s.a_rect ? [[[s.a_rect[0], s.a_rect[1]], [s.a_rect[2], s.a_rect[1]], [s.a_rect[2], s.a_rect[3]], [s.a_rect[0], s.a_rect[3]]]] : [];
      return { s, rings, path: pathOf(rings, true) };
    });
  };

  const shownAt = (x, z, S) => {
    if (!L.on[x.layer] || L.hidden.has(x.p.id)) return false;
    if (S && (S.focus === x.p.id || S.pinned === x.p.id || (S.planPlaces && S.planPlaces.has(x.p.id)))) return true;
    return z >= (SHOW[x.p.kind] === undefined ? 2 : SHOW[x.p.kind]);
  };
  const iconPx = (z) => Math.max(20, Math.min(34, 18 + z * 3));
  L.iconPx = iconPx;
  L.placesInView = (V, S) => {
    const out = [];
    for (const x of L.places) if (shownAt(x, V.z, S) && V.inView(x.p.a[0], x.p.a[1], 24)) out.push(x.p);
    return out;
  };
  L.hit = (V, px, py, coarse, S) => {
    const disc = coarse ? 48 : 24;
    let best = null, bd = Infinity;
    for (const x of L.places) {
      if (!shownAt(x, V.z, S)) continue;
      const [sx, sy] = V.toScreen(x.p.a[0], x.p.a[1]), d = Math.hypot(sx - px, sy - py), r = Math.max(disc / 2, iconPx(V.z) / 2);
      if (d <= r && d < bd) { bd = d; best = x.p; }
    }
    if (best) return { place: best };
    if (!L.on.zones) return null;
    const [au, av] = V.toA(px, py);
    for (const zz of L.zonesByArea) for (const ring of zz.rings) if (inRing(ring, au, av)) return { zone: zz.z };
    return null;
  };

  const colors = (S) => Object.assign({}, FALLBACK, S.colors || {});
  const factionColor = (C, f) => (f === "horde" ? C.horde : f === "alliance" ? C.alliance : C.contested);

  // ---------- the draw: A-unit layers under one transform, then screen-space sprites and labels ----------
  L.draw = (ctx, V, S) => {
    const C = colors(S), s = V.scale(), k = V.dpr, z = V.z, noTiles = !S.tilesLoaded;
    ctx.setTransform(k, 0, 0, k, 0, 0); ctx.globalAlpha = 1;
    // land shows as parchment where no painted tile has arrived yet
    ctx.setTransform(k * s, 0, 0, k * s, k * (V.w / 2 - V.cx * s), k * (V.h / 2 - V.oy - V.cy * s));
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const px = (n) => n / s;
    if (noTiles) { ctx.fillStyle = C.land; ctx.globalAlpha = 0.9; for (const l of L.land) fillPath(ctx, l.path); ctx.globalAlpha = 1; }
    if (L.on.coasts) {
      for (const l of L.land) {
        ctx.save();
        if (l.path.p) { ctx.clip(l.path.p); ctx.strokeStyle = C.ink; ctx.globalAlpha = 0.1; ctx.lineWidth = px(12); strokePath(ctx, l.path); }
        ctx.restore();
        ctx.globalAlpha = 1; ctx.strokeStyle = C.ink; ctx.lineWidth = px(2 - Math.min(1, Math.max(0, z / 3))); strokePath(ctx, l.path);
      }
    }
    if (L.on.zones) {
      const r = V.rect();
      let hotZ = null;
      for (const zz of L.zones) {
        const a = zz.z.a_rect; if (a[2] < r[0] || a[0] > r[2] || a[3] < r[1] || a[1] > r[3]) continue;
        const hot = S.zoneHot === zz.z.id; if (hot) hotZ = zz;
        ctx.globalAlpha = hot ? 0.2 : 0.08; ctx.fillStyle = factionColor(C, zz.z.faction); fillPath(ctx, zz.path);
        if (!L.borders && !hot) { ctx.globalAlpha = 0.55; ctx.strokeStyle = C.inkSoft; ctx.lineWidth = px(1.2); ctx.setLineDash(S.moving ? [] : [px(2), px(4)]); strokePath(ctx, zz.path); ctx.setLineDash([]); }
      }
      // one dotted line per shared border (a border drawn by both its zones doubles its dots)
      if (L.borders && seen(L.borders, r)) { ctx.globalAlpha = 0.55; ctx.strokeStyle = C.inkSoft; ctx.lineWidth = px(1.2); ctx.setLineDash(S.moving ? [] : [px(2), px(4)]); strokePath(ctx, L.borders); ctx.setLineDash([]); }
      if (hotZ) { ctx.globalAlpha = 0.9; ctx.strokeStyle = C.inkSoft; ctx.lineWidth = px(2); ctx.setLineDash(S.moving ? [] : [px(2), px(4)]); strokePath(ctx, hotZ.path); ctx.setLineDash([]); }
      ctx.globalAlpha = 1;
    }
    if (L.on.subzones && z >= 3) {
      ctx.strokeStyle = C.inkSoft; ctx.globalAlpha = 0.4; ctx.lineWidth = px(0.8);
      const sr = V.rect(); for (const sz of L.subzones) if (seen(sz.path, sr)) strokePath(ctx, sz.path);
      ctx.globalAlpha = 1;
    }
    // courses: walking edges dashed, flight paths softer, transports a long dash
    const edges = (data.routes && data.routes.edges) || [], vr = V.rect();
    const drawEdges = (mode, on, dash, alpha, w) => {
      if (!on) return;
      ctx.strokeStyle = C.inkSoft; ctx.globalAlpha = alpha; ctx.lineWidth = px(w); ctx.setLineDash(S.moving ? [] : dash.map(px));
      for (const e of edges) if (e.mode === mode) { const pp = L.edgePaths.get(e.id); if (seen(pp, vr)) strokePath(ctx, pp); }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    };
    drawEdges("course", L.on.courses, [6, 5], z < 1 ? 0.35 : 0.7, 1.6);
    drawEdges("flightpath", L.on.flights, [3, 6], 0.45, 1.2);
    if (L.on.zeppelins) {
      ctx.strokeStyle = C.inkSoft; ctx.globalAlpha = 0.6; ctx.lineWidth = px(1.6); ctx.setLineDash(S.moving ? [] : [px(16), px(7)]);
      for (const e of edges) if (e.mode === "zeppelin" || e.mode === "boat") { const pp = L.edgePaths.get(e.id); if (seen(pp, vr)) strokePath(ctx, pp); }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // the plan: every drawn edge as ink under a warm line, partial edges cut at their progress
    if (S.planEdges && S.planEdges.length) {
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? C.plan : C.ink; ctx.lineWidth = px(pass ? 3.4 : 5.6); ctx.globalAlpha = pass ? 0.95 : 0.55; ctx.setLineDash([]);
        for (const pe of S.planEdges) {
          if (pe.progress <= 0) continue;
          const pts = pe.pts; if (!pts || pts.length < 2) continue;
          ctx.beginPath(); lineTo(ctx, pts, false); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // ---------- screen space ----------
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const size = iconPx(z), cands = [];
    const sprite = (name) => (S.sprites && S.sprites[name]) || null;
    const drawn = [];
    for (const x of L.places) {
      if (!shownAt(x, z, S) || !V.inView(x.p.a[0], x.p.a[1], 60)) continue;
      const [sx, sy] = V.toScreen(x.p.a[0], x.p.a[1]), img = x.icon && sprite(x.icon), isF = S.focus === x.p.id, end = !!(S.planEnds && S.planEnds.has(x.p.id));
      drawn.push(x.p);
      // a plan's starts and meeting point keep a readable icon and their names at any zoom (the day-one view on a phone is wide)
      const sz = isF ? size * 1.25 : end ? Math.max(size, 28) : size;
      if (isF) { ctx.beginPath(); ctx.arc(sx, sy, sz * 0.72, 0, 6.2832); ctx.strokeStyle = C.brass; ctx.lineWidth = 3; ctx.stroke(); }
      if (img) ctx.drawImage(img, sx - sz / 2, sy - sz / 2, sz, sz);
      else { // art not here yet: a plain disc in the faction colour, not an icon
        ctx.beginPath(); ctx.arc(sx, sy, sz * 0.28, 0, 6.2832); ctx.fillStyle = factionColor(C, x.p.faction); ctx.globalAlpha = 0.95; ctx.fill();
        ctx.globalAlpha = 1; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.stroke();
      }
      if (S.pinned === x.p.id) { ctx.beginPath(); ctx.arc(sx, sy, sz * 0.55, 0, 6.2832); ctx.strokeStyle = C.plan; ctx.lineWidth = 3; ctx.stroke(); }
      const nz = NAME[x.p.kind] === undefined ? 3 : NAME[x.p.kind];
      if (L.on.labels && (z >= nz || isF || end || S.hover === x.p.id)) cands.push({ t: x.p.name, x: sx, y: sy + sz * 0.62, pr: isF || S.hover === x.p.id ? 9 : end ? 8 : PRIO[x.p.kind] || 1, size: 12, kind: "place" });
    }
    L.lastDrawn = drawn;
    if (L.on.zeppelins && S.zep && sprite("zeppelin")) {
      const [sx, sy] = V.toScreen(S.zep.pos[0], S.zep.pos[1]), w = 54, im = sprite("zeppelin");
      ctx.save(); ctx.translate(sx, sy); if (S.zep.flip) ctx.scale(-1, 1); ctx.drawImage(im, -w / 2, -w * 0.3, w, w * 0.6); ctx.restore();
    }
    if (L.on.party && S.party) {
      for (const m of S.party) {
        const [sx0, sy] = V.toScreen(m.pos[0], m.pos[1]), sx = sx0 + (m.dx || 0), pin = sprite("pin"), crest = sprite(`crest-${m.class_key}`), w = 30;
        ctx.beginPath(); ctx.arc(sx, sy - w * 0.62, w * 0.36, 0, 6.2832); ctx.fillStyle = m.color || C.brass; ctx.fill();
        if (crest) ctx.drawImage(crest, sx - w * 0.28, sy - w * 0.9, w * 0.56, w * 0.56);
        if (pin) ctx.drawImage(pin, sx - w * 0.34, sy - w * 1.0, w * 0.68, w);
        else { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
    if (L.on.labels) {
      if (L.on.zones) for (const zz of L.zones) {
        const lb = zz.z.label; if (!lb || z < (lb.min_zoom || 0) || L.placeIds.has(zz.z.id)) continue;
        const [sx, sy] = V.toScreen(lb.a[0], lb.a[1]);
        if (sx < -80 || sy < -30 || sx > V.w + 80 || sy > V.h + 30) continue;
        const wpx = (zz.z.a_rect[2] - zz.z.a_rect[0]) * s;
        if (wpx < 46) continue;
        cands.push({ t: zz.z.name.toUpperCase(), x: sx, y: sy, pr: PRIO.zone, size: Math.max(12, Math.min(20, 10 + z * 2)), kind: "zone", fit: wpx });
      }
      const named = new Set(cands.map((c) => c.t)); /* a subzone that shares a place's name (The Crossroads) is named once, by the place */
      if (z >= 3) for (const sz of L.subzones) { const lb = sz.s.label; if (!lb || z < (lb.min_zoom || 3) || named.has(sz.s.name)) continue; const [sx, sy] = V.toScreen(lb.a[0], lb.a[1]); cands.push({ t: sz.s.name || sz.s.id, x: sx, y: sy, pr: 0.5, size: 12, kind: "sub" }); }
      L.drawLabels(ctx, V, cands, C);
    }
    ctx.globalAlpha = 1;
  };

  // priority first, a cell grid for collisions; the drawn count is kept for the tests
  L.drawLabels = (ctx, V, cands, C) => {
    cands.sort((a, b) => b.pr - a.pr);
    const cell = 40, occ = new Set(), cols = Math.ceil(V.w / cell) + 4; let n = 0;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const c of cands) {
      ctx.font = `${c.kind === "zone" ? 600 : 500} ${c.size}px ${C.font}`;
      const w = textW(ctx, c.t, c.size), h = c.size + 4;
      if (c.fit && w > c.fit * 1.05) continue;
      // a place's name near the edge slides inward rather than being cut by it (its point is in view)
      if (c.kind === "place") c.x = Math.max(w / 2 + 4, Math.min(V.w - w / 2 - 4, c.x));
      const x0 = Math.floor((c.x - w / 2) / cell), x1 = Math.floor((c.x + w / 2) / cell), y0 = Math.floor((c.y - h / 2) / cell), y1 = Math.floor((c.y + h / 2) / cell);
      let free = true;
      for (let gy = y0; gy <= y1 && free; gy++) for (let gx = x0; gx <= x1; gx++) if (occ.has(gy * cols + gx + 2)) { free = false; break; }
      if (!free) continue;
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) occ.add(gy * cols + gx + 2);
      if ("letterSpacing" in ctx) ctx.letterSpacing = c.kind === "zone" ? "1.5px" : "0px";
      ctx.lineWidth = 3; ctx.strokeStyle = C.parchment; ctx.globalAlpha = 0.85; ctx.lineJoin = "round"; ctx.strokeText(c.t, c.x, c.y);
      ctx.globalAlpha = 1; ctx.fillStyle = c.kind === "zone" ? C.ink : C.inkSoft; ctx.fillText(c.t, c.x, c.y);
      n++;
    }
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    L.lastLabels = n;
  };
  return L;
}
