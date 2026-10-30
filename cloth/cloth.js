/* Cloth banners for the tab rail (mobile contract section 8, node N7). Raw WebGL, no dependency. One canvas behind the tabs, one shared
   9 by 25 grid, one draw call per banner. The painted file is deformed and shaded here, never drawn: a travelling wave down the cloth
   (a pointer sweep kicks it), a fold shade, a candle gradient from the left. The painting is 3-sliced horizontally (the finials and the
   braided trim keep their proportions, the cloth field between stretches).
   One rAF loop steps all twelve banners with the BoardSpring constants (cloth: k 40, c 6; firm: k 300, c 34; one family, semi-implicit
   Euler at 1/120 s), so twelve banners cost one callback, not twelve. At rest nothing is scheduled: the last frame stays on the canvas.
   Imported on demand by js/cloth-hook.js. Relative imports only: there are none. */

const COLS = 8, ROWS = 24, STEP = 1 / 120, MAX_AMP = 14;
const KC = 40, CC = 6, KF = 300, CF = 34; /* BoardSpring presets cloth and firm (m = 1) */
const REST_AMP = 0.5, REST_AMP_V = 3; /* a banner swing under half a pixel is not visible: settles in about 1.1 s (the contract's 1.5 s bound; 0.4 and 2 rested at 1.3 s, too close) */

const VS = `attribute vec2 a_uv;
uniform vec2 u_view; uniform vec4 u_rect; uniform vec4 u_w; uniform float u_t;
varying vec2 v_s; varying float v_f;
void main() {
  float v = a_uv.y, amp = u_w.x;
  float ph = v * 6.0 - u_t * 9.0 + u_w.y;
  float dx = amp * sin(ph) * v * sqrt(v) * u_w.z;
  float dy = amp * 0.25 * cos(v * 4.0 - u_t * 7.0 + u_w.y) * v * v;
  vec2 p = vec2(u_rect.x + a_uv.x * u_rect.z + dx, u_rect.y + u_w.w + v * u_rect.w + dy);
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
  v_s = a_uv;
  v_f = 1.0 + 0.12 * cos(ph) * v * amp / 14.0;
}`;
const FS = `precision mediump float;
uniform sampler2D u_tex; uniform vec4 u_sl; uniform vec3 u_warm; uniform float u_lit;
varying vec2 v_s; varying float v_f;
void main() {
  float u = v_s.x, tx;
  if (u < u_sl.x) tx = u / u_sl.x * u_sl.z;
  else if (u > 1.0 - u_sl.y) tx = 1.0 - u_sl.w + (u - (1.0 - u_sl.y)) / u_sl.y * u_sl.w;
  else tx = u_sl.z + (u - u_sl.x) / (1.0 - u_sl.x - u_sl.y) * (1.0 - u_sl.z - u_sl.w);
  vec4 c = texture2D(u_tex, vec2(tx, v_s.y));
  vec3 rgb = c.rgb * v_f * mix(1.0, 1.06, (1.0 - u) * 0.5) * mix(vec3(1.0), u_warm, (1.0 - u) * 0.10) * u_lit;
  gl_FragColor = vec4(min(rgb, vec3(c.a)), c.a);
}`;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hexRgb = (s) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(s || "").trim()); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 0.82, 0.55]; };

export function createCloth(o) {
  const { canvas, rail, tabs, images = {}, tokens = {}, onLost } = o;
  const T = { hang: 6, lift: 2, trim: 52, warm: "#ffd18c", ...tokens };
  let gl = null, glKind = null;
  for (const kind of ["webgl2", "webgl"]) {
    try { gl = canvas.getContext(kind, { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" }); } catch (e) { gl = null; }
    if (gl) { glKind = kind; break; }
  }
  if (!gl) return null;

  /* ---- program ---- */
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader"); return s; };
  let prog, buf, idx, count = 0;
  const loc = {};
  try {
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
  } catch (e) { loseContext(); return null; }
  gl.useProgram(prog);
  for (const n of ["u_view", "u_rect", "u_w", "u_t", "u_tex", "u_sl", "u_warm", "u_lit"]) loc[n] = gl.getUniformLocation(prog, n);
  const aUv = gl.getAttribLocation(prog, "a_uv");
  {
    const pos = new Float32Array((COLS + 1) * (ROWS + 1) * 2), ix = new Uint16Array(COLS * ROWS * 6);
    let p = 0, q = 0;
    for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) { pos[p++] = c / COLS; pos[p++] = r / ROWS; }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const a = r * (COLS + 1) + c, b = a + 1, d = a + COLS + 1, e = d + 1; ix.set([a, d, b, b, d, e], q); q += 6; }
    buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    idx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STATIC_DRAW);
    count = ix.length;
    gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
  }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.clearColor(0, 0, 0, 0);
  gl.uniform1i(loc.u_tex, 0);
  gl.uniform3f(loc.u_warm, ...hexRgb(T.warm));

  /* ---- banners ---- */
  const B = tabs.map((t) => ({ key: t.key, el: t.el, x: 0, y: 0, w: 0, h: 0, ax: 0, av: 0, ox: 0, ov: 0, ot: 0, phase: 0, dir: 1, sel: false, lift: false, tex: null, imgW: 224, imgH: 352, last: -1e9 }));
  let W = 0, CH = 1, Hh = 0, dprEff = 1, bakedH = 0, ready = false, destroyed = false, raf = 0, last = 0, acc = 0, t = 0, kicks = 0, uploadMs = 0, textures = 0, hover = -1, dirty = true;
  let pending = []; /* neighbour kicks: { at, i, px, dir } */
  const ring = new Float32Array(120); let rn = 0, lastCost = 0;
  const frameApi = () => { const n = Math.min(rn, 120), a = Array.from(ring.subarray(0, n)).sort((x, y) => x - y); return { last: +lastCost.toFixed(3), p95: n ? +a[Math.min(n - 1, Math.ceil(n * 0.95) - 1)].toFixed(3) : 0 }; };

  function bake(b) {
    const img = images[b.key]; if (!img) return;
    const nw = img.naturalWidth || img.width || 224, nh = img.naturalHeight || img.height || 352;
    b.imgW = nw; b.imgH = nh;
    const scale = Hh * dprEff / nh; let src = img;
    if (scale < 0.85 && typeof document !== "undefined") {
      try { /* a 4x minify with LINEAR and no mipmaps shimmers: land the painting near its drawn size first */
        const c = document.createElement("canvas"); c.width = Math.max(8, Math.round(nw * scale)); c.height = Math.max(8, Math.round(nh * scale));
        const g = c.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, c.width, c.height); src = c;
      } catch (e) { src = img; }
    }
    if (!b.tex) { b.tex = gl.createTexture(); textures++; }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  function layout() {
    if (destroyed) return false;
    const cw = rail.clientWidth, ch = rail.clientHeight;
    if (!rail.offsetWidth || !cw || !ch) { ready = false; return false; }
    let right = 0, any = false;
    for (const b of B) {
      const e = b.el, w = e.offsetWidth;
      if (!w) { b.w = 0; continue; }
      b.x = e.offsetLeft; b.y = e.offsetTop; b.w = w; b.h = e.offsetHeight; right = Math.max(right, b.x + b.w); any = true;
    }
    if (!any) { ready = false; return false; }
    let padR = 0; try { padR = parseFloat(getComputedStyle(rail).paddingRight) || 0; } catch (e) {}
    const nw = Math.max(cw, Math.ceil(right + padR)), nh = ch, dpr = Math.min(window.devicePixelRatio || 1, 2), eff = Math.min(dpr, 4096 / nw);
    const bw = Math.round(nw * eff), bh = Math.round(nh * eff);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    canvas.style.width = `${nw}px`; canvas.style.height = `${nh}px`;
    W = nw; CH = nh; Hh = B.find((b) => b.w).h; dprEff = eff;
    gl.viewport(0, 0, bw, bh);
    if (!bakedH || Math.abs(Hh * eff - bakedH) / bakedH > 0.12) {
      const t0 = performance.now(); for (const b of B) bake(b); uploadMs = +(performance.now() - t0).toFixed(1); bakedH = Hh * eff;
    }
    ready = true; dirty = true;
    return true;
  }

  function targetOf(b) { return (b.sel ? T.hang : 0) - (b.lift ? T.lift : 0); }
  function retarget() { for (const b of B) b.ot = targetOf(b); wake(); }
  const moving = (b) => b.ax !== 0 || b.av !== 0 || b.ox !== b.ot || b.ov !== 0;
  const anyMoving = () => pending.length > 0 || B.some(moving);

  function kickAt(i, px, dir) {
    const b = B[i]; if (!b || destroyed) return;
    if (!b.ax && !b.av) b.phase = 0;
    b.ax = clamp(b.ax + px, -MAX_AMP, MAX_AMP); b.dir = dir < 0 ? -1 : 1; kicks++; wake();
  }
  function kick(key, px, dir) { const i = B.findIndex((b) => b.key === key); if (i >= 0) kickAt(i, px, dir); }
  function kickWave(i, px, dir, now) { /* the banner, then one hop each way 60 ms later at 40 percent */
    kickAt(i, px, dir);
    for (const j of [i - 1, i + 1]) if (B[j]) pending.push({ at: now + 60, i: j, px: px * 0.4, dir });
  }

  /* the pointer path in rail space: x0 to x, at y; vx in px per second */
  function pointer(x, y, vx, x0) {
    if (destroyed || !ready) return;
    const now = performance.now(), lo = Math.min(x, x0 == null ? x : x0), hi = Math.max(x, x0 == null ? x : x0);
    let over = -1;
    for (let i = 0; i < B.length; i++) {
      const b = B[i]; if (!b.w) continue;
      const inY = y >= b.y - 4 && y <= b.y + b.h + T.hang;
      if (x >= b.x && x <= b.x + b.w && inY) over = i;
      if (inY && hi >= b.x && lo <= b.x + b.w && Math.abs(vx) >= 40 && now - b.last >= 60) { b.last = now; kickWave(i, clamp(Math.abs(vx) * 0.04, 1, MAX_AMP), vx < 0 ? -1 : 1, now); }
    }
    if (over !== hover) { if (hover >= 0) { B[hover].lift = false; } hover = over; if (over >= 0) B[over].lift = true; retarget(); }
  }
  function leave() { if (hover >= 0) { B[hover].lift = false; hover = -1; retarget(); } }
  function focus(key, visible) { for (const b of B) if (b.key === key) { if (!b.fv) kick(key, 6, 1); b.fv = !!visible; } else b.fv = false; syncLift(); }
  function blur() { for (const b of B) b.fv = false; syncLift(); }
  function syncLift() { B.forEach((b, i) => { b.lift = i === hover || !!b.fv; }); retarget(); }
  function scene(key, prev) {
    for (const b of B) { const was = b.sel; b.sel = b.key === key; if (b.sel && !was) kick(b.key, 8, 1); else if (!b.sel && was && b.key === prev) kick(b.key, 4, -1); }
    layout(); retarget();
  }

  /* ---- the loop ---- */
  function step(dt, now) {
    if (pending.length) { const rest = []; for (const p of pending) { if (p.at <= now) kickAt(p.i, p.px, p.dir); else rest.push(p); } pending = rest; }
    acc += dt;
    while (acc >= STEP) {
      for (const b of B) {
        if (b.ax || b.av) { b.av += (-KC * b.ax - CC * b.av) * STEP; b.ax += b.av * STEP; }
        if (b.ox !== b.ot || b.ov) { b.ov += (KF * (b.ot - b.ox) - CF * b.ov) * STEP; b.ox += b.ov * STEP; }
      }
      acc -= STEP;
    }
    for (const b of B) {
      if ((b.ax || b.av) && Math.abs(b.ax) < REST_AMP && Math.abs(b.av) < REST_AMP_V) { b.ax = 0; b.av = 0; }
      if ((b.ox !== b.ot || b.ov) && Math.abs(b.ox - b.ot) < 0.1 && Math.abs(b.ov) < 0.5) { b.ox = b.ot; b.ov = 0; }
    }
  }

  function draw() {
    if (!ready || destroyed || (gl.isContextLost && gl.isContextLost())) return;
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(loc.u_view, W, CH);
    gl.uniform1f(loc.u_t, t);
    const order = []; B.forEach((b, i) => { if (b.w && b.tex && !b.sel) order.push(i); }); B.forEach((b, i) => { if (b.w && b.tex && b.sel) order.push(i); });
    for (const i of order) {
      const b = B[i], sl = Math.min(T.trim * (b.h / b.imgH), b.w * 0.45);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.uniform4f(loc.u_rect, b.x, b.y, b.w, b.h);
      gl.uniform4f(loc.u_w, b.ax, b.phase, b.dir, b.ox);
      gl.uniform4f(loc.u_sl, sl / b.w, sl / b.w, T.trim / b.imgW, T.trim / b.imgW);
      gl.uniform1f(loc.u_lit, b.sel ? 1.08 : 1);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    }
    dirty = false;
  }

  function clothFrame(now) {
    raf = 0;
    if (destroyed || document.hidden) return;
    const dt = last ? Math.min(0.5, (now - last) / 1000) : 1 / 60; last = now; /* capped at 0.5 s (was 0.05, then 0.1): the fixed 1/120 s substeps keep it stable, so the swing keeps real time even at 4 fps (3440 wide in software GL ran 217 ms frames and rested at 2.9 s); a wake resets last, so a hidden tab never jumps */
    const c0 = performance.now();
    const waved = B.some((b) => b.ax || b.av);
    step(dt, now);
    if (waved) t += dt;
    draw();
    lastCost = performance.now() - c0; ring[rn++ % 120] = lastCost;
    /* integrator (2026-10-30): a pending hop that lands inside step() calls wake(), which already asked for the next frame; asking
       again here started a second loop (four at once after a sweep, measured in Chromium) */
    if (anyMoving()) { if (!raf) raf = requestAnimationFrame(clothFrame); }
    else { t = 0; last = 0; acc = 0; }
  }
  function wake() { if (!raf && !destroyed && !document.hidden && ready) { last = 0; raf = requestAnimationFrame(clothFrame); } }

  function onVis() { /* hidden: nothing runs; shown again: one static rest frame, then nothing until the next input */
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0; } return; }
    for (const b of B) { b.ax = b.av = 0; b.ox = b.ot; b.ov = 0; } pending = []; t = 0; last = 0; acc = 0;
    if (ready) { draw(); }
  }
  document.addEventListener("visibilitychange", onVis);
  const lostH = (e) => { try { e.preventDefault(); } catch (x) {} if (onLost) onLost(); destroy(); };
  canvas.addEventListener("webglcontextlost", lostH);

  function loseContext() { try { const x = gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); } catch (e) {} }
  function destroy() {
    if (destroyed) return; destroyed = true;
    if (raf) cancelAnimationFrame(raf); raf = 0; pending = [];
    document.removeEventListener("visibilitychange", onVis); canvas.removeEventListener("webglcontextlost", lostH);
    try { for (const b of B) if (b.tex) { gl.deleteTexture(b.tex); b.tex = null; } gl.deleteBuffer(buf); gl.deleteBuffer(idx); gl.deleteProgram(prog); } catch (e) {}
    textures = 0; loseContext();
  }

  /* the first selection, then the first rest frame */
  for (const b of B) { b.sel = b.el.getAttribute("aria-selected") === "true"; b.ot = b.ox = targetOf(b); }
  layout(); if (ready) draw();

  return {
    layout, pointer, leave, focus, blur, scene, kick, destroy,
    status: () => ({ on: !destroyed, gl: destroyed ? null : glKind, textures, running: !!raf, frame: frameApi(), kicks, uploadMs, ready, banners: B.map((b) => ({ key: b.key, amp: +b.ax.toFixed(2) })) }),
  };
}
