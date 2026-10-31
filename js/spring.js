(function () {
  if (typeof window === "undefined" || !window) return;
  var win = window;
  var PRESETS = { oak: { k: 180, c: 24, m: 1 }, firm: { k: 300, c: 34, m: 1 }, cloth: { k: 40, c: 6, m: 1 } };
  var H = 1 / 120, MAX_FRAME = 0.25,  REST_X = 0.1, REST_V = 0.5, VEL_WINDOW = 80;
  var liveSprings = 0, liveTracks = 0;
  var NONE = { closest: function () { return null; }, node: null };

  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
  function clock() { var p = win.performance; return p && typeof p.now === "function" ? p.now() : Date.now(); }
  function requestFrame(fn) {
    if (typeof win.requestAnimationFrame === "function") return win.requestAnimationFrame(fn);
    return setTimeout(function () { fn(clock()); }, 16);
  }
  function cancelFrame(id) {
    if (typeof win.cancelAnimationFrame === "function") win.cancelAnimationFrame(id);
    else clearTimeout(id);
  }
  function accel(x, v, p, target) { return (-p.k * (x - target) - p.c * v) / p.m; }
  function atRest(x, v, target) { return Math.abs(x - target) < REST_X && Math.abs(v) < REST_V; }

  function sim(name, x0, v0, target, ms) {
    var p = PRESETS[name] || PRESETS.oak;
    var x = num(x0, 0), v = num(v0, 0), tg = num(target, 0);
    var out = [{ t: 0, x: x, v: v }];
    var n = Math.floor(num(ms, 0) / 1000 * 60);
    for (var i = 1; i <= n; i++) {
      for (var j = 0; j < 2; j++) { v += accel(x, v, p, tg) * H; x += v * H; }
      out.push({ t: i / 60, x: x, v: v });
    }
    return out;
  }

  function resist(d, dim) {
    var w = num(dim, 0), dd = num(d, 0);
    if (!w) return 0;
    return w * (1 - 1 / ((0.55 * Math.abs(dd)) / w + 1)) * Math.sign(dd);
  }

  function spring(o) {
    o = o || {};
    var p = PRESETS[o.preset] || PRESETS.oak;
    var x = num(o.x, 0), v = num(o.v, 0), target = num(o.target, 0);
    var onFrame = typeof o.onFrame === "function" ? o.onFrame : null;
    var onRest = typeof o.onRest === "function" ? o.onRest : null;
    var running = false, frameId = null, last = 0, acc = 0;

    function settle() {
      running = false; liveSprings--;
      x = target; v = 0;
      if (onFrame) onFrame(x, v);
      if (onRest) onRest(x);
    }
    function frame() {
      frameId = null;
      var now = clock();
      acc += Math.min(MAX_FRAME, Math.max(0, (now - last) / 1000));
      last = now;
      while (acc >= H) { v += accel(x, v, p, target) * H; x += v * H; acc -= H; }
      if (atRest(x, v, target)) return settle();
      if (onFrame) onFrame(x, v);
      frameId = requestFrame(frame);
    }
    function start() {
      if (running) return;
      running = true; liveSprings++;
      last = clock(); acc = 0;
      frameId = requestFrame(frame);
    }
    if (!atRest(x, v, target)) start();
    return {
      set: function (t) {
        target = num(t, target);
        if (running) return;
        if (!atRest(x, v, target)) return start();
        x = target; v = 0;
        if (onFrame) onFrame(x, v);
        if (onRest) onRest(x);
      },
      jump: function (nx) { x = num(nx, x); v = 0; if (onFrame) onFrame(x, v); },
      kick: function (dv) { v += num(dv, 0); start(); },
      stop: function () {
        if (!running) return;
        cancelFrame(frameId); frameId = null; running = false; liveSprings--;
      },
      get x() { return x; },
      get v() { return v; },
      get target() { return target; },
      get running() { return running; }
    };
  }

  function velocity(list, now) {
    var pts = [], sx = 0, sy = 0, n = 0, i;
    for (i = 0; i < list.length; i++) if (now - list[i].t <= VEL_WINDOW) pts.push(list[i]);
    for (i = 1; i < pts.length; i++) {
      var dt = pts[i].t - pts[i - 1].t;
      if (dt > 0) { sx += (pts[i].x - pts[i - 1].x) / dt; sy += (pts[i].y - pts[i - 1].y) / dt; n++; }
    }
    return n ? { vx: sx / n, vy: sy / n } : { vx: 0, vy: 0 };
  }

  function track(el, opts) {
    opts = opts || {};
    var axis = opts.axis || "any";
    var slop = num(opts.slop, 10), ratio = num(opts.lockRatio, 1.5);
    var capture = opts.capture !== false;
    function fire(k, s) { if (typeof opts[k] === "function") opts[k](s); }
    var g = null, down = 0, dead = false, live = true;
    liveTracks++;

    function sample(e) { return { x: num(e.clientX, 0), y: num(e.clientY, 0), t: num(e.timeStamp, clock()) }; }
    function view(q) {
      var vel = velocity(q.samples, q.t);
      return {
        dx: q.x - q.x0, dy: q.y - q.y0, vx: vel.vx, vy: vel.vy, x0: q.x0, y0: q.y0,
        t0: q.t0, ms: q.t - q.t0, pointerType: q.pointerType, target: q.target, axis: q.axis
      };
    }
    function release() {
      if (down > 0) down--;
      if (down === 0) dead = false;
    }
    function onDown(e) {
      down++;
      if (g && g.id !== e.pointerId) {
        if (g.started && !g.ended) fire("onCancel", view(g));
        g = null; dead = true;
        return;
      }
      if (dead || g) return;
      if (!opts.mouse && e.pointerType === "mouse") return;
      if (opts.canStart && !opts.canStart(e)) return;
      var a = sample(e);
      var t = e.target;
      g = {
        id: e.pointerId, pointerType: e.pointerType, x0: a.x, y0: a.y, x: a.x, y: a.y,
        t0: a.t, t: a.t, samples: [a], axis: null, started: false, ended: false, handed: false,
        target: (!t || !t.closest || typeof t.closest !== "function") ? NONE : t
      };
      if (capture && typeof el.setPointerCapture === "function") {
        try { el.setPointerCapture(e.pointerId); } catch (err) {  }
      }
    }
    function onMove(e) {
      if (!g || g.ended || g.handed || e.pointerId !== g.id) return;
      var a = sample(e);
      g.x = a.x; g.y = a.y; g.t = a.t; g.samples.push(a);
      while (g.samples.length > 2 && a.t - g.samples[0].t > VEL_WINDOW) g.samples.shift();
      if (!g.started) {
        var ax = Math.abs(g.x - g.x0), ay = Math.abs(g.y - g.y0);
        if (Math.max(ax, ay) <= slop) return;
        var lock = ax >= ratio * ay ? "x" : ay >= ratio * ax ? "y" : null;
        if (!lock) return;
        g.axis = lock;
        if (axis !== "any" && lock !== axis) { g.handed = true; return; }
        g.started = true;
        fire("onStart", view(g));
      }
      if (e.cancelable && typeof e.preventDefault === "function") e.preventDefault();
      fire("onMove", view(g));
    }
    function onUp(e) {
      release();
      if (!g || e.pointerId !== g.id) return;
      if (g.started && !g.ended) { g.ended = true; g.t = num(e.timeStamp, clock()); fire("onEnd", view(g)); }
      g = null;
    }
    function onCancelEvt(e) {
      release();
      if (g && g.started && !g.ended) { g.ended = true; fire("onCancel", view(g)); }
      g = null;
    }
    function onLost() {
      if (g && g.started && !g.ended) { g.ended = true; fire("onCancel", view(g)); }
      g = null;
    }
    function stop() {
      if (!live) return;
      live = false; liveTracks--;
      if (g && g.started && !g.ended) { g.ended = true; fire("onCancel", view(g)); }
      g = null;
      if (el && typeof el.removeEventListener === "function") EV.forEach(function (p) { el.removeEventListener(p[0], p[1]); });
    }
    var EV = [["pointerdown", onDown], ["pointermove", onMove], ["pointerup", onUp], ["pointercancel", onCancelEvt], ["lostpointercapture", onLost]];
    if (el && typeof el.addEventListener === "function") EV.forEach(function (p) { el.addEventListener(p[0], p[1]); });
    return { stop: stop };
  }

  win.BoardSpring = Object.freeze({
    spring: spring,
    sim: sim,
    resist: resist,
    track: track,
    status: function () { return { springs: liveSprings, tracks: liveTracks }; }
  });
})();
