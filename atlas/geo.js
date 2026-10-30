// geo.js: the Atlas projection maths (contract section 1.4). Pure: no DOM, no Node, no imports.
// World coordinates are the client's: x grows north, y grows west, in yards. A map's own frame is (u right, v down), both 0 to 1:
//   u = (ymax - y) / (ymax - ymin)      v = (xmax - x) / (xmax - xmin)
// The Azeroth frame (UiMap 947, 3:2) holds both continents where the client's own composite puts them. Points are stored as integer
// A-units on a 30000 by 20000 plane (au = round(U * 30000), av = round(V * 20000)); one A-unit is about 1.5 yards. Distances are
// always taken in world yards before projection, never from A-units.
//
// Usage:  import { createGeo } from "./geo.js";  const geo = createGeo(world);  geo.worldToA(1, -441.8, -2596.1)
//         or  setWorld(world)  once, then the named exports below.
// `world` is world.json: { frame: { w, h }, continents: [{ map_id, ui_map, composite: { ui_min, ui_max, world }, world }], zones: [{ ui_map, map_id, world }] }
// world rects are [xmin, ymin, xmax, ymax] (the client's Region_0, Region_1, Region_3, Region_4).

export function createGeo(world) {
  const W = world.frame.w, H = world.frame.h;
  const comp = new Map();       // map id -> { umin, vmin, uspan, vspan, r: [xmin, ymin, xmax, ymax] }
  const maps = new Map();       // ui map id -> { map_id, r }
  for (const c of world.continents) {
    const k = c.composite;
    comp.set(c.map_id, { umin: k.ui_min[0], vmin: k.ui_min[1], uspan: k.ui_max[0] - k.ui_min[0], vspan: k.ui_max[1] - k.ui_min[1], r: k.world });
    maps.set(c.ui_map, { map_id: c.map_id, r: c.world });
  }
  for (const z of world.zones || []) maps.set(z.ui_map, { map_id: z.map_id, r: z.world });

  const frameOf = (mapId, x, y) => {
    const c = comp.get(mapId); if (!c) return null;
    const [x0, y0, x1, y1] = c.r;
    const u = (y1 - y) / (y1 - y0), v = (x1 - x) / (x1 - x0);
    return [c.umin + u * c.uspan, c.vmin + v * c.vspan];
  };

  // world (map id, x, y) -> [au, av] integers; null when the map has no composite
  function worldToA(mapId, x, y) {
    const f = frameOf(mapId, x, y); if (!f) return null;
    return [Math.round(f[0] * W), Math.round(f[1] * H)];
  }
  // [au, av] (floats allowed) -> [x, y] world yards on that continent
  function aToWorld(mapId, au, av) {
    const c = comp.get(mapId); if (!c) return null;
    const [x0, y0, x1, y1] = c.r;
    const u = (au / W - c.umin) / c.uspan, v = (av / H - c.vmin) / c.vspan;
    return [x1 - v * (x1 - x0), y1 - u * (y1 - y0)];
  }
  // world point on a UiMap's own frame -> [pctX, pctY] (0 to 100); the /way frame
  function worldToZone(uiMapId, x, y) {
    const m = maps.get(uiMapId); if (!m) return null;
    const [x0, y0, x1, y1] = m.r;
    return [100 * (y1 - y) / (y1 - y0), 100 * (x1 - x) / (x1 - x0)];
  }
  function zoneToWorld(uiMapId, px, py) {
    const m = maps.get(uiMapId); if (!m) return null;
    const [x0, y0, x1, y1] = m.r;
    return [x1 - (py / 100) * (x1 - x0), y1 - (px / 100) * (y1 - y0)];
  }
  function zoneToA(uiMapId, px, py) {
    const m = maps.get(uiMapId); if (!m) return null;
    const w = zoneToWorld(uiMapId, px, py);
    return worldToA(m.map_id, w[0], w[1]);
  }
  // straight-line world yards between two [x, y] points on one map (mapId kept for the signature; flat plane)
  function yards(mapId, p1, p2) { return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]); }
  // yards per A-unit for a continent (mean of the two axes), used to price a crossing drawn between continents
  function yardsPerA(mapId) {
    const c = comp.get(mapId); if (!c) return null;
    const [x0, y0, x1, y1] = c.r;
    return ((x1 - x0) / (c.vspan * H) + (y1 - y0) / (c.uspan * W)) / 2;
  }
  return { worldToA, aToWorld, worldToZone, zoneToWorld, zoneToA, yards, yardsPerA, frame: { w: W, h: H } };
}

let current = null;
export function setWorld(world) { current = createGeo(world); return current; }
const need = () => { if (!current) throw new Error("geo.js: call setWorld(world) first"); return current; };
export const worldToA = (m, x, y) => need().worldToA(m, x, y);
export const aToWorld = (m, au, av) => need().aToWorld(m, au, av);
export const worldToZone = (ui, x, y) => need().worldToZone(ui, x, y);
export const zoneToWorld = (ui, px, py) => need().zoneToWorld(ui, px, py);
export const zoneToA = (ui, px, py) => need().zoneToA(ui, px, py);
export const yards = (m, p1, p2) => need().yards(m, p1, p2);
