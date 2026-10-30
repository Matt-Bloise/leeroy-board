// Pointer, pinch, wheel, double-tap, inertia and keyboard (contract 3.3). Every listener on the canvas stops the event so
// js/wide.js (on #map) and js/v13d.js never see the Atlas's input. Handlers work from the element they were bound to
// and the numbers on the event.
export function bindGestures(o) {
  const { el, host, view } = o, G = { pointers: new Map(), moved: false, drag: null, last: null, inertia: null, tapAt: 0, tapX: 0, tapY: 0, zoomAt: 0, raf: 0, bound: [] };
  const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };
  const prevent = (e) => { if (e && e.preventDefault) e.preventDefault(); };
  const on = (t, ev, f, opt) => { t.addEventListener(ev, f, opt); G.bound.push([t, ev, f, opt]); };
  const rel = (e) => {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return [(e.clientX || 0) - (r.left || 0), (e.clientY || 0) - (r.top || 0)];
  };
  const stopInertia = () => { G.inertia = null; };
  const frame = () => {
    G.raf = 0;
    const i = G.inertia; if (!i) return;
    const t = Math.min(1, (performance.now() - i.t0) / 320), ease = 1 - Math.pow(1 - t, 3), dt = ease - i.prev;
    i.prev = ease;
    view.panPx(i.dx * dt, i.dy * dt); o.onChange("inertia");
    if (t < 1) G.raf = requestAnimationFrame(frame); else G.inertia = null;
  };
  const dist = () => { const p = [...G.pointers.values()]; return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
  const mid = () => { const p = [...G.pointers.values()]; return [(p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2]; };

  on(el, "pointerdown", (e) => {
    stop(e);
    if (e.button && e.button !== 0) return;
    const [x, y] = rel(e);
    G.pointers.set(e.pointerId === undefined ? 1 : e.pointerId, { x, y });
    try { if (el.setPointerCapture && e.pointerId !== undefined) el.setPointerCapture(e.pointerId); } catch (x2) { /* ignore */ }
    stopInertia();
    if (G.pointers.size === 1) { G.moved = false; G.drag = { x0: x, y0: y, x, y }; G.last = []; G.pinch = 0; }
    else { G.moved = true; G.pinch = dist(); G.pinchMid = mid(); }
    o.onDown && o.onDown();
  });
  on(el, "pointermove", (e) => {
    stop(e);
    const id = e.pointerId === undefined ? 1 : e.pointerId;
    if (!G.pointers.has(id)) { o.onHover && o.onHover(...rel(e)); return; }
    const [x, y] = rel(e), p = G.pointers.get(id), dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (G.pointers.size >= 2) {
      const d = dist(), m = mid();
      if (G.pinch > 0 && d > 0) view.zoomAbout(Math.log2(d / G.pinch), m[0], m[1]);
      view.panPx(m[0] - G.pinchMid[0], m[1] - G.pinchMid[1]);
      G.pinch = d; G.pinchMid = m; o.onChange("pinch"); return;
    }
    if (!G.drag) return;
    G.drag.x = x; G.drag.y = y;
    if (!G.moved && Math.hypot(x - G.drag.x0, y - G.drag.y0) < 5) return;
    G.moved = true;
    view.panPx(dx, dy);
    const now = performance.now(); G.last.push([now, dx, dy]); while (G.last.length && now - G.last[0][0] > 100) G.last.shift();
    o.onChange("drag");
  });
  const up = (e) => {
    stop(e);
    const id = e.pointerId === undefined ? 1 : e.pointerId;
    if (!G.pointers.has(id)) return;
    const [x, y] = rel(e), was = G.pointers.size;
    G.pointers.delete(id);
    try { if (el.releasePointerCapture && e.pointerId !== undefined) el.releasePointerCapture(e.pointerId); } catch (x2) { /* ignore */ }
    if (was !== 1) { if (G.pointers.size === 1) { const r = [...G.pointers.values()][0]; G.drag = { x0: r.x, y0: r.y, x: r.x, y: r.y }; G.last = []; } return; }
    const drag = G.drag; G.drag = null;
    if (!G.moved && e.type !== "pointercancel") {
      const now = performance.now();
      if (now - G.tapAt < 320 && Math.hypot(x - G.tapX, y - G.tapY) < 30) { G.tapAt = 0; zoomStep(1, x, y); return; }
      G.tapAt = now; G.tapX = x; G.tapY = y;
      o.onPick && o.onPick(x, y, e);
      return;
    }
    if (drag && !o.reduced() && G.last.length > 1) {
      const sum = G.last.reduce((a, s) => [a[0] + s[1], a[1] + s[2]], [0, 0]), span = Math.max(16, G.last[G.last.length - 1][0] - G.last[0][0]);
      const vx = sum[0] / span, vy = sum[1] / span;
      if (Math.hypot(vx, vy) > 0.08) { G.inertia = { t0: performance.now(), dx: vx * 320 * 0.45, dy: vy * 320 * 0.45, prev: 0 }; G.raf = requestAnimationFrame(frame); }
    }
  };
  on(el, "pointerup", up); on(el, "pointercancel", up);
  on(el, "wheel", (e) => {
    stop(e); prevent(e);
    const unit = e.deltaMode === 1 ? 16 : 1, d = Math.max(-1, Math.min(1, -(e.deltaY || 0) * unit * (e.ctrlKey ? 0.0025 : 0.0012) * 1.6));
    const [x, y] = rel(e); view.zoomAbout(d, x, y); o.onChange("wheel");
  }, { passive: false });
  on(el, "dblclick", (e) => { stop(e); if (performance.now() - G.zoomAt < 400) return; const [x, y] = rel(e); zoomStep(1, x, y); });
  function zoomStep(n, x, y) {
    G.zoomAt = performance.now();
    if (o.reduced() || !o.animateZoom) { view.zoomAbout(n, x, y); o.onChange("zoom"); return; }
    o.animateZoom(n, x, y);
  }
  G.zoomStep = zoomStep;

  on(host, "keydown", (e) => {
    const k = e.key; let used = true;
    const pan = (fx, fy) => { view.panPx(fx * view.w * 0.2, fy * view.h * 0.2); o.onChange("key"); };
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "ArrowLeft") pan(1, 0); else if (k === "ArrowRight") pan(-1, 0);
    else if (k === "ArrowUp") pan(0, 1); else if (k === "ArrowDown") pan(0, -1);
    else if (k === "+" || k === "=") zoomStep(1, view.w / 2, view.h / 2);
    else if (k === "-" || k === "_") zoomStep(-1, view.w / 2, view.h / 2);
    else if (k === "0" || k === "Home") o.keys.fit();
    else if (k === "Enter") { if (!o.keys.enter()) used = false; }
    else if (k === "Escape") { if (!o.keys.escape()) used = false; }
    else used = false;
    if (used) { prevent(e); stop(e); }
  });
  // cards, controls and the places list sit inside #map too: their pointer and wheel events stop here, so the sketch's pan never starts
  for (const ev of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel"]) on(host, ev, stop, { passive: true });
  G.destroy = () => { for (const [t, ev, f, opt] of G.bound) t.removeEventListener(ev, f, opt); G.bound = []; if (G.raf) cancelAnimationFrame(G.raf); G.inertia = null; G.pointers.clear(); };
  return G;
}
