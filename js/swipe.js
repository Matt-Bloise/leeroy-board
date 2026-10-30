/* Swipe between scenes and the wall flick (contract section 5, 2026-10-30). Full note: board/MOBILE-NOTES.md, file notes. */
(() => {
  "use strict";
  const K = window.__boardKit;
  if (!K || typeof document === "undefined") return;
  const PHONE_ORDER = ["tonight", "five", "signups", "librarian", "timeline", "roads", "racials", "legacy", "buffs", "ledger", "decide", "library"];
  const $ = (q) => document.querySelector(q);
  const SPRING = () => window.BoardSpring || null;
  const reduced = () => !!(K.reduceMQ && K.reduceMQ.matches);
  const owns = () => {
    if (reduced()) return false;
    const sh = window.BoardShell;
    return !sh || typeof sh.ownsSwipe !== "function" ? true : !!sh.ownsSwipe();
  };
  const haptic = (name) => { try { const H = window.BoardHaptics; if (H && typeof H.fire === "function") H.fire(name); } catch (e) { /* silent where the platform gives nothing */ } };
  /* the contract's rubber band; the same formula when BoardSpring is absent */
  const resist = (d, dim) => {
    const S = SPRING();
    if (S && typeof S.resist === "function") return S.resist(d, dim);
    return d === 0 ? 0 : dim * (1 - 1 / ((0.55 * Math.abs(d)) / dim + 1)) * Math.sign(d);
  };
  /* one spring glide (v in units per second); with no spring, or under reduced motion, the value jumps and rests at once */
  const glide = (preset, x0, v0, target, onFrame, onRest) => {
    const S = SPRING();
    if (!S || typeof S.spring !== "function" || reduced()) { onFrame(target); onRest(target); return null; }
    const h = S.spring({ preset, x: x0, v: v0, onFrame, onRest });
    h.set(target); /* a spring starts on set(); it rests on its own and calls onRest once */
    return h;
  };
  const stopGlide = (g) => { try { if (g && typeof g.stop === "function") g.stop(); } catch (e) { /* the handle is spent */ } };
  const tx = (n) => `translateX(${n.toFixed(2)}px)`;
  const head = () => $("#scene .sheet-head");
  const setSway = (dx) => { const hd = head(); if (hd) hd.style.setProperty("--sway", ((dx / Math.max(1, innerWidth)) * 3).toFixed(3)); };

  /* ---------- scene swipe ---------- */
  const carouselOf = (t) => {
    const car = t && typeof t.closest === "function" ? t.closest(".cards") : null;
    return car && car.scrollWidth > car.clientWidth + 2 ? car : null;
  };
  const swipeCanStart = (e) => {
    if (!owns() || K.SC.open === null) return false;
    const t = e && e.target;
    if (!t || typeof t.closest !== "function") return true;
    if (t.closest("input, select, textarea, .lib-rail, .lib-examples, .lib-tools, .bottombar, .bsheet, #map, .ch-sug")) return false; /* .ch-sug: the chat's chips scroll sideways (companion N6) */
    /* the five's carousel keeps its own pan: a start inside it is refused unless the carousel is at one of its ends */
    const car = carouselOf(t);
    return !(car && car.scrollLeft > 2 && car.scrollLeft < car.scrollWidth - car.clientWidth - 2);
  };

  let pending = null; /* set at the start; becomes the live gesture on the first move that locks the axis */
  let live = null;    /* { from, idx, car, sl, dir, nxt, tick } */
  let glideH = null, toKey = null;
  let flickDy = 0, flickLive = false;

  const neighbour = (dir) => {
    const j = live.idx + dir;
    if (j < 0 || j >= PHONE_ORDER.length) return null;
    const key = PHONE_ORDER[j], el = $(`#panel-${key}`);
    if (!el) return null;
    el.hidden = false;
    return { key, el };
  };
  const paint = (cur, nxt, x, dir) => {
    if (cur) cur.style.transform = tx(x);
    if (nxt) nxt.el.style.transform = tx(x + dir * innerWidth);
  };
  const clearPanels = (cur, nxt) => {
    if (cur) cur.style.transform = "";
    if (nxt) { nxt.el.style.transform = ""; nxt.el.hidden = true; }
  };
  const giveBack = () => {
    if (!live) return;
    const cur = $(`#panel-${live.from}`), nxt = live.nxt, dir = live.dir;
    const x0 = live.x || 0;
    live = null; pending = null;
    stopGlide(glideH);
    glideH = glide("oak", x0, 0, 0,
      (x) => { if (!reduced()) paint(cur, nxt, x, dir); setSway(x); },
      () => { clearPanels(cur, nxt); setSway(0); glideH = null; });
  };

  const onSwipeStart = (s) => {
    const from = K.SC.open;
    if (!from) return;
    const car = carouselOf(s.target);
    pending = { from, idx: PHONE_ORDER.indexOf(from), car, sl: car ? car.scrollLeft : 0 };
  };
  const onSwipeMove = (s) => {
    if (!live && pending) { live = { ...pending, dir: 0, nxt: null, tick: false, x: 0 }; pending = null; stopGlide(glideH); glideH = null; }
    if (!live || K.SC.open !== live.from) return;
    const W = innerWidth, dx = s.dx;
    const dir = dx < 0 ? 1 : dx > 0 ? -1 : 0;
    if (dir !== 0 && dir !== live.dir) {
      if (live.nxt) clearPanels(null, live.nxt);
      live.dir = dir; live.nxt = neighbour(dir);
    }
    const cur = $(`#panel-${live.from}`);
    if (!cur) return;
    const atEnd = !live.nxt;
    const x = atEnd ? resist(dx, W) : dx;
    if (atEnd && Math.abs(dx) > 24 && !live.tick) { live.tick = true; haptic("boundary"); }
    live.x = x;
    if (!reduced()) paint(cur, live.nxt, x, live.dir || 0);
    setSway(x);
  };
  const onSwipeEnd = (s) => {
    if (!live) { pending = null; return; }
    const { from, nxt, dir, car, sl } = live;
    const W = innerWidth, dx = s.dx, vx = Number(s.vx) || 0;
    /* a carousel that moved took the gesture as its own pan */
    if (car && car.scrollLeft !== sl) { giveBack(); return; }
    const far = Math.abs(dx) >= W * 0.28;
    const flick = Math.abs(vx) > 0.5 && Math.abs(dx) >= 20 && Math.sign(vx) === Math.sign(dx);
    if (!nxt || !(far || flick)) { giveBack(); return; }
    const cur = $(`#panel-${from}`), x0 = live.x || dx;
    const to = nxt.key;
    live = null; pending = null;
    toKey = to;
    stopGlide(glideH);
    glideH = glide("oak", x0, vx * 1000, -dir * W,
      (x) => { if (!reduced()) paint(cur, nxt, x, dir); setSway(x); },
      () => {
        glideH = null;
        /* the strip has carried on: the scene changes in this frame and the transforms clear with it */
        K.switchTab(to, false);
        clearPanels(cur, null);
        nxt.el.style.transform = "";
        setSway(0);
        toKey = null;
        K.emit("swipe", { from, to });
      });
  };
  const onSwipeCancel = () => { pending = null; if (live) giveBack(); };

  /* ---------- wall flick: a downward drag on the scene head closes the scene ---------- */
  const flickCanStart = (e) => {
    if (!owns() || K.SC.open === null) return false;
    const t = e && e.target;
    return !(t && typeof t.closest === "function" && t.closest("button, a, input, select, textarea"));
  };
  const sheetEl = () => $("#scene .sheet");
  const placeSheet = (y) => { const sh = sheetEl(); if (sh) sh.style.transform = `translateY(${y.toFixed(2)}px)`; };
  const onFlickMove = (s) => {
    if (reduced()) return;
    flickDy = Math.max(0, s.dy || 0); flickLive = true;
    placeSheet(resist(flickDy, innerHeight));
  };
  const onFlickEnd = (s) => {
    const dy = Math.max(0, s.dy || 0), vy = Number(s.vy) || 0;
    flickLive = false; flickDy = 0;
    const close = dy > 80 || (vy > 0.6 && dy >= 40);
    if (!close) { glide("oak", resist(dy, innerHeight), 0, 0, placeSheet, () => placeSheet(0)); return; }
    if (reduced()) { K.requestClose(); return; }
    glide("oak", resist(dy, innerHeight), 0, innerHeight, placeSheet, () => { K.requestClose(); placeSheet(0); });
  };
  const onFlickCancel = () => { flickLive = false; flickDy = 0; placeSheet(0); };

  /* ---------- attach ---------- */
  let attached = false;
  const attach = () => {
    if (attached) return;
    const S = SPRING(), body = $("#sheet-body"), hd = head();
    if (!S || typeof S.track !== "function" || !body) return;
    attached = true;
    S.track(body, {
      axis: "x", slop: 10, lockRatio: 1.5, mouse: false, capture: true,
      canStart: swipeCanStart, onStart: onSwipeStart, onMove: onSwipeMove, onEnd: onSwipeEnd, onCancel: onSwipeCancel
    });
    if (hd) S.track(hd, {
      axis: "y", slop: 10, lockRatio: 1.5, mouse: false, capture: true,
      canStart: flickCanStart, onStart: () => {}, onMove: onFlickMove, onEnd: onFlickEnd, onCancel: onFlickCancel
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true });
  else attach();

  const status = () => ({
    live: !!live,
    dx: Math.round((live && live.x) || 0),
    from: live ? live.from : null,
    to: toKey,
    order: PHONE_ORDER.slice(),
    flick: flickLive,
    flickDy: Math.round(flickDy)
  });
  window.BoardSwipe = Object.freeze({ status, order: PHONE_ORDER.slice() });
})();
