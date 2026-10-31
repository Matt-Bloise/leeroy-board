export const S = 4, SPREAD = 6;
const font = (px) => `700 ${px}px "Alegreya Sans SC", "Alegreya Sans", Georgia, serif`;

function edt(grid, w, h) {
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < len; q++) { let s; do { const r = v[k]; s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r); } while (s <= z[k] && --k >= 0); k++; v[k] = q; z[k] = s; z[k + 1] = 1e20; }
    k = 0; for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + f[r]; }
  };
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = grid[y * w + x]; pass(h); for (let y = 0; y < h; y++) grid[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = grid[y * w + x]; pass(w); for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]); }
}

export function sdfLabel(job, mk) {
  const t0 = performance.now(), text = String(job.text || "");
  let c = mk(8, 8), x = c.getContext("2d");
  x.font = font(100); const mh = x.measureText("H"), capR = (mh.actualBoundingBoxAscent > 0 ? mh.actualBoundingBoxAscent : 66) / 100;
  let px = (job.capCss / capR) * S;
  const setF = (p) => { x.font = font(p); if ("letterSpacing" in x) x.letterSpacing = `${(p * 0.05).toFixed(2)}px`; };
  setF(px);
  const room = Math.max(8, (job.widthCss - 2 * job.pad) * S);
  let lines = [text];
  if (x.measureText(text).width > room && text.indexOf(" ") > 0) {
    let best = 1e9; for (let i = text.indexOf(" "); i >= 0; i = text.indexOf(" ", i + 1)) { const a = text.slice(0, i), b = text.slice(i + 1), m = Math.max(x.measureText(a).width, x.measureText(b).width); if (m < best) { best = m; lines = [a, b]; } }
  }
  const m = Math.max(...lines.map((l) => x.measureText(l).width)); if (m > room) px *= room / m;
  const cap = px * capR, lh = px * 1.08, pad = SPREAD * S + 2, W = Math.max(8, Math.ceil(job.widthCss * S)), H = Math.ceil(pad * 2 + cap * 1.25 + lh * (lines.length - 1));
  c = mk(W, H); x = c.getContext("2d"); setF(px);
  x.fillStyle = "#fff"; x.textAlign = "center"; x.textBaseline = "alphabetic";
  lines.forEach((l, i) => x.fillText(l, W / 2, pad + cap + i * lh));
  const al = x.getImageData(0, 0, W, H).data, N = W * H, ins = new Float64Array(N), out = new Float64Array(N);
  let top = -1, bot = -1;
  for (let i = 0; i < N; i++) { const on = al[i * 4 + 3] > 127; ins[i] = on ? 1e20 : 0; out[i] = on ? 0 : 1e20; if (on) { const r = (i / W) | 0; if (top < 0) top = r; bot = r; } }
  edt(ins, W, H); edt(out, W, H);
  const data = new Uint8Array(N), k = 127.5 / (SPREAD * S);
  for (let i = 0; i < N; i++) { const s = ins[i] - out[i]; data[i] = Math.max(0, Math.min(255, Math.round(127.5 + s * k))); }
  return { w: W, h: H, data, lines: lines.length, cap: +(cap / S).toFixed(2), inkTop: Math.max(0, top) / S, inkBot: (bot + 1) / S, ms: +(performance.now() - t0).toFixed(1) };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  let fontP = null;
  self.onmessage = (e) => {
    const j = e.data || {};
    if (!fontP) fontP = (async () => { try { if (!self.fonts || typeof FontFace !== "function") return false; const ff = new FontFace("Alegreya Sans SC", `url(${j.fontUrl})`, { weight: "700" }); self.fonts.add(ff); await ff.load(); return true; } catch (x) { return false; } })();
    fontP.then((ok) => {
      let r; try { r = sdfLabel(j, (w, h) => new OffscreenCanvas(w, h)); } catch (x) { self.postMessage({ id: j.id, error: String((x && x.message) || x) }); return; }
      r.id = j.id; r.font = ok; self.postMessage(r, [r.data.buffer]);
    });
  };
}
