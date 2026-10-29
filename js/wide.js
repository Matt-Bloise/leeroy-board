/* Wide screens (owner, 2026-10-29): the Three roads map takes the sheet, and pans and zooms (wheel, drag, pinch, + - 0 and the
   arrow keys, three buttons). Runs after js/v13d.js through the page's own hooks. Phones and short landscape screens keep the
   compact layout and the tap-to-zoom-a-zone map of v13d: nothing here is active under 700 px wide or 501 px tall. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h, s } = K;
const wideOn = () => innerWidth >= 700 && innerHeight >= 501;
const MAXZ = 3.5, MAP = [600, 400];
let box = null, panel = null, st = null, raf = 0, dragged = false;
const num = (a) => a.map(Number);
const size = () => { const r = box.getBoundingClientRect(); return [r.width || 1, r.height || 1]; };
/* the view in map units: centre and zoom, where 1 is the whole map in the box (what "meet" draws) */
function read() {
  const sv = box.querySelector("svg"), [x, y, w, hh] = num((sv.getAttribute("viewBox") || "0 0 600 400").split(/\s+/)), [bw, bh] = size(), a = bw / bh;
  const wf = Math.max(MAP[0], MAP[1] * a), we = Math.max(w, hh * a);
  return { cx: x + w / 2, cy: y + hh / 2, z: Math.max(1, Math.min(MAXZ, wf / we)) };
}
function clamp(v) {
  const [bw, bh] = size(), a = bw / bh, wf = Math.max(MAP[0], MAP[1] * a), z = Math.max(1, Math.min(MAXZ, v.z)), w = wf / z, hh = w / a;
  const lim = (c, span, total) => (span >= total ? total / 2 : Math.max(span / 2, Math.min(total - span / 2, c)));
  return { z, cx: lim(v.cx, w, MAP[0]), cy: lim(v.cy, hh, MAP[1]) };
}
const boxOf = (v) => { const [bw, bh] = size(), a = bw / bh, w = Math.max(MAP[0], MAP[1] * a) / v.z, hh = w / a; return [v.cx - w / 2, v.cy - hh / 2, w, hh]; };
function put(v, quiet) {
  const sv = box.querySelector("svg"); if (!sv || box.clientWidth < 50) return;
  st = clamp(v);
  sv.setAttribute("viewBox", boxOf(st).map((n) => n.toFixed(2)).join(" "));
  if (!quiet) cancelAnimationFrame(raf);
}
function glide(to) {
  cancelAnimationFrame(raf);
  const from = read(), t = clamp(to);
  if (K.reduceMQ.matches) { put(t); return; }
  const t0 = performance.now(), dur = 380;
  const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3), z = from.z * Math.pow(t.z / from.z, e);
    put({ z, cx: from.cx + (t.cx - from.cx) * e, cy: from.cy + (t.cy - from.cy) * e }, true); if (k < 1) raf = requestAnimationFrame(step); };
  raf = requestAnimationFrame(step);
}
/* the point of the map under a screen position, and the view that keeps it there at a new zoom */
function zoomAt(px, py, factor) {
  const v = read(), [bw, bh] = size(), r = box.getBoundingClientRect(), fx = (px - r.left) / bw, fy = (py - r.top) / bh, [x, y, w, hh] = boxOf(v);
  const mx = x + fx * w, my = y + fy * hh, z = Math.max(1, Math.min(MAXZ, v.z * factor)), nw = w * v.z / z, nh = hh * v.z / z;
  return { z, cx: mx - (fx - 0.5) * nw, cy: my - (fy - 0.5) * nh };
}
const reset = () => {
  const whole = box.querySelector(".zone-whole"); if (box.classList.contains("zoomed") && whole) { whole.click(); return; }
  glide({ z: 1, cx: 300, cy: 200 });
};
const stepZoom = (f, px, py) => { const r = box.getBoundingClientRect(); glide(zoomAt(px == null ? r.left + r.width / 2 : px, py == null ? r.top + r.height / 2 : py, f)); };
const ICON = {
  plus: "M12 5v14M5 12h14", minus: "M5 12h14", reset: "M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6",
};
const ctlBtn = (cls, label, path) => h("button", { type: "button", class: `m-btn ${cls}`, "aria-label": label, title: label }, s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, s("path", { d: path })));

/* one place for pointers: a finger or mouse drags the map, two fingers pinch it */
function bindInput() {
  const pts = new Map(); let g = null;
  box.addEventListener("pointerdown", (e) => {
    if (!wideOn() || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.target.closest && e.target.closest(".zone-card, button, a")) return;
    dragged = false; cancelAnimationFrame(raf);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    g = { v: read(), moved: 0 };
    box.focus({ preventScroll: true });
  });
  box.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    const prev = pts.get(e.pointerId), [bw, bh] = size();
    if (pts.size === 1) {
      const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; g.moved += Math.abs(dx) + Math.abs(dy);
      if (g.moved < 5 && !dragged) return;
      if (!dragged) { dragged = true; try { box.setPointerCapture(e.pointerId); } catch (x) {} box.classList.add("dragging"); }
      const v = read(), [, , w, hh] = boxOf(v);
      put({ z: v.z, cx: v.cx - dx / bw * w, cy: v.cy - dy / bh * hh });
    } else if (pts.size === 2) {
      const others = [...pts.entries()].find(([id]) => id !== e.pointerId)[1], d0 = Math.hypot(prev[0] - others[0], prev[1] - others[1]), d1 = Math.hypot(e.clientX - others[0], e.clientY - others[1]);
      dragged = true;
      if (d0 > 8 && d1 > 8) put(zoomAt((e.clientX + others[0]) / 2, (e.clientY + others[1]) / 2, d1 / d0));
    }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
  });
  const up = (e) => { pts.delete(e.pointerId); if (!pts.size) { box.classList.remove("dragging"); g = null; } };
  box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
  /* a drag is not a tap: the zone zoom of v13d never sees the click that ends one */
  box.addEventListener("click", (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
  box.addEventListener("wheel", (e) => {
    if (!wideOn() || (e.target.closest && e.target.closest(".zone-card"))) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016));
    put(zoomAt(e.clientX, e.clientY, f));
  }, { passive: false });
  box.addEventListener("keydown", (e) => {
    if (!wideOn() || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key, v = read(), [, , w, hh] = boxOf(v), mv = (dx, dy) => glide({ z: v.z, cx: v.cx + dx * w * 0.2, cy: v.cy + dy * hh * 0.2 });
    if (k === "+" || k === "=") stepZoom(1.4); else if (k === "-" || k === "_") stepZoom(1 / 1.4);
    else if (k === "0" || k === "Home") reset();
    else if (k === "ArrowLeft") mv(-1, 0); else if (k === "ArrowRight") mv(1, 0); else if (k === "ArrowUp") mv(0, -1); else if (k === "ArrowDown") mv(0, 1);
    else return;
    e.preventDefault(); e.stopPropagation();
  });
}

/* the layout the panel is in: the map with the cards beside it (one or both sides) or the map with the cards under it */
function lay() {
  if (!panel) return;
  const on = wideOn();
  panel.classList.toggle("wide-map", on);
  if (!on) { delete panel.dataset.lay; return; }
  const body = panel.parentElement, W = body.clientWidth, H = body.clientHeight; if (!W || !H) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, min = 19 * rem, full = Math.min(H * 1.5, W - min);
  let l = "side";
  if (W / H < 1.3) l = "below"; else if (W - H * 1.5 >= 2 * min + 24) l = "side2";
  panel.dataset.lay = l;
  panel.style.setProperty("--mw", `${Math.floor(l === "side2" ? H * 1.5 : full)}px`);
  if (box.querySelector("svg")) put(read(), true);
}

K.on("map", (M) => {
  box = $("#map"); panel = $("#panel-roads");
  if (!box.dataset.pan) {
    box.dataset.pan = "1"; bindInput();
    box.setAttribute("tabindex", "0"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "Map of the three roads. Plus and minus zoom, arrow keys move, zero resets.");
    const ctl = h("div", { class: "map-ctl", role: "group", "aria-label": "Map zoom" }, ctlBtn("m-in", "Zoom in", ICON.plus), ctlBtn("m-out", "Zoom out", ICON.minus), ctlBtn("m-reset", "Show the whole map", ICON.reset));
    ctl.querySelector(".m-in").onclick = () => stepZoom(1.5); ctl.querySelector(".m-out").onclick = () => stepZoom(1 / 1.5); ctl.querySelector(".m-reset").onclick = reset;
    panel.append(ctl);
    if (typeof ResizeObserver === "function") new ResizeObserver(() => lay()).observe(panel.parentElement);
  }
  lay();
  if (st && st.z > 1.02 && wideOn()) put(st, true); /* the map redrew (a resize): the same view again */
});
K.on("scene", (k) => { if (k === "roads") requestAnimationFrame(lay); });
K.on("closed", (k) => { if (k === "roads") { st = null; if (box && box.querySelector("svg") && wideOn()) put({ z: 1, cx: 300, cy: 200 }, true); } });
addEventListener("resize", () => lay());
})();
