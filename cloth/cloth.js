/* Woven ribbons for the tab rail (mobile contract section 8, node N7; lane R, RIBBONS.md, 2026-10-30). Raw WebGL, no dependency. One canvas
   over the sheet's head and the top of the page, one shared 8 by 48 grid, one draw call per ribbon (plus one for the chosen ribbon's shadow).
   Each ribbon is three pieces in one mesh: a rod loop (greyscale, tinted), a body that samples the dyed fabric tile at thread scale (so the
   weave never stretches as the ribbon unrolls) and a frayed end. The body is lit per pixel: a normal from the tile's own luminance plus the
   wave's slope, a wrap diffuse from the candle (upper left), a low warm sheen, a darker selvedge, a fold shade. The scene name is baked into a
   label texture (cloth/ribbon-bake.js) in gold satin stitch and rides the cloth: it bends with the wave and takes the light.
   Length is live: each ribbon has a length spring (firm, a little under-damped, so a chosen ribbon overshoots by about 3 percent), the tail
   curls where it is still moving (the last 12 px foreshorten and shade like a roll), the chosen ribbon casts a feathered shadow on the page.
   One rAF loop steps all twelve ribbons at 1/120 s, so twelve ribbons cost one callback. At rest nothing is scheduled: the last frame stays.
   Imported on demand by js/cloth-hook.js. Relative imports only. */
import { bakeLabel } from "./ribbon-bake.js?v=3dda3cac04";

const COLS = 8, ROWS = 48, STEP = 1 / 120, MAX_AMP = 14;
const KC = 40, CC = 6, KL = 260, CL = 24; /* BoardSpring cloth (k 40, c 6) for the sway; the length spring is firm and a little under-damped (zeta 0.74, about 3 percent overshoot, lands in about 0.45 s) */
const REST_AMP = 0.5, REST_AMP_V = 3; /* a swing under half a pixel is not visible: settles in about 1.1 s */
const SWEEP_S = 0.42, TILE_PX = 256; /* the sheen sweep down the lettering on hover; css px per fabric tile repeat (256 texels at 1:1) */

const VS = `attribute vec2 a_uv;
uniform vec2 u_view; uniform vec4 u_rect; uniform vec4 u_w; uniform vec4 u_g; uniform vec2 u_off; uniform float u_t;
varying vec2 v_p; varying float v_sl; varying float v_c;
void main() {
  float H = u_rect.w, s = a_uv.y * H, e = H - u_g.y, Z = u_g.z, so = s, c = 0.0;
  if (Z > 0.5 && s > e - Z) { float f = min(s - (e - Z), Z) / Z; so = (e - Z) + Z * sin(f * 1.5708) + max(s - e, 0.0); c = f; }
  float d = max(so - u_g.x, 0.0) / u_g.w;
  float env = pow(min(d, 1.5), 1.5) * 0.6;
  float ph = d * 6.0 - u_t * 9.0 + u_w.y;
  float dx = u_w.x * sin(ph) * env * u_w.z;
  float dy = u_w.x * 0.2 * cos(d * 4.0 - u_t * 7.0 + u_w.y) * env * min(d, 1.5);
  vec2 p = vec2(u_rect.x + a_uv.x * u_rect.z + dx + u_off.x, u_rect.y + so + dy + u_off.y);
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
  v_p = vec2(a_uv.x * u_rect.z, s); v_sl = cos(ph) * env * u_w.x / 14.0; v_c = c;
}`;
const FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_tile; uniform sampler2D u_lbl; uniform sampler2D u_loop; uniform sampler2D u_fr;
uniform vec4 u_g; uniform vec4 u_lb; uniform vec4 u_wh; uniform vec3 u_dye; uniform vec3 u_warm; uniform float u_lit;
varying vec2 v_p; varying float v_sl; varying float v_c;
float lum(vec3 c) { return dot(c, vec3(0.30, 0.59, 0.11)); }
void main() {
  float x = v_p.x, s = v_p.y, W = u_wh.x, H = u_wh.y, e = H - u_g.y, edge = min(x, W - x);
  if (u_lb.w > 0.5 && u_lb.w < 1.5) { /* the shadow pass: the ribbon's own footprint, feathered, black */
    float m = smoothstep(0.0, 11.0, edge) * smoothstep(0.0, 12.0, H - s) * smoothstep(0.0, 6.0, s - u_g.x * 0.5);
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.42 * m * m * u_wh.z); return;
  }
  vec3 L = normalize(vec3(-0.6, -0.7, 0.4)), Hv = normalize(L + vec3(0.0, 0.0, 1.0));
  vec3 n = vec3(0.0, 0.0, 1.0); vec3 rgb; float a = 1.0;
  if (u_lb.w > 1.5) { /* the rod pass: the brass rod and the wool folded over it; wool takes the dye, brass keeps its colour */
    vec4 p = texture2D(u_loop, vec2(x / W, s / u_g.x)); float sat = (max(p.r, max(p.g, p.b)) - min(p.r, min(p.g, p.b))) / max(p.a, 0.01);
    gl_FragColor = vec4(min(p.rgb * mix(u_dye * 1.5, vec3(1.0), smoothstep(0.06, 0.22, sat)) * (0.8 + 0.3 * (1.0 - s / u_g.x)) * u_lit, vec3(p.a)), p.a); return;
  }
  if (s >= e) { vec4 p = texture2D(u_fr, vec2(x / W, (s - e) / max(u_g.y, 0.001))); rgb = p.rgb * u_dye * 1.5; a = p.a; n.x = v_sl * 0.35; }
  else {
    vec2 uv = vec2(x, s - u_g.x) / ${TILE_PX}.0;
    vec3 c0 = texture2D(u_tile, uv).rgb;
    float h0 = lum(c0), hx = lum(texture2D(u_tile, uv + vec2(${1 / TILE_PX}, 0.0)).rgb), hy = lum(texture2D(u_tile, uv + vec2(0.0, ${1 / TILE_PX})).rgb);
    n = normalize(vec3((h0 - hx) * 1.3 + v_sl * 0.5 + 0.10 * sin(s * 0.09 + x * 0.04), (h0 - hy) * 1.3, 1.0));
    c0 = mix(vec3(lum(c0)), c0, 0.72);
    float sel = smoothstep(0.0, 3.5, edge);
    float k = x / W * 2.0 - 1.0; c0 *= mix(0.58 + 0.08 * sin(s * 1.9), 1.0, sel) * (1.06 - 0.10 * k * k) * (0.62 + 0.38 * smoothstep(0.0, 16.0, s - u_g.x));
    rgb = c0;
    float lt = (s - u_lb.x) / u_lb.y;
    if (lt > 0.0 && lt < 1.0) {
      vec4 g = texture2D(u_lbl, vec2(x / W, lt));
      float q = (lt - u_lb.z * 1.5 + 0.25) * 3.0, band = u_lb.z >= 0.0 ? exp(-q * q) : 0.0;
      rgb = mix(rgb, g.rgb * (1.15 + 0.9 * band), g.a);
    }
  }
  float diff = 0.8 + 0.45 * max(0.0, dot(n, L)), spec = 0.10 * pow(max(0.0, dot(n, Hv)), 10.0);
  float fold = 1.0 - 0.34 * v_c * v_c + 0.22 * smoothstep(0.55, 0.78, v_c) * (1.0 - smoothstep(0.78, 1.0, v_c));
  rgb = (rgb * diff * fold + u_warm * spec * a) * u_lit;
  gl_FragColor = vec4(min(rgb, vec3(a)), a);
}`;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hexRgb = (s) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(s || "").trim()); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 0.82, 0.55]; };

export function createCloth(o) {
  const { canvas, rail, sheet = rail, tabs, images = {}, parts = {}, tokens = {}, onLost } = o;
  const T = { warm: "#ffd18c", ...tokens };
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
  } catch (e) { console.warn("cloth shader", e.message); loseContext(); return null; }
  gl.useProgram(prog);
  for (const n of ["u_view", "u_rect", "u_w", "u_g", "u_off", "u_t", "u_tile", "u_lbl", "u_loop", "u_fr", "u_lb", "u_wh", "u_dye", "u_warm", "u_lit"]) loc[n] = gl.getUniformLocation(prog, n);
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
  gl.uniform1i(loc.u_tile, 0); gl.uniform1i(loc.u_lbl, 1); gl.uniform1i(loc.u_loop, 2); gl.uniform1i(loc.u_fr, 3);
  gl.uniform3f(loc.u_warm, ...hexRgb(T.warm));

  let textures = 0;
  const upload = (unit, src, repeat) => {
    const tex = gl.createTexture(); textures++; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
    const w = repeat ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? w : gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (repeat) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  };
  const shared = [];
  if (parts.loop) shared.push(upload(2, parts.loop, false));
  if (parts.fringe) shared.push(upload(3, parts.fringe, false));

  /* ---- ribbons ---- */
  const B = tabs.map((t) => ({ key: t.key, el: t.el, text: t.label || "", x: 0, y: 0, w: 0, h: 0, len: 0, lv: 0, lt: 0, go: false, sw: -1, ax: 0, av: 0, phase: 0, dir: 1, sel: false, lift: false, fv: false, tile: null, lbl: null, lblW: 0, lblF: 0, lblFont: false, dye: [0.4, 0.3, 0.3], ox: 0, ov: 0, ot: 0, last: -1e9 }));
  const G = { rod: 14, rest: 54, open: 118, fringe: 10, drop: 6, curl: 12 };
  let W = 0, CH = 1, dprEff = 1, ready = false, destroyed = false, raf = 0, last = 0, acc = 0, t = 0, kicks = 0, uploadMs = 0, bakeMs = 0, baked = 0, hover = -1, closed = true, hid = true, railL = 0, railR = 0, drawn = 0;
  let pending = []; /* timed actions: { at, i, px, dir } a neighbour kick, or { at, i, go: true } a ribbon starting its drop */
  const ring = new Float32Array(120); let rn = 0, lastCost = 0;
  const frameApi = () => { const n = Math.min(rn, 120), a = Array.from(ring.subarray(0, n)).sort((x, y) => x - y); return { last: +lastCost.toFixed(3), p95: n ? +a[Math.min(n - 1, Math.ceil(n * 0.95) - 1)].toFixed(3) : 0 }; };

  function geometry() {
    let cs = null; try { cs = getComputedStyle(rail); } catch (e) { cs = null; }
    const px = (n, d) => { const v = cs ? parseFloat(cs.getPropertyValue(n)) : NaN; return v > 0 ? v : d; };
    G.rest = px("--ribbon-rest", 54); G.rod = G.rest * 0.25; G.open = G.rest * px("--ribbon-k", 2.5); G.fringe = G.rest / 5.4; G.drop = G.rest / 9; /* the fringe and the hover drop follow the rest length (css reads the same ratio) */
  }
  const dyeOf = (img) => { /* the mean colour of the tile: tints the greyscale loop and fringe */
    try { const c = document.createElement("canvas"); c.width = c.height = 1; const x = c.getContext("2d"); x.drawImage(img, 0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255]; } catch (e) { return [0.4, 0.3, 0.3]; }
  };
  function fontOk() { try { return !document.fonts || document.fonts.check('700 13px "Alegreya Sans SC"'); } catch (e) { return true; } }
  function bake(b, dpr) {
    if (!b.tile && images[b.key]) { const t0 = performance.now(); b.tile = upload(0, images[b.key], true); b.dye = dyeOf(images[b.key]); uploadMs += performance.now() - t0; }
    let fs = 13; try { fs = parseFloat(getComputedStyle(b.el).fontSize) || 13; } catch (e) {}
    const f = fontOk();
    if (b.lbl && Math.abs(b.w - b.lblW) / b.lblW < 0.12 && Math.abs(fs - b.lblF) / b.lblF < 0.12 && f === b.lblFont) return;
    const t0 = performance.now();
    const c = bakeLabel({ text: b.text, widthPx: b.w, fontPx: fs, dpr, maxH: G.rest - G.fringe - 24, gold: parts.gold || null, pale: b.key === "library" });
    gl.activeTexture(gl.TEXTURE1);
    if (!b.lbl) { b.lbl = gl.createTexture(); textures++; baked++; }
    gl.bindTexture(gl.TEXTURE_2D, b.lbl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    b.lblW = b.w; b.lblF = fs; b.lblFont = f; b.lblH = c.height / dpr; bakeMs += performance.now() - t0;
  }

  /* one ribbon's texture upload and label bake per frame, so the 80 to 110 ms of first-use work never lands in one frame */
  const need = new Set(); let pumpRaf = 0;
  const pumpGo = () => { if (need.size && !pumpRaf && !destroyed) pumpRaf = requestAnimationFrame(pumpStep); };
  function pumpStep() {
    pumpRaf = 0; if (destroyed || !need.size) return;
    const b = need.values().next().value; need.delete(b);
    if (b.w) { bake(b, dprEff); if (ready) { draw(); wake(); } }
    pumpGo();
  }
  function layout() {
    if (destroyed) return false;
    const cw = rail.clientWidth, ch = rail.clientHeight;
    if (!rail.offsetWidth || !cw || !ch) { ready = false; hid = true; return false; }
    geometry();
    const sr = sheet.getBoundingClientRect(), rr = rail.getBoundingClientRect(); let any = false;
    for (const b of B) {
      const e = b.el, w = e.offsetWidth;
      if (!w) { b.w = 0; continue; }
      const r = e.getBoundingClientRect(); b.x = r.left - sr.left; b.y = r.top - sr.top; b.w = w; b.h = e.offsetHeight; any = true;
    }
    if (!any) { ready = false; hid = true; return false; }
    railL = rr.left - sr.left; railR = rr.right - sr.left;
    const nw = Math.max(1, Math.round(sr.width)), top = Math.max(...B.filter((b) => b.w).map((b) => b.y)), nh = Math.min(Math.round(sr.height), Math.ceil(top + G.rod + G.open + MAX_AMP + 8));
    const dpr = Math.min(window.devicePixelRatio || 1, 2), eff = Math.min(dpr, 4096 / nw);
    const bw = Math.round(nw * eff), bh = Math.round(nh * eff);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    canvas.style.width = `${nw}px`; canvas.style.height = `${nh}px`;
    W = nw; CH = nh; dprEff = eff;
    gl.viewport(0, 0, bw, bh);
    for (const b of B) if (b.w) need.add(b);
    pumpGo();
    ready = true;
    if (closed && hid) intro(); /* the sheet opened: the ribbons drop from the rod, one every 25 ms from the left (section 4) */
    hid = false;
    retarget();
    return true;
  }
  function intro() {
    const now = performance.now(); closed = false; pending = pending.filter((p) => !p.go);
    B.forEach((b, i) => { b.len = 0; b.lv = 0; b.go = false; b.lt = 0; pending.push({ at: now + i * 25, i, go: true }); });
    wake();
  }

  const restOf = () => G.rest, openOf = () => G.open;
  function targetOf(b) { return !b.go ? 0 : b.sel ? openOf() : restOf() + (b.lift ? G.drop : 0); }
  function retarget() { for (const b of B) b.lt = targetOf(b); wake(); }
  const moving = (b) => b.ax !== 0 || b.av !== 0 || b.len !== b.lt || b.lv !== 0 || b.sw >= 0;
  const anyMoving = () => pending.length > 0 || B.some(moving);
  const ampK = () => G.rest / 50; /* the kick values (px) were set for a 38 px banner */

  function kickAt(i, px, dir) {
    const b = B[i]; if (!b || destroyed) return;
    if (!b.ax && !b.av) b.phase = 0;
    b.ax = clamp(b.ax + px, -MAX_AMP, MAX_AMP); b.dir = dir < 0 ? -1 : 1; kicks++; wake();
  }
  function kick(key, px, dir) { const i = B.findIndex((b) => b.key === key); if (i >= 0) kickAt(i, px, dir); }
  function kickWave(i, px, dir, now) { kickAt(i, px, dir); for (const j of [i - 1, i + 1]) if (B[j]) pending.push({ at: now + 60, i: j, px: px * 0.4, dir }); }
  const setLift = (b, on) => { if (on && !b.lift && !b.sel) b.sw = 0; b.lift = on; };

  /* the pointer path in canvas space (the sheet): x0 to x, at y; vx in px per second */
  function pointer(x, y, vx, x0) {
    if (destroyed || !ready) return;
    const now = performance.now(), lo = Math.min(x, x0 == null ? x : x0), hi = Math.max(x, x0 == null ? x : x0);
    let over = -1;
    for (let i = 0; i < B.length; i++) {
      const b = B[i]; if (!b.w) continue;
      const inY = y >= b.y - 4 && y <= b.y + b.h + G.drop;
      if (x >= b.x && x <= b.x + b.w && inY) over = i;
      if (inY && hi >= b.x && lo <= b.x + b.w && Math.abs(vx) >= 40 && now - b.last >= 60) { b.last = now; kickWave(i, clamp(Math.abs(vx) * 0.04, 1, MAX_AMP), vx < 0 ? -1 : 1, now); }
    }
    if (over !== hover) { if (hover >= 0) setLift(B[hover], false); hover = over; if (over >= 0) { setLift(B[over], true); kickAt(over, 4, 1); } retarget(); }
  }
  function leave() { if (hover >= 0) { setLift(B[hover], false); hover = -1; retarget(); } }
  function focus(key, visible) { for (const b of B) if (b.key === key) { if (!b.fv) kick(key, 6, 1); b.fv = !!visible; } else b.fv = false; syncLift(); }
  function blur() { for (const b of B) b.fv = false; syncLift(); }
  function syncLift() { B.forEach((b, i) => setLift(b, i === hover || !!b.fv)); retarget(); }
  /* choose, switch (key set), close (key null): the chosen ribbon unrolls, the old one rolls up 120 ms later (section 4) */
  function scene(key, prev) {
    const now = performance.now();
    if (key == null) { for (const b of B) { b.sel = false; } closed = true; hid = false; retarget(); return; }
    if (closed && !hid) closed = false;
    for (const b of B) {
      const was = b.sel; b.sel = b.key === key;
      if (b.sel && !was) { kick(b.key, 8, 1); setLift(b, false); }
      else if (!b.sel && was && b.key === prev) { b.sel = true; pending.push({ at: now + 120, i: B.indexOf(b), unsel: true }); kick(b.key, 4, -1); }
    }
    layout(); retarget();
  }

  /* ---- the loop ---- */
  function step(dt, now) {
    if (pending.length) {
      const rest = [];
      for (const p of pending) {
        if (p.at > now) { rest.push(p); continue; }
        if (p.go) { const b = B[p.i]; if (b) b.go = true; } else if (p.unsel) { const b = B[p.i]; if (b) b.sel = false; } else kickAt(p.i, p.px, p.dir);
      }
      pending = rest; for (const b of B) b.lt = targetOf(b);
    }
    acc += dt;
    while (acc >= STEP) {
      for (const b of B) {
        if (b.ax || b.av) { b.av += (-KC * b.ax - CC * b.av) * STEP; b.ax += b.av * STEP; }
        if (b.len !== b.lt || b.lv) { b.lv += (KL * (b.lt - b.len) - CL * b.lv) * STEP; b.len += b.lv * STEP; if (b.len < 0) { b.len = 0; b.lv = 0; } }
      }
      acc -= STEP;
    }
    for (const b of B) {
      if ((b.ax || b.av) && Math.abs(b.ax) < REST_AMP && Math.abs(b.av) < REST_AMP_V) { b.ax = 0; b.av = 0; }
      if ((b.len !== b.lt || b.lv) && Math.abs(b.len - b.lt) < 0.1 && Math.abs(b.lv) < 0.5) { b.len = b.lt; b.lv = 0; }
      if (b.sw >= 0) { b.sw += dt / SWEEP_S; if (b.sw > 1) b.sw = -1; }
    }
  }

  const anySelF = () => B.some((b) => b.sel);
  let anySel = false;
  const widthScale = (b) => (b.sel ? 1 + 0.14 * clamp((b.len - G.rest) / Math.max(1, G.open - G.rest), 0, 1) : anySel ? 0.94 : 1);
  function drawOne(b, shadow) {
    const H = G.rod + b.len; if (H < 2 || !b.w || !b.tile) return;
    const gap = Math.abs(b.lt - b.len), curl = Math.min(gap / 12, 1) * G.curl * Math.max(0.6, G.rest / 54), Z = Math.min(curl, Math.max(0, (b.len - G.fringe) * 0.6));
    const E = shadow ? 6 : 0, ws = widthScale(b), bw = b.w * ws, bx = b.x + (b.w - bw) / 2;
    gl.uniform4f(loc.u_rect, bx - E, b.y, bw + 2 * E, H + E);
    gl.uniform4f(loc.u_w, b.ax * ampK(), b.phase, b.dir, 0);
    gl.uniform4f(loc.u_g, G.rod, Math.min(G.fringe, b.len * 0.5), Z, Math.max(30, G.rest));
    gl.uniform4f(loc.u_wh, bw + 2 * E, H + E, shadow ? clamp((b.len - G.rest) / 20, 0, 1) : 1, 0);
    gl.uniform2f(loc.u_off, shadow ? 4 : 0, shadow ? 5 : 0);
    if (shadow) { gl.uniform4f(loc.u_lb, 0, 1, -1, 1); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0); return; }
    const lc = G.rod + 24 + (G.rest - G.fringe - 24) / 2 + 2, lh = b.lblH || 20;
    gl.uniform4f(loc.u_lb, lc - lh / 2, lh, b.sw, 0);
    gl.uniform3f(loc.u_dye, b.dye[0], b.dye[1], b.dye[2]);
    gl.uniform1f(loc.u_lit, b.sel ? 1.12 : anySel ? 0.8 : 0.9);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.tile);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.lbl || b.tile);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    drawn++;
  }
  function drawRod(b) { /* the rod and the wool fold over it: a flat quad of the same mesh, a little wider than the ribbon, no sway */
    const ws = widthScale(b), bw = b.w * ws, E = bw * 0.056;
    gl.uniform4f(loc.u_rect, b.x + (b.w - bw) / 2 - E, b.y, bw + 2 * E, G.rod); gl.uniform4f(loc.u_w, 0, 0, 1, 0); gl.uniform4f(loc.u_g, G.rod, 0.001, 0, G.rest);
    gl.uniform4f(loc.u_wh, bw + 2 * E, G.rod, 1, 0); gl.uniform2f(loc.u_off, 0, 0); gl.uniform4f(loc.u_lb, 0, 1, -1, 2);
    gl.uniform3f(loc.u_dye, b.dye[0], b.dye[1], b.dye[2]); gl.uniform1f(loc.u_lit, b.sel ? 1.05 : anySel ? 0.78 : 0.9);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  }
  function draw() {
    if (!ready || destroyed || (gl.isContextLost && gl.isContextLost())) return;
    gl.disable(gl.SCISSOR_TEST); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST); /* a scrolling rail (1024 wide) clips its ribbons at the rail's edges, a little loosely for the sway */
    const sx = Math.max(0, Math.floor((railL - 16) * dprEff)), ex = Math.min(canvas.width, Math.ceil((railR + 16) * dprEff));
    gl.scissor(sx, 0, Math.max(0, ex - sx), canvas.height);
    gl.uniform2f(loc.u_view, W, CH); gl.uniform1f(loc.u_t, t);
    drawn = 0; anySel = anySelF();
    const order = []; B.forEach((b, i) => { if (b.w && b.tile && !b.sel) order.push(i); }); B.forEach((b, i) => { if (b.w && b.tile && b.sel) order.push(i); });
    for (const i of order) { const b = B[i]; if (b.sel && b.len > G.rest + 2) drawOne(b, true); drawOne(b, false); drawRod(b); }
  }

  function clothFrame(now) {
    raf = 0;
    if (destroyed || document.hidden) return;
    const dt = last ? Math.min(0.5, (now - last) / 1000) : 1 / 60; last = now; /* capped at 0.5 s: the fixed 1/120 s substeps keep it stable; a wake resets last, so a hidden tab never jumps */
    const c0 = performance.now();
    const waved = B.some((b) => b.ax || b.av);
    step(dt, now);
    if (waved) t += dt;
    draw();
    lastCost = performance.now() - c0; ring[rn++ % 120] = lastCost;
    /* a pending hop that lands inside step() calls wake(), which already asked for the next frame (integrator note of 2026-10-30) */
    if (anyMoving()) { if (!raf) raf = requestAnimationFrame(clothFrame); }
    else { t = 0; last = 0; acc = 0; }
  }
  function wake() { if (!raf && !destroyed && !document.hidden && ready) { last = 0; raf = requestAnimationFrame(clothFrame); } }

  function onVis() { /* hidden: nothing runs; shown again: one static rest frame, then nothing until the next input */
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0; } return; }
    for (const b of B) { b.ax = b.av = 0; b.len = b.lt = targetOf(b); b.lv = 0; b.sw = -1; } pending = []; t = 0; last = 0; acc = 0;
    if (ready) { draw(); }
  }
  document.addEventListener("visibilitychange", onVis);
  const lostH = (e) => { try { e.preventDefault(); } catch (x) {} if (onLost) onLost(); destroy(); };
  canvas.addEventListener("webglcontextlost", lostH);

  function loseContext() { try { const x = gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); } catch (e) {} }
  function destroy() {
    if (destroyed) return; destroyed = true;
    if (raf) cancelAnimationFrame(raf); raf = 0; pending = []; if (pumpRaf) cancelAnimationFrame(pumpRaf); pumpRaf = 0; need.clear();
    document.removeEventListener("visibilitychange", onVis); canvas.removeEventListener("webglcontextlost", lostH);
    try { for (const b of B) { if (b.tile) gl.deleteTexture(b.tile); if (b.lbl) gl.deleteTexture(b.lbl); b.tile = b.lbl = null; } for (const x of shared) gl.deleteTexture(x); gl.deleteBuffer(buf); gl.deleteBuffer(idx); gl.deleteProgram(prog); } catch (e) {}
    textures = 0; loseContext();
  }

  /* the first selection; the ribbons drop in at the first layout that finds the rail visible */
  for (const b of B) b.sel = b.el.getAttribute("aria-selected") === "true";
  layout(); if (ready) { draw(); wake(); }

  return {
    layout, pointer, leave, focus, blur, scene, kick, destroy,
    status: () => ({ on: !destroyed, gl: destroyed ? null : glKind, textures, running: !!raf, frame: frameApi(), kicks, uploadMs: +uploadMs.toFixed(1), bakeMs: +bakeMs.toFixed(1), baked, drawn, ready, geometry: { ...G }, banners: B.map((b) => ({ key: b.key, amp: +b.ax.toFixed(2), len: +b.len.toFixed(1), target: +b.lt.toFixed(1), sel: b.sel })) }),
  };
}
