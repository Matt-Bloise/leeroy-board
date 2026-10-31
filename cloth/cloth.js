import { VS, FS, RVS, RFS } from "./weave.glsl.js?v=05273c8840";
import { createBaker, fontReady } from "./ribbon-bake.js?v=0130fc4966";

const COLS = 8, ROWS = 64, STEP = 1 / 120, MAX_AMP = 14;
const KC = 40, CC = 6, KL = 180, CL = 22;
const REST_AMP = 0.5, REST_AMP_V = 3, SWEEP_S = 0.42, HOLD_MS = 280, STAGGER = 18, TUCK = 0.55, PLUS = 12;
const CREST_K = 0.52, CREST_MIN = 44, CREST_MAX = 100, CLEAR = 6, LS = 4;
const DPR_MAX = 3, HEAT = 8e6, MAX_W = 8192, ANISO = 8;
const DYES = { indigo: [0.078, 0.152, 0.278], royal: [0.061, 0.187, 0.488], "burnt-orange": [0.655, 0.207, 0.05], crimson: [0.541, 0.046, 0.074], copper: [0.412, 0.186, 0.092], plum: [0.232, 0.115, 0.213], wine: [0.362, 0.066, 0.086], forest: [0.147, 0.241, 0.131], olive: [0.317, 0.299, 0.106], ochre: [0.645, 0.388, 0.06], slate: [0.221, 0.297, 0.368], teal: [0.024, 0.188, 0.215] };
const GOLD = [1, 0.84, 0.5];
const INK = {};
const IMG = (n) => new URL(`../img/ribbons/${n}.webp`, import.meta.url).href;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function art(name, pre) {
  return fetch(IMG(name)).then((r) => { if (!r.ok) throw new Error(name); return r.blob(); })
    .then((b) => (typeof createImageBitmap === "function" ? createImageBitmap(b, { premultiplyAlpha: pre ? "premultiply" : "none" }) : new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(b); })));
}

export function createCloth(o) {
  const { canvas, rail, sheet = rail, tabs, onLost, onReady } = o;
  const born = {}; let sized = false, waiting = false, pend = null, gl = null, pcx = null, anx = null, aniso = 0, prog = null, rprog = null;
  const shaders = [];
  const mk = (v, f) => { const p = gl.createProgram(); for (const [t, s] of [[gl.VERTEX_SHADER, v], [gl.FRAGMENT_SHADER, f]]) { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); gl.attachShader(p, x); shaders.push(x); } gl.linkProgram(p); return p; };
  function init() {
    if (destroyed) return;
    const t0 = performance.now();
    try { gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" }); } catch (e) { gl = null; }
    born.ctx = +(performance.now() - t0).toFixed(1);
    if (!gl) { lose(); return; }
    pcx = gl.getExtension("KHR_parallel_shader_compile"); anx = gl.getExtension("EXT_texture_filter_anisotropic");
    aniso = anx ? Math.min(ANISO, gl.getParameter(anx.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) : 0;
    prog = mk(VS, FS); rprog = mk(RVS, RFS); born.init = +(performance.now() - t0).toFixed(1);
    idle(poll);
  }
  let linked = 0, U = {}, RU = {}, vao = null, rvao = null, bufs = [], count = 0, blank = null, ibuf = null;
  const inst = new Float32Array(Math.max(1, tabs.length) * 8);
  function checkLink() {
    if (linked || !gl) return linked > 0;
    if (pcx && !(gl.getProgramParameter(prog, pcx.COMPLETION_STATUS_KHR) && gl.getProgramParameter(rprog, pcx.COMPLETION_STATUS_KHR))) return false;
    for (const p of [prog, rprog]) if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn("cloth shader", gl.getProgramInfoLog(p) || shaders.map((s) => gl.getShaderInfoLog(s)).join(" ")); linked = -1; setTimeout(lose, 0); return false; }
    linked = 1; setup(); return true;
  }
  function setup() {
    for (const n of ["u_view", "u_rect", "u_w", "u_g", "u_off", "u_t", "u_lbl", "u_cr", "u_fr", "u_wh", "u_ft", "u_lr", "u_cb", "u_dye", "u_thr", "u_k"]) U[n] = gl.getUniformLocation(prog, n);
    for (const n of ["u_view", "u_loop"]) RU[n] = gl.getUniformLocation(rprog, n);
    const pos = new Float32Array((COLS + 1) * (ROWS + 1) * 2), ix = new Uint16Array(COLS * ROWS * 6);
    let p = 0, q = 0;
    for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) { pos[p++] = c / COLS; pos[p++] = r / ROWS; }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const a = r * (COLS + 1) + c, b = a + 1, d = a + COLS + 1, e = d + 1; ix.set([a, d, b, b, d, e], q); q += 6; }
    count = ix.length;
    const buf = (target, data, usage) => { const x = gl.createBuffer(); gl.bindBuffer(target, x); gl.bufferData(target, data, usage); bufs.push(x); return x; };
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    buf(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW); const au = gl.getAttribLocation(prog, "a_uv"); gl.enableVertexAttribArray(au); gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 0, 0);
    buf(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STATIC_DRAW);
    rvao = gl.createVertexArray(); gl.bindVertexArray(rvao);
    buf(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW); const ru = gl.getAttribLocation(rprog, "a_uv"); gl.enableVertexAttribArray(ru); gl.vertexAttribPointer(ru, 2, gl.FLOAT, false, 0, 0);
    ibuf = buf(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
    for (const [n, off] of [["i_r", 0], ["i_d", 16]]) { const l = gl.getAttribLocation(rprog, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 4, gl.FLOAT, false, 32, off); gl.vertexAttribDivisor(l, 1); }
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0);
    gl.useProgram(rprog); gl.uniform1i(RU.u_loop, 3);
    gl.useProgram(prog); gl.uniform1i(U.u_lbl, 0); gl.uniform1i(U.u_cr, 1); gl.uniform1i(U.u_fr, 2);
    blank = gl.createTexture(); for (let u = 0; u < 4; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, blank); }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    for (const [n, pre] of [["p-loop", true], ["p-fringe", true]]) art(n, pre).then((im) => queue(() => { shared[n] = put(n === "p-loop" ? 3 : 2, null, n, () => img(im, pre)); }), () => {});
  }

  let textures = 0, uploadMs = 0, uploadMax = 0, ups = 0;
  const bytes = new Map(), shared = {};
  const img = (src, pre) => { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pre); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src); return (src.width || src.naturalWidth) * (src.height || src.naturalHeight) * 4; };
  function put(unit, old, tag, fill) {
    const t = old || gl.createTexture(); if (!old) textures++;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    const n = fill();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, anx.TEXTURE_MAX_ANISOTROPY_EXT, aniso);
    gl.bindTexture(gl.TEXTURE_2D, blank);
    bytes.set(tag, Math.round((n * 4) / 3)); return t;
  }
  const work = []; let pumpRaf = 0;
  const queue = (f) => { work.push(f); if (!pumpRaf && !destroyed) pumpRaf = requestAnimationFrame(pump); };
  function pump() {
    pumpRaf = 0; if (destroyed || !work.length) return;
    const t0 = performance.now(); try { work.shift()(); } catch (e) {} const ms = performance.now() - t0; uploadMs += ms; uploadMax = Math.max(uploadMax, ms); ups++;
    if (ready) { draw(); }
    if (work.length) pumpRaf = requestAnimationFrame(pump);
  }

  const B = tabs.map((t) => ({ key: t.key, el: t.el, text: t.label || "", dye: DYES[t.colour] || [0.3, 0.25, 0.25], ink: INK[t.colour] || [GOLD, -0.22], x: 0, y: 0, w: 0, h: 0, len: 0, lv: 0, lt: 0, go: false, mode: "rest", sw: -1, swept: false, ax: 0, av: 0, phase: 0, dir: 1, sel: false, lift: false, fv: false, lbl: null, li: null, want: "", wid: "", cr: null, crN: 0, last: -1e9 }));
  const G = { rod: 22, rest: 88, open: 194, fringe: 16, drop: 10, cap: 13 };
  let W = 0, CH = 1, dprEff = 1, dprAsk = 1, ready = false, destroyed = false, raf = 0, last = 0, acc = 0, t = 0, kicks = 0, baked = 0, bakeMs = 0, hover = -1, closed = true, hid = true, railL = 0, railR = 0, calls = 0, hold = null, seq = 0, lkey = "";
  const dbg = { ink: 1, solo: null };
  let pending = [];
  const ring = new Float32Array(120); let rn = 0, lastCost = 0;
  const frameApi = () => { const n = Math.min(rn, 120), a = Array.from(ring.subarray(0, n)).sort((x, y) => x - y); return { last: +lastCost.toFixed(3), p95: n ? +a[Math.min(n - 1, Math.ceil(n * 0.95) - 1)].toFixed(3) : 0 }; };
  const baker = createBaker((r) => {
    const b = B[parseInt(r.id, 10)]; if (!b || r.id !== b.wid || destroyed) return; bakeMs += r.ms || 0;
    queue(() => { b.lbl = put(0, b.lbl, `l${b.key}`, () => { gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, r.w, r.h, 0, gl.RED, gl.UNSIGNED_BYTE, r.data); return r.w * r.h; }); if (!b.li) baked++; b.li = r; });
  });

  function geometry() {
    let cs = null; try { cs = getComputedStyle(rail); } catch (e) { cs = null; }
    const px = (n, d) => { const v = cs ? parseFloat(cs.getPropertyValue(n)) : NaN; return v > 0 ? v : d; };
    G.rest = px("--ribbon-rest", 88); G.rod = px("--ribbon-rod", G.rest * 0.25); G.open = G.rest * px("--ribbon-k", 2.2); G.fringe = Math.min(18, G.rest / 5.4); G.drop = G.rest / 9; G.cap = px("--ribbon-cap", 13);
  }
  function plan(b) {
    const room = G.rest - G.fringe - CLEAR - 11 - G.cap * 2.62, c = room < 32 ? 0 : Math.min(clamp(CREST_K * b.w, CREST_MIN, CREST_MAX), room), top = CLEAR + c + 4;
    return { c, mid: (top + G.rest - G.fringe - 4) / 2 };
  }
  function feed(b, i) {
    const w = fontReady(), want = `${b.text}|${Math.round(b.w / 4)}|${G.cap}|${baker.mode() === "idle" && w}`;
    if (want !== b.want) { b.want = want; b.wid = `${i}:${++seq}`; baker.bake({ id: b.wid, text: b.text, widthCss: b.w, capCss: G.cap, pad: 5 }); }
    const n = plan(b).c * dprAsk > 120 ? 256 : 128;
    if (plan(b).c && n > b.crN) { b.crN = n; art(`crests/${b.key}${n === 256 ? "" : "-128"}`, false).then((im) => queue(() => { b.cr = put(1, b.cr, `c${b.key}`, () => img(im, false)); b.crT = n; }), () => {}); }
  }

  function layout() {
    if (destroyed || !checkLink()) return false;
    const cw = rail.clientWidth, ch = rail.clientHeight;
    if (!rail.offsetWidth || !cw || !ch) { ready = false; hid = true; return false; }
    const k = [cw, ch, rail.scrollLeft, rail.offsetLeft, rail.offsetTop, sheet.clientWidth, sheet.clientHeight, window.devicePixelRatio].join();
    if (k !== lkey || !ready) {
      lkey = k; geometry();
      const sr = sheet.getBoundingClientRect(), rr = rail.getBoundingClientRect(); let any = false;
      for (const b of B) { const e = b.el, w = e.offsetWidth; if (!w) { b.w = 0; continue; } const r = e.getBoundingClientRect(); b.x = r.left - sr.left; b.y = r.top - sr.top; b.w = w; b.h = e.offsetHeight; any = true; }
      if (!any) { ready = false; hid = true; return false; }
      railL = rr.left - sr.left; railR = rr.right - sr.left;
      const nw = Math.max(1, Math.round(sr.width)), top = Math.max(...B.filter((b) => b.w).map((b) => b.y)), nh = Math.min(Math.round(sr.height), Math.ceil(top + G.rod + G.open + MAX_AMP + 8));
      dprAsk = Math.min(window.devicePixelRatio || 1, DPR_MAX); const eff = Math.min(dprAsk, MAX_W / nw, Math.sqrt(HEAT / (nw * nh)));
      const bw = Math.round(nw * eff), bh = Math.round(nh * eff);
      if (canvas.width !== bw || canvas.height !== bh) {
        if (!sized) { pend = [bw, bh]; if (!waiting) { waiting = true; calm(() => { waiting = false; if (destroyed || !pend) return; canvas.width = pend[0]; canvas.height = pend[1]; sized = true; if (onReady) onReady(); }); } lkey = ""; ready = false; hid = true; return false; }
        canvas.width = bw; canvas.height = bh;
      }
      canvas.style.width = `${nw}px`; canvas.style.height = `${nh}px`;
      W = nw; CH = nh; dprEff = eff; gl.viewport(0, 0, bw, bh);
      B.forEach((b, i) => { if (b.w) feed(b, i); });
    }
    ready = true;
    if (closed && hid) intro();
    hid = false;
    retarget(); draw();
    return true;
  }
  function intro() {
    const now = performance.now(); closed = false; hold = null; pending = pending.filter((p) => !p.go && !p.m);
    B.forEach((b, i) => { b.len = 0; b.lv = 0; b.go = false; b.lt = 0; b.mode = b.sel ? "chosen" : "rest"; pending.push({ at: now + i * 25, i, go: true }); });
    wake();
  }

  function targetOf(b) { return !b.go ? 0 : b.mode === "open" ? G.open : b.mode === "tuck" ? G.rest * TUCK : b.mode === "chosen" ? G.rest + PLUS : G.rest + (b.lift ? G.drop : 0); }
  function retarget() { for (const b of B) b.lt = targetOf(b); wake(); }
  const moving = (b) => b.ax !== 0 || b.av !== 0 || b.len !== b.lt || b.lv !== 0 || b.sw >= 0;
  const anyMoving = () => pending.length > 0 || !!hold || B.some(moving);
  const ampK = () => G.rest / 50;

  function kickAt(i, px, dir) { const b = B[i]; if (!b || destroyed) return; if (!b.ax && !b.av) b.phase = 0; b.ax = clamp(b.ax + px, -MAX_AMP, MAX_AMP); b.dir = dir < 0 ? -1 : 1; kicks++; wake(); }
  function kick(key, px, dir) { const i = B.findIndex((b) => b.key === key); if (i >= 0) kickAt(i, px, dir); }
  function kickWave(i, px, dir, now) { kickAt(i, px, dir); for (const j of [i - 1, i + 1]) if (B[j]) pending.push({ at: now + 60, i: j, px: px * 0.4, dir }); }
  const setLift = (b, on) => { if (on && !b.lift && !b.sel) b.sw = 0; b.lift = on; };

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
  function scene(key, prev) {
    const now = performance.now(); pending = pending.filter((p) => p.m == null); hold = null;
    if (key == null) { for (const b of B) { b.sel = false; b.mode = "rest"; } closed = true; hid = true; retarget(); return; }
    if (closed && !hid) closed = false;
    const ci = B.findIndex((b) => b.key === key);
    B.forEach((b, i) => { b.sel = i === ci; });
    if (prev == null || prev === key || ci < 0 || !ready) { for (const b of B) b.mode = b.sel ? "chosen" : "rest"; retarget(); return; }
    B.forEach((b, i) => {
      if (i === ci) { b.mode = "open"; b.swept = false; setLift(b, false); kickAt(i, 8, 1); }
      else if (b.key === prev || b.mode === "open" || b.mode === "chosen") { b.mode = "tuck"; kickAt(i, 4, -1); }
      else if (b.mode !== "tuck") pending.push({ at: now + STAGGER * Math.abs(i - ci), i, m: "tuck" });
    });
    hold = { i: ci, at: 0 };
    retarget();
  }
  function settle(now) {
    const ci = hold.i; hold = null;
    B.forEach((b, i) => { if (i === ci) b.mode = "chosen"; else pending.push({ at: now + STAGGER * Math.abs(i - ci), i, m: "rest" }); });
  }

  function step(dt, now) {
    if (hold) { const c = B[hold.i]; if (!hold.at && c.len >= 0.98 * G.open) hold.at = now + HOLD_MS; if (hold.at && now >= hold.at) settle(now); }
    for (const b of B) if (b.mode === "open" && !b.swept && b.len >= G.rest + 0.6 * (G.open - G.rest)) { b.swept = true; b.sw = 0; }
    if (pending.length) {
      const rest = [];
      for (const p of pending) {
        if (p.at > now) { rest.push(p); continue; }
        const b = B[p.i]; if (!b) continue;
        if (p.go) b.go = true; else if (p.m) b.mode = p.m; else kickAt(p.i, p.px, p.dir);
      }
      pending = rest;
    }
    for (const b of B) b.lt = targetOf(b);
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

  let anySel = false;
  const widthScale = (b) => (b.sel ? 1 + 0.08 * clamp(b.len / (G.rest + PLUS), 0, 1) : 1);
  const litOf = (b, r) => (b.sel ? (r ? 1.05 : 1.12) : anySel ? (r ? 0.78 : 0.8) : 0.9);
  function drawOne(b, shadow) {
    const len = b.len; if (len < 1 || !b.w) return;
    const R = Math.min(clamp(Math.abs(b.lt - len) / 12, 0, 1) * (4 + 0.03 * Math.max(0, G.open - len)), len * 0.3), A = G.rod + len + (Math.PI - 1) * R;
    const ws = widthScale(b), bw = b.w * ws, bx = b.x + (b.w - bw) / 2, E = shadow ? 6 : 1, AA = A + (shadow ? 6 : 0);
    gl.uniform4f(U.u_rect, bx - E, b.y, bw + 2 * E, AA);
    gl.uniform4f(U.u_w, b.ax * ampK(), b.phase, b.dir, 0);
    gl.uniform4f(U.u_g, G.rod, R, Math.max(30, G.rest), shadow ? 0 : E);
    gl.uniform4f(U.u_wh, shadow ? bw + 2 * E : bw, AA, shadow ? clamp((len - G.rest - PLUS) / 20, 0, 1) : 1, shadow ? 1 : 0);
    gl.uniform2f(U.u_off, shadow ? 4 : 0, shadow ? 5 : 0);
    if (!shadow) {
      const p = plan(b), li = b.li;
      gl.uniform4f(U.u_ft, Math.min(G.fringe, len * 0.5), clamp(R / 3, 0, 1), li && b.lbl ? 1 : 0, b.cr && p.c ? 1 : 0);
      gl.uniform4f(U.u_cb, (bw - p.c) / 2, CLEAR, p.c, 0);
      if (li) { const lw = li.w / LS, lh = li.h / LS; gl.uniform4f(U.u_lr, (bw - lw) / 2, p.mid - (li.inkTop + li.inkBot) / 2, lw, lh); }
      gl.uniform3f(U.u_dye, b.dye[0], b.dye[1], b.dye[2]); gl.uniform3f(U.u_thr, b.ink[0][0], b.ink[0][1], b.ink[0][2]);
      gl.uniform4f(U.u_k, litOf(b), b.ink[1], dbg.ink, b.sw);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.lbl || blank);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.cr || blank);
    }
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0); calls++;
  }
  function draw() {
    if (!ready || destroyed || linked < 1 || gl.isContextLost()) return;
    gl.disable(gl.SCISSOR_TEST); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    const sx = Math.max(0, Math.floor((railL - 16) * dprEff)), ex = Math.min(canvas.width, Math.ceil((railR + 16) * dprEff));
    gl.scissor(sx, 0, Math.max(0, ex - sx), canvas.height);
    calls = 0; anySel = B.some((b) => b.sel);
    const order = [], on = (b) => b.w && (!dbg.solo || b.key === dbg.solo); B.forEach((b, i) => { if (on(b) && !b.sel) order.push(i); }); B.forEach((b, i) => { if (on(b) && b.sel) order.push(i); });
    gl.useProgram(prog); gl.bindVertexArray(vao); gl.uniform2f(U.u_view, W, CH); gl.uniform1f(U.u_t, t);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, shared["p-fringe"] || blank);
    for (const i of order) { const b = B[i]; if (b.sel && b.len > G.rest + PLUS + 2) drawOne(b, true); drawOne(b, false); }
    let n = 0;
    for (const i of order) { const b = B[i], bw = b.w * widthScale(b), E = bw * 0.056, l = litOf(b, 1); inst.set([b.x + (b.w - bw) / 2 - E, b.y, bw + 2 * E, G.rod, b.dye[0], b.dye[1], b.dye[2], l], n * 8); n++; }
    if (n && shared["p-loop"]) {
      gl.useProgram(rprog); gl.bindVertexArray(rvao); gl.uniform2f(RU.u_view, W, CH);
      gl.bindBuffer(gl.ARRAY_BUFFER, ibuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst.subarray(0, n * 8));
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, shared["p-loop"]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n); calls++;
    }
    gl.bindVertexArray(null);
  }

  function clothFrame(now) {
    raf = 0;
    if (destroyed || document.hidden) return;
    const dt = last ? Math.min(0.5, (now - last) / 1000) : 1 / 60; last = now;
    const c0 = performance.now(), waved = B.some((b) => b.ax || b.av);
    step(dt, now);
    if (waved) t += dt;
    draw();
    lastCost = performance.now() - c0; ring[rn++ % 120] = lastCost;
    if (anyMoving()) { if (!raf) raf = requestAnimationFrame(clothFrame); }
    else { t = 0; last = 0; acc = 0; }
  }
  function wake() { if (!raf && !destroyed && !document.hidden && ready) { last = 0; raf = requestAnimationFrame(clothFrame); } }

  function onVis() {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0; } return; }
    hold = null; pending = [];
    for (const b of B) { b.go = true; b.mode = b.sel ? "chosen" : "rest"; b.ax = b.av = 0; b.len = b.lt = targetOf(b); b.lv = 0; b.sw = -1; } t = 0; last = 0; acc = 0;
    if (ready) draw();
  }
  document.addEventListener("visibilitychange", onVis);
  const lostH = (e) => { try { e.preventDefault(); } catch (x) {} lose(); };
  canvas.addEventListener("webglcontextlost", lostH);
  function lose() { if (destroyed) return; if (onLost) onLost(); destroy(); }

  function destroy() {
    if (destroyed) return; destroyed = true;
    if (raf) cancelAnimationFrame(raf); raf = 0; pending = []; hold = null; if (pumpRaf) cancelAnimationFrame(pumpRaf); pumpRaf = 0; work.length = 0; baker.destroy();
    document.removeEventListener("visibilitychange", onVis); canvas.removeEventListener("webglcontextlost", lostH);
    if (gl) try { for (const b of B) { if (b.lbl) gl.deleteTexture(b.lbl); if (b.cr) gl.deleteTexture(b.cr); b.lbl = b.cr = null; } for (const k in shared) gl.deleteTexture(shared[k]); if (blank) gl.deleteTexture(blank); for (const x of bufs) gl.deleteBuffer(x); gl.deleteProgram(prog); gl.deleteProgram(rprog); for (const s of shaders) gl.deleteShader(s); } catch (e) {}
    textures = 0; bytes.clear();
    try { const x = gl && gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); } catch (e) {}
  }

  for (const b of B) b.sel = b.el.getAttribute("aria-selected") === "true";
  const idle = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 2500 }) : setTimeout(f, 50));
  const poll = () => { if (destroyed) return; if (checkLink()) { if (onReady) onReady(); } else if (!linked) setTimeout(() => idle(poll), 16); };
  function calm(f) { let n = 0, l = 0, k = 0; const tick = (t) => { if (destroyed) return; n = l && t - l < 24 ? n + 1 : 0; l = t; if (n >= 8 || ++k > 240) idle(f); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
  calm(init);

  return {
    layout, pointer, leave, focus, blur, scene, kick, destroy,
    status: (q) => {
      if (q && ("ink" in q || "solo" in q)) { if ("ink" in q) dbg.ink = q.ink ? 1 : 0; if ("solo" in q) dbg.solo = q.solo || null; draw(); }
      let tb = 0; for (const v of bytes.values()) tb += v;
      return { on: !destroyed, gl: destroyed ? null : "webgl2", linked, textures, textureBytes: tb, drawCalls: calls, dprEff: +dprEff.toFixed(3), dpr: dprAsk, canvas: [canvas.width, canvas.height, W, CH], running: !!raf, frame: frameApi(), kicks, uploads: ups, uploadMs: +uploadMs.toFixed(1), uploadMaxMs: +uploadMax.toFixed(2), bakeMs: +bakeMs.toFixed(1), bakeMode: baker.mode(), baked, born, ready, geometry: { ...G }, banners: B.map((b) => { const p = plan(b); return { key: b.key, amp: +b.ax.toFixed(2), len: +b.len.toFixed(1), target: +b.lt.toFixed(1), sel: b.sel, go: b.go, mode: b.mode, w: b.w, crestCss: +p.c.toFixed(1), crestTex: b.cr ? b.crT : 0, lines: b.li ? b.li.lines : 0, cap: b.li ? b.li.cap : 0, font: b.li ? b.li.font : null, labelTex: b.li ? [b.li.w, b.li.h] : null }; }) };
    },
  };
}
