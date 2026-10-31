export const FRAME = { w: 30000, h: 20000 };
export const BASE = 1536 / 30000; // CSS px per A-unit at zoom 0 (level 0 is 1536 px wide)
export const ZMAX = 3; // a level-3 tile (the last painted) is 512 css px at zoom 3: 1.0 texel on a 1x screen
export const BACKING_MAX = 8e6; // device pixels in the canvas backing
export const backingDpr = (dpr, w, h) => { const d = Math.min(dpr || 1, 3), px = Math.max(1, w * h); return px * d * d > BACKING_MAX ? Math.max(1, Math.sqrt(BACKING_MAX / px)) : d; };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function createView(o = {}) {
  const V = { w: o.w || 600, h: o.h || 400, dpr: o.dpr || 1, cx: 15000, cy: 10000, z: 0, zmin: -2, oy: 0 }; // oy: pixels the focus sits above the middle (a bottom sheet is open)
  V.scale = (z) => BASE * Math.pow(2, z === undefined ? V.z : z);
  V.minZoom = () => clamp(Math.log2(Math.min(V.w / FRAME.w, V.h / FRAME.h) / BASE), -2.5, 0);
  V.set = (cx, cy, z) => {
    V.zmin = V.minZoom();
    V.z = clamp(Number.isFinite(z) ? z : V.z, V.zmin, ZMAX);
    const s = V.scale(), hw = V.w / 2 / s, hh = V.h / 2 / s;
    V.cx = FRAME.w <= 2 * hw ? FRAME.w / 2 : clamp(cx, hw, FRAME.w - hw);
    V.cy = FRAME.h <= 2 * hh ? FRAME.h / 2 : clamp(cy, hh, FRAME.h - hh);
    V.clamped = (FRAME.w > 2 * hw && Math.abs(V.cx - cx) * s > 1) || (FRAME.h > 2 * hh && Math.abs(V.cy - cy) * s > 1); // a pan asked for more than the frame has
    return V;
  };
  V.resize = (w, h, dpr) => { V.w = Math.max(1, w); V.h = Math.max(1, h); V.dpr = dpr || V.dpr; V.set(V.cx, V.cy, V.z); return V; };
  V.toScreen = (au, av) => { const s = V.scale(); return [V.w / 2 + (au - V.cx) * s, V.h / 2 - V.oy + (av - V.cy) * s]; };
  V.toA = (x, y) => { const s = V.scale(); return [V.cx + (x - V.w / 2) / s, V.cy + (y - V.h / 2 + V.oy) / s]; };
  V.rect = () => { const s = V.scale(); return [V.cx - V.w / 2 / s, V.cy - (V.h / 2 - V.oy) / s, V.cx + V.w / 2 / s, V.cy + (V.h / 2 + V.oy) / s]; };
  V.panPx = (dx, dy) => { const s = V.scale(); return V.set(V.cx - dx / s, V.cy - dy / s, V.z); };
  V.zoomAbout = (dz, x, y) => {
    const [au, av] = V.toA(x, y), z = clamp(V.z + dz, V.minZoom(), ZMAX), s = V.scale(z);
    return V.set(au - (x - V.w / 2) / s, av - (y - V.h / 2 + V.oy) / s, z);
  };
  V.fit = (r, pad = 0.12, zcap = ZMAX) => {
    const w = Math.max(1, r[2] - r[0]), h = Math.max(1, r[3] - r[1]);
    const s = Math.min(V.w / (w * (1 + 2 * pad)), V.h / (h * (1 + 2 * pad)));
    return { cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, z: clamp(Math.log2(s / BASE), V.minZoom(), Math.min(zcap, ZMAX)) };
  };
  V.fitIn = (r, I = {}, pad = 0.12, zcap = ZMAX, oy = V.oy) => {
    const l = I.l || 0, t = I.t || 0, fw = Math.max(80, V.w - l - (I.r || 0)), fh = Math.max(80, V.h - t - (I.b || 0));
    const w = Math.max(1, r[2] - r[0]), h = Math.max(1, r[3] - r[1]);
    const z = clamp(Math.log2(Math.min(fw / (w * (1 + 2 * pad)), fh / (h * (1 + 2 * pad))) / BASE), V.minZoom(), Math.min(zcap, ZMAX)), s = V.scale(z);
    return { cx: (r[0] + r[2]) / 2 - (l + fw / 2 - V.w / 2) / s, cy: (r[1] + r[3]) / 2 - (t + fh / 2 - V.h / 2 + oy) / s, z };
  };
  V.inView =(au, av, m = 0) => { const r = V.rect(), k = m / V.scale(); return au >= r[0] - k && au <= r[2] + k && av >= r[1] - k && av <= r[3] + k; };
  V.set(15000, 10000, 0);
  return V;
}

export const levelFor = (z, levels = 4) => clamp(Math.ceil(z - 0.35), 0, levels - 1);

export function createTiles(o) {
  const T = { index: null, cache: new Map(), pending: new Map(), failed: new Set(), queue: [], wanted: 0, loaded: 0, max: 48, busy: 0, log: o.log || [], placeholder: false };
  const sets = {};
  T.setIndex = (idx) => {
    T.index = idx || null; T.placeholder = !!(idx && idx.placeholder);
    for (const k of Object.keys(sets)) delete sets[k];
    if (idx && idx.tiles) for (const [L, list] of Object.entries(idx.tiles)) sets[L] = new Set(list);
  };
  T.has = (L, x, y) => !!(sets[L] && sets[L].has(`${x}_${y}`));
  T.url = (L, x, y) => {
    const sha = T.index && T.index.sha && T.index.sha[`${L}/${x}_${y}.webp`];
    return `${o.dir}${L}/${x}_${y}.webp${sha ? `?v=${sha}` : ""}`;
  };
  const pump = () => {
    while (T.busy < 6 && T.queue.length) {
      const k = T.queue.shift(), m = T.pending.get(k);
      if (!m) continue;
      T.busy++;
      const done = () => { T.busy--; T.pending.delete(k); if (o.onTile) o.onTile(k); pump(); };
      T.log.push(m.url); if (T.log.length > 400) T.log.shift();
      Promise.resolve().then(() => o.loadImage(m.url)).then((img) => { if (img) { T.cache.set(k, img); evict(); } else T.failed.add(m.url); done(); }, () => { T.failed.add(m.url); done(); });
    }
  };
  const evict = () => {
    while (T.cache.size > T.max) {
      const k = T.cache.keys().next().value, b = T.cache.get(k);
      T.cache.delete(k);
      try { if (b && typeof b.close === "function") b.close(); } catch (e) {  }
    }
  };
  const want = (L, x, y) => {
    const k = `${L}/${x}_${y}`;
    if (T.cache.has(k) || T.pending.has(k) || T.failed.has(T.url(L, x, y))) return;
    T.pending.set(k, { url: T.url(L, x, y) }); T.queue.push(k); pump();
  };
  const get = (L, x, y) => { const k = `${L}/${x}_${y}`, b = T.cache.get(k); if (b) { T.cache.delete(k); T.cache.set(k, b); } return b || null; };

  T.visible = (V, levels = 4) => {
    const L = levelFor(V.z, levels), span = 10000 / Math.pow(2, L), r = V.rect(), out = [];
    const x0 = Math.max(0, Math.floor(r[0] / span)), x1 = Math.min(3 * Math.pow(2, L) - 1, Math.floor(r[2] / span));
    const y0 = Math.max(0, Math.floor(r[1] / span)), y1 = Math.min(2 * Math.pow(2, L) - 1, Math.floor(r[3] / span));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (T.has(L, x, y)) out.push([L, x, y]);
    return out;
  };

  T.draw = (ctx, V) => {
    const levels = T.index ? T.index.levels : 4, L = levelFor(V.z, levels), span = 10000 / Math.pow(2, L), r = V.rect(), s = V.scale(), sw = span * s;
    const x0 = Math.max(0, Math.floor(r[0] / span)), x1 = Math.min(3 * Math.pow(2, L) - 1, Math.floor(r[2] / span));
    const y0 = Math.max(0, Math.floor(r[1] / span)), y1 = Math.min(2 * Math.pow(2, L) - 1, Math.floor(r[3] / span));
    let wanted = 0, loaded = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const own = T.has(L, x, y), [sx, sy] = V.toScreen(x * span, y * span);
      const ax = Math.floor(sx), ay = Math.floor(sy), bx = Math.ceil(sx + sw), by = Math.ceil(sy + sw);
      let img = own ? get(L, x, y) : null, q = 512, ox = 0, oy = 0;
      if (own) wanted++;
      if (img) loaded++;
      else {
        if (own) want(L, x, y);
        for (let l = L - 1; l >= 0 && !img; l--) {
          const d = L - l, px = x >> d, py = y >> d;
          if (!T.has(l, px, py)) continue;
          const b = get(l, px, py);
          if (b) { img = b; q = 512 / Math.pow(2, d); ox = (x - (px << d)) * q; oy = (y - (py << d)) * q; } else if (!own) { want(l, px, py); break; }
        }
      }
      if (img) ctx.drawImage(img, ox, oy, q, q, ax, ay, bx - ax, by - ay);
    }
    T.wanted = wanted; T.loaded = loaded;
    return loaded;
  };
  T.stats = () => ({ wanted: T.wanted, loaded: T.loaded, failed: T.failed.size });
  T.clear = () => { for (const b of T.cache.values()) { try { if (b && typeof b.close === "function") b.close(); } catch (e) {  } } T.cache.clear(); T.pending.clear(); T.queue.length = 0; };
  return T;
}

export function defaultLoader() {
  return (url) => {
    if (typeof fetch === "function" && typeof createImageBitmap === "function") {
      return fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); }).then((b) => createImageBitmap(b));
    }
    return new Promise((res, rej) => {
      const im = new Image();
      let n = 0, t = 0;
      im.onload = () => { clearInterval(t); res(im); }; im.onerror = () => { clearInterval(t); rej(new Error("image")); }; im.src = url;
      t = setInterval(() => { if (im.naturalWidth) { clearInterval(t); res(im); } else if (++n > 40) { clearInterval(t); rej(new Error("timeout")); } }, 25);
    });
  };
}

export function createFrames() {
  const ring = []; let last = 0;
  return {
    tick(now) { if (last) { ring.push(now - last); if (ring.length > 120) ring.shift(); } last = now; },
    idle() { last = 0; },
    p95() { if (!ring.length) return 0; const a = ring.slice().sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] * 10) / 10; },
  };
}
