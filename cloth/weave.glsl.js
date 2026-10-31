
export const VS = `#version 300 es
in vec2 a_uv;
uniform vec2 u_view; uniform vec4 u_rect; uniform vec4 u_w; uniform vec4 u_g; uniform vec2 u_off; uniform float u_t;
out vec2 v_p; out float v_sl; out float v_cos;
void main() {
  float A = u_rect.w, s = a_uv.y * A, R = u_g.y, y = s, c = 1.0;
  if (R > 0.05) { float s0 = A - 3.14159 * R; if (s > s0) { float th = (s - s0) / R; y = s0 + R * sin(th); c = cos(th); } }
  y -= 0.02 * A * (s / A) * (s / A); /* the free end hangs 2 percent short: sag */
  float d = max(y - u_g.x, 0.0) / u_g.z, env = pow(min(d, 1.5), 1.5) * 0.6, ph = d * 6.0 - u_t * 9.0 + u_w.y;
  float dx = u_w.x * sin(ph) * env * u_w.z, dy = u_w.x * 0.2 * cos(d * 4.0 - u_t * 7.0 + u_w.y) * env * min(d, 1.5);
  vec2 p = vec2(u_rect.x + a_uv.x * u_rect.z + dx + u_off.x, u_rect.y + y + dy + u_off.y);
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
  v_p = vec2(a_uv.x * u_rect.z - u_g.w, s); v_sl = cos(ph) * env * u_w.x / 14.0; v_cos = c;
}`;

export const FS = `#version 300 es
precision highp float;
uniform sampler2D u_lbl; uniform sampler2D u_cr; uniform sampler2D u_fr;
uniform sampler2D u_sk; uniform vec4 u_wv; uniform vec4 u_g; uniform vec4 u_wh; uniform vec4 u_ft; uniform vec4 u_lr; uniform vec4 u_cb; uniform vec3 u_dye; uniform vec3 u_thr; uniform vec4 u_k;
in vec2 v_p; in float v_sl; in float v_cos;
out vec4 o;
const float P = 1.5, SP = 0.85, SPREAD = 6.0;
const vec3 L = vec3(-0.5513, -0.6515, 0.5212), HV = vec3(-0.3161, -0.3735, 0.8721); /* the candle, upper left (y down), and its half vector */
float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
float kk(vec3 T, float e) { float t = dot(T, HV); return pow(sqrt(max(0.0, 1.0 - t * t)), e); }
void main() {
  float x = v_p.x, s = v_p.y, W = u_wh.x, A = u_wh.y, rod = u_g.x, F = u_ft.x, e = A - F, edge = min(x, W - x);
  vec2 fw = fwidth(v_p); float px = 1.0 / max(max(fw.x, fw.y), 1e-4);
  if (u_wh.w > 0.5) { float m = smoothstep(0.0, 11.0, edge) * smoothstep(0.0, 12.0, A - s) * smoothstep(0.0, 6.0, s - rod * 0.5); o = vec4(0.0, 0.0, 0.0, 0.42 * m * m * u_wh.z); return; }
  if (edge < 0.0 && s > rod && s < e) { /* loose fibres past the long edges: 1 device px wide, 6 to 14 px long, about one row in five */
    float dp = -edge * px, rw = floor(s * px / 5.0), hs = h1(rw * 1.31 + (x < W * 0.5 ? 0.0 : 71.0)), ln = 6.0 + 8.0 * h1(rw * 1.7 + 3.0), yf = fract(s * px / 5.0) * 5.0;
    float wa = step(0.8, hs) * (1.0 - smoothstep(0.0, ln, dp)) * (1.0 - smoothstep(0.35, 0.95, abs(yf - 2.5 - 1.2 * h1(rw))));
    if (wa <= 0.0) discard; wa *= 0.65; o = vec4(u_dye * 1.3 * u_k.x * wa, wa); return;
  }
  float a = clamp(edge * px + 0.5, 0.0, 1.0); if (a <= 0.0) discard;
  bool back = v_cos < 0.0;
  if (s >= e) { vec4 p = texture(u_fr, vec2(x / W, (s - e) / max(F, 0.001))); a *= 1.0 - u_ft.y; o = vec4(p.rgb * u_dye * 1.5 * u_k.x * (0.9 + 0.3 * v_sl) * a, p.a * a); return; }
  vec2 q = vec2(x, s - rod), g = q / P, cell = floor(g), f = fract(g);
  float ch = h1(cell.x * 1.37 + 0.1), m3 = mod(cell.x + cell.y, 3.0);
  float up = m3 < 1.5 ? 1.0 : 0.0, along = up > 0.5 ? (f.y + step(0.5, m3)) * 0.5 : f.x;
  vec4 cr = vec4(0.0); float csh = 0.0; vec2 cu = (q - u_cb.xy) / u_cb.z;
  if (u_ft.w > 0.5 && !back && cu.x > 0.0 && cu.x < 1.0 && cu.y > 0.0 && cu.y < 1.0) { cr = texture(u_cr, cu); csh = texture(u_cr, cu - vec2(0.6, 0.8) / (px * u_cb.z)).a; }
  float ic = smoothstep(0.2, 0.3, cr.a);
  float pc = P, ea = 0.28;
  if (ic > 0.5) { /* weft satin on a finer 1 css px grid: floats over four warps, bound under one, the binding point steps two per pick */
    pc = 1.0; ea = 0.12; g = q / pc; cell = floor(g); f = fract(g);
    float k = mod(cell.x - 2.0 * cell.y, 5.0); up = k < 0.5 ? 1.0 : 0.0; along = up > 0.5 ? f.y : (k - 1.0 + f.x) * 0.25;
  }
  if (back) up = 1.0 - up;
  float tid = up > 0.5 ? cell.x : cell.y + 977.0, across = up > 0.5 ? f.x : f.y, u = across * 2.0 - 1.0;
  float slub = 0.85 + 0.3 * vn(vec2(tid * 3.1 + ch * 7.0, (up > 0.5 ? q.y : q.x) * 0.08));
  float hgt = sqrt(max(0.0, 1.0 - u * u * slub)) * (1.0 - ea + ea * sin(3.14159 * along));
  float dh = -u / max(sqrt(max(1e-3, 1.0 - u * u)), 0.25) * 0.55, det = smoothstep(1.6, 2.6, pc * px);
  vec3 n = normalize(mix(vec3(0.0, 0.0, 1.0), normalize(up > 0.5 ? vec3(dh, 0.0, 1.0) : vec3(0.0, dh, 1.0)), det));
  hgt = mix(0.66, hgt, det);
  vec3 T = up > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), base = up > 0.5 ? u_dye : u_dye * 0.68;
  base *= (0.92 + 0.16 * h1(tid + ch)) * (0.94 + 0.12 * vn(q * 0.04));
  float sE = 24.0, sK = 0.16;
  if (ic > 0.5) { base = cr.rgb * (up < 0.5 ? 0.94 + 0.12 * h1(tid) : 0.72); sE = 40.0; sK = up < 0.5 ? 0.45 : 0.1; } /* a binding point sinks between the floats */
  base *= 1.0 - 0.3 * csh * (1.0 - ic); /* the crest stands 2 device px: a 1 px contact shadow falls lower right */
  if (ic > 0.0) {
    base = mix(base, base * 0.3 + vec3(0.03, 0.02, 0.01), ic * (1.0 - smoothstep(0.4, 0.48, cr.a)));
    float d2 = 0.35 / u_cb.z, hx = texture(u_cr, cu + vec2(d2, 0.0)).a, hy = texture(u_cr, cu + vec2(0.0, d2)).a;
    n = normalize(n + vec3(cr.a - hx, cr.a - hy, 0.0) * 6.0 * ic);
  }
  vec3 shc = vec3(1.0, 0.85, 0.6);
  if (ic < 0.001) { /* the photographed herringbone tile at thread pitch, tinted by the dye; fibre noise per device pixel; wool selvedge; satin streak along the warp */
    float selv = 1.0 - smoothstep(2.0, 3.5, edge * px), th = u_wv.x * (1.0 + selv) / 27.0;
    vec4 sk = u_wv.z > 0.5 ? texture(u_sk, vec2(x, q.y) * th) : vec4(0.5);
    float fib = h2(gl_FragCoord.xy), mot = 1.0 + 0.09 * (vn(vec2(x * 0.02 + ch, s / A * 3.0)) - 0.5);
    base = u_dye * (1.0 + 2.0 * (sk.r - 0.5) / 0.12 * 0.2) * (1.0 + 0.2 * (sk.a - 0.5)) * mot * (0.94 + 0.12 * vn(vec2(floor(x * th * 27.0) * 7.3, q.y * th * 1.7))) * (1.0 + 0.04 * (fib - 0.5)) * mix(1.0, 0.82, selv);
    n = normalize(vec3((sk.g - 0.5) * 2.0, (sk.b - 0.5) * 2.0, 1.0) * vec3(1.0, 1.0, 1.0));
    n = normalize(mix(vec3(0.0, 0.0, 1.0), n, mix(1.0, 0.6, selv)));
    hgt = 0.55 + 0.9 * (sk.r - 0.5); T = vec3(0.0, 1.0, 0.0);
    sE = mix(26.0, 6.0, selv) * (1.0 - 0.24 * (fib - 0.5)); sK = mix(0.6, 0.04, selv); shc = mix(u_dye, vec3(1.0), 0.35) * 1.3;
  }
  if (back) base *= 0.7;
  n = normalize(n + vec3(v_sl * 0.35, 0.0, 0.0));
  float diff = 0.55 + 0.6 * max(0.0, dot(n, L)), occ = mix(1.0, 0.55 + 0.45 * hgt, det);
  vec3 c = base * diff * occ + shc * sK * kk(T, sE) * hgt + (ic < 0.001 ? mix(u_dye, vec3(1.0), 0.35) * 0.6 * pow(1.0 - n.z, 4.0) * 3.0 : vec3(0.0));
  c *= mix(0.62, 1.0, smoothstep(1.5, 3.5, edge)) * (0.72 + 0.28 * smoothstep(0.0, 8.0, q.y));
  if (u_g.y > 0.05) c *= 0.45 + 0.55 * abs(v_cos);
  c *= u_k.x;
  vec2 lu = (q - u_lr.xy) / u_lr.zw;
  if (u_ft.z > 0.5 && !back && lu.x > 0.0 && lu.x < 1.0 && lu.y > 0.0 && lu.y < 1.0) {
    float sd = (texture(u_lbl, lu).r - 0.5) * 2.0 * SPREAD;
    vec2 lt = 1.0 / vec2(textureSize(u_lbl, 0));
    vec2 gr = vec2(texture(u_lbl, lu + vec2(lt.x, 0.0)).r - texture(u_lbl, lu - vec2(lt.x, 0.0)).r, texture(u_lbl, lu + vec2(0.0, lt.y)).r - texture(u_lbl, lu - vec2(0.0, lt.y)).r);
    vec2 gd = length(gr) > 1e-5 ? normalize(gr) : vec2(1.0, 0.0);
    float sds = (texture(u_lbl, lu - vec2(0.6, 0.8) / (px * u_lr.zw)).r - 0.5) * 2.0 * SPREAD;
    c *= 1.0 + u_k.y * smoothstep(-5.5, -0.5, sd);
    c *= 1.0 - 0.6 * smoothstep(-1.2, 0.4, sds) * (1.0 - smoothstep(-0.3, 0.3, sd));
    float aw = fwidth(sd) * 0.75 + 1e-4, cv = smoothstep(-aw, aw, sd) * u_k.z;
    if (cv > 0.0) {
      float hs = sqrt(clamp(sd / 1.4, 0.0, 1.0)); vec2 tg = vec2(0.7071, 0.7071); /* stitches run at 45 degrees to the warp */
      float sp = dot(q, tg) / SP, sf = fract(sp), sdet = smoothstep(1.4, 2.4, SP * px);
      float gv = mix(1.0, 0.8 + 0.2 * sqrt(sin(3.14159 * sf)), sdet);
      vec3 sn = normalize(vec3(-gd * (1.0 - hs) * 1.6 + tg * (sf - 0.5) * 0.8 * sdet + vec2(v_sl * 0.35, 0.0), 1.0));
      vec3 th = u_thr * (0.95 + 0.08 * h1(floor(sp)));
      float sw = u_k.w >= 0.0 ? exp(-pow((lu.y - u_k.w * 1.5 + 0.25) * 3.0, 2.0)) : 0.0;
      vec3 sc = th * (0.8 + 0.42 * max(0.0, dot(sn, L))) * gv * (1.0 + 0.5 * sw) + vec3(1.0, 0.92, 0.75) * 0.75 * kk(vec3(gd, 0.0), 30.0) * gv;
      sc *= mix(0.84, 1.0, smoothstep(0.0, 0.6, sd)) * mix(1.0, u_k.x, 0.35);
      c = mix(c, sc, cv);
    }
  }
  o = vec4(c * a, a);
}`;

export const RVS = `#version 300 es
in vec2 a_uv; in vec4 i_r; in vec4 i_d;
uniform vec2 u_view; out vec2 v_uv; out vec4 v_d;
void main() { vec2 p = i_r.xy + a_uv * i_r.zw; v_uv = a_uv; v_d = i_d; gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0); }`;
export const RFS = `#version 300 es
precision mediump float;
uniform sampler2D u_loop; in vec2 v_uv; in vec4 v_d; out vec4 o;
void main() {
  vec4 p = texture(u_loop, v_uv); float sat = (max(p.r, max(p.g, p.b)) - min(p.r, min(p.g, p.b))) / max(p.a, 0.01);
  o = vec4(min(p.rgb * mix(v_d.rgb * 1.5, vec3(1.0), smoothstep(0.06, 0.22, sat)) * (0.8 + 0.3 * (1.0 - v_uv.y)) * v_d.a, vec3(p.a)), p.a);
}`;
