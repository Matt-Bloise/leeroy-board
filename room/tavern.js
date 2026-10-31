import * as THREE from "../vendor/three.module.min.js?v=08fd7545d1";

const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const cv = (w, h) => { const c = typeof document === "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas"); c.width = w; c.height = h; return [c, c.getContext("2d")]; };

function glowCanvas(S = 128) {
  const [c, g] = cv(S, S), rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.18, "rgba(255,255,255,0.55)"); rg.addColorStop(0.5, "rgba(255,255,255,0.12)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.fillRect(0, 0, S, S); return c;
}

let boxN = 0;
function boxGeo(w, h, d, unit = 1) {
  const geo = new THREE.BoxGeometry(w, h, d), p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv, ext = [w, h, d];
  const r = rnd(101 + 37 * boxN++), ou = r() * 4, ov = r() * 4, flip = Math.max(w, h, d) < 3 && r() < 0.5 ? -1 : 1;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)) > 0.5 ? 0 : Math.abs(n.getY(i)) > 0.5 ? 1 : 2, pl = [0, 1, 2].filter((a) => a !== ax);
    const [a, b] = ext[pl[0]] >= ext[pl[1]] ? [pl[1], pl[0]] : [pl[0], pl[1]];
    uv.setXY(i, flip * (p.getComponent(i, b) + 3.1 * ax) / unit + ou, flip * (p.getComponent(i, a) + 7.3 * ax) / unit + ov);
  }
  return geo;
}

const FLAME_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const NOISE = `float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }`;
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
const FIRE_FS = `uniform float uTime, uSeed, uGain; varying vec2 vUv; ${NOISE}
void main() {
  float y = vUv.y, t = uTime * 1.4 + uSeed * 7.0;
  float f = n2(vec2(vUv.x * 5.0 + uSeed, y * 2.6 - t * 1.9)) * 0.6 + n2(vec2(vUv.x * 11.0, y * 6.0 - t * 3.3)) * 0.4;
  float shape = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x) * (1.0 - y);
  float flame = smoothstep(0.32, 0.8, f * shape * 1.9);
  vec3 col = mix(vec3(0.9, 0.18, 0.02), vec3(1.0, 0.78, 0.38), flame) * flame + vec3(0.35, 0.07, 0.0) * shape * shape;
  gl_FragColor = vec4(col * uGain, 1.0);
}`;
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
  renderer.debug.checkShaderErrors = false;
  let lostEarly = false; const onEarlyLoss = (e) => { e.preventDefault(); lostEarly = true; };
  canvas.addEventListener("webglcontextlost", onEarlyLoss);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = !!opt.shadows; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
  const gl = renderer.getContext(), dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const info = { renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)), vendor: String(gl.getParameter(gl.VENDOR)), three: THREE.REVISION };
  info.colorSpace = "srgb"; info.wideWhy = "not a P3 display";
  try {
    const wide = opt.wide || { off: false, p3: false };
    if (wide.off) info.wideWhy = "hdr=0";
    else if (wide.p3) {
      if (!("drawingBufferColorSpace" in gl)) info.wideWhy = "no drawingBufferColorSpace";
      else if (!THREE.DisplayP3ColorSpace) info.wideWhy = "this three.js build has no DisplayP3ColorSpace";
      else { gl.drawingBufferColorSpace = "display-p3"; if (gl.drawingBufferColorSpace === "display-p3") { renderer.outputColorSpace = THREE.DisplayP3ColorSpace; info.colorSpace = "display-p3"; info.wideWhy = ""; } else info.wideWhy = "context refused display-p3"; }
    }
  } catch (e) { info.colorSpace = "srgb"; info.wideWhy = "error: " + (e && e.message); }
  info.software = /swiftshader|llvmpipe|software|basic render|warp/i.test(info.renderer);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(52, 1, 0.05, 40);
  scene.background = new THREE.Color(0x000000); scene.fog = new THREE.FogExp2(0x000000, 0.075);
  const room = new THREE.Group(); scene.add(room);
  const owned = { tex: [], geo: new Set(), mat: new Set() }; let texBytes = 0;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = async (c, rep, srgb = true) => {
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (rep) t.repeat.set(rep, rep);
    timed(() => renderer.initTexture(t)); texBytes += c.width * c.height * 4 * 1.33; owned.tex.push(t); await yieldTask(); return t;
  };
  let warned = false; const loaded = [];
  const fetchBitmap = async (name) => {
    try {
      const res = await fetch(new URL("../img/room/" + name + ".webp", import.meta.url));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await createImageBitmap(await res.blob(), { imageOrientation: "flipY" });
    } catch (e) { if (!warned) { warned = true; console.warn("room textures: " + name + " not loaded (" + ((e && e.message) || e) + "), flat colours instead"); } return null; }
  };
  const upload = async (name, bmp) => {
    if (!bmp) return null;
    const t = new THREE.Texture(bmp); t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true;
    timed(() => renderer.initTexture(t)); texBytes += 1024 * 1024 * 4 * 1.33; owned.tex.push(t); loaded.push(name); await yieldTask(); return t;
  };
  const NAMES = ["oak-planks", "oak-floor", "stone", "plaster"], bitmaps = await Promise.all(NAMES.map(fetchBitmap));
  const [tWood, tDark, tStone, tPlaster] = [await upload(NAMES[0], bitmaps[0]), await upload(NAMES[1], bitmaps[1]), await upload(NAMES[2], bitmaps[2]), await upload(NAMES[3], bitmaps[3])];
  const tGlow = await tex(glowCanvas());
  const blendU = { value: opt.tier === "medium" || opt.tier === "low" ? 0 : 1 };
  const blendFix = (m, k) => {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uBlend = blendU; sh.uniforms.uConst = { value: k };
      sh.fragmentShader = "uniform float uBlend, uConst;\n" + NOISE + "\n" + sh.fragmentShader.replace("#include <map_fragment>", `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D(map, vMapUv);
  if (uBlend > 0.5) {
    vec2 q = vMapUv * 0.37 + vec2(0.31, 0.57); float c2 = cos(0.6), s2 = sin(0.6);
    vec4 other = texture2D(map, vec2(c2 * q.x - s2 * q.y, s2 * q.x + c2 * q.y));
    float w = uConst >= 0.0 ? uConst : 0.5 * smoothstep(0.2, 0.8, n2(vMapUv * 0.6 + 3.7)) + 0.25;
    sampledDiffuseColor = mix(sampledDiffuseColor, other, w);
  }
  diffuseColor *= sampledDiffuseColor;
#endif`);
    };
    m.customProgramCacheKey = () => "texblend";
  };
  const lowT = opt.tier === "medium" || opt.tier === "low";
  const M = (o, flat, k = -1) => { if (lowT) { o = { ...o, bumpMap: null }; } if (flat != null && !o.map) o = { ...o, color: flat, bumpMap: null }; const m = new THREE.MeshStandardMaterial(o); owned.mat.add(m); if (o.map) blendFix(m, k); return m; };
  const mat = {
    wood: M({ map: tWood, bumpMap: tWood, bumpScale: 1.2, roughness: 0.78, color: 0xb9a48c }, 0x6a4a2e),
    beam: M({ map: tDark, bumpMap: tDark, bumpScale: 1.6, roughness: 0.85, color: 0x8a7462 }, 0x3e2a1c),
    floor: M({ map: tDark, bumpMap: tDark, bumpScale: 1.0, roughness: 0.7, color: 0x9a846e }, 0x3e2a1c, 0.5),
    stone: M({ map: tStone, bumpMap: tStone, bumpScale: 1.2, roughness: 0.92, color: 0xb0a090 }, 0x6e6254),
    soot: M({ color: 0x0c0806, roughness: 1 }),
    plaster: M({ map: tPlaster, bumpMap: tPlaster, bumpScale: 0.8, roughness: 0.95, color: 0x8f7c66 }, 0x8a7660),
    iron: M({ color: 0x2a2622, roughness: 0.48, metalness: 0.85 }),
    brass: M({ color: 0xb08a4a, roughness: 0.32, metalness: 1 }),
    pewter: M({ color: 0x9a968e, roughness: 0.3, metalness: 0.9 }),
    wax: M({ color: 0xe8dcc0, roughness: 0.55, emissive: 0xa86a3a, emissiveIntensity: 0.9 }),
    glassG: M({ color: 0x2f5a2a, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.82 }),
    glassB: M({ color: 0x5a3214, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.85 }),
    glassC: M({ color: 0xc8c0a8, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.55 }),
    cork: M({ color: 0x6a4a2a, roughness: 0.9 }),
    log: M({ map: tDark, color: 0x4a3426, roughness: 0.9, emissive: 0x4a1404, emissiveIntensity: 0.5 }, 0x2a1c12),
    pane: M({ color: 0xffc070, roughness: 0.2, transparent: true, opacity: 0.35, emissive: 0xffa040, emissiveIntensity: 0.9 }),
  };
  const add = (geo, m, x, y, z, o = {}) => {
    const mesh = new THREE.Mesh(geo, m); owned.geo.add(geo); mesh.position.set(x, y, z);
    if (o.ry) mesh.rotation.y = o.ry; if (o.rx) mesh.rotation.x = o.rx; if (o.rz) mesh.rotation.z = o.rz;
    mesh.castShadow = o.cast !== false; mesh.receiveShadow = true; (o.parent || room).add(mesh); return mesh;
  };
  const WX = 4.2, CEIL = 3.1, BACK = -8.5, FRONT = 1;

  const shell = () => {
    add(boxGeo(WX * 2, 0.1, FRONT - BACK, 3), mat.floor, 0, -0.05, (FRONT + BACK) / 2, { cast: false });
    add(boxGeo(WX * 2, 0.08, FRONT - BACK, 3), mat.beam, 0, CEIL + 0.04, (FRONT + BACK) / 2, { cast: false });
    add(boxGeo(WX * 2, CEIL, 0.1, 2.8), mat.plaster, 0, CEIL / 2, BACK - 0.05, { cast: false });
    for (const s of [-1, 1]) {
      const x = s * (WX + 0.05);
      add(boxGeo(0.1, CEIL - 0.9, FRONT - BACK, 2.8), mat.plaster, x, 0.9 + (CEIL - 0.9) / 2, (FRONT + BACK) / 2, { cast: false });
      add(boxGeo(0.06, 0.9, FRONT - BACK, 2.8), mat.wood, x - s * 0.05, 0.45, (FRONT + BACK) / 2, { cast: false });
      add(boxGeo(0.1, 0.1, FRONT - BACK, 2.8), mat.beam, x - s * 0.08, 0.93, (FRONT + BACK) / 2);
      add(boxGeo(0.16, 0.2, FRONT - BACK, 2.8), mat.beam, x - s * 0.1, CEIL - 0.1, (FRONT + BACK) / 2);
      add(boxGeo(0.14, 0.18, FRONT - BACK, 2.8), mat.beam, x - s * 0.09, 2.15, (FRONT + BACK) / 2);
      for (let z = 0.2; z > BACK; z -= 1.9) add(boxGeo(0.16, CEIL, 0.22, 2.8), mat.beam, x - s * 0.1, CEIL / 2, z);
      for (let z = -0.75; z > BACK + 1; z -= 1.9) {
        const b = add(boxGeo(0.1, 1.2, 0.14, 2.8), mat.beam, x - s * 0.1, 2.6, z - 0.45); b.rotation.x = 0.85;
      }
    }
    for (let z = -0.6; z > BACK; z -= 1.45) add(boxGeo(WX * 2, 0.3, 0.26, 2.8), mat.beam, 0, CEIL - 0.15, z);
    for (const x of [-1.6, 1.6]) add(boxGeo(0.12, 0.1, FRONT - BACK, 2.8), mat.beam, x, CEIL - 0.34, (FRONT + BACK) / 2, { cast: false });
  };
  shell(); await yieldTask();

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

  const hearth = new THREE.Group(); room.add(hearth);
  {
    const hx = -WX + 0.36, D = 0.72;
    add(boxGeo(D, 0.95, 0.42, 2), mat.stone, hx, 0.475, 0.62, { parent: hearth });
    add(boxGeo(D, 0.95, 0.42, 2), mat.stone, hx, 0.475, -0.62, { parent: hearth });
    add(boxGeo(D + 0.04, 0.34, 1.68, 2), mat.stone, hx + 0.02, 1.12, 0, { parent: hearth });
    add(boxGeo(D + 0.16, 0.1, 1.9, 2.8), mat.wood, hx + 0.08, 1.34, 0, { parent: hearth });
    add(boxGeo(D - 0.1, CEIL - 1.39, 1.4, 2), mat.stone, hx - 0.05, 1.39 + (CEIL - 1.39) / 2, 0, { parent: hearth });
    add(boxGeo(0.1, 0.95, 0.84, 1), mat.soot, -WX + 0.05, 0.475, 0, { parent: hearth, cast: false });
    add(boxGeo(D + 0.3, 0.06, 1.9, 2), mat.stone, hx + 0.12, 0.03, 0, { parent: hearth, cast: false });
    const logG = new THREE.CylinderGeometry(0.06, 0.07, 0.62, 10);
    add(logG, mat.log, hx - 0.02, 0.1, 0.02, { parent: hearth, rx: Math.PI / 2, ry: 0.2 });
    add(logG, mat.log, hx + 0.08, 0.12, -0.05, { parent: hearth, rx: Math.PI / 2, ry: -0.35 });
    add(logG, mat.log, hx + 0.02, 0.22, 0, { parent: hearth, rx: Math.PI / 2, ry: 0.05 });
    for (const [z, w, h, s] of [[-0.12, 0.42, 0.62, 0], [0.12, 0.38, 0.55, 3], [0, 0.55, 0.72, 6]]) {
      const f = flame(hearth, hx + 0.05, 0.12, z, w, h, FIRE_FS, 1.3); f.material.uniforms.uSeed.value = s;
    }
    glow(hearth, hx + 0.2, 0.42, 0, 1.6, 0xff7a2a, 0.3);
    mug(hearth, hx + 0.12, 1.39, 0.62, 0.4); mug(hearth, hx + 0.16, 1.39, 0.45, -0.3, mat.pewter);
    bottle(hearth, hx + 0.1, 1.39, -0.58, 0, mat.glassG); candle(hearth, hx + 0.16, 1.39, -0.32, 0.2);
  }
  const shelf = new THREE.Group(), lanternG = new THREE.Group(); room.add(shelf);
  {
    const sx = WX - 0.2;
    add(boxGeo(0.04, 1.5, 1.6, 2.8), mat.wood, WX - 0.02, 1.55, 0, { parent: shelf, cast: false });
    const ys = [0.95, 1.45, 1.95];
    ys.forEach((y, i) => {
      add(boxGeo(0.34, 0.05, 1.7, 2.8), mat.beam, sx, y, 0, { parent: shelf });
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
    const L = lanternG; L.position.set(WX - 0.3, 2.42, 0.25); shelf.add(L);
    add(new THREE.BoxGeometry(0.3, 0.02, 0.02), mat.iron, 0.12, 0.2, 0, { parent: L, cast: false });
    add(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 4), mat.iron, 0, 0.13, 0, { parent: L, cast: false });
    add(new THREE.CylinderGeometry(0.02, 0.09, 0.08, 4, 1).rotateY(Math.PI / 4), mat.iron, 0, 0.05, 0, { parent: L });
    add(new THREE.BoxGeometry(0.12, 0.18, 0.12), mat.pane, 0, -0.08, 0, { parent: L, cast: false });
    for (const [x, z] of [[-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06], [0.06, 0.06]]) add(new THREE.BoxGeometry(0.012, 0.2, 0.012), mat.iron, x, -0.08, z, { parent: L, cast: false });
    add(new THREE.BoxGeometry(0.14, 0.02, 0.14), mat.iron, 0, -0.18, 0, { parent: L, cast: false });
    flame(L, 0, -0.15, 0, 0.04, 0.09); glow(L, 0, -0.08, 0, 0.9, 0xffb868, 0.6);
  }
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

  const fireL = new THREE.PointLight(0xff8a3a, 16, 0, 2), chandL = new THREE.PointLight(0xffc070, 7, 0, 2), lantL = new THREE.PointLight(0xffd28a, 5, 0, 2), fillL = new THREE.PointLight(0xffd18c, 7, 0, 2);
  hearth.add(fireL); fireL.position.set(-WX + 0.9, 0.55, 0);
  chand.add(chandL); chandL.position.set(0, 0.12, 0);
  lanternG.add(lantL); lantL.position.set(0, -0.08, 0);
  fillL.position.set(0, 2.45, -2.3); room.add(fillL);
  const hemi = new THREE.HemisphereLight(0x5a6a8a, 0x3a1c0a, 0.9); room.add(hemi);
  const shadowLights = opt.shadows ? [fireL, chandL] : [];
  for (const l of shadowLights) { l.castShadow = true; l.shadow.mapSize.set(opt.shadows > 1 ? 1024 : 512, opt.shadows > 1 ? 1024 : 512); l.shadow.radius = 4; l.shadow.bias = -0.004; l.shadow.camera.near = 0.1; l.shadow.camera.far = 12; }
  const base = { fire: fireL.intensity, chand: chandL.intensity, lant: lantL.intensity, fill: fillL.intensity };

  const air = [];
  const makePoints = (n, min, max, o) => {
    const g = new THREE.BufferGeometry(), seed = new Float32Array(n * 3);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uSize: { value: o.size }, uRise: { value: o.rise }, uPR: { value: 1 }, uMin: { value: new THREE.Vector3(...min) }, uMax: { value: new THREE.Vector3(...max) }, uColor: { value: new THREE.Color(o.color) }, uLit: { value: o.lit ? 1 : 0 }, uL0: { value: new THREE.Vector3() }, uL1: { value: new THREE.Vector3() }, uL2: { value: new THREE.Vector3() } }, vertexShader: AIR_VS, fragmentShader: AIR_FS, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const p = new THREE.Points(g, m); p.frustumCulled = false; scene.add(p); return p;
  };
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
      const u = p.material.uniforms; u.uTime.value = s; u.uPR.value = renderer.domElement.height / 900;
      if (p.userData.follow) p.position.copy(p.userData.follow.position);
      else { u.uL0.value.copy(fireL.getWorldPosition(v)); u.uL1.value.copy(chandL.getWorldPosition(v)); u.uL2.value.copy(lantL.getWorldPosition(v)); }
    }
  };
  const flick = (s, ph) => 0.5 * Math.sin(s * 7.1 + ph) + 0.3 * Math.sin(s * 13.7 + ph * 2.3) + 0.2 * Math.sin(s * 23.1 + ph * 0.7);
  const setLights = (k, s, flicker, n) => {
    const own = (ph) => (n == null ? flick(s, ph) : 0.7 * n + 0.3 * flick(s, ph));
    const fl = (ph, amt) => (flicker ? 1 + amt * own(ph) * flicker : 1);
    fireL.intensity = base.fire * k.hearth * fireK * fl(0.3, 0.22); chandL.intensity = base.chand * k.candles * fl(1.7, 0.08); lantL.intensity = base.lant * k.lantern * fl(5.3, 0.1);
    fillL.intensity = base.fill * (k.key == null ? 1 : k.key) * fl(2.9, 0.12);
    for (const g of glows) g.s.material.opacity = g.base * (g.s.parent === hearth ? k.hearth * fl(0.3, 0.15) : g.s.parent === chand ? k.candles : g.s.parent === lanternG ? k.lantern : k.candles);
  };
  const setKey = (nx, ny) => { fillL.position.set(nx * 2.4, 2.35 - ny * 0.75, -2.3 - Math.abs(nx) * 0.6); };


  const pose = { pos: new THREE.Vector3(0, 1.6, 0), yaw: 0, pitch: 0 };
  let fireK = 1;
  const layout = (W, H, rect) => {
    fireK = W < H ? 0.55 : 0.8;
    if (W < H) {
      hearth.position.z = -2.78; shelf.position.z = -4.6; chand.visible = false;
      pose.pos.set(-1.15, 1.32, -2.78); pose.yaw = Math.PI / 2; pose.pitch = (9 * Math.PI) / 180;
      if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
      return;
    }
    pose.pos.set(0, 1.6, 0); pose.yaw = 0; pose.pitch = 0;
    const tanV = Math.tan((camera.fov * Math.PI) / 360), tanH = tanV * camera.aspect;
    const ndc = (px) => (px / W) * 2 - 1;
    const gl0 = rect ? (ndc(0) + ndc(Math.max(rect.left, 1))) / 2 : -0.92, gr0 = rect ? (ndc(W) + ndc(Math.min(rect.right, W - 1))) / 2 : 0.92;
    const place = (g, frontX, ndcX, zMin, zMax) => { const d = Math.abs(frontX) / (tanH * Math.max(0.3, Math.abs(ndcX))); g.position.z = -Math.min(zMax, Math.max(zMin, d)); };
    place(hearth, WX - 0.3, gl0 - 0.02, 2.2, 6.5);  place(shelf, WX - 0.25, gr0, 2.4, 6.5);
    if (rect && rect.left < 70) hearth.position.z = -1.2;
    if (rect && W - rect.right < 70) shelf.position.z = -1.2;
    chand.visible = true; chand.position.set(0, 2.2, -5.6);
    if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  };

  await yieldTask();
  setAir(AIR_MAX); tick(0); layout(opt.W || 1, opt.H || 1, null);
  try { if (gl.getExtension("KHR_parallel_shader_compile")) await renderer.compileAsync(scene, camera); else timed(() => renderer.compile(scene, camera)); }
  catch (er) { if (!(lostEarly || gl.isContextLost())) throw er; }
  canvas.removeEventListener("webglcontextlost", onEarlyLoss);
  if (lostEarly || gl.isContextLost()) { try { renderer.dispose(); } catch (er) {} throw new Error("WebGL context lost while the room started"); }
  setAir(0);
  if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  let lost = false;
  scene.traverse((o) => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) { if (m && m.isMeshStandardMaterial) m.dithering = true; } });
  return {
    renderer, scene, camera, info, layout, setLights, setKey, tick, pose,
    setAir: (n) => setAir(n),
    shadowsOn: () => renderer.shadowMap.enabled,
    setBlend: (on) => { blendU.value = on ? 1 : 0; },
    textures: () => loaded.slice(), canvasTextures: () => owned.tex.filter((t) => t.isCanvasTexture).length,
    memory: () => Math.round(texBytes + renderer.info.memory.geometries * 24e3),
    dispose() {
      if (lost) return; lost = true;
      for (const p of air) { scene.remove(p); p.geometry.dispose(); p.material.dispose(); } for (const t of owned.tex) t.dispose(); for (const g of owned.geo) g.dispose(); for (const m of owned.mat) m.dispose();
      for (const g of [mugBody, band, handle, flameGeo, candleGeo, corkGeo, ...BOTTLES]) g.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
}
