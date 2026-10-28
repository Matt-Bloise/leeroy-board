// The tavern room behind the board (V7-SPEC 3.1, rebuilt on three.js in V10). The scenery and the renderer are in tavern.js
// (vendored three.js 0.170.0, modelled from primitives and canvas textures). This file owns the loop, the camera, the tiers
// and the hooks the ladder (tier.js) reads. Pointer and tilt give up to 6 degrees of parallax; opening a scene dollies the
// camera 0.6 m into the room with the v3 easing, closing pulls it back. The board itself stays the DOM's own wall plate.
//   const room = await startRoom({ tier, canvas, motion, launchEpoch, newSignup, onSlow, onStartCost, onLost })
//   room.setTier(t)  room.refresh(next)  room.stop()  room.status()
import { createTavern } from "./tavern.js?v=d3e1367bb0";

/* shadows are drawn once (the lights do not move), so they cost nothing per frame; ultra gets the sharper map.
   V13a: fps 0 draws on every display refresh (a 175 Hz panel gets 175 draws, not every third one); budget is the frame
   time the slow-frame judge holds renderer.render() to. */
const TIERS = {
  medium: { dpr: 1, fps: 30, flicker: 0, air: 0, exposure: 1.9, budget: 33.3 },
  high: { dpr: 1.5, fps: 0, flicker: 1, air: 260, exposure: 2.0, budget: 16.7 },
  ultra: { dpr: 2, fps: 0, flicker: 1, air: 600, exposure: 2.05, budget: 16.7 },
};
/* the slow-frame judge (V13a): only renderer.render() is timed, so the page's own work (a scene opening, a search) never
   counts against the room; frames within QUIET ms of a scene opening or closing, a resize or a return from hidden are left
   out; a window of JUDGE_MS with at least MIN_SAMPLES draws is slow when its p95 is over the tier's budget */
export const JUDGE_MS = 2000, QUIET_MS = 1500, MIN_SAMPLES = 20;
export function p95(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0; }
/* time-based easing: the share of the gap closed in dt ms, the same 6% per 16.7 ms the 60 fps loop used */
export const easeShare = (dt, per = 0.06) => 1 - Math.pow(1 - per, Math.min(100, Math.max(0, dt)) / 16.7);
export const NEEDS_LIBRARY = [];
const DEG = Math.PI / 180, HFOV = 85;

function bezier(x1, y1, x2, y2) { /* the v3 motion token as a function of t */
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => { let t = x; for (let i = 0; i < 6; i++) { const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d; } return Y(Math.max(0, Math.min(1, t))); };
}
const yieldTask = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); /* one step per frame */

export async function startRoom(ctx) {
  let T = TIERS[ctx.tier] || TIERS.high, tierName = ctx.tier;
  const canvas = ctx.canvas;
  /* the room times its own synchronous start-up steps (recorded by the ladder, never a demotion) */
  let startCost = 0; const timed = (f) => { const t0 = performance.now(); const v = f(); startCost = Math.max(startCost, Math.round(performance.now() - t0)); return v; };
  const R = await createTavern(canvas, { shadows: tierName === "ultra" ? 2 : 1, power: tierName === "medium" ? "low-power" : "high-performance", yieldTask, timed });
  const { renderer, scene, camera } = R;

  const lantern = () => (ctx.newSignup ? 1.8 : 1);
  const launchNight = () => ctx.launchEpoch && Date.now() / 1000 >= ctx.launchEpoch;
  const levels = () => { const lit = launchNight() ? 1.5 : 1; return { hearth: 1, candles: lit, lantern: lantern() * lit }; };
  let K = levels();
  const applyTier = () => { renderer.toneMappingExposure = T.exposure; R.setAir(landscape ? T.air : 0); }; /* no dust in portrait: on a phone it reads as noise */
  let landscape = innerWidth >= innerHeight;

  /* the camera keeps one horizontal field of view on every landscape screen, so the hearth and the shelves stay in the gutters */
  const anchor = document.querySelector("#main") || document.body;
  let W = innerWidth, H = innerHeight;
  const size = () => {
    W = innerWidth; H = innerHeight; camera.aspect = W / H;
    const wide = Math.atan(Math.tan((HFOV / 2) * DEG) / camera.aspect) * 2 / DEG;
    camera.fov = Math.max(46, Math.min(70, wide)); camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(T.dpr, window.devicePixelRatio || 1)); renderer.setSize(W, H, false);
    if ((W >= H) !== landscape) { landscape = W >= H; applyTier(); }
    R.layout(W, H, anchor.getBoundingClientRect());
  };
  applyTier(); size();

  /* camera: parallax from pointer and tilt, dolly on scene open */
  const ease = bezier(0.2, 0.8, 0.2, 1);
  const cam = { tx: 0, ty: 0, x: 0, y: 0, dolly: 0, from: 0, to: 0, t0: 0 };
  const onPointer = (e) => { cam.tx = (e.clientX / W - 0.5) * 2; cam.ty = (e.clientY / H - 0.5) * 2; };
  const onTilt = (e) => { if (e.gamma == null) return; cam.tx = Math.max(-1, Math.min(1, e.gamma / 30)); cam.ty = Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 30)); };
  const html = document.documentElement;
  const sceneOpen = () => html.classList.contains("scene-open");
  let opened = sceneOpen(), quietUntil = 0;
  const hush = () => { quietUntil = performance.now() + QUIET_MS; judge.samples = []; judge.t0 = 0; };
  const mo = new MutationObserver(() => { const o = sceneOpen(); if (o === opened) return; opened = o; cam.from = cam.dolly; cam.to = o ? 0.6 : 0; cam.t0 = performance.now(); hush(); wake(); });
  mo.observe(html, { attributes: true, attributeFilter: ["class"] });
  addEventListener("pointermove", onPointer, { passive: true });
  addEventListener("deviceorientation", onTilt, { passive: true });
  /* only a resize moves the gutters; a scroll moves the board but the room is fixed behind it */
  let rsz = 0; const onResize = () => { hush(); wake(); if (!rsz) rsz = requestAnimationFrame(() => { rsz = 0; size(); dirty = true; }); };
  addEventListener("resize", onResize, { passive: true });

  /* the loop, the stats and the slow-frame watch */
  const st = { fps: 0, drawCalls: 0, triangles: 0, frames: 0, lost: false, paused: false, held: false, renderP95: 0, windows: 0, slowWindows: 0 };
  const judge = { samples: [], t0: 0 };
  let raf = 0, last = 0, lastDraw = 0, dts = [], firstDraw = 0, stopped = false, dirty = true;
  /* V13a: while a scene is open the room sits blurred and dimmed behind it. Once the dolly has landed nothing in it moves,
     so the loop holds: no draw, no frame, and the blur over it is composited once instead of on every refresh. */
  const wake = () => { st.held = false; if (!raf && !stopped && !document.hidden) raf = requestAnimationFrame(frame); };
  const judgeDraw = (now, ms) => {
    if (!firstDraw || now - firstDraw < QUIET_MS || now < quietUntil) return; /* warm-up, a scene change, a resize */
    if (!judge.t0) judge.t0 = now;
    judge.samples.push(ms);
    if (now - judge.t0 < JUDGE_MS) return;
    const n = judge.samples.length, v = p95(judge.samples); judge.samples = []; judge.t0 = now;
    if (n < MIN_SAMPLES) return;
    st.windows++; st.renderP95 = +v.toFixed(2);
    if (v > T.budget) { st.slowWindows++; if (ctx.onSlow) ctx.onSlow(`renderer.render() p95 ${v.toFixed(1)} ms over ${T.budget} ms for 2 s`); }
  };
  const frame = (now) => {
    raf = 0;
    if (document.hidden) { st.paused = true; return; }
    st.paused = false;
    const dt = last ? now - last : 16.7; last = now;
    dts.push(dt); if (dts.length > 120) dts.shift();
    const k = Math.min(1, (now - cam.t0) / (ctx.motion ? ctx.motion.move * 1.6 : 520));
    if (opened && k >= 1 && !dirty && st.frames) { st.held = true; last = 0; return; } /* held until the scene closes */
    if (!T.fps || now - lastDraw >= 1000 / T.fps - 2) {
      const step = lastDraw ? now - lastDraw : 16.7;
      lastDraw = now; dirty = false;
      const s = now / 1000;
      if (!opened) { const e = easeShare(step); cam.x += (cam.tx - cam.x) * e; cam.y += (cam.ty - cam.y) * e; }
      cam.dolly = cam.from + (cam.to - cam.from) * ease(k);
      /* the pose (tavern.js) faces the board on a wide screen and the hearth on a tall one; parallax slides along its right
         vector and the dolly moves along its forward vector */
      const P = R.pose, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw);
      camera.position.set(P.pos.x + rx * cam.x * 0.08 + fx * cam.dolly, P.pos.y - cam.y * 0.04, P.pos.z + rz * cam.x * 0.08 + fz * cam.dolly);
      camera.rotation.set(P.pitch - cam.y * 3 * DEG, P.yaw - cam.x * 6 * DEG, 0, "YXZ");
      R.setLights(K, s, T.flicker * (ctx.flicker ? ctx.flicker() : 1)); R.tick(T.fps ? Math.round(s * T.fps) / T.fps : s);
      if (!firstDraw) firstDraw = now;
      const r0 = performance.now();
      if (st.frames) renderer.render(scene, camera); else timed(() => renderer.render(scene, camera));
      judgeDraw(now, performance.now() - r0);
      if (!st.frames && ctx.onStartCost) setTimeout(() => ctx.onStartCost(startCost), 0);
      st.drawCalls = renderer.info.render.calls; st.triangles = renderer.info.render.triangles; st.frames++;
      if (ctx.onFrame) ctx.onFrame(dt);
    }
    const avg = dts.reduce((a, b) => a + b, 0) / dts.length; st.fps = Math.round(1000 / avg);
    if (!stopped) raf = requestAnimationFrame(frame);
  };
  /* back from hidden: a fresh judge window and a fresh warm-up, so the throttled frames never count */
  const vis = () => { judge.samples = []; judge.t0 = 0; last = 0; if (!document.hidden) { firstDraw = 0; dirty = true; } if (!document.hidden && !raf && !stopped) raf = requestAnimationFrame(frame); };
  document.addEventListener("visibilitychange", vis);
  const onLost = (e) => { e.preventDefault(); if (stopped) return; st.lost = true; if (ctx.onLost) ctx.onLost(); };
  canvas.addEventListener("webglcontextlost", onLost, { once: true }); /* our own dispose() loses the context on purpose */
  raf = requestAnimationFrame(frame);

  return {
    info: { renderer: R.info.renderer, software: R.info.software, three: R.info.three },
    setTier(t) { if (!TIERS[t]) return; T = TIERS[t]; tierName = t; applyTier(); size(); hush(); dirty = true; wake(); },
    refresh(next) { Object.assign(ctx, next); K = levels(); dirty = true; wake(); },
    status: () => ({ tier: tierName, fps: st.fps, drawCalls: st.drawCalls, triangles: st.triangles, memory: R.memory(), frames: st.frames, paused: st.paused, held: st.held, renderP95: st.renderP95, judged: st.windows, slowWindows: st.slowWindows, lost: st.lost, renderer: R.info.renderer, software: R.info.software, three: R.info.three, shadows: R.shadowsOn(), needsLibrary: NEEDS_LIBRARY }),
    stop() {
      stopped = true; if (raf) cancelAnimationFrame(raf); raf = 0; mo.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      removeEventListener("pointermove", onPointer); removeEventListener("deviceorientation", onTilt); removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", vis); R.dispose();
    },
  };
}
