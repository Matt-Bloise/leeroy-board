// Smoothed shapes for the Atlas (fix round 2). world.json keeps the client grid's simplified rings as they are (the data stays
// byte-stable); this module turns them into the shapes the map draws, the same way in the engine and in the tile painter:
//   1. each continent's land rings and zone rings are rasterised onto one label grid (CELL A-units a cell, world aligned):
//      land from the land rings (holes filled), zones in order of size (a smaller zone wins an overlap), gaps filled from the nearest zone,
//      one majority pass to drop raster specks;
//   2. every boundary is traced along cell edges and cut at junctions (a lattice point where three regions meet, or a
//      checkerboard pinch), so each piece of border is shared by exactly the two regions beside it;
//   3. each piece is smoothed once (Douglas-Peucker to take out the staircase, then Chaikin corner cutting, then a light
//      tidy), and zone rings, coast rings and border lines are put together from those same pieces.
// So a zone's fill, its neighbour's fill, the dotted border between them and the coast all meet exactly. Pure and
// deterministic: no DOM, no clock, no random; the same world gives the same numbers in Node and in any browser.
export const SHAPE = { cell: 60, eps: 1, iters: 3, tidy: 0.12, version: 1 };

// ---------- polyline helpers ----------
function perp(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
export function dpOpen(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop(); let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) { const d = perp(pts[i], pts[s], pts[e]); if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// a closed ring (no repeated last point): split at the point farthest from the first, simplify both halves
export function dpClosed(pts, eps) {
  if (pts.length <= 4) return pts.slice();
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dpOpen(pts.slice(0, far + 1), eps), b = dpOpen(pts.slice(far).concat([pts[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}
// Chaikin corner cutting: each pass replaces a corner by two points a quarter of the way along its edges. An open line keeps
// its two ends (the junctions other pieces share).
export function chaikin(pts, iters, closed) {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const n = p.length; if (n < 3) return p;
    const out = closed ? [] : [p[0]];
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = p[i], b = p[(i + 1) % n];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) out.push(p[n - 1]);
    p = out;
  }
  return p;
}
const r1 = (n) => Math.round(n * 10) / 10;

// ---------- raster ----------
// even-odd scanline fill of rings into a mask of nx by ny cells (cell centres tested)
function fillMask(rings, g, mask, val) {
  const { x0, y0, nx, ny, G } = g, xs = [];
  let ylo = Infinity, yhi = -Infinity;
  for (const r of rings) for (const q of r) { if (q[1] < ylo) ylo = q[1]; if (q[1] > yhi) yhi = q[1]; }
  const j0 = Math.max(0, Math.floor((ylo - y0) / G) - 1), j1 = Math.min(ny - 1, Math.ceil((yhi - y0) / G) + 1);
  for (let j = j0; j <= j1; j++) {
    const yc = y0 + (j + 0.5) * G; xs.length = 0;
    for (const r of rings) for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
      const a = r[i], b = r[k];
      if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let t = 0; t + 1 < xs.length; t += 2) {
      const i0 = Math.max(0, Math.ceil((xs[t] - x0) / G - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[t + 1] - x0) / G - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * nx + i] = val;
    }
  }
}

// ---------- one continent ----------
function continentShapes(c, zones, G, cache) {
  // the lattice: world aligned, two cells of sea around everything
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const grow = (r) => { for (const q of r) { if (q[0] < bx0) bx0 = q[0]; if (q[1] < by0) by0 = q[1]; if (q[0] > bx1) bx1 = q[0]; if (q[1] > by1) by1 = q[1]; } };
  for (const r of c.land || []) grow(r);
  for (const zz of zones) for (const r of zz.z.rings) grow(r);
  if (!(bx1 > bx0)) return null;
  const x0 = Math.floor(bx0 / G) * G - 2 * G, y0 = Math.floor(by0 / G) * G - 2 * G;
  const nx = Math.ceil((bx1 - x0) / G) + 2, ny = Math.ceil((by1 - y0) / G) + 2, N = nx * ny, g = { x0, y0, nx, ny, G };
  // land is every ring's inside: a hole in the rings is grid cells the build dropped (no known area, no terrain), not water,
  // so it is drawn as land and the zone around it takes it (the old painter's nonzero clip filled them too)
  const land = new Uint8Array(N); for (const r of c.land || []) fillMask([r], g, land, 1);
  // zones, largest first, so a smaller zone (a city) wins where two rings overlap
  const order = zones.slice().sort((a, b) => b.area - a.area || (a.z.id < b.z.id ? -1 : 1));
  const lab = new Int16Array(N), tmp = new Uint8Array(N);
  order.forEach((zz, k) => {
    tmp.fill(0); fillMask(zz.z.rings, g, tmp, 1);
    for (let i = 0; i < N; i++) if (tmp[i] && land[i]) lab[i] = k + 1;
  });
  // land no zone ring covers takes the nearest zone (breadth first from every labelled cell, in index order)
  const q = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (lab[i]) q[qt++] = i;
  while (qh < qt) {
    const i = q[qh++], x = i % nx, y = (i / nx) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
      const k = Y * nx + X; if (land[k] && !lab[k]) { lab[k] = lab[i]; q[qt++] = k; }
    }
  }
  // one majority pass over land: a cell most of whose eight neighbours share another zone joins it
  const src = lab.slice(), cnt = new Int16Array(order.length + 1);
  for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = y * nx + x; if (!src[i]) continue;
    let best = src[i], bn = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = src[i + dy * nx + dx]; if (v) cnt[v]++; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = src[i + dy * nx + dx]; if (v && cnt[v] > bn) { bn = cnt[v]; best = v; } }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt[src[i + dy * nx + dx]] = 0;
    if (best !== src[i] && bn >= 6) lab[i] = best;
  }
  const L = (x, y) => (x < 0 || y < 0 || x >= nx || y >= ny ? 0 : lab[y * nx + x]);
  const V = nx + 1, vid = (x, y) => y * V + x;
  // junctions: three or more labels around a lattice point, or a two-label checkerboard
  const junction = (x, y) => {
    const a = L(x - 1, y - 1), b = L(x, y - 1), cc = L(x - 1, y), d = L(x, y);
    const n = new Set([a, b, cc, d]).size;
    return n >= 3 || (n === 2 && a === d && b === cc && a !== b);
  };
  // the directed edges around region test(cell): the region on the left of travel (y grows downward)
  const traceRings = (test, box) => {
    const out = new Map(); // from vertex id -> list of [to vertex id, dx, dy]
    const add = (fx, fy, tx, ty) => { const k = vid(fx, fy); if (!out.has(k)) out.set(k, []); out.get(k).push([vid(tx, ty), tx - fx, ty - fy]); };
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) {
      if (!test(L(x, y))) continue;
      if (!test(L(x, y - 1))) add(x + 1, y, x, y);
      if (!test(L(x - 1, y))) add(x, y, x, y + 1);
      if (!test(L(x, y + 1))) add(x, y + 1, x + 1, y + 1);
      if (!test(L(x + 1, y))) add(x + 1, y + 1, x + 1, y);
    }
    const rings = [];
    for (const k0 of [...out.keys()].sort((a, b) => a - b)) {
      while (out.get(k0) && out.get(k0).length) {
        const ring = [k0]; let cur = k0, dir = null, guard = 0;
        for (;;) {
          const list = out.get(cur); if (!list || !list.length) break;
          let pick = 0;
          // a pinch: turn toward the region, so the two diagonal cells stay apart
          if (list.length > 1 && dir) { pick = list.findIndex((e) => dir[0] * e[2] - dir[1] * e[1] < 0); if (pick < 0) pick = 0; }
          const [to, dx, dy] = list.splice(pick, 1)[0];
          dir = [dx, dy]; cur = to;
          if (cur === k0 || ++guard > 1e6) break;
          ring.push(cur);
        }
        if (ring.length >= 3) rings.push(ring);
      }
    }
    return rings;
  };
  const xyOf = (k) => [x0 + (k % V) * G, y0 + Math.floor(k / V) * G];
  const isJ = new Map(); const J = (k) => { if (!isJ.has(k)) isJ.set(k, junction(k % V, Math.floor(k / V))); return isJ.get(k); };
  // a piece's key is its vertex list in the canonical direction; the smoothed points are cached by key, so both sides get the same
  // each label's box of cells, so a zone's trace walks its own box only
  const boxes = new Map(); let lb = [nx, ny, -1, -1];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const v = lab[y * nx + x]; if (!v) continue;
    let b = boxes.get(v); if (!b) { b = [x, y, x, y]; boxes.set(v, b); }
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    if (x < lb[0]) lb[0] = x; if (y < lb[1]) lb[1] = y; if (x > lb[2]) lb[2] = x; if (y > lb[3]) lb[3] = y;
  }
  const smoothRun = (run, closed) => {
    let r = run, rev = false;
    if (closed) {
      let m = 0; for (let i = 1; i < r.length; i++) if (r[i] < r[m]) m = i;
      r = r.slice(m).concat(r.slice(0, m));
      if (r[r.length - 1] < r[1]) { r = [r[0]].concat(r.slice(1).reverse()); rev = true; }
    } else {
      const f = [r[0], r[1]], b = [r[r.length - 1], r[r.length - 2]];
      if (b[0] < f[0] || (b[0] === f[0] && b[1] < f[1])) { r = r.slice().reverse(); rev = true; }
    }
    const key = `${c.id}:${closed ? "o" : "-"}${r.join(",")}`;
    let pts = cache.get(key);
    if (!pts) {
      const raw = r.map(xyOf);
      pts = closed
        ? dpClosed(chaikin(dpClosed(raw, SHAPE.eps * G), SHAPE.iters, true), SHAPE.tidy * G)
        : dpOpen(chaikin(dpOpen(raw, SHAPE.eps * G), SHAPE.iters, false), SHAPE.tidy * G);
      pts = pts.map((p) => [r1(p[0]), r1(p[1])]);
      cache.set(key, pts);
    }
    return { key, canon: pts, pts: rev ? (closed ? [pts[0]].concat(pts.slice(1).reverse()) : pts.slice().reverse()) : pts };
  };
  // a traced ring cut at its junctions into pieces, smoothed piece by piece and joined again
  const sideOf = (a, b, test) => { // the label across the first edge of a piece, seen from the region
    const ax = a % V, ay = Math.floor(a / V), dx = (b % V) - ax, dy = Math.floor(b / V) - ay;
    // region on the left of travel: the cell on the right is across
    const cx = dx === 1 ? ax : dx === -1 ? ax - 1 : dy === 1 ? ax - 1 : ax, cy = dy === 1 ? ay : dy === -1 ? ay - 1 : dx === 1 ? ay : ay - 1;
    const v = L(cx, cy); return test(v) ? null : v;
  };
  const pieces = new Map(); // key -> { pts, sides: Set }
  const assemble = (ring, test, self) => {
    const js = []; for (let i = 0; i < ring.length; i++) if (J(ring[i])) js.push(i);
    const note = (run, closed) => {
      const s = smoothRun(run, closed), other = sideOf(run[0], run[1], test);
      if (!pieces.has(s.key)) pieces.set(s.key, { pts: s.canon, closed, sides: new Set() });
      const P = pieces.get(s.key); P.sides.add(self); if (other !== null) P.sides.add(other);
      return s.pts;
    };
    if (!js.length) return note(ring, true);
    const out = [];
    for (let t = 0; t < js.length; t++) {
      const a = js[t], b = js[(t + 1) % js.length], run = [];
      for (let i = a; ; i = (i + 1) % ring.length) { run.push(ring[i]); if (i === b && run.length > 1) break; }
      const pts = note(run, false);
      for (let i = 0; i < pts.length - 1; i++) out.push(pts[i]);
    }
    return out;
  };
  const zoneRings = new Map();
  order.forEach((zz, k) => {
    const id = k + 1, test = (v) => v === id;
    const b = boxes.get(id);
    zoneRings.set(zz.z.id, b ? traceRings(test, b).map((ring) => assemble(ring, test, id)).filter((r) => r.length >= 3) : []);
  });
  const landTest = (v) => v > 0;
  const landRings = lb[2] < 0 ? [] : traceRings(landTest, lb).map((ring) => assemble(ring, landTest, -1)).filter((r) => r.length >= 3);
  // borders: pieces with a zone on both sides, each drawn once
  const borders = [];
  for (const P of pieces.values()) { const zs = [...P.sides].filter((s) => s > 0); if (zs.length >= 2 && !P.sides.has(0)) borders.push(P.closed ? P.pts.concat([P.pts[0]]) : P.pts); }
  return { land: landRings, zones: zoneRings, borders, cells: N };
}

// One ring smoothed on its own (subzone outlines, drawn as hairlines from zoom 3, share no border with anything drawn)
export function smoothRing(r) { return r.length > 4 ? chaikin(dpClosed(r, 0.5 * SHAPE.cell), 2, true).map((p) => [r1(p[0]), r1(p[1])]) : r; }

// The shapes for a whole world. Returns null for a world drawn from rectangles (no zone grid).
export function buildShapes(world, o = {}) {
  if (!world || !world.zones || (world.shapes && world.shapes.source === "rectangles")) return null;
  const G = o.cell || SHAPE.cell, cache = new Map(), out = { land: new Map(), zones: new Map(), borders: [], cells: 0, cell: G };
  for (const c of world.continents || []) {
    const zones = world.zones.filter((z) => z.map_id === c.map_id && z.rings && z.rings.length).map((z) => ({ z, area: (z.a_rect[2] - z.a_rect[0]) * (z.a_rect[3] - z.a_rect[1]) }));
    const s = continentShapes(c, zones, G, cache); if (!s) continue;
    out.land.set(c.id, s.land); out.cells += s.cells;
    for (const [id, rings] of s.zones) out.zones.set(id, rings);
    for (const b of s.borders) out.borders.push(b);
  }
  return out;
}
