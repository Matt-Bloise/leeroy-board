// The tavern room behind the board (V7-SPEC 3.1). Built from primitives on the renderer interface in gl2.js: floor, walls,
// ceiling beams, a hearth with fire, the bar, a lantern by the door, the notice board plane that sits exactly behind the DOM
// wall, point lights with the candle flicker, fog, and GPU wisps at high tier. Pointer and tilt give up to 6 degrees of
// parallax; opening a scene dollies the camera 0.6 m toward the board with the v3 easing, closing pulls it back.
//   const room = await startRoom({ tier, canvas, motion, launchEpoch, newSignup, onFrame, onLost })
//   room.setTier(t)  room.stop()  room.status()
import { createRenderer, box, plane } from "./gl2.js";

const TIERS = {
  medium: { dpr: 1, fps: 30, flicker: false, particles: 0, bloom: false, exposure: 1.1 },
  high: { dpr: 1.5, fps: 60, flicker: true, particles: 420, bloom: true, exposure: 1.15, bloomK: 0.6 },
  ultra: { dpr: 2, fps: 60, flicker: true, particles: 1200, bloom: true, exposure: 1.2, bloomK: 0.8 },
};
export const NEEDS_LIBRARY = ["soft shadows", "screen-space reflections on the ale and glass"];
const DEG = Math.PI / 180, BOARD_Z = -2.2, EYE = [0, 1.55, 0];

const css = (name, fb) => { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); const m = v.match(/^#([0-9a-f]{6})$/i); if (!m) return fb; const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const lin = (c) => c.map((x) => Math.pow(x, 2.2));
const scale = (c, k) => c.map((x) => x * k);
function bezier(x1, y1, x2, y2) { /* the v3 motion token as a function of t */
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => { let t = x; for (let i = 0; i < 6; i++) { const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d; } return Y(Math.max(0, Math.min(1, t))); };
}
/* images decode off the main thread (img.decode); each texture uploads in its own task, so starting the room makes no long task */
const loadImg = async (src) => { const i = new Image(); i.decoding = "async"; i.src = src; await i.decode(); return i; };
const yieldTask = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); /* one upload per frame */

export async function startRoom(ctx) {
  let T = TIERS[ctx.tier] || TIERS.high, tierName = ctx.tier;
  const canvas = ctx.canvas;
  /* the room times its own synchronous start-up steps; the ladder demotes when one passes 100 ms */
  let startCost = 0; const timed = (f) => { const t0 = performance.now(); const v = f(); startCost = Math.max(startCost, Math.round(performance.now() - t0)); return v; };
  let R = await createRenderer(canvas, { bloom: T.bloom, bloomK: T.bloomK, power: tierName === "medium" ? "low-power" : "high-performance" });
  if (!R) throw new Error("WebGL2 renderer did not start");
  const [wood, wall] = await Promise.all(["img/board-wall.jpg", "img/tavern-plate.jpg"].map(loadImg));
  const colors = {
    fog: lin(css("--room-fog", [0.05, 0.03, 0.02])), hearth: lin(css("--room-hearth", [1, 0.54, 0.23])), candle: lin(css("--room-candle", [1, 0.75, 0.44])),
    lantern: lin(css("--room-lantern", [1, 0.82, 0.54])), cool: lin(css("--room-cool", [0.23, 0.28, 0.4])), warm: lin(css("--light-warm", [1, 0.82, 0.55])),
  };
  let board = null; const beams = [];
  const build = async () => {
    const tWood = timed(() => R.texture(wood)); await yieldTask();
    const tWall = timed(() => R.texture(wall)); await yieldTask();
    R.mesh(box(9, 0.1, 6), { tex: tWood, tint: [0.34, 0.27, 0.22], uv: [2, 1.4] }).set({ pos: [0, -0.05, -2.2] });
    R.mesh(box(9, 0.1, 6), { tex: tWood, tint: [0.09, 0.07, 0.055], uv: [2, 1.4] }).set({ pos: [0, 3.05, -2.2] });
    R.mesh(plane(9.2, 4.2), { tex: tWall, tint: [0.3, 0.25, 0.21] }).set({ pos: [0, 1.7, -4.6] });
    for (const x of [-3.6, 3.6]) R.mesh(box(0.1, 3.2, 6), { tex: tWall, tint: [0.2, 0.17, 0.14] }).set({ pos: [x, 1.5, -2.2] }); /* the back wall's own texture, so no seam where they meet */
    for (const z of [-4.1, -3.2]) beams.push(R.mesh(box(9, 0.22, 0.26), { tex: tWood, tint: [0.14, 0.1, 0.08], uv: [4, 0.15] }).set({ pos: [0, 2.86, z] }));
    for (const x of [-2.9, 2.9]) R.mesh(box(0.26, 3, 0.26), { tex: tWood, tint: [0.2, 0.15, 0.12], uv: [0.15, 1.5] }).set({ pos: [x, 1.5, -4.0] });
    /* candle sconces where the candle lights hang, so the light has a source */
    for (const x of [-1.9, 1.9]) { R.mesh(box(0.06, 0.16, 0.06), { tint: [0.9, 0.85, 0.7], emit: [0.35, 0.3, 0.2] }).set({ pos: [x, 2.33, -4.45] }); R.mesh(box(0.03, 0.05, 0.03), { tint: [0, 0, 0], emit: scale(colors.candle, 3) }).set({ pos: [x, 2.45, -4.45] }); }
    /* the hearth, back left: a dark stone surround (two jambs and a lintel), the mantel, a fire in its mouth */
    const stone = { tex: tWood, tint: [0.05, 0.045, 0.04] };
    for (const dx of [-0.6, 0.6]) R.mesh(box(0.3, 1.2, 0.5), stone).set({ pos: [-3.0 + dx, 0.6, -4.3] });
    R.mesh(box(1.5, 0.3, 0.5), stone).set({ pos: [-3.0, 1.2, -4.3] });
    R.mesh(box(1.8, 0.1, 0.65), { tex: tWood, tint: [0.18, 0.13, 0.1] }).set({ pos: [-3.0, 1.4, -4.25] });
    R.mesh(plane(0.9, 1.05), { tint: [0.01, 0.005, 0.0], emit: [0.02, 0.005, 0], fire: 1 }).set({ pos: [-3.0, 0.53, -4.4] });
    /* the bar, back right: a dark counter that catches the warm light on its top edge */
    R.mesh(box(2.4, 1.05, 0.7), { tex: tWood, tint: [0.16, 0.12, 0.09] }).set({ pos: [2.9, 0.53, -3.9] });
    R.mesh(box(2.6, 0.07, 0.85), { tex: tWood, tint: [0.32, 0.24, 0.18], uv: [1, 0.2] }).set({ pos: [2.9, 1.09, -3.9] });
    /* the lantern by the door, far right */
    R.mesh(box(0.18, 0.28, 0.18), { tint: [0.2, 0.15, 0.1], emit: scale(colors.lantern, 0.0) }).set({ pos: [3.35, 2.05, -3.3] });
    /* the notice board: the plane the DOM wall sits on */
    board = R.mesh(plane(1, 1), { tex: tWood, tint: [0.4, 0.33, 0.27] }); /* kept dark: the gutters between tiles stay calm */
  };
  await build();
  const lantern = () => (ctx.newSignup ? 1.6 : 0.5);
  const launchNight = () => ctx.launchEpoch && Date.now() / 1000 >= ctx.launchEpoch;
  const baseLights = () => {
    const lit = launchNight() ? 1.6 : 1;
    return [
      { pos: [-3.0, 0.55, -4.05], color: scale(colors.hearth, 2.0), range: 4.0, f: 0.18, ph: 0.3 },
      { pos: [-1.9, 2.45, -4.1], color: scale(colors.candle, 1.5 * lit), range: 3.4, f: 0.12, ph: 1.7 },
      { pos: [1.9, 2.45, -4.1], color: scale(colors.candle, 1.5 * lit), range: 3.4, f: 0.12, ph: 2.9 },
      { pos: [2.6, 2.2, -3.3], color: scale(colors.warm, 1.0), range: 3.0, f: 0.05, ph: 4.1 },
      { pos: [3.3, 2.0, -3.1], color: scale(colors.lantern, lantern() * lit), range: 2.6, f: 0.1, ph: 5.3 },
      { pos: [0, 1.5, -0.4], color: scale(colors.warm, 0.6), range: 4.2, f: 0.06, ph: 0.9 }, /* below the beams, so their undersides stay dark behind the heading */
    ];
  };
  let L = baseLights();
  R.fog = { color: colors.fog, density: 0.15 }; R.ambient = scale(colors.cool, 0.35); R.exposure = T.exposure;
  const applyTier = () => { R.exposure = T.exposure; R.bloom = T.bloom; R.bloomK = T.bloomK || 0.9; R.particles(T.particles, { min: [-3.4, 0.1, -4.4], max: [3.4, 2.9, -0.8] }); };
  applyTier();

  /* where the DOM wall is: the board plane fills that rectangle at BOARD_Z when the camera is at rest */
  const anchor = document.querySelector("#main") || document.body;
  let W = innerWidth, H = innerHeight;
  const placeBoard = () => {
    const r = anchor.getBoundingClientRect(), fov = R.camera.fov, d = -BOARD_Z, hh = d * Math.tan(fov / 2), hw = hh * (W / H);
    const cx = ((r.left + r.width / 2) / W - 0.5) * 2 * hw, cy = EYE[1] + (0.5 - (r.top + r.height / 2) / H) * 2 * hh;
    board.set({ pos: [cx, cy, BOARD_Z], scale: [(r.width / W) * 2 * hw, (r.height / H) * 2 * hh, 1] });
  };
  const size = () => { W = innerWidth; H = innerHeight; beams.forEach((b) => { b.visible = W >= H; }); /* in portrait the beams would cross the heading */ R.camera.fov = (W / H < 1 ? 64 : 52) * DEG; R.resize(W, H, Math.min(T.dpr, window.devicePixelRatio || 1)); placeBoard(); };
  size();

  /* camera: parallax from pointer and tilt, dolly on scene open */
  const ease = bezier(0.2, 0.8, 0.2, 1);
  const cam = { tx: 0, ty: 0, x: 0, y: 0, dolly: 0, from: 0, to: 0, t0: 0 };
  const onPointer = (e) => { cam.tx = (e.clientX / W - 0.5) * 2; cam.ty = (e.clientY / H - 0.5) * 2; };
  const onTilt = (e) => { if (e.gamma == null) return; cam.tx = Math.max(-1, Math.min(1, e.gamma / 30)); cam.ty = Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 30)); };
  const html = document.documentElement;
  const sceneOpen = () => html.classList.contains("scene-open");
  let opened = sceneOpen();
  const mo = new MutationObserver(() => { const o = sceneOpen(); if (o === opened) return; opened = o; cam.from = cam.dolly; cam.to = o ? 0.6 : 0; cam.t0 = performance.now(); });
  mo.observe(html, { attributes: true, attributeFilter: ["class"] });
  addEventListener("pointermove", onPointer, { passive: true });
  addEventListener("deviceorientation", onTilt, { passive: true });
  let rsz = 0; const onResize = () => { if (!rsz) rsz = requestAnimationFrame(() => { rsz = 0; size(); }); };
  addEventListener("resize", onResize, { passive: true }); addEventListener("scroll", onResize, { passive: true });

  /* the loop, the stats and the slow-frame watch */
  const st = { fps: 0, drawCalls: 0, triangles: 0, frames: 0, slow: [], lost: false, paused: false };
  let raf = 0, last = 0, lastDraw = 0, dts = [], firstDraw = 0;
  const flick = (s, ph) => 0.5 * Math.sin(s * 7.1 + ph) + 0.3 * Math.sin(s * 13.7 + ph * 2.3) + 0.2 * Math.sin(s * 23.1 + ph * 0.7);
  const frame = (now) => {
    raf = 0;
    if (document.hidden) { st.paused = true; return; }
    st.paused = false;
    const dt = last ? now - last : 16.7; last = now;
    dts.push(dt); if (dts.length > 120) dts.shift();
    if (dt > 50 && firstDraw && now - firstDraw > 1500) st.slow.push(now); /* steady state only: the first 1.5 s of drawing is warm-up (by time, so a slow device still gets judged) */
    st.slow = st.slow.filter((t) => now - t < 5000);
    if (st.slow.length >= 3 && ctx.onSlow) { st.slow = []; ctx.onSlow(); if (!raf && !stopped) raf = requestAnimationFrame(frame); return; }
    if (now - lastDraw >= 1000 / T.fps - 2) {
      lastDraw = now;
      const s = now / 1000;
      cam.x += (cam.tx - cam.x) * 0.06; cam.y += (cam.ty - cam.y) * 0.06;
      const k = Math.min(1, (now - cam.t0) / (ctx.motion ? ctx.motion.move * 1.6 : 520));
      cam.dolly = cam.from + (cam.to - cam.from) * ease(k);
      R.camera.yaw = -cam.x * 6 * DEG; R.camera.pitch = -cam.y * 3 * DEG; R.camera.pos = [EYE[0] + cam.x * 0.08, EYE[1] - cam.y * 0.04, EYE[2] - cam.dolly];
      R.lights = L.map((l) => ({ pos: l.pos, range: l.range, color: T.flicker ? scale(l.color, 1 + l.f * flick(s, l.ph) * (ctx.flicker ? ctx.flicker() : 1)) : l.color }));
      if (!firstDraw) firstDraw = now;
      const out = st.frames ? R.draw(s) : timed(() => R.draw(s)); if (!st.frames && ctx.onStartCost) setTimeout(() => ctx.onStartCost(startCost), 0);
      st.drawCalls = out.drawCalls; st.triangles = out.triangles; st.frames++;
      if (ctx.onFrame) ctx.onFrame(dt);
    }
    const avg = dts.reduce((a, b) => a + b, 0) / dts.length; st.fps = Math.round(1000 / avg);
    if (!stopped) raf = requestAnimationFrame(frame);
  };
  let stopped = false;
  /* back from hidden: a fresh slow-frame window and a fresh warm-up, so the throttled frames never count */
  const vis = () => { st.slow = []; last = 0; if (!document.hidden) firstDraw = 0; if (!document.hidden && !raf && !stopped) raf = requestAnimationFrame(frame); };
  document.addEventListener("visibilitychange", vis);
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (stopped) return; st.lost = true; if (ctx.onLost) ctx.onLost(); }, { once: true }); /* our own dispose() loses the context on purpose */
  raf = requestAnimationFrame(frame);

  return {
    info: R.info,
    setTier(t) { if (!TIERS[t]) return; T = TIERS[t]; tierName = t; applyTier(); size(); },
    refresh(next) { Object.assign(ctx, next); L = baseLights(); },
    status: () => ({ tier: tierName, fps: st.fps, drawCalls: st.drawCalls, triangles: st.triangles, memory: R ? R.memory() : 0, frames: st.frames, paused: st.paused, lost: st.lost, renderer: R ? R.info.renderer : null, software: R ? R.info.software : null, needsLibrary: NEEDS_LIBRARY }),
    stop() {
      stopped = true; if (raf) cancelAnimationFrame(raf); raf = 0; mo.disconnect();
      removeEventListener("pointermove", onPointer); removeEventListener("deviceorientation", onTilt); removeEventListener("resize", onResize); removeEventListener("scroll", onResize);
      document.removeEventListener("visibilitychange", vis); if (R) R.dispose();
    },
  };
}
