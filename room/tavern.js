// The modelled tavern (V10): the room's scenery and renderer on the vendored three.js 0.170.0. It replaces the hand-written
// WebGL2 backend (gl2.js) and its painted back wall. Everything is built here from primitives (boxes, cylinders, lathes,
// tori) and canvas textures drawn in code: wood planks, field stone, lime plaster. No model or image downloads.
//   const T = await createTavern(canvas, { shadows, power, yieldTask, timed })   shadows: 1 (512 maps) or 2 (1024)
//   T.renderer T.scene T.camera     three objects; room.js owns the loop and the camera motion
//   T.layout(W, H, rect)            places the hearth and the shelves in the side gutters beside the board's rectangle
//   T.setLights(k, s, flicker, n)   light levels (k: { hearth, candles, lantern, key }) and the flicker at time s (n: shared signal)
//   T.setKey(nx, ny)                moves the key light with the pointer or the tilt (-1 to 1)
//   T.setAir(n, s)                  dust and embers (n 0 removes), animated on the GPU at time s
//   T.memory()  T.dispose()
import * as THREE from "../vendor/three.module.min.js?v=08fd7545d1";

/* ---------- canvas textures, drawn in code ---------- */
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const cv = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return [c, c.getContext("2d")]; };
const rgb = (c, k = 1, a = 1) => `rgba(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)},${a})`;

function woodCanvas(seed, base, planks = 4, S = 512) {
  const r = rnd(seed), [c, g] = cv(S, S), pw = S / planks;
  for (let i = 0; i < planks; i++) {
    const x0 = i * pw, k = 0.78 + r() * 0.4;
    g.fillStyle = rgb(base, k); g.fillRect(x0, 0, pw, S);
    const sh = g.createLinearGradient(x0, 0, x0 + pw, 0); /* a plank is a little rounded: darker at both edges */
    sh.addColorStop(0, "rgba(0,0,0,0.35)"); sh.addColorStop(0.12, "rgba(0,0,0,0)"); sh.addColorStop(0.88, "rgba(0,0,0,0)"); sh.addColorStop(1, "rgba(0,0,0,0.4)");
    g.fillStyle = sh; g.fillRect(x0, 0, pw, S);
    for (let n = 0; n < 46; n++) { /* grain: long wavy lines down the plank */
      const x = x0 + r() * pw, amp = 1 + r() * 4, f = 0.004 + r() * 0.01, ph = r() * 6;
      g.strokeStyle = r() < 0.7 ? `rgba(20,10,4,${0.08 + r() * 0.18})` : `rgba(255,220,170,${0.03 + r() * 0.05})`;
      g.lineWidth = 0.6 + r() * 1.8; g.beginPath();
      for (let y = 0; y <= S; y += 16) g.lineTo(Math.min(x0 + pw - 2, Math.max(x0 + 2, x + Math.sin(y * f + ph) * amp)), y);
      g.stroke();
    }
    for (let n = r() < 0.6 ? 1 : 0; n > 0; n--) { /* a knot */
      const kx = x0 + pw * (0.3 + r() * 0.4), ky = r() * S, rg = g.createRadialGradient(kx, ky, 0, kx, ky, pw * 0.22);
      rg.addColorStop(0, "rgba(15,7,2,0.85)"); rg.addColorStop(0.45, "rgba(30,15,6,0.4)"); rg.addColorStop(1, "rgba(30,15,6,0)");
      g.fillStyle = rg; g.beginPath(); g.ellipse(kx, ky, pw * 0.22, pw * 0.4, 0, 0, 7); g.fill();
    }
    g.fillStyle = "rgba(8,4,2,0.9)"; g.fillRect(x0, 0, 2, S); /* the seam */
    for (let y = r() * 200; y < S; y += 180 + r() * 260) { g.fillStyle = "rgba(10,5,2,0.7)"; g.fillRect(x0, y, pw, 2); } /* butt joints */
  }
  for (let n = 0; n < 1400; n++) { g.fillStyle = `rgba(${r() < 0.5 ? "0,0,0" : "255,230,190"},${r() * 0.06})`; g.fillRect(r() * S, r() * S, 1 + r() * 2, 2 + r() * 6); }
  return c;
}
function stoneCanvas(seed, S = 512) {
  const r = rnd(seed), [c, g] = cv(S, S);
  g.fillStyle = "#2a221c"; g.fillRect(0, 0, S, S); /* lime mortar, gritty */
  for (let n = 0; n < 2500; n++) { g.fillStyle = `rgba(${r() < 0.5 ? "0,0,0" : "200,180,150"},${r() * 0.18})`; g.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 3); }
  /* courses of rough-dressed stone: uneven heights that sum to the tile, joints staggered, every stone an irregular polygon,
     drawn again one tile over where it crosses an edge, so the texture repeats with no seam */
  const rows = 5, hs = Array.from({ length: rows }, () => 0.7 + r() * 0.6), sum = hs.reduce((a, b) => a + b, 0);
  let y = 0;
  for (const hr of hs) {
    const h = (hr / sum) * S;
    for (let x = r() * 40; x < S + 40;) {
      const w = Math.min(70 + r() * 110, S + 40 - x), k = 0.7 + r() * 0.45, warm = r() * 18;
      const tone = [118 * k + warm, 106 * k + warm * 0.5, 94 * k], gap = 3 + r() * 3, j = () => (r() - 0.5) * 9;
      const pts = [[x + gap + j(), y + gap + j()], [x + w * 0.5 + j(), y + gap * 0.6 + j()], [x + w - gap + j(), y + gap + j()], [x + w - gap * 0.6 + j(), y + h * 0.5 + j()],
        [x + w - gap + j(), y + h - gap + j()], [x + w * 0.5 + j(), y + h - gap * 0.6 + j()], [x + gap + j(), y + h - gap + j()], [x + gap * 0.6 + j(), y + h * 0.5 + j()]];
      for (const ox of [0, -S]) {
        if (ox && x + w < S) continue;
        const path = () => { g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px + ox, py) : g.moveTo(px + ox, py))); g.closePath(); };
        const gr = g.createLinearGradient(x + ox, y, x + ox + w * 0.4, y + h);
        gr.addColorStop(0, rgb(tone, 1.12)); gr.addColorStop(1, rgb(tone, 0.8));
        path(); g.fillStyle = gr; g.fill();
        g.save(); path(); g.clip();
        for (let n = 0; n < 26; n++) { g.fillStyle = `rgba(${r() < 0.55 ? "20,14,10" : "235,220,200"},${r() * 0.1})`; g.beginPath(); g.ellipse(x + ox + r() * w, y + r() * h, 3 + r() * 16, 2 + r() * 9, r() * 3, 0, 7); g.fill(); }
        g.lineWidth = 5; g.strokeStyle = "rgba(14,10,7,0.3)"; path(); g.stroke(); /* the edge falls away into the joint */
        g.restore();
      }
      x += w;
    }
    y += h;
  }
  return c;
}
function plasterCanvas(seed, S = 512) {
  const r = rnd(seed), [c, g] = cv(S, S);
  g.fillStyle = "#8a7660"; g.fillRect(0, 0, S, S);
  for (let n = 0; n < 70; n++) { /* soft mottling, wrapped so the tile repeats without a seam */
    const x = r() * S, y = r() * S, rad = 30 + r() * 110, dark = r() < 0.6;
    for (const [ox, oy] of [[0, 0], [-S, 0], [S, 0], [0, -S], [0, S]]) {
      const rg = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      rg.addColorStop(0, dark ? `rgba(40,26,14,${0.08 + r() * 0.12})` : `rgba(255,236,200,${0.05 + r() * 0.06})`); rg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = rg; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    }
  }
  g.strokeStyle = "rgba(30,20,12,0.35)"; g.lineWidth = 1;
  for (let n = 0; n < 7; n++) { let x = r() * S, y = r() * S; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 9; k++) { x += (r() - 0.5) * 30; y += r() * 18; g.lineTo(x, y); } g.stroke(); }
  for (let n = 0; n < 3000; n++) { g.fillStyle = `rgba(${r() < 0.5 ? "0,0,0" : "255,240,220"},${r() * 0.07})`; g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2); }
  return c;
}
function glowCanvas(S = 128) {
  const [c, g] = cv(S, S), rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.18, "rgba(255,255,255,0.55)"); rg.addColorStop(0.5, "rgba(255,255,255,0.12)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.fillRect(0, 0, S, S); return c;
}

/* box UVs in world units, the texture's grain (its v axis) along the box's longest side, so wood reads the same everywhere */
function boxGeo(w, h, d, unit = 1) {
  const geo = new THREE.BoxGeometry(w, h, d), p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv, ext = [w, h, d];
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)) > 0.5 ? 0 : Math.abs(n.getY(i)) > 0.5 ? 1 : 2, pl = [0, 1, 2].filter((a) => a !== ax);
    const [a, b] = ext[pl[0]] >= ext[pl[1]] ? [pl[1], pl[0]] : [pl[0], pl[1]];
    uv.setXY(i, (p.getComponent(i, a) + 7.3 * ax) / unit, (p.getComponent(i, b) + 3.1 * ax) / unit);
  }
  return geo;
}

const FLAME_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const NOISE = `float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }`;
/* a candle flame: a teardrop that sways, white-gold core, orange skirt, a blue root */
const CANDLE_FS = `uniform float uTime, uSeed, uGain; varying vec2 vUv; ${NOISE}
void main() {
  float y = vUv.y, t = uTime + uSeed * 10.0;
  float x = (vUv.x - 0.5) * 2.0 + (n2(vec2(y * 3.0 - t * 2.3, uSeed)) - 0.5) * 0.5 * y;
  float w = 0.62 * sin(3.14159 * pow(clamp(y, 0.0, 1.0), 0.7)) * (1.0 - 0.15 * n2(vec2(t * 4.0, uSeed)));
  float d = abs(x) / max(w, 0.001);
  float body = smoothstep(1.0, 0.35, d) * smoothstep(0.98, 0.55, y), core = smoothstep(0.55, 0.0, d) * smoothstep(0.7, 0.2, y);
  vec3 col = vec3(1.0, 0.42, 0.08) * body + vec3(1.0, 0.86, 0.6) * core + vec3(0.1, 0.18, 0.6) * smoothstep(0.25, 0.0, y) * smoothstep(1.0, 0.3, d) * 0.6;
  gl_FragColor = vec4(col * uGain, 1.0);
}`;
/* the hearth fire: turbulent tongues across a wide plane */
const FIRE_FS = `uniform float uTime, uSeed, uGain; varying vec2 vUv; ${NOISE}
void main() {
  float y = vUv.y, t = uTime * 1.4 + uSeed * 7.0;
  float f = n2(vec2(vUv.x * 5.0 + uSeed, y * 2.6 - t * 1.9)) * 0.6 + n2(vec2(vUv.x * 11.0, y * 6.0 - t * 3.3)) * 0.4;
  float shape = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x) * (1.0 - y);
  float flame = smoothstep(0.32, 0.8, f * shape * 1.9);
  vec3 col = mix(vec3(0.9, 0.18, 0.02), vec3(1.0, 0.78, 0.38), flame) * flame + vec3(0.35, 0.07, 0.0) * shape * shape;
  gl_FragColor = vec4(col * uGain, 1.0);
}`;
/* dust in the light and embers off the fire: points that drift on the GPU; dust shows only near a light */
const AIR_VS = `attribute vec3 aSeed; uniform float uTime, uSize, uRise, uPR; uniform vec3 uMin, uMax, uL0, uL1, uL2; uniform float uLit;
varying float vA;
void main() {
  vec3 span = uMax - uMin, p = uMin + aSeed * span;
  p.y = uMin.y + mod(aSeed.y * span.y + uTime * uRise * (0.4 + aSeed.x * 0.6), span.y);
  p.x += sin(uTime * 0.31 + aSeed.z * 23.0) * 0.12; p.z += cos(uTime * 0.27 + aSeed.x * 19.0) * 0.12;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv; gl_PointSize = uSize * uPR / max(0.5, -mv.z);
  float life = (p.y - uMin.y) / span.y, near = 1.0;
  if (uLit > 0.5) { vec3 a = p - uL0, b = p - uL1, c = p - uL2; near = min(1.0, 1.4 / (1.0 + dot(a, a) * 1.2) + 1.0 / (1.0 + dot(b, b) * 1.6) + 1.0 / (1.0 + dot(c, c) * 1.6)); }
  vA = smoothstep(0.0, 0.12, life) * smoothstep(1.0, 0.55, life) * (0.35 + 0.65 * fract(aSeed.z * 31.0)) * near;
}`;
const AIR_FS = `uniform vec3 uColor; varying float vA;
void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d); gl_FragColor = vec4(uColor * a * a * vA, 1.0); }`;

export async function createTavern(canvas, opt) {
  const yieldTask = opt.yieldTask, timed = opt.timed;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: opt.power || "high-performance", stencil: false });
  if (!renderer.getContext()) throw new Error("WebGL did not start");
  /* V13e: a context lost while the room starts (WebKit at 2120x909 lost it during the shader compile) must end as a failed start,
     never an uncaught error: three's shader log check reads a null log on a lost context, so it is off, and the loss is caught */
  renderer.debug.checkShaderErrors = false;
  let lostEarly = false; const onEarlyLoss = (e) => { e.preventDefault(); lostEarly = true; };
  canvas.addEventListener("webglcontextlost", onEarlyLoss);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = !!opt.shadows; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
  const gl = renderer.getContext(), dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const info = { renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)), vendor: String(gl.getParameter(gl.VENDOR)), three: THREE.REVISION };
  /* 2026-10-29 wide gamut: a Display P3 drawing buffer only where all of it is there: a P3 display, a context that accepts the
     colour space, this three.js build knowing "display-p3" as an output space (the vendored 0.170.0 min build does not export
     DisplayP3ColorSpace, so today this stays sRGB and says why), and no ?hdr=0 or html.hdr-off. HDR (extended range) is not
     attempted: Chromium's WebGL takes only srgb and display-p3 (probe: board/tools/oracle/hdr-probe.mjs). Tiers are untouched. */
  info.colorSpace = "srgb"; info.wideWhy = "not a P3 display";
  try {
    const off = /[?&]hdr=0(?:&|#|$)/.test(location.search || "") || document.documentElement.classList.contains("hdr-off");
    if (off) info.wideWhy = "hdr=0";
    else if (matchMedia("(color-gamut: p3)").matches) {
      if (!("drawingBufferColorSpace" in gl)) info.wideWhy = "no drawingBufferColorSpace";
      else if (!THREE.DisplayP3ColorSpace) info.wideWhy = "this three.js build has no DisplayP3ColorSpace";
      else { gl.drawingBufferColorSpace = "display-p3"; if (gl.drawingBufferColorSpace === "display-p3") { renderer.outputColorSpace = THREE.DisplayP3ColorSpace; info.colorSpace = "display-p3"; info.wideWhy = ""; } else info.wideWhy = "context refused display-p3"; }
    }
  } catch (e) { info.colorSpace = "srgb"; info.wideWhy = "error: " + (e && e.message); }
  info.software = /swiftshader|llvmpipe|software|basic render|warp/i.test(info.renderer);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(52, 1, 0.05, 40);
  scene.background = new THREE.Color(0x000000); scene.fog = new THREE.FogExp2(0x030201, 0.075); /* V14: true black at the far edge (OLED), no lifted brown */
  const room = new THREE.Group(); scene.add(room);
  const owned = { tex: [], geo: new Set(), mat: new Set() }; let texBytes = 0;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = async (c, rep, srgb = true) => {
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (rep) t.repeat.set(rep, rep);
    timed(() => renderer.initTexture(t)); texBytes += c.width * c.height * 4 * 1.33; owned.tex.push(t); await yieldTask(); return t;
  };
  /* textures: each drawn and uploaded in its own task */
  const woodC = timed(() => woodCanvas(11, [96, 64, 40])); const tWood = await tex(woodC);
  const darkC = timed(() => woodCanvas(29, [62, 42, 28], 5)); const tDark = await tex(darkC);
  const stoneC = timed(() => stoneCanvas(7)); const tStone = await tex(stoneC);
  const plasterC = timed(() => plasterCanvas(3)); const tPlaster = await tex(plasterC);
  const tGlow = await tex(glowCanvas());
  const M = (o) => { const m = new THREE.MeshStandardMaterial(o); owned.mat.add(m); return m; };
  const mat = {
    wood: M({ map: tWood, bumpMap: tWood, bumpScale: 1.2, roughness: 0.78, color: 0xb9a48c }),
    beam: M({ map: tDark, bumpMap: tDark, bumpScale: 1.6, roughness: 0.85, color: 0x8a7462 }),
    floor: M({ map: tDark, bumpMap: tDark, bumpScale: 1.0, roughness: 0.7, color: 0x9a846e }),
    stone: M({ map: tStone, bumpMap: tStone, bumpScale: 3, roughness: 0.92, color: 0xb0a090 }),
    soot: M({ color: 0x0c0806, roughness: 1 }),
    plaster: M({ map: tPlaster, bumpMap: tPlaster, bumpScale: 0.8, roughness: 0.95, color: 0x8f7c66 }),
    iron: M({ color: 0x2a2622, roughness: 0.48, metalness: 0.85 }),
    brass: M({ color: 0xb08a4a, roughness: 0.32, metalness: 1 }),
    pewter: M({ color: 0x9a968e, roughness: 0.3, metalness: 0.9 }),
    wax: M({ color: 0xe8dcc0, roughness: 0.55, emissive: 0xa86a3a, emissiveIntensity: 0.9 }), /* wax glows near its flame */
    glassG: M({ color: 0x2f5a2a, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.82 }),
    glassB: M({ color: 0x5a3214, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.85 }),
    glassC: M({ color: 0xc8c0a8, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.55 }),
    cork: M({ color: 0x6a4a2a, roughness: 0.9 }),
    log: M({ map: tDark, color: 0x4a3426, roughness: 0.9, emissive: 0x4a1404, emissiveIntensity: 0.5 }),
    pane: M({ color: 0xffc070, roughness: 0.2, transparent: true, opacity: 0.35, emissive: 0xffa040, emissiveIntensity: 0.9 }),
  };
  const add = (geo, m, x, y, z, o = {}) => {
    const mesh = new THREE.Mesh(geo, m); owned.geo.add(geo); mesh.position.set(x, y, z);
    if (o.ry) mesh.rotation.y = o.ry; if (o.rx) mesh.rotation.x = o.rx; if (o.rz) mesh.rotation.z = o.rz;
    mesh.castShadow = o.cast !== false; mesh.receiveShadow = true; (o.parent || room).add(mesh); return mesh;
  };
  const WX = 4.2, CEIL = 3.1, BACK = -8.5, FRONT = 1;

  /* ---------- the shell: floor, ceiling planks, walls of plaster between oak framing over a plank wainscot ---------- */
  const shell = () => {
    add(boxGeo(WX * 2, 0.1, FRONT - BACK, 1.6), mat.floor, 0, -0.05, (FRONT + BACK) / 2, { cast: false });
    add(boxGeo(WX * 2, 0.08, FRONT - BACK, 1.2), mat.beam, 0, CEIL + 0.04, (FRONT + BACK) / 2, { cast: false });
    add(boxGeo(WX * 2, CEIL, 0.1, 2.2), mat.plaster, 0, CEIL / 2, BACK - 0.05, { cast: false });
    for (const s of [-1, 1]) {
      const x = s * (WX + 0.05);
      add(boxGeo(0.1, CEIL - 0.9, FRONT - BACK, 2.2), mat.plaster, x, 0.9 + (CEIL - 0.9) / 2, (FRONT + BACK) / 2, { cast: false });
      add(boxGeo(0.06, 0.9, FRONT - BACK, 1.4), mat.wood, x - s * 0.05, 0.45, (FRONT + BACK) / 2, { cast: false }); /* wainscot */
      add(boxGeo(0.1, 0.1, FRONT - BACK, 1), mat.beam, x - s * 0.08, 0.93, (FRONT + BACK) / 2); /* chair rail */
      add(boxGeo(0.16, 0.2, FRONT - BACK, 1), mat.beam, x - s * 0.1, CEIL - 0.1, (FRONT + BACK) / 2); /* wall plate */
      add(boxGeo(0.14, 0.18, FRONT - BACK, 1), mat.beam, x - s * 0.09, 2.15, (FRONT + BACK) / 2); /* mid rail */
      for (let z = 0.2; z > BACK; z -= 1.9) add(boxGeo(0.16, CEIL, 0.22, 1), mat.beam, x - s * 0.1, CEIL / 2, z); /* posts */
      for (let z = -0.75; z > BACK + 1; z -= 1.9) { /* braces from the posts up to the wall plate */
        const b = add(boxGeo(0.1, 1.2, 0.14, 1), mat.beam, x - s * 0.1, 2.6, z - 0.45); b.rotation.x = 0.85;
      }
    }
    for (let z = -0.6; z > BACK; z -= 1.45) add(boxGeo(WX * 2, 0.3, 0.26, 1.2), mat.beam, 0, CEIL - 0.15, z); /* ceiling beams */
    for (const x of [-1.6, 1.6]) add(boxGeo(0.12, 0.1, FRONT - BACK, 1), mat.beam, x, CEIL - 0.34, (FRONT + BACK) / 2, { cast: false }); /* purlins under the beams */
  };
  shell(); await yieldTask();

  /* ---------- props ---------- */
  const lathe = (pts, seg = 18) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  const BOTTLES = [
    lathe([[0, 0], [0.07, 0], [0.074, 0.02], [0.074, 0.2], [0.062, 0.245], [0.024, 0.28], [0.021, 0.34], [0.027, 0.35], [0, 0.352]]),
    lathe([[0, 0], [0.085, 0], [0.09, 0.03], [0.088, 0.13], [0.05, 0.19], [0.022, 0.21], [0.02, 0.27], [0.026, 0.28], [0, 0.282]]),
    lathe([[0, 0], [0.05, 0], [0.055, 0.02], [0.055, 0.24], [0.02, 0.3], [0.017, 0.38], [0.022, 0.39], [0, 0.392]]),
  ];
  const corkGeo = new THREE.CylinderGeometry(0.018, 0.016, 0.03, 8);
  const bottle = (p, x, y, z, kind, m) => { const g = BOTTLES[kind % 3]; add(g, m, x, y, z, { parent: p }); const top = g.parameters.points.at(-1).y; add(corkGeo, mat.cork, x, y + top + 0.005, z, { parent: p, cast: false }); };
  const mugBody = new THREE.CylinderGeometry(0.06, 0.068, 0.15, 18), band = new THREE.TorusGeometry(0.066, 0.006, 6, 24), handle = new THREE.TorusGeometry(0.045, 0.011, 6, 12, Math.PI);
  const mug = (p, x, y, z, ry, m = mat.wood) => {
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = ry; p.add(g);
    add(mugBody, m, 0, 0.075, 0, { parent: g });
    for (const by of [0.03, 0.12]) add(band, mat.iron, 0, by, 0, { parent: g, rx: Math.PI / 2, cast: false });
    add(handle, m === mat.wood ? mat.iron : m, 0.066, 0.075, 0, { parent: g, rz: -Math.PI / 2 });
  };
  const flames = [], glows = [];
  const flameGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const flame = (p, x, y, z, w, h, fs = CANDLE_FS, gain = 1.6) => {
    const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uSeed: { value: Math.random() * 10 }, uGain: { value: gain } }, vertexShader: FLAME_VS, fragmentShader: fs, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    owned.mat.add(m); const f = new THREE.Mesh(flameGeo, m); f.position.set(x, y, z); f.scale.set(w, h, 1); p.add(f); flames.push(f); return f;
  };
  const glow = (p, x, y, z, size, color, opacity) => {
    const m = new THREE.SpriteMaterial({ map: tGlow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity, fog: false });
    owned.mat.add(m); const s = new THREE.Sprite(m); s.position.set(x, y, z); s.scale.set(size, size, 1); p.add(s); glows.push({ s, base: opacity }); return s;
  };
  const candleGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.16, 12);
  const candle = (p, x, y, z, h = 0.16) => {
    add(candleGeo, mat.wax, x, y + h / 2, z, { parent: p }).scale.y = h / 0.16;
    flame(p, x, y + h + 0.004, z, 0.05, 0.11); glow(p, x, y + h + 0.05, z, 0.6, 0xffb060, 0.6);
  };

  /* the hearth on the left wall: a stone chimney breast, an oak mantel, a fire on logs; placed in the left gutter by layout() */
  const hearth = new THREE.Group(); room.add(hearth);
  {
    const hx = -WX + 0.36, D = 0.72;
    add(boxGeo(D, 0.95, 0.42, 1.5), mat.stone, hx, 0.475, 0.62, { parent: hearth }); /* jambs */
    add(boxGeo(D, 0.95, 0.42, 1.5), mat.stone, hx, 0.475, -0.62, { parent: hearth });
    add(boxGeo(D + 0.04, 0.34, 1.68, 1.5), mat.stone, hx + 0.02, 1.12, 0, { parent: hearth }); /* lintel */
    add(boxGeo(D + 0.16, 0.1, 1.9, 0.7), mat.wood, hx + 0.08, 1.34, 0, { parent: hearth }); /* mantel */
    add(boxGeo(D - 0.1, CEIL - 1.39, 1.4, 1.5), mat.stone, hx - 0.05, 1.39 + (CEIL - 1.39) / 2, 0, { parent: hearth }); /* chimney */
    add(boxGeo(0.1, 0.95, 0.84, 1), mat.soot, -WX + 0.05, 0.475, 0, { parent: hearth, cast: false }); /* the firebox back */
    add(boxGeo(D + 0.3, 0.06, 1.9, 1.5), mat.stone, hx + 0.12, 0.03, 0, { parent: hearth, cast: false }); /* hearth stone */
    const logG = new THREE.CylinderGeometry(0.06, 0.07, 0.62, 10);
    add(logG, mat.log, hx - 0.02, 0.1, 0.02, { parent: hearth, rx: Math.PI / 2, ry: 0.2 });
    add(logG, mat.log, hx + 0.08, 0.12, -0.05, { parent: hearth, rx: Math.PI / 2, ry: -0.35 });
    add(logG, mat.log, hx + 0.02, 0.22, 0, { parent: hearth, rx: Math.PI / 2, ry: 0.05 });
    for (const [z, w, h, s] of [[-0.12, 0.42, 0.62, 0], [0.12, 0.38, 0.55, 3], [0, 0.55, 0.72, 6]]) {
      const f = flame(hearth, hx + 0.05, 0.12, z, w, h, FIRE_FS, 1.3); f.material.uniforms.uSeed.value = s;
    }
    glow(hearth, hx + 0.2, 0.42, 0, 1.6, 0xff7a2a, 0.3); /* soft: at full strength it glared beside the first tile (critic panel 2) */
    mug(hearth, hx + 0.12, 1.39, 0.62, 0.4); mug(hearth, hx + 0.16, 1.39, 0.45, -0.3, mat.pewter);
    bottle(hearth, hx + 0.1, 1.39, -0.58, 0, mat.glassG); candle(hearth, hx + 0.16, 1.39, -0.32, 0.2);
  }
  /* the shelves on the right wall: three oak boards of bottles and tankards, a barrel, a lantern on a bracket */
  const shelf = new THREE.Group(), lanternG = new THREE.Group(); room.add(shelf);
  {
    const sx = WX - 0.2;
    add(boxGeo(0.04, 1.5, 1.6, 1.2), mat.wood, WX - 0.02, 1.55, 0, { parent: shelf, cast: false });
    const ys = [0.95, 1.45, 1.95];
    ys.forEach((y, i) => {
      add(boxGeo(0.34, 0.05, 1.7, 1), mat.beam, sx, y, 0, { parent: shelf });
      for (const z of [-0.78, 0.78]) add(boxGeo(0.06, 0.14, 0.05, 1), mat.iron, WX - 0.06, y - 0.08, z, { parent: shelf, cast: false });
      const r = rnd(5 + i * 13);
      for (let z = -0.68; z < 0.7;) {
        const k = Math.floor(r() * 6);
        if (k < 3) { bottle(shelf, sx + (r() - 0.5) * 0.08, y + 0.025, z, k, [mat.glassG, mat.glassB, mat.glassC][Math.floor(r() * 3)]); z += 0.14 + r() * 0.06; }
        else if (k < 5) { mug(shelf, sx, y + 0.025, z + 0.03, Math.PI + (r() - 0.5), k === 3 ? mat.wood : mat.pewter); z += 0.2; }
        else z += 0.12;
      }
    });
    const barrel = lathe([[0, 0], [0.22, 0], [0.25, 0.1], [0.27, 0.28], [0.25, 0.46], [0.22, 0.56], [0, 0.56]], 22);
    add(barrel, mat.wood, sx - 0.15, 0, 0.45, { parent: shelf });
    for (const [by, br] of [[0.08, 0.243], [0.47, 0.243], [0.28, 0.272]]) add(new THREE.TorusGeometry(br, 0.008, 6, 28), mat.iron, sx - 0.15, by, 0.45, { parent: shelf, rx: Math.PI / 2, cast: false });
    /* the lantern by the door */
    const L = lanternG; L.position.set(WX - 0.3, 2.42, 0.25); shelf.add(L);
    add(new THREE.BoxGeometry(0.3, 0.02, 0.02), mat.iron, 0.12, 0.2, 0, { parent: L, cast: false }); /* bracket */
    add(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 4), mat.iron, 0, 0.13, 0, { parent: L, cast: false });
    add(new THREE.CylinderGeometry(0.02, 0.09, 0.08, 4, 1).rotateY(Math.PI / 4), mat.iron, 0, 0.05, 0, { parent: L });
    add(new THREE.BoxGeometry(0.12, 0.18, 0.12), mat.pane, 0, -0.08, 0, { parent: L, cast: false });
    for (const [x, z] of [[-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06], [0.06, 0.06]]) add(new THREE.BoxGeometry(0.012, 0.2, 0.012), mat.iron, x, -0.08, z, { parent: L, cast: false });
    add(new THREE.BoxGeometry(0.14, 0.02, 0.14), mat.iron, 0, -0.18, 0, { parent: L, cast: false });
    flame(L, 0, -0.15, 0, 0.04, 0.09); glow(L, 0, -0.08, 0, 0.9, 0xffb868, 0.6);
  }
  /* the iron chandelier: a ring of six candles, hung behind the board (layout), where it is never
     seen; its light washes the beams and the dust */
  const chand = new THREE.Group(); room.add(chand);
  {
    add(new THREE.TorusGeometry(0.24, 0.013, 8, 40), mat.iron, 0, 0, 0, { parent: chand, rx: Math.PI / 2 });
    add(new THREE.TorusGeometry(0.11, 0.009, 6, 28), mat.iron, 0, 0.04, 0, { parent: chand, rx: Math.PI / 2, cast: false });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3, x = Math.cos(a) * 0.24, z = Math.sin(a) * 0.24;
      add(new THREE.CylinderGeometry(0.026, 0.015, 0.025, 10), mat.brass, x, 0.015, z, { parent: chand, cast: false });
      candle(chand, x, 0.03, z, 0.06 + (i % 3) * 0.015);
    }
  }
  await yieldTask();

  /* ---------- lights ---------- */
  const fireL = new THREE.PointLight(0xff8a3a, 16, 0, 2), chandL = new THREE.PointLight(0xffc070, 7, 0, 2), lantL = new THREE.PointLight(0xffd28a, 5, 0, 2), fillL = new THREE.PointLight(0xffd18c, 7, 0, 2);
  hearth.add(fireL); fireL.position.set(-WX + 0.9, 0.55, 0);
  chand.add(chandL); chandL.position.set(0, 0.12, 0);
  lanternG.add(lantL); lantL.position.set(0, -0.08, 0);
  fillL.position.set(0, 2.45, -2.3); room.add(fillL);
  const hemi = new THREE.HemisphereLight(0x5a6a8a, 0x3a1c0a, 0.9); room.add(hemi);
  const shadowLights = opt.shadows ? [fireL, chandL] : [];
  for (const l of shadowLights) { l.castShadow = true; l.shadow.mapSize.set(opt.shadows > 1 ? 1024 : 512, opt.shadows > 1 ? 1024 : 512); l.shadow.radius = 4; l.shadow.bias = -0.004; l.shadow.camera.near = 0.1; l.shadow.camera.far = 12; }
  const base = { fire: fireL.intensity, chand: chandL.intensity, lant: lantL.intensity, fill: fillL.intensity };

  /* ---------- air: dust in the light, embers over the fire ---------- */
  const air = [];
  const makePoints = (n, min, max, o) => {
    const g = new THREE.BufferGeometry(), seed = new Float32Array(n * 3);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uSize: { value: o.size }, uRise: { value: o.rise }, uPR: { value: 1 }, uMin: { value: new THREE.Vector3(...min) }, uMax: { value: new THREE.Vector3(...max) }, uColor: { value: new THREE.Color(o.color) }, uLit: { value: o.lit ? 1 : 0 }, uL0: { value: new THREE.Vector3() }, uL1: { value: new THREE.Vector3() }, uL2: { value: new THREE.Vector3() } }, vertexShader: AIR_VS, fragmentShader: AIR_FS, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const p = new THREE.Points(g, m); p.frustumCulled = false; scene.add(p); return p;
  };
  /* built once at the largest count and compiled with the rest; a tier change only moves the draw range, so it never compiles */
  const AIR_MAX = 600;
  air.push(makePoints(AIR_MAX, [-3.6, 0.3, -6.5], [3.6, 2.9, -1.2], { size: 9, rise: 0.025, color: 0xffd7a0, lit: true }));
  air.push(makePoints(AIR_MAX / 8, [-3.7, 0.3, -0.35], [-3.0, 2.4, 0.35], { size: 7, rise: 0.35, color: 0xff7a28 }));
  air[1].userData.follow = hearth;
  const setAir = (n) => {
    n = Math.min(AIR_MAX, n || 0);
    air[0].geometry.setDrawRange(0, n); air[1].geometry.setDrawRange(0, n ? Math.max(12, Math.round(n / 8)) : 0);
    for (const p of air) p.visible = n > 0;
  };

  const v = new THREE.Vector3();
  const tick = (s) => {
    for (const f of flames) { f.quaternion.copy(camera.quaternion); f.material.uniforms.uTime.value = s; }
    for (const p of air) {
      const u = p.material.uniforms; u.uTime.value = s; u.uPR.value = renderer.domElement.height / 900; /* point size follows the drawing buffer's height */
      if (p.userData.follow) p.position.copy(p.userData.follow.position);
      else { u.uL0.value.copy(fireL.getWorldPosition(v)); u.uL1.value.copy(chandL.getWorldPosition(v)); u.uL2.value.copy(lantL.getWorldPosition(v)); }
    }
  };
  const flick = (s, ph) => 0.5 * Math.sin(s * 7.1 + ph) + 0.3 * Math.sin(s * 13.7 + ph * 2.3) + 0.2 * Math.sin(s * 23.1 + ph * 0.7);
  /* V13b: n is the page's shared flicker signal (-1 to 1, the same one the wall light and the card highlights read); the
     hearth follows it, the candles and the lantern keep a little of their own flutter on top */
  const setLights = (k, s, flicker, n) => {
    const own = (ph) => (n == null ? flick(s, ph) : 0.7 * n + 0.3 * flick(s, ph));
    const fl = (ph, amt) => (flicker ? 1 + amt * own(ph) * flicker : 1);
    fireL.intensity = base.fire * k.hearth * fireK * fl(0.3, 0.22); chandL.intensity = base.chand * k.candles * fl(1.7, 0.08); lantL.intensity = base.lant * k.lantern * fl(5.3, 0.1);
    fillL.intensity = base.fill * (k.key == null ? 1 : k.key) * fl(2.9, 0.12);
    for (const g of glows) g.s.material.opacity = g.base * (g.s.parent === hearth ? k.hearth * fl(0.3, 0.15) : g.s.parent === chand ? k.candles : g.s.parent === lanternG ? k.lantern : k.candles);
  };
  /* V13b: the key light is the warm fill over the room's middle; the pointer (or the phone's tilt) moves it, nx and ny from
     -1 to 1, the same light position the card highlights on the page use. It casts no shadow, so moving it costs nothing. */
  const setKey = (nx, ny) => { fillL.position.set(nx * 2.4, 2.35 - ny * 0.75, -2.3 - Math.abs(nx) * 0.6); };

  /* no environment reflections: three's PMREM capture compiles its blur shaders in one task (1.1 s on ANGLE D3D11, measured),
     which the room's start must never cost; the glass and metal get their glints from the point lights instead */

  /* the side features sit in the gutters beside the board, wherever the board's edges fall on this screen; a tall screen
     shows almost no gutter, so there the camera turns to face the hearth wall and the beams run away from it */
  const pose = { pos: new THREE.Vector3(0, 1.6, 0), yaw: 0, pitch: 0 };
  let fireK = 1;
  const layout = (W, H, rect) => {
    fireK = W < H ? 0.55 : 0.8; /* a phone sees the fire only as a band of light between the cards: kept low */
    if (W < H) {
      hearth.position.z = -2.78; shelf.position.z = -4.6; chand.visible = false;
      pose.pos.set(-1.15, 1.32, -2.78); pose.yaw = Math.PI / 2; pose.pitch = (9 * Math.PI) / 180; /* the fire sits behind the cards: a phone gets the chimney and the beams, calm behind the heading */
      if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
      return;
    }
    pose.pos.set(0, 1.6, 0); pose.yaw = 0; pose.pitch = 0;
    const tanV = Math.tan((camera.fov * Math.PI) / 360), tanH = tanV * camera.aspect;
    const ndc = (px) => (px / W) * 2 - 1;
    const gl0 = rect ? (ndc(0) + ndc(Math.max(rect.left, 1))) / 2 : -0.92, gr0 = rect ? (ndc(W) + ndc(Math.min(rect.right, W - 1))) / 2 : 0.92;
    const place = (g, frontX, ndcX, zMin, zMax) => { const d = Math.abs(frontX) / (tanH * Math.max(0.3, Math.abs(ndcX))); g.position.z = -Math.min(zMax, Math.max(zMin, d)); };
    place(hearth, WX - 0.3, gl0 - 0.02, 2.2, 6.5); /* the near jamb hides the near half of the opening */ place(shelf, WX - 0.25, gr0, 2.4, 6.5); /* by the fire and the bottles, not the front faces */
    /* a gutter under 70 px would show only a clipped sliver of the prop: it moves beside the camera, out of the frame (its
       light stays in the scene, so the light count and the compiled shaders never change) */
    if (rect && rect.left < 70) hearth.position.z = -1.2;
    if (rect && W - rect.right < 70) shelf.position.z = -1.2;
    /* the chandelier hangs behind the board: its light warms the beams, its iron never crowds the heading (critic panel 1) */
    chand.visible = true; chand.position.set(0, 2.2, -5.6); /* no chains: a chain would cross the gap between the clock and the board */
    if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  };

  await yieldTask();
  setAir(AIR_MAX); tick(0); layout(innerWidth, innerHeight, null); /* everything visible while it compiles */
  /* shaders compile in parallel where the browser can (KHR_parallel_shader_compile), so no long task; without it (software
     GPUs, which auto never gives a 3D tier) they compile in one step, timed, and the ladder judges the frames after */
  try { if (gl.getExtension("KHR_parallel_shader_compile")) await renderer.compileAsync(scene, camera); else timed(() => renderer.compile(scene, camera)); }
  catch (er) { if (!(lostEarly || gl.isContextLost())) throw er; }
  canvas.removeEventListener("webglcontextlost", onEarlyLoss);
  if (lostEarly || gl.isContextLost()) { try { renderer.dispose(); } catch (er) {} throw new Error("WebGL context lost while the room started"); }
  setAir(0);
  if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  let lost = false;
  /* V14: ordered dithering on every lit material: dark fog and wall gradients band on 8-bit OLED panels without it */
  scene.traverse((o) => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) { if (m && m.isMeshStandardMaterial) m.dithering = true; } });
  return {
    renderer, scene, camera, info, layout, setLights, setKey, tick, pose,
    setAir: (n) => setAir(n),
    shadowsOn: () => renderer.shadowMap.enabled,
    memory: () => Math.round(texBytes + renderer.info.memory.geometries * 24e3),
    dispose() {
      if (lost) return; lost = true;
      for (const p of air) { scene.remove(p); p.geometry.dispose(); p.material.dispose(); } for (const t of owned.tex) t.dispose(); for (const g of owned.geo) g.dispose(); for (const m of owned.mat) m.dispose();
      for (const g of [mugBody, band, handle, flameGeo, candleGeo, corkGeo, ...BOTTLES]) g.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
}
