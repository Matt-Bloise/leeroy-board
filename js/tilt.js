/* Tilt: the one orientation source; writes --tilt-x, --tilt-y on html. */
(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const root = document.documentElement, KEY = "board-tilt";
  const NOTE = { "no motion": "Your browser is not sharing motion here.", denied: "Motion access was declined; reload the page to be asked again.", "low power": "Tilt is paused to save battery." };
  const now = () => performance.now(), mq = (q) => matchMedia(q);
  const qRed = mq("(prefers-reduced-motion: reduce)"), qCoarse = mq("(pointer: coarse)");
  const isRed = () => !!(qRed && qRed.matches), isCoarse = () => !!(qCoarse && qCoarse.matches);
  const DOE = () => window.DeviceOrientationEvent, hasDOE = () => typeof DOE() === "function";
  const needsAsk = () => hasDOE() && typeof DOE().requestPermission === "function";
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  const median = (a) => { const s = a.slice().sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const fmt = (v) => (Math.round(v * 100) / 100 + 0).toFixed(2);
  const kitMem = () => { try { const m = window.__boardKit.MEM; return typeof m.get === "function" ? m : null; } catch (e) { return null; } };
  const memGet = () => { const m = kitMem(); if (m) return m.get("tilt"); try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const memSet = (v) => { const m = kitMem(); if (m) return m.set("tilt", v); try { localStorage.setItem(KEY, v); } catch (e) {} };
  const ST = { on: false, listening: false, permission: "n/a", lowPower: false, why: "", note: "", got: 0, rate: 0, t0: 0 };
  const CAL = { b: [], g: [], b0: null, g0: null }, V = { x: 0, y: 0, tx: 0, ty: 0, lastAt: 0, lx: null, ly: null };
  const subs = [];
  let timer = 0, dog = 0, gx = null, gy = null, auto = false, resume = false;

  function emit() {
    const d = { x: V.x, y: V.y };
    for (const f of subs.slice()) { try { f(d); } catch (e) {} }
    try { window.__boardKit.emit("tilt", d); } catch (e) {}
  }
  function write(x, y) {
    V.x = x; V.y = y;
    const cx = V.lx === null || Math.abs(x - V.lx) >= 0.01, cy = V.ly === null || Math.abs(y - V.ly) >= 0.01;
    if (cx) { V.lx = x; root.style.setProperty("--tilt-x", fmt(x)); }
    if (cy) { V.ly = y; root.style.setProperty("--tilt-y", fmt(y)); }
    if (cx || cy) emit();
  }
  function stopGlide() { try { gx && gx.stop(); gy && gy.stop(); } catch (e) {} gx = gy = null; }
  function glideRest() {
    stopGlide();
    const S = window.BoardSpring;
    if (!S || !S.spring || isRed() || document.hidden) { write(0, 0); return; }
    try {
      gx = S.spring({ preset: "oak", x: V.x, target: 0, onFrame: (x) => write(x, V.y), onRest: () => { gx = null; } });
      gy = S.spring({ preset: "oak", x: V.y, target: 0, onFrame: (y) => write(V.x, y), onRest: () => { gy = null; } });
    } catch (e) { write(0, 0); }
  }
  function tick() {
    if (V.lastAt && now() - V.lastAt > 600) { V.tx = V.ty = 0; if (!gx && !gy && (V.x || V.y)) glideRest(); return; }
    write(V.x + (V.tx - V.x) * 0.12, V.y + (V.ty - V.y) * 0.12);
  }
  function onOrient(e) {
    const b = e && e.beta, g = e && e.gamma;
    if (b == null || g == null || !isFinite(b) || !isFinite(g)) return;
    ST.got++; V.lastAt = now(); stopGlide();
    ST.rate = Math.round((ST.got * 1000) / Math.max(1, now() - ST.t0));
    if (CAL.b0 === null) { CAL.b.push(b); CAL.g.push(g); if (CAL.b.length >= 12) { CAL.b0 = median(CAL.b); CAL.g0 = median(CAL.g); CAL.b = []; CAL.g = []; } return; }
    V.tx = clamp((g - CAL.g0) / 18); V.ty = clamp((b - CAL.b0) / 14);
  }
  const recalibrate = () => { CAL.b0 = CAL.g0 = null; CAL.b = []; CAL.g = []; V.tx = V.ty = 0; };
  function listen() {
    if (ST.listening) return;
    ST.listening = true; ST.got = 0; ST.t0 = now(); recalibrate();
    addEventListener("deviceorientation", onOrient);
    timer = setInterval(tick, 33);
    dog = setTimeout(() => { if (ST.listening && !ST.got) disable("no motion"); }, 1500);
  }
  function unlisten() {
    try { removeEventListener("deviceorientation", onOrient); clearInterval(timer); clearTimeout(dog); } catch (e) {}
    ST.listening = false; timer = dog = 0;
  }
  function reflect() {
    try { const b = document.querySelector("#tilt"); if (b) { b.setAttribute("aria-pressed", String(ST.on)); b.hidden = isRed() || !isCoarse() || !hasDOE(); } root.classList.toggle("tilting", ST.on); } catch (e) {}
  }
  function disable(reason, note) {
    const why = reason || "off";
    if (why === "off") memSet("off");
    ST.on = false; ST.why = why; ST.note = note !== undefined ? note : (NOTE[why] || "");
    unlisten();
    if (document.hidden) { stopGlide(); write(0, 0); } else glideRest();
    reflect();
    return status();
  }
  const gate = () => isRed() ? "reduced motion" : !isCoarse() ? "not coarse" : ST.lowPower ? "low power" : document.hidden ? "hidden page" : !hasDOE() ? "no motion API" : "";
  function start(isAuto) {
    auto = isAuto === true; ST.on = true; ST.why = ""; ST.note = "";
    memSet("on"); listen(); reflect();
    return status();
  }
  function enable() {
    if (ST.on && ST.listening) return status();
    const g = gate();
    if (g) return disable(g);
    if (needsAsk() && ST.permission !== "granted") {
      let p;
      try { p = DOE().requestPermission(); } catch (e) { p = Promise.reject(e); }
      ST.permission = "none";
      const no = () => { ST.permission = "denied"; disable("denied"); };
      reflect();
      /* the ask answers later: a promise of the status after it, so board.js labels the button right */
      return Promise.resolve(p).then((r) => { if (r !== "granted") return no(); ST.permission = "granted"; if (!gate()) start(); else reflect(); }, no).then(status);
    }
    return start();
  }
  function toggle() { return ST.on ? disable("off") : enable(); }
  function subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    subs.push(fn);
    return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
  }
  function status() {
    return { on: ST.on, x: +fmt(V.x), y: +fmt(V.y), rate: ST.rate, permission: ST.permission, lowPower: ST.lowPower, reduced: isRed(), why: ST.why, note: ST.note };
  }

  try { if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) window.screen.orientation.addEventListener("change", () => { if (ST.listening) recalibrate(); }); } catch (e) {}
  /* hidden: unsubscribe; an automatic start resumes on show, an explicit enable() waits for enable() */
  try { document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (ST.on) { resume = auto; disable("hidden page"); } return; }
    if (resume) { resume = false; if (!ST.on && memGet() !== "off" && !gate()) start(true); }
  }); } catch (e) {}
  const onMQ = () => { if (ST.on && gate() && !document.hidden) disable(gate()); reflect(); };
  for (const q of [qRed, qCoarse]) { try { q.addEventListener("change", onMQ); } catch (e) {} }
  try {
    navigator.getBattery().then((bat) => {
      const read = () => { ST.lowPower = bat.level <= 0.2 && !bat.charging; if (ST.lowPower && ST.on) disable("low power"); else reflect(); };
      read(); for (const ev of ["levelchange", "chargingchange"]) { try { bat.addEventListener(ev, read); } catch (e) {} }
    }, () => {});
  } catch (e) {}

  function boot() {
    try {
      ST.permission = !hasDOE() ? "n/a" : needsAsk() ? "none" : "granted";
      const sensory = window.BoardSensory && window.BoardSensory.config ? window.BoardSensory.config() : null;
      if (memGet() !== "off" && sensory && sensory.spatial && !needsAsk() && !gate()) start(true); else reflect();
    } catch (e) {}
  }
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 0);
  else addEventListener("load", boot);

  window.BoardTilt = Object.freeze({ on: subscribe, toggle, enable, disable: (reason) => disable(reason || "off"), status });
})();
