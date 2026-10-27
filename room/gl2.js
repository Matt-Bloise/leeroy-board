// The room's renderer backend: raw WebGL2, no third-party code (V7 stage 12). room.js talks to it only through the small
// interface below (scene, camera, lights, draw), so a vendored renderer library could replace this file without touching
// room.js, tier.js or the page.
//
//   const R = await createRenderer(canvas, { bloom, bloomK, power })  null when WebGL2 is missing or a shader fails;
//        shaders compile in parallel (KHR_parallel_shader_compile) and are waited on across frames, so no long task
//   R.bloom, R.bloomK                    bloom on or off and its strength, switchable at any frame
//   R.texture(image)                     -> texture handle (mipmapped, repeat)
//   R.mesh(geometry, material)           -> node; node.set({ pos, rotY, scale }), node.visible
//        geometry: box(w, h, d) or plane(w, h) from this file (each face maps the texture once);
//        material: { tex, tint, emit, uv: [u, v] repeats across a face, fire }
//   R.lights                             array of up to 6 { pos: [x, y, z], color: [r, g, b], range }
//   R.camera                             { pos: [x, y, z], yaw, pitch, fov }  (radians; yaw 0 looks down -z)
//   R.fog, R.ambient, R.exposure         { color, density }, [r, g, b], number
//   R.particles(n, box)                  GPU points drifting up inside box { min: [x, y, z], max: [x, y, z] }; n 0 removes
//   R.resize(w, h, dpr)  R.draw(seconds) -> { drawCalls, triangles }  R.memory() -> bytes  R.dispose()
//   R.info                               { renderer, vendor, software }
//   Not in this backend (marked "needs a renderer library"): soft shadows, screen-space reflections.

export function box(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2;
  const F = [
    [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], [w, h]],
    [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]], [w, h]],
    [[1, 0, 0], [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]], [d, h]],
    [[-1, 0, 0], [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]], [d, h]],
    [[0, 1, 0], [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]], [w, d]],
    [[0, -1, 0], [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]], [w, d]],
  ];
  return faces(F);
}
export function plane(w, h) { const x = w / 2, y = h / 2; return faces([[[0, 0, 1], [[-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0]], [w, h]]]); }
function faces(F) {
  const v = [], idx = [];
  for (const [n, q, [su, sv]] of F) {
    const b = v.length / 8;
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    q.forEach((p, i) => v.push(...p, ...n, uv[i][0], uv[i][1]));
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { v: new Float32Array(v), i: new Uint16Array(idx) };
}

const VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec2 aUv;
uniform mat4 uModel, uVP; uniform vec2 uUv;
out vec3 vW; out vec3 vN; out vec2 vUv; out vec2 vLoc;
void main() { vec4 w = uModel * vec4(aPos, 1.0); vW = w.xyz; vN = mat3(uModel) * aNrm; vUv = aUv * uUv; vLoc = aUv; gl_Position = uVP * w; }`;
const FS = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec2 vUv; in vec2 vLoc;
uniform sampler2D uTex; uniform int uHasTex; uniform vec3 uTint, uEmit; uniform float uFire, uTime;
uniform vec3 uAmb; uniform int uNL; uniform vec3 uLP[6]; uniform vec3 uLC[6]; uniform float uLR[6];
uniform vec3 uEye, uFogC; uniform float uFogD, uExp, uVH;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec3 base = uTint;
  if (uHasTex == 1) base *= pow(texture(uTex, vUv).rgb, vec3(2.2));
  vec3 n = normalize(vN), col = base * uAmb;
  for (int i = 0; i < 6; i++) { if (i >= uNL) break;
    vec3 L = uLP[i] - vW; float d = length(L); L /= d;
    float att = 1.0 / (1.0 + 4.0 * d * d / (uLR[i] * uLR[i]));
    col += base * uLC[i] * max(dot(n, L), 0.0) * att; }
  col += uEmit;
  if (uFire > 0.0) {
    float y = vLoc.y, t = uTime;
    float f = noise(vec2(vLoc.x * 6.0, y * 3.0 - t * 2.4)) * 0.6 + noise(vec2(vLoc.x * 13.0, y * 7.0 - t * 4.1)) * 0.4;
    float shape = smoothstep(0.0, 0.25, vLoc.x) * smoothstep(1.0, 0.75, vLoc.x) * (1.0 - y);
    float flame = smoothstep(0.35, 0.85, f * shape * 1.8);
    col += uFire * (mix(vec3(1.4, 0.32, 0.04), vec3(2.2, 1.3, 0.45), flame) * flame + vec3(0.25, 0.06, 0.0) * shape);
  }
  float fd = length(vW - uEye); col = mix(col, uFogC, 1.0 - exp(-pow(uFogD * fd, 2.0)));
  col *= uExp * mix(1.0, 0.45, smoothstep(0.62, 1.0, gl_FragCoord.y / uVH)); /* a scrim behind the page's heading */
  col = col / (1.0 + col);
  o = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;
const PVS = `#version 300 es
layout(location=0) in vec4 aSeed;
uniform mat4 uVP; uniform float uTime, uPx; uniform vec3 uMin, uMax;
out float vA; out vec3 vC;
void main() {
  vec3 span = uMax - uMin;
  float y = fract(aSeed.y + uTime * (0.012 + 0.02 * aSeed.w));
  vec3 p = uMin + span * vec3(aSeed.x + 0.03 * sin(uTime * 0.7 + aSeed.w * 40.0), y, aSeed.z + 0.03 * cos(uTime * 0.5 + aSeed.x * 30.0));
  p.x = uMin.x + span.x * fract((p.x - uMin.x) / span.x);
  vec4 c = uVP * vec4(p, 1.0);
  gl_Position = c; gl_PointSize = uPx * (0.6 + aSeed.w) / max(0.5, c.w);
  vA = sin(3.14159 * y) * (0.45 + 0.55 * sin(uTime * 1.3 + aSeed.w * 20.0));
  vC = mix(vec3(1.0, 0.72, 0.35), vec3(0.55, 0.75, 1.0), step(0.82, aSeed.w));
}`;
const PFS = `#version 300 es
precision mediump float; in float vA; in vec3 vC; out vec4 o;
void main() { vec2 d = gl_PointCoord - 0.5; float a = exp(-dot(d, d) * 9.0) * max(vA, 0.0) * 0.6; o = vec4(vC * a, a); }`;
const QVS = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3)); out vec2 vUv;
void main() { vec2 p = P[gl_VertexID]; vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0, 1); }`;
const BRIGHT = `#version 300 es
precision mediump float; in vec2 vUv; uniform sampler2D uT; out vec4 o;
void main() { vec3 c = texture(uT, vUv).rgb; float l = dot(c, vec3(0.299, 0.587, 0.114)); o = vec4(c * smoothstep(0.72, 1.0, l), 1); }`;
const BLUR = `#version 300 es
precision mediump float; in vec2 vUv; uniform sampler2D uT; uniform vec2 uDir; out vec4 o;
void main() { vec3 c = texture(uT, vUv).rgb * 0.227;
  c += (texture(uT, vUv + uDir * 1.385).rgb + texture(uT, vUv - uDir * 1.385).rgb) * 0.316;
  c += (texture(uT, vUv + uDir * 3.231).rgb + texture(uT, vUv - uDir * 3.231).rgb) * 0.070; o = vec4(c, 1); }`;
const COMP = `#version 300 es
precision mediump float; in vec2 vUv; uniform sampler2D uT, uB; uniform float uK; out vec4 o;
void main() { o = vec4(texture(uT, vUv).rgb + texture(uB, vUv).rgb * uK, 1); }`;

/* start compiling and linking; nothing here waits on the driver */
function begin(gl, vs, fs) {
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs), p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  return { p, v, f };
}
const frameWait = () => new Promise((r) => requestAnimationFrame(() => r()));
/* finish: with the parallel-compile extension, wait across frames until the driver says done, then read the result */
async function finish(gl, par, b) {
  if (par) for (let i = 0; i < 600 && !gl.getProgramParameter(b.p, par.COMPLETION_STATUS_KHR); i++) await frameWait();
  const p = b.p;
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getShaderInfoLog(b.v) || gl.getShaderInfoLog(b.f) || gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i), k = a.name.replace(/\[0\]$/, ""); u[k] = gl.getUniformLocation(p, a.name); }
  return { p, u };
}
const persp = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2), r = 1 / (n - f); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * r, -1, 0, 0, 2 * f * n * r, 0]; };
const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
function view(pos, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const f = [-sy * cp, sp, -cy * cp], r = [cy, 0, -sy], u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const d = (a) => -(a[0] * pos[0] + a[1] * pos[1] + a[2] * pos[2]);
  return [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, d(r), d(u), -d(f), 1];
}
const model = (pos, rotY, s) => { const c = Math.cos(rotY) * s, n = Math.sin(rotY) * s; return [c, 0, -n, 0, 0, s, 0, 0, n, 0, c, 0, pos[0], pos[1], pos[2], 1]; };
const model3 = (pos, rotY, sc) => { const c = Math.cos(rotY), n = Math.sin(rotY); return [c * sc[0], 0, -n * sc[0], 0, 0, sc[1], 0, 0, n * sc[2], 0, c * sc[2], 0, pos[0], pos[1], pos[2], 1]; };

export async function createRenderer(canvas, opts = {}) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, depth: true, powerPreference: opts.power || "default", preserveDrawingBuffer: false });
  if (!gl) return null;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const info = { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) };
  info.software = /swiftshader|llvmpipe|software|basic render|warp/i.test(`${info.renderer} ${info.vendor}`);
  let P, PP, PB, PL, PC;
  const par = gl.getExtension("KHR_parallel_shader_compile"); info.parallelCompile = !!par;
  try {
    const pending = [[VS, FS], [PVS, PFS], [QVS, BRIGHT], [QVS, BLUR], [QVS, COMP]].map(([v, f]) => begin(gl, v, f));
    const done = [];
    for (const b of pending) { done.push(await finish(gl, par, b)); if (!par) await frameWait(); /* without the extension, one program per frame */ }
    [P, PP, PB, PL, PC] = done;
  } catch (e) { return null; }
  const nodes = [], textures = [], buffers = [];
  let bytes = 0, W = 1, H = 1, part = null, rt = null;
  const white = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, white); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  const R = {
    info, bloom: !!opts.bloom, bloomK: opts.bloomK || 0.9, lights: [], camera: { pos: [0, 1.6, 0], yaw: 0, pitch: 0, fov: 0.87 }, fog: { color: [0.05, 0.03, 0.02], density: 0.08 }, ambient: [0.08, 0.06, 0.05], exposure: 1.2,
    texture(img) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const an = gl.getExtension("EXT_texture_filter_anisotropic"); if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 4);
      textures.push(t); bytes += Math.round((img.width * img.height * 4 * 4) / 3); return t;
    },
    mesh(g, m) {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, g.v, gl.STATIC_DRAW);
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.i, gl.STATIC_DRAW);
      [[0, 3, 0], [1, 3, 12], [2, 2, 24]].forEach(([l, n, o]) => { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, n, gl.FLOAT, false, 32, o); });
      gl.bindVertexArray(null); buffers.push(vb, ib); bytes += g.v.byteLength + g.i.byteLength;
      const node = { vao, n: g.i.length, m: { tint: [1, 1, 1], emit: [0, 0, 0], uv: [1, 1], fire: 0, ...m }, M: model([0, 0, 0], 0, 1), visible: true,
        set({ pos = [0, 0, 0], rotY = 0, scale = 1 }) { node.M = Array.isArray(scale) ? model3(pos, rotY, scale) : model(pos, rotY, scale); return node; } };
      nodes.push(node); return node;
    },
    particles(n, b) {
      if (part) { gl.deleteBuffer(part.buf); gl.deleteVertexArray(part.vao); part = null; }
      if (!n) return;
      const seeds = new Float32Array(n * 4); for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);
      part = { vao, buf, n, b };
    },
    resize(w, h, dpr) {
      W = Math.max(1, Math.round(w * dpr)); H = Math.max(1, Math.round(h * dpr));
      canvas.width = W; canvas.height = H;
      if (rt) { Object.values(rt).forEach((x) => x.free()); rt = null; }
    },
    memory: () => bytes + (rt ? W * H * 4 * 2 : 0),
    draw(t) {
      if (R.bloom && !rt) makeTargets();
      if (!R.bloom && rt) { Object.values(rt).forEach((x) => x.free()); rt = null; }
      const c = R.camera, VP = mul(persp(c.fov, W / H, 0.05, 40), view(c.pos, c.yaw, c.pitch));
      let calls = 0, tris = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.scene.fb : null); gl.viewport(0, 0, W, H);
      gl.clearColor(R.fog.color[0], R.fog.color[1], R.fog.color[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(true);
      gl.useProgram(P.p); const u = P.u;
      gl.uniformMatrix4fv(u.uVP, false, VP); gl.uniform3fv(u.uEye, c.pos); gl.uniform3fv(u.uFogC, R.fog.color); gl.uniform1f(u.uFogD, R.fog.density);
      gl.uniform3fv(u.uAmb, R.ambient); gl.uniform1f(u.uExp, R.exposure); gl.uniform1f(u.uTime, t); gl.uniform1f(u.uVH, H);
      const L = R.lights.slice(0, 6); gl.uniform1i(u.uNL, L.length);
      if (L.length) { gl.uniform3fv(u.uLP, L.flatMap((l) => l.pos)); gl.uniform3fv(u.uLC, L.flatMap((l) => l.color)); gl.uniform1fv(u.uLR, L.map((l) => l.range)); }
      gl.activeTexture(gl.TEXTURE0); gl.uniform1i(u.uTex, 0);
      for (const nd of nodes) {
        if (!nd.visible) continue;
        const m = nd.m;
        gl.bindTexture(gl.TEXTURE_2D, m.tex || white); gl.uniform1i(u.uHasTex, m.tex ? 1 : 0);
        gl.uniform3fv(u.uTint, m.tint); gl.uniform3fv(u.uEmit, m.emit); gl.uniform2fv(u.uUv, m.uv); gl.uniform1f(u.uFire, m.fire || 0);
        gl.uniformMatrix4fv(u.uModel, false, nd.M);
        gl.bindVertexArray(nd.vao); gl.drawElements(gl.TRIANGLES, nd.n, gl.UNSIGNED_SHORT, 0); calls++; tris += nd.n / 3;
      }
      if (part) {
        gl.useProgram(PP.p); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
        gl.uniformMatrix4fv(PP.u.uVP, false, VP); gl.uniform1f(PP.u.uTime, t); gl.uniform1f(PP.u.uPx, 14 * (H / 900));
        gl.uniform3fv(PP.u.uMin, part.b.min); gl.uniform3fv(PP.u.uMax, part.b.max);
        gl.bindVertexArray(part.vao); gl.drawArrays(gl.POINTS, 0, part.n); calls++;
        gl.depthMask(true); gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(null);
      if (rt) calls += bloom();
      return { drawCalls: calls, triangles: tris };
    },
    dispose() {
      nodes.forEach((n) => gl.deleteVertexArray(n.vao)); buffers.forEach((b) => gl.deleteBuffer(b)); textures.forEach((t) => gl.deleteTexture(t));
      R.particles(0); nodes.length = 0; const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    },
  };
  function target(w, h) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    return { tex, fb, w, h, depth(dw, dh) { rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, dw, dh); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb); },
      free() { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); if (rb) gl.deleteRenderbuffer(rb); } };
  }
  function makeTargets() {
    if (rt) Object.values(rt).forEach((x) => x.free());
    const hw = Math.max(1, W >> 2), hh = Math.max(1, H >> 2);
    const scene = target(W, H); scene.depth(W, H);
    rt = { scene, a: target(hw, hh), b: target(hw, hh) };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function quad(pr, fb, w, h, tex, set) { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.useProgram(pr.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(pr.u.uT, 0); if (set) set(pr.u); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  function bloom() {
    gl.disable(gl.DEPTH_TEST);
    const { scene, a, b } = rt;
    quad(PB, a.fb, a.w, a.h, scene.tex);
    quad(PL, b.fb, b.w, b.h, a.tex, (u) => gl.uniform2f(u.uDir, 1 / b.w, 0));
    quad(PL, a.fb, a.w, a.h, b.tex, (u) => gl.uniform2f(u.uDir, 0, 1 / a.h));
    quad(PC, null, W, H, scene.tex, (u) => { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, a.tex); gl.uniform1i(u.uB, 1); gl.uniform1f(u.uK, R.bloomK); });
    gl.activeTexture(gl.TEXTURE0); gl.enable(gl.DEPTH_TEST);
    return 4;
  }
  return R;
}
