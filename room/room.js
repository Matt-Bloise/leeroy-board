import { createTavern } from "./tavern.js?v=27667f5e32";

const TIERS = {
  medium: { dpr: 1, fps: 30, flicker: 0.6, air: 0, exposure: 1.9, budget: 33.3 },
  high: { dpr: 1.5, fps: 0, flicker: 1, air: 260, exposure: 2.0, budget: 16.7 },
  ultra: { dpr: 2, fps: 0, flicker: 1, air: 600, exposure: 2.05, budget: 16.7 },
};
export const JUDGE_MS = 2000, QUIET_MS = 1500, MIN_SAMPLES = 20;
export function p95(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0; }
export const easeShare = (dt, per = 0.06) => 1 - Math.pow(1 - per, Math.min(100, Math.max(0, dt)) / 16.7);
export const NEEDS_LIBRARY = [];
export const SCENE_FPS = 24, SCENE_DIM = 0.72;
export const DRIFT = { x: 0.32, y: 0.2, px: 71, py: 53 };
const DEG = Math.PI / 180, HFOV = 85;

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => { let t = x; for (let i = 0; i < 6; i++) { const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d; } return Y(Math.max(0, Math.min(1, t))); };
}
const hasRaf = typeof requestAnimationFrame === "function";
const nextFrame = hasRaf ? (f) => requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
const dropFrame = hasRaf ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);
const yieldFrame = () => new Promise((r) => nextFrame(() => setTimeout(r, 0)));

export async function startRoom(ctx) {
  let T = TIERS[ctx.tier] || TIERS.high, tierName = ctx.tier;
  const ease = bezier(0.2, 0.8, 0.2, 1);
  const E = { W: 1, H: 1, dpr: 1, rect: null, reduce: false, hidden: false, sceneOpen: false, ...(ctx.env || {}) };
  const cam = { tx: 0, ty: 0, x: 0, y: 0, dolly: 0, from: 0, to: 0, t0: 0, dim: 1, dimFrom: 1, dimTo: 1, kx: -0.7, ky: -0.55 };
  const canvas = ctx.canvas;
  let startCost = 0; const timed = (f) => { const t0 = performance.now(); const v = f(); startCost = Math.max(startCost, Math.round(performance.now() - t0)); return v; };
  const R = await createTavern(canvas, { tier: tierName, shadows: tierName === "ultra" ? 2 : 1, power: tierName === "medium" ? "low-power" : "high-performance", yieldTask: ctx.yieldTask || yieldFrame, timed, W: E.W, H: E.H, wide: E.wide });
  const { renderer, scene, camera } = R;

  const lantern = () => (ctx.newSignup ? 1.8 : 1);
  const launchNight = () => ctx.launchEpoch && Date.now() / 1000 >= ctx.launchEpoch;
  const levels = () => { const lit = launchNight() ? 1.5 : 1; return { hearth: 1, candles: lit, lantern: lantern() * lit }; };
  let K = levels(), Kmove = null;
  const applyTier = () => { renderer.toneMappingExposure = T.exposure * cam.dim; R.setAir(landscape ? T.air : 0); };
  let landscape = E.W >= E.H;

  let W = E.W, H = E.H;
  const size = () => {
    W = E.W; H = E.H; camera.aspect = W / H;
    const wide = Math.atan(Math.tan((HFOV / 2) * DEG) / camera.aspect) * 2 / DEG;
    camera.fov = Math.max(46, Math.min(70, wide)); camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(T.dpr, Math.max(E.dpr || 1, T.dpr >= 1.5 ? 1.5 : 1)));  renderer.setSize(W, H, false);
    if ((W >= H) !== landscape) { landscape = W >= H; applyTier(); }
    R.layout(W, H, E.rect);
  };
  applyTier(); size();

  let opened = !!E.sceneOpen, quietUntil = 0;
  const hush = () => { quietUntil = performance.now() + QUIET_MS; judge.samples = []; judge.t0 = 0; };
  const aimN = () => { const a = ctx.aim ? ctx.aim() : null; return a && a.tx != null ? [Math.max(-1, Math.min(1, (a.tx / W - 0.5) * 2)), Math.max(-1, Math.min(1, (a.ty / H - 0.5) * 2))] : null; };
  const sceneTo = (o) => { o = !!o; if (o === opened) return; opened = o; cam.from = cam.dolly; cam.to = o && !E.reduce ? 0.6 : 0; cam.dimFrom = cam.dim; cam.dimTo = o ? SCENE_DIM : 1; cam.t0 = performance.now(); hush(); wake(); };
  if (opened) { cam.dolly = cam.to = E.reduce ? 0 : 0.6; cam.dim = cam.dimFrom = cam.dimTo = SCENE_DIM; applyTier(); }
  let rsz = 0; const onResize = () => { hush(); wake(); if (!rsz) rsz = nextFrame(() => { rsz = 0; size(); dirty = true; }); };

  const st = { fps: 0, drawCalls: 0, triangles: 0, frames: 0, lost: false, paused: false, held: false, renderP95: 0, windows: 0, slowWindows: 0 };
  const judge = { samples: [], t0: 0 };
  let raf = 0, last = 0, lastDraw = 0, dts = [], firstDraw = 0, stopped = false, dirty = true;
  const wake = () => { st.held = false; if (!raf && !stopped && !E.hidden) raf = nextFrame(frame); };
  const judgeDraw = (now, ms) => {
    if (!firstDraw || now - firstDraw < QUIET_MS || now < quietUntil) return;
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
    if (E.hidden) { st.paused = true; return; }
    st.paused = false;
    const dt = last ? now - last : 16.7; last = now;
    dts.push(dt); if (dts.length > 120) dts.shift();
    const k = Math.min(1, (now - cam.t0) / (ctx.motion ? (opened ? ctx.motion.move : ctx.motion.close || ctx.motion.move) * 1.6 : 520));
    const fps = opened && k >= 1 ? SCENE_FPS : T.fps;
    if (!fps || now - lastDraw >= 1000 / fps - 2) {
      const step = lastDraw ? now - lastDraw : 16.7;
      lastDraw = now; dirty = false; st.held = opened && k >= 1;
      const s = now / 1000;
      if (!opened) {
        const a = aimN(), e = easeShare(step), ke = easeShare(step, 0.08);
        cam.tx = a ? a[0] : 0; cam.ty = a ? a[1] : 0;
        cam.x += (cam.tx - cam.x) * e; cam.y += (cam.ty - cam.y) * e;
        cam.kx += ((a ? a[0] : -0.7) - cam.kx) * ke; cam.ky += ((a ? a[1] : -0.55) - cam.ky) * ke;
      }
      const ek = ease(k);
      cam.dolly = cam.from + (cam.to - cam.from) * ek;
      const dim = cam.dimFrom + (cam.dimTo - cam.dimFrom) * ek;
      if (dim !== cam.dim) { cam.dim = dim; renderer.toneMappingExposure = T.exposure * dim; }
      const calm = E.reduce, dx = calm ? 0 : DRIFT.x * Math.sin((s * 2 * Math.PI) / DRIFT.px), dy = calm ? 0 : DRIFT.y * Math.sin((s * 2 * Math.PI) / DRIFT.py + 1.1);
      const px = cam.x + dx, py = cam.y + dy;
      const P = R.pose, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw);
      camera.position.set(P.pos.x + rx * px * 0.08 + fx * cam.dolly, P.pos.y - py * 0.04, P.pos.z + rz * px * 0.08 + fz * cam.dolly);
      camera.rotation.set(P.pitch - py * 3 * DEG, P.yaw - px * 6 * DEG, 0, "YXZ");
      if (Kmove) Kmove(now);
      const n = ctx.signal ? ctx.signal(s) : null;
      R.setKey(cam.kx, cam.ky);
      R.setLights(K, s, T.flicker * (ctx.flicker ? ctx.flicker() : 1), n); R.tick(T.fps ? Math.round(s * T.fps) / T.fps : s);
      if (ctx.onLight && !opened) ctx.onLight(cam.kx, cam.ky, n == null ? 0 : n * T.flicker);
      if (!firstDraw) firstDraw = now;
      const r0 = performance.now();
      if (st.frames) renderer.render(scene, camera); else timed(() => renderer.render(scene, camera));
      judgeDraw(now, performance.now() - r0);
      if (!st.frames && ctx.onStartCost) setTimeout(() => ctx.onStartCost(startCost), 0);
      st.drawCalls = renderer.info.render.calls; st.triangles = renderer.info.render.triangles; st.frames++;
      if (ctx.onFrame) ctx.onFrame(dt);
    }
    const avg = dts.reduce((a, b) => a + b, 0) / dts.length; st.fps = Math.round(1000 / avg);
    if (!stopped) raf = nextFrame(frame);
  };
  const visible = (on) => { E.hidden = !on; judge.samples = []; judge.t0 = 0; last = 0; if (on) { firstDraw = 0; dirty = true; } if (on && !raf && !stopped) raf = nextFrame(frame); };
  const onLost = (e) => { if (e && e.preventDefault) e.preventDefault(); if (stopped) return; st.lost = true; if (ctx.onLost) ctx.onLost(); };
  canvas.addEventListener("webglcontextlost", onLost, { once: true });
  if (!E.hidden) raf = nextFrame(frame);

  return {
    info: { renderer: R.info.renderer, software: R.info.software, three: R.info.three, colorSpace: R.info.colorSpace, wideWhy: R.info.wideWhy },
    setTier(t) { if (!TIERS[t]) return; T = TIERS[t]; tierName = t; R.setBlend(t !== "medium" && t !== "low"); applyTier(); size(); hush(); dirty = true; wake(); },
    refresh(next) { Object.assign(ctx, next); const to = levels(), from = { ...K }, t0 = performance.now(); Kmove = (now) => { const k = Math.min(1, (now - t0) / 1500), flare = Math.sin(Math.PI * k) * 0.25; for (const n of ["hearth", "candles", "lantern"]) K[n] = from[n] + (to[n] - from[n]) * ease(k) + (to[n] !== from[n] ? flare : 0); if (k >= 1) Kmove = null; }; dirty = true; wake(); },
    status: () => ({ tier: tierName, fps: st.fps, drawCalls: st.drawCalls, triangles: st.triangles, memory: R.memory(), frames: st.frames, paused: st.paused, held: st.held, renderP95: st.renderP95, judged: st.windows, slowWindows: st.slowWindows, lost: st.lost, renderer: R.info.renderer, software: R.info.software, three: R.info.three, shadows: R.shadowsOn(), textures: R.textures(), canvasTextures: R.canvasTextures(), needsLibrary: NEEDS_LIBRARY }),
    resize(env) { Object.assign(E, env); onResize(); },
    scene: sceneTo,
    visible,
    motion(reduce) { E.reduce = !!reduce; dirty = true; wake(); },
    stop() {
      stopped = true; if (raf) dropFrame(raf); raf = 0; if (rsz) dropFrame(rsz); rsz = 0;
      canvas.removeEventListener("webglcontextlost", onLost);
      R.dispose();
    },
  };
}
