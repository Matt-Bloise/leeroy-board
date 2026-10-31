(() => {
  const CUE_DB = { open: -14, close: -16, tab: -18, flip: -18, stamp: -17, tick: -30, tock: -31, chip: -24, latch: -24, paper: -18, pin: -24, quill: -24, page: -21, detent: -27, copy: -24, menu: -24, card: -24, esc: -22, swell: -22, cheer: -20,
    hover: -34, whoosh: -24, unfurl: -24, cork: -22, thunk: -22, tipc: -32 };
  const EVT_DB = { coin: -26, good: -24, bad: -24, fanfare: -22, creak: -34, door: -26, laugh: -36, babble: -40, gull: -42, thunder: -24, hoof: -34, shimmer: -36, purr: -42, drip: -42, pour: -36 };
  const LIMIT = { threshold: -12, knee: 6, ratio: 8, attack: 0.003, release: 0.15 };
  const DUCK_DB = -7, DUCK_MS = 250, TAKES = 4;
  const S = { queued: {}, buildMs: {}, spatial: true, getPan: null, listeners: [], ctx: null, on: false, vol: 0.7, live: 0, takes: {}, last: {}, plays: 0, flick: null, onCrackle: null, scene: false, next: 0, crack: 0, timer: 0, lastCue: {} };
  const dbToGain = (db) => Math.pow(10, db / 20);
  const rnd = (a, b) => a + Math.random() * (b - a);

  function build() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return false;
    let c0; try { c0 = new C({ sampleRate: 48000, latencyHint: "playback" }); } catch (e) { c0 = new C(); }
    const c = S.ctx = c0, R = c.sampleRate, TAU = 2 * Math.PI;
    const G = (v, to) => { const g = c.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    const F = (type, f, q, to) => { const x = c.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; if (to) x.connect(to); return x; };
    const lim = S.limiter = c.createDynamicsCompressor();
    for (const k of ["threshold", "knee", "ratio", "attack", "release"]) lim[k].value = LIMIT[k];
    lim.connect(c.destination);
    const m = S.master = G(0, lim);
    S.ui = G(1, m);
    S.duck = G(1, m);
    S.ambLvl = G(1, S.duck);
    S.lp = F("lowpass", 18000, 0.5, S.ambLvl);
    S.mus = G(0, S.duck);
    const verb = () => { try { const n = Math.round(1.4 * R), ir = c.createBuffer(2, n, R), dk = Math.exp(-3.4 / R), kk = Math.exp(-3 / R); for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0, e = 1, k = 0.95; for (let i = 0; i < n; i++) { lp += (Math.random() * 2 - 1 - lp) * (0.25 + k * 0.7 / 0.95 * 0.95); e *= dk; k *= kk; d[i] = lp * e * (i < 90 ? i / 90 : 1); } } const cv = c.createConvolver(); cv.buffer = ir; S.verbIn = G(1, cv); cv.connect(G(0.7, S.duck)); S.ui.connect(G(dbToGain(-17), S.verbIn)); S.mus.connect(G(dbToGain(-10), S.verbIn)); } catch (e) {} };
    setTimeout(verb, 40);
    S.amb = G(1, S.lp);
    const mk = (sec, fn, take, lo) => { const r = lo ? R / 2 : R, b = c.createBuffer(1, Math.max(1, Math.round(sec * r)), r), d = b.getChannelData(0); const st = { a: 0, b: 0, c: 0, take, R: r }; for (let i = 0; i < d.length; i++) d[i] = fn(i / r, Math.random() * 2 - 1, st); let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v)); if (pk > 0) for (let i = 0; i < d.length; i++) d[i] /= pk; return b; };
    const band = (st, w, lo, hi) => { const Rr = st.R || R; st.a += (w - st.a) * (1 - Math.exp(-TAU * hi / Rr)); st.b += (w - st.b) * (1 - Math.exp(-TAU * lo / Rr)); return st.a - st.b; };
    const sub = (st) => st.s || (st.s = { a: 0, b: 0, take: st.take, R: st.R });
    const LO = new Set(["thunder", "purr", "hoof", "door", "babble", "laugh", "gull", "shimmer", "pour", "creak", "fanfare", "swell", "cheer", "unfurl", "whoosh"]);
    const FAN = [[293.7, 0, 0.55], [440, 0.45, 0.55], [587.3, 0.9, 0.5], [293.7, 1.4, 1.4], [440, 1.4, 1.4], [740, 1.4, 1.4]], GOOD = [1046.5, 1318.5, 1568], HOOF = [0, 0.17, 0.31, 0.52, 0.68], SHIM = [1568, 2093, 2637, 3136, 3951];
    const at = (st, i) => (st.m || (st.m = []))[i] || (st.m[i] = { a: 0, b: 0, take: st.take, R: st.R });
    const env = (t, atk, dec) => (t < atk ? t / atk : Math.exp(-(t - atk) / dec));
    const wood = (f0, nf, dec, sub) => (t, w, st) => { const j = 1 + (st.take - 1.5) * 0.03; return 0.9 * band(st, w, nf * 0.6 * j, nf * 1.4 * j) * env(t, 0.001, dec) + 0.6 * Math.sin(TAU * f0 * j * t) * env(t, 0.002, dec * 1.3) + sub * Math.sin(TAU * 70 * t) * env(t, 0.002, dec * 0.8); };
    const rustle = (dur, lo, hi) => (t, w, st) => { const k = Math.min(1, t / dur), e = Math.sin(Math.PI * k); const j = 1 + (st.take - 1.5) * 0.05; return band(st, w, lo * j, (lo + (hi - lo) * k) * j) * e * e; };
    const defs = {
      open: [0.2, (t, w, st) => wood(190, 650, 0.035, 0.25)(t, w, st) + (t > 0.03 ? 0.5 * rustle(0.16, 1800, 3600)(t - 0.03, w, sub(st)) : 0)],
      close: [0.12, wood(230, 850, 0.025, 0.12)],
      tab: [0.09, rustle(0.08, 2200, 4200)],
      flip: [0.24, (t, w, st) => rustle(0.24, 1500, 4800)(t, w, st) * (1 + 1.5 * Math.exp(-Math.pow((t - 0.12) / 0.03, 2)))],
      stamp: [0.14, (t, w, st) => wood(170, 520, 0.04, 0.3)(t, w, st)],
      tick: [0.03, (t, w, st) => band(st, w, 2500, 6000) * env(t, 0.0005, 0.004) + 0.3 * Math.sin(TAU * 1900 * t) * env(t, 0.0005, 0.006)],
      tock: [0.03, (t, w, st) => band(st, w, 1400, 3500) * env(t, 0.0005, 0.005) + 0.3 * Math.sin(TAU * 1300 * t) * env(t, 0.0005, 0.007)],
      chip: [0.06, wood(600, 1200, 0.012, 0)],
      latch: [0.08, (t, w, st) => band(st, w, 1800, 4200) * (env(t, 0.0005, 0.006) + (t > 0.022 ? 0.8 * env(t - 0.022, 0.0005, 0.008) : 0))],
      paper: [0.2, rustle(0.18, 1500, 3200)],
      pin: [0.05, (t, w, st) => band(st, w, 1300, 2600) * env(t, 0.0005, 0.008) + 0.5 * Math.sin(TAU * 320 * t) * env(t, 0.001, 0.015)],
      quill: [0.24, (t, w, st) => band(st, w, 3500, 8000) * (0.5 + 0.5 * Math.sin(TAU * (28 + st.take * 3) * t)) * Math.sin(Math.PI * Math.min(1, t / 0.24))],
      page: [0.32, (t, w, st) => rustle(0.32, 1200, 4400)(t, w, st) * (1 + Math.exp(-Math.pow((t - 0.2) / 0.04, 2)))],
      detent: [0.02, (t, w, st) => band(st, w, 2500, 5000) * env(t, 0.0003, 0.003)],
      copy: [0.09, (t, w, st) => wood(700, 1500, 0.008, 0)(t, w, st) + (t > 0.045 ? wood(760, 1600, 0.008, 0)(t - 0.045, w, sub(st)) : 0)],
      menu: [0.06, wood(420, 900, 0.014, 0)],
      card: [0.07, rustle(0.06, 2500, 5000)],
      esc: [0.1, wood(260, 900, 0.02, 0)],
      swell: [1.2, (t, w, st) => band(st, w, 250, 900) * Math.sin(Math.PI * Math.min(1, t / 1.2)) * (0.6 + 0.4 * Math.sin(TAU * 5.5 * t))],
      cheer: [1.4, (t, w, st) => (band(st, w, 300, 1400) * (0.6 + 0.4 * Math.sin(TAU * 7 * t + st.take))) * Math.sin(Math.PI * Math.min(1, t / 1.4)) * (t < 0.05 ? t / 0.05 : 1)],
      clink: [0.5, (t, w, st) => { const f = 2300 + st.take * 170; return (Math.sin(TAU * f * t) + 0.6 * Math.sin(TAU * f * 2.76 * t) + 0.35 * Math.sin(TAU * f * 5.4 * t)) * env(t, 0.001, 0.09) + (t > 0.11 ? 0.5 * Math.sin(TAU * f * 1.07 * t) * env(t - 0.11, 0.001, 0.07) : 0); }],
      hover: [0.04, wood(1100, 2200, 0.005, 0)],
      whoosh: [0.5, rustle(0.5, 160, 1100)],
      unfurl: [0.5, (t, w, st) => rustle(0.5, 900, 3800)(t, w, st) * (0.7 + 0.3 * Math.sin(TAU * 38 * t))],
      coin: [0.6, (t, w, st) => { const f = 1760 + st.take * 45; return (Math.sin(TAU * f * t) * env(t, 0.001, 0.28) + 0.5 * Math.sin(TAU * f * 1.505 * t) * env(t, 0.001, 0.18) + 0.25 * Math.sin(TAU * f * 2.76 * t) * env(t, 0.001, 0.08)); }],
      cork: [0.14, (t, w, st) => Math.sin(TAU * (140 * t + 14.4 * (1 - Math.exp(-25 * t)))) * env(t, 0.001, 0.035) + 0.4 * band(st, w, 600, 2500) * env(t, 0.0005, 0.01)],
      thunk: [0.2, wood(130, 320, 0.05, 0.25)],
      good: [0.75, (t, w, st) => { let o = 0; GOOD.forEach((f, i) => { const u = t - i * 0.09; if (u > 0) o += Math.sin(TAU * f * u) * env(u, 0.002, 0.28) + 0.3 * Math.sin(TAU * f * 2.76 * u) * env(u, 0.002, 0.1); }); return o; }],
      bad: [0.3, (t, w, st) => wood(150, 350, 0.05, 0.2)(t, w, st) + (t > 0.12 ? wood(120, 300, 0.05, 0.2)(t - 0.12, w, at(st, 0)) : 0)],
      tipc: [0.03, (t, w, st) => band(st, w, 3000, 6000) * env(t, 0.0003, 0.003)],
      crackle: [0.03, (t, w, st) => band(st, w, 900, 5000) * env(t, 0.0003, 0.004 + st.take * 0.0015)],
      fanfare: [2.5, (t, w, st) => { let o = 0; FAN.forEach(([f, s0, d]) => { const u = t - s0; if (u < 0 || u > d + 0.5) return; const e = Math.min(1, u / 0.05) * (u < d ? 1 : Math.exp(-(u - d) / 0.2)) * (d > 1 ? Math.exp(-u / 0.9) : 1); const vb = 1 + 0.0008 * Math.sin(TAU * 5.5 * u); for (let h = 1; h <= 2; h++) o += Math.sin(TAU * f * h * u * vb) / (h * Math.sqrt(h)) * e * 0.25; }); return o; }],
      creak: [0.7, (t, w, st) => band(st, w, 180, 700 + 500 * t) * Math.pow(Math.max(0, Math.sin(TAU * (28 + 14 * t) * t)), 2) * Math.sin(Math.PI * Math.min(1, t / 0.7))],
      door: [1.5, (t, w, st) => wood(110, 300, 0.08, 0.4)(t, w, st) + (t > 0.1 && t < 1 ? 0.5 * band(at(st, 1), w, 220, 900 + 600 * t) * Math.pow(Math.max(0, Math.sin(TAU * (34 + 20 * t) * t)), 2) * Math.sin(Math.PI * (t - 0.1) / 0.9) : 0) + (t > 1.1 ? 0.8 * band(at(st, 2), w, 1800, 4200) * env(t - 1.1, 0.0005, 0.01) : 0)],
      laugh: [1.8, (t, w, st) => { const k = Math.floor(t / 0.19), u = t - k * 0.19; if (k > 6) return 0; const f0 = 210 + 18 * ((st.take * 7 + k * 3) % 5) - k * 4; let x = 0; for (let h = 1; h <= 6; h++) x += Math.sin(TAU * h * f0 * t) / h; return band(st, x * 0.7 + w * 0.15, 420, 1500) * env(u, 0.01, 0.07) * (1 - k / 8); }],
      babble: [1.4, (t, w, st) => { const f0 = 118 + st.take * 9 + 12 * Math.sin(TAU * 0.9 * t + st.take); let x = 0; for (let h = 1; h <= 8; h++) x += Math.sin(TAU * h * f0 * t) / h; const syl = Math.pow(Math.max(0, Math.sin(TAU * (3.6 + 0.4 * st.take) * t)), 1.5); return band(st, x * 0.7 + w * 0.2, 350, 1600 + 400 * Math.sin(TAU * 1.7 * t)) * syl * Math.sin(Math.PI * Math.min(1, t / 1.4)); }],
      gull: [1.1, (t, w, st) => { const f = 1500 + 900 * Math.sin(Math.PI * Math.min(1, t / 0.5)) - 500 * Math.max(0, (t - 0.5) / 0.6); let x = 0; for (let h = 1; h <= 4; h++) x += Math.sin(TAU * h * f * t) / h; return (x + 0.3 * w) * Math.sin(Math.PI * Math.min(1, t / 1.1)) * (0.6 + 0.4 * Math.sin(TAU * 22 * t)); }],
      thunder: [3.6, (t, w, st) => 0.9 * band(st, w, 25, 380 + 200 * Math.exp(-t)) * env(t, 0.4, 1.9) * (1 + 0.7 * Math.sin(TAU * 1.3 * t + st.take) * Math.exp(-t / 3)) + 0.45 * band(at(st, 3), w, 800, 4000) * env(t, 0.003, 0.12)],
      hoof: [1, (t, w, st) => { let o = 0; HOOF.forEach((s0, i) => { if (t >= s0) o += wood(150 + 20 * (i % 2), 420, 0.035, 0.2)(t - s0, w, at(st, i)) * (0.7 + 0.3 * (i % 2)); }); return o; }],
      shimmer: [1.7, (t, w, st) => { let o = 0; SHIM.forEach((f, i) => { const u = t - ((i * 0.13 + st.take * 0.07) % 0.5); if (u > 0) o += Math.sin(TAU * f * u) * env(u, 0.02, 0.35) * (0.8 + 0.2 * Math.sin(TAU * 6 * u)); }); return o; }],
      purr: [2.4, (t, w, st) => band(st, w, 35, 170) * (0.55 + 0.45 * Math.sin(TAU * 24 * t)) * Math.sin(Math.PI * Math.min(1, t / 2.4))],
      drip: [0.12, (t) => Math.sin(TAU * (1000 + (t < 0.05 ? 900 * t / 0.05 : 900)) * t) * env(t, 0.001, 0.02)],
      pour: [1.2, (t, w, st) => band(st, w, 1200, 3500) * (0.55 + 0.45 * Math.sin(TAU * 9 * t)) * Math.sin(Math.PI * Math.min(1, t / 1.2))],
    };
    const jobs = Object.keys(defs).filter((n) => EVT_DB[n] == null).flatMap((n) => Array.from({ length: defs[n][2] || TAKES }, (_, k) => [n, k])); let i = 0, busy = false;
    const step = () => { busy = true; const t0 = performance.now(); while (i < jobs.length && performance.now() - t0 < 6) { const [n, k] = jobs[i++], [sec, fn] = defs[n]; const q0 = performance.now(); (S.takes[n] ||= []).push(mk(sec, fn, k, LO.has(n))); S.buildMs[n] = (S.buildMs[n] || 0) + performance.now() - q0; } if (i < jobs.length) setTimeout(step, 0); else busy = false; };
    S.ensure = (n) => { if (!defs[n] || S.queued[n]) return; S.queued[n] = 1; for (let k = 0; k < 2; k++) jobs.push([n, k]); if (!busy) setTimeout(step, 0); };
    setTimeout(step, 0);
    let p1 = 0, p2 = 0;
    const noise = c.createBuffer(1, Math.round(1.5 * R), R), nd = noise.getChannelData(0);
    for (let k = 0; k < nd.length; k++) { const w = Math.random() * 2 - 1; p1 += (w - p1) * 0.08; p2 += (p1 - p2) * 0.3; nd[k] = p2 * 3 + w * 0.08; }
    const src = c.createBufferSource(); src.buffer = noise; src.loop = true; src.start();
    S.fire = G(0.11, S.amb); src.connect(F("bandpass", 400, 0.9, S.fire));
    src.connect(F("lowpass", 110, 0.7, G(0.07, S.amb)));
    S.murmur = G(dbToGain(-40) * 4, S.amb);
    const mf = F("bandpass", 520, 1.4, S.murmur); src.connect(mf);
    const lfo = c.createOscillator(); lfo.frequency.value = 0.09; const lg = G(dbToGain(-40) * 2, S.murmur.gain); lfo.connect(lg); lfo.start();
    S.next = c.currentTime + 5; S.crack = c.currentTime + 0.5;
    S.timer = setInterval(tickAmb, 100);
    document.addEventListener("visibilitychange", () => { try { if (document.hidden) c.suspend(); else if (S.on) c.resume(); } catch (e) {} });
    if (typeof navigator !== "undefined" && navigator.audioSession) { try { navigator.audioSession.type = "playback"; } catch (e) {} }
    return true;
  }
  function play(name, opt) {
    const c = S.ctx, list = S.takes[name];
    if (!list && S.ensure && EVT_DB[name] != null) S.ensure(name);
    if (!S.on || !c || c.state !== "running" || document.hidden || !list) return false;
    const o = opt || {}, at = c.currentTime + Math.max(0, (o.delay || 0) / 1000);
    let k = (Math.random() * list.length) | 0; if (list.length > 1 && k === S.last[name]) k = (k + 1 + ((Math.random() * (list.length - 1)) | 0)) % list.length;
    S.last[name] = k;
    try {
      const b = c.createBufferSource(); b.buffer = list[k]; b.playbackRate.value = rnd(0.97, 1.03) * (o.rate || 1);
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = (o.amb ? 6000 : 9000) * rnd(0.9, 1.1);
      const g = c.createGain(); g.gain.value = dbToGain((o.db != null ? o.db : CUE_DB[name] != null ? CUE_DB[name] : EVT_DB[name] != null ? EVT_DB[name] : -24) + rnd(-1.5, 1.5)) * (o.gain || 1);
      b.connect(f); f.connect(g);
      let out = g, pn = null;
      const pv = o.pan != null ? o.pan : (!o.amb && S.getPan ? S.getPan() : 0);
      if (S.spatial && pv && c.createStereoPanner) { pn = c.createStereoPanner(); pn.pan.value = Math.max(-0.85, Math.min(0.85, pv)); g.connect(pn); out = pn; }
      out.connect(o.amb ? S.amb : S.ui);
      S.live++; b.onended = () => { S.live--; try { g.disconnect(); if (pn) pn.disconnect(); } catch (e) {} };
      b.start(at); S.plays++; S.lastCue[name] = performance.now();
      if (!o.amb) duck(at);
      if (S.cueHook && !o.noHook) { try { S.cueHook(name, o); } catch (e) {} }
      return true;
    } catch (e) { return false; }
  }
  function duck(at) {
    const g = S.duck.gain, low = dbToGain(DUCK_DB);
    g.cancelScheduledValues(at); g.setTargetAtTime(low, at, 0.01); g.setTargetAtTime(1, at + DUCK_MS / 1000, 0.08);
  }
  function tickAmb() {
    const c = S.ctx; if (!S.on || !c || c.state !== "running") return;
    try {
      const now = c.currentTime, n = S.flick ? S.flick(performance.now() / 1000) : 0;
      S.fire.gain.setTargetAtTime(0.11 * (1 + 0.12 * n), now, 0.08);
      while (S.crack < now + 0.1) {
        const t = Math.max(now, S.crack);
        play("crackle", { amb: true, db: rnd(-30, -24), delay: (t - now) * 1000 });
        if (S.onCrackle) { const ms = (t - now) * 1000; setTimeout(() => { try { S.onCrackle(); } catch (e) {} }, ms); }
        S.crack = t + Math.exp(rnd(Math.log(0.12), Math.log(1.4)));
      }
      if (S.next < now + 0.1) { play("clink", { amb: true, db: rnd(-36, -31) }); S.next = Math.max(now, S.next) + rnd(8, 20); }
    } catch (e) {}
  }
  function setOn(on) {
    S.on = on; for (const f of S.listeners) { try { f(on); } catch (e) {} }
    if (on && !S.ctx) { let ok = false; try { ok = build(); } catch (e) { try { S.ctx.close(); } catch (x) {} S.ctx = null; } if (!ok) { S.on = false; return false; } }
    if (!S.ctx) return true;
    const c = S.ctx, g = S.master.gain, t = c.currentTime;
    clearTimeout(S.sus);
    try {
      if (on) c.resume();
      g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.setTargetAtTime(on ? S.vol * 0.6 : 0, t, on ? 0.2 : 0.1);
      if (!on) S.sus = setTimeout(() => { try { if (!S.on) c.suspend(); } catch (e) {} }, 700);
    } catch (e) {}
    return true;
  }
  function setVol(v) { S.vol = v; try { if (S.on && S.ctx) S.master.gain.setTargetAtTime(v * 0.6, S.ctx.currentTime, 0.05); } catch (e) {} }
  function setScene(on) {
    S.scene = on; const c = S.ctx; if (!c) return;
    try { S.lp.frequency.setTargetAtTime(on ? 2500 : 18000, c.currentTime, 0.32 / 3); S.amb.gain.setTargetAtTime(on ? 0.5 : 1, c.currentTime, 0.1); } catch (e) {}
  }
  function gesture() { const c = S.ctx; if (S.on && c && c.state !== "running") { try { c.resume(); } catch (e) {} } return running(); }
  const running = () => !!(S.ctx && S.ctx.state === "running");
  function measure(ms = 500) {
    return new Promise((done) => {
      const c = S.ctx; if (!c || !S.master) return done(null);
      const tap = (node) => { const an = c.createAnalyser(); an.fftSize = 2048; node.connect(an); return { an, d: new Float32Array(2048), peak: 0, sum: 0, k: 0 }; };
      const out = tap(S.limiter), amb = tap(S.duck), ui = tap(S.ui);
      const iv = setInterval(() => { for (const x of [out, amb, ui]) { x.an.getFloatTimeDomainData(x.d); for (const v of x.d) { x.peak = Math.max(x.peak, Math.abs(v)); x.sum += v * v; x.k++; } } }, 40);
      const db = (v) => +(20 * Math.log10(v || 1e-9)).toFixed(1);
      setTimeout(() => { clearInterval(iv); const r = (x) => { try { (x === out ? S.limiter : x === amb ? S.duck : S.ui).disconnect(x.an); } catch (e) {} return { peakDb: db(x.peak), rmsDb: db(Math.sqrt(x.sum / Math.max(1, x.k))) }; }; const o = r(out); done({ rmsDb: o.rmsDb, peakDb: o.peakDb, out: o, ambience: r(amb), ui: r(ui) }); }, ms);
    });
  }
  window.BoardSound = Object.freeze({
    CUE_DB, EVT_DB, LIMIT, DUCK_DB, DUCK_MS, TAKES,
    setOn, setVol, setScene, play, gesture, running, measure,
    setFlick: (f) => { S.flick = f; },
    internals: () => (S.ctx ? { ctx: S.ctx, ui: S.ui, amb: S.amb, ambLvl: S.ambLvl, mus: S.mus, duck: S.duck, master: S.master, limiter: S.limiter, verbIn: S.verbIn } : null),
    setCueHook: (f) => { S.cueHook = f; }, onState: (f) => { S.listeners.push(f); }, setSpatial: (v) => { S.spatial = !!v; }, setPanSource: (f) => { S.getPan = f; }, ensure: (n) => { if (S.ensure) S.ensure(n); }, hasTake: (n) => !!(S.takes[n] && S.takes[n].length), onCrackle: (f) => { S.onCrackle = f; },
    status: () => ({ buildMs: Object.fromEntries(Object.entries(S.buildMs).map(([k, v]) => [k, Math.round(v)])), on: S.on, state: S.ctx ? S.ctx.state : "none", live: S.live, plays: S.plays, takes: Object.fromEntries(Object.entries(S.takes).map(([k, v]) => [k, v.length])), master: S.master ? +S.master.gain.value.toFixed(3) : 0, ambience: S.amb ? +S.amb.gain.value.toFixed(3) : 0, lowpass: S.lp ? Math.round(S.lp.frequency.value) : 0, limiter: S.limiter ? { threshold: S.limiter.threshold.value, ratio: S.limiter.ratio.value } : null, volume: S.vol, lastCue: { ...S.lastCue } }),
  });
})();
