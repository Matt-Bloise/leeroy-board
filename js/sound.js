/* The board's sound (V13c, spec 3; craft 3 to 7, 22, 24 to 29; phone-deep 2.1, 2.2). Everything is synthesized here, no files.

   The mix: two buses into one master and a limiter.
     ambience bus  fire bed, crackles, a low murmur, the odd glass clink -> low-pass (18 kHz, 2.5 kHz under an open scene)
                   -> duck gain (7 dB down for 250 ms around every UI cue) -> master
     UI bus        every touch's cue, mixed above the ambience -> master
     master        volume (off by default) -> DynamicsCompressor limiter (-12 dB threshold, ratio 8) -> speakers
   Variation: each cue has four takes built from fresh noise and slightly moved pitches; plays go round robin without an
   immediate repeat, with gain +-1.5 dB and a low-pass cutoff +-10% per play. Impacts carry their energy at 400 to 900 Hz with
   a 150 to 250 Hz body, so they are heard on laptop and phone speakers; a sub is only a sweetener.
   The page gives the sound one shared flicker (flick) and asks to hear each crackle (onCrackle), so the fire's light pops
   with the sound it makes. */
(() => {
  const CUE_DB = { open: -14, close: -16, tab: -20, flip: -18, stamp: -17, tick: -30, tock: -31, chip: -24, latch: -24, paper: -24, pin: -24, quill: -24, page: -21, detent: -27, copy: -24, menu: -24, card: -24, esc: -22, swell: -22, cheer: -20 };
  const LIMIT = { threshold: -12, knee: 6, ratio: 8, attack: 0.003, release: 0.15 };
  const DUCK_DB = -7, DUCK_MS = 250, TAKES = 4;
  const S = { ctx: null, on: false, vol: 0.7, live: 0, takes: {}, last: {}, plays: 0, flick: null, onCrackle: null, scene: false, next: 0, crack: 0, timer: 0, lastCue: {} };
  const dbToGain = (db) => Math.pow(10, db / 20);
  const rnd = (a, b) => a + Math.random() * (b - a);

  function build() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return false;
    const c = S.ctx = new C(), R = c.sampleRate, TAU = 2 * Math.PI;
    const G = (v, to) => { const g = c.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    const F = (type, f, q, to) => { const x = c.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; if (to) x.connect(to); return x; };
    const lim = S.limiter = c.createDynamicsCompressor();
    for (const k of ["threshold", "knee", "ratio", "attack", "release"]) lim[k].value = LIMIT[k];
    lim.connect(c.destination);
    const m = S.master = G(0, lim);
    S.ui = G(1, m);
    S.duck = G(1, m);
    S.lp = F("lowpass", 18000, 0.5, S.duck);
    S.amb = G(1, S.lp);
    /* buffers: mk(seconds, fn(t, rand, take)) with a noise source per take, so no two takes share a sample */
    const mk = (sec, fn, take) => { const b = c.createBuffer(1, Math.max(1, Math.round(sec * R)), R), d = b.getChannelData(0); const st = { a: 0, b: 0, c: 0, take }; for (let i = 0; i < d.length; i++) d[i] = fn(i / R, Math.random() * 2 - 1, st); let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v)); if (pk > 0) for (let i = 0; i < d.length; i++) d[i] /= pk; return b; };
    /* one-pole band: two smoothed copies of the noise, subtracted */
    const band = (st, w, lo, hi) => { st.a += (w - st.a) * (1 - Math.exp(-TAU * hi / R)); st.b += (w - st.b) * (1 - Math.exp(-TAU * lo / R)); return st.a - st.b; };
    const sub = (st) => st.s || (st.s = { a: 0, b: 0, take: st.take }); /* a second filter state for a second layer */
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
      crackle: [0.03, (t, w, st) => band(st, w, 900, 5000) * env(t, 0.0003, 0.004 + st.take * 0.0015)],
    };
    /* the takes are built a few at a time so building never holds a frame */
    const jobs = Object.keys(defs).flatMap((n) => Array.from({ length: TAKES }, (_, k) => [n, k])); let i = 0;
    const step = () => { const t0 = performance.now(); while (i < jobs.length && performance.now() - t0 < 6) { const [n, k] = jobs[i++], [sec, fn] = defs[n]; (S.takes[n] ||= []).push(mk(sec, fn, k)); } if (i < jobs.length) setTimeout(step, 0); };
    setTimeout(step, 0);
    /* the bed: brown-ish noise through a band at 400 Hz (the fire), a 110 Hz rumble and a murmur band breathing slowly */
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
    if (typeof navigator !== "undefined" && navigator.audioSession) { try { navigator.audioSession.type = "playback"; } catch (e) {} } /* iPhone: play with the ring switch on silent */
    return true;
  }
  /* one take, gain +-1.5 dB, cutoff +-10%, through the UI bus (or the ambience bus), with the ambience ducked around it */
  function play(name, opt) {
    const c = S.ctx, list = S.takes[name];
    if (!S.on || !c || c.state !== "running" || document.hidden || !list) return false;
    const o = opt || {}, at = c.currentTime + Math.max(0, (o.delay || 0) / 1000);
    let k = (Math.random() * list.length) | 0; if (list.length > 1 && k === S.last[name]) k = (k + 1 + ((Math.random() * (list.length - 1)) | 0)) % list.length;
    S.last[name] = k;
    try {
      const b = c.createBufferSource(); b.buffer = list[k]; b.playbackRate.value = rnd(0.97, 1.03);
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = (o.amb ? 6000 : 9000) * rnd(0.9, 1.1);
      const g = c.createGain(); g.gain.value = dbToGain((o.db != null ? o.db : CUE_DB[name] != null ? CUE_DB[name] : -24) + rnd(-1.5, 1.5)) * (o.gain || 1);
      b.connect(f); f.connect(g); g.connect(o.amb ? S.amb : S.ui);
      S.live++; b.onended = () => { S.live--; try { g.disconnect(); } catch (e) {} };
      b.start(at); S.plays++; S.lastCue[name] = performance.now();
      if (!o.amb) duck(at);
      return true;
    } catch (e) { return false; }
  }
  function duck(at) {
    const g = S.duck.gain, low = dbToGain(DUCK_DB);
    g.cancelScheduledValues(at); g.setTargetAtTime(low, at, 0.01); g.setTargetAtTime(1, at + DUCK_MS / 1000, 0.08);
  }
  /* the ambience, every 100 ms: the bed follows the shared flicker; crackles are short noise transients at uneven gaps, each
     one a pop in the page's light; every 8 to 20 s a glass or tankard clink somewhere in the room */
  function tickAmb() {
    const c = S.ctx; if (!S.on || !c || c.state !== "running") return;
    try {
      const now = c.currentTime, n = S.flick ? S.flick(performance.now() / 1000) : 0;
      S.fire.gain.setTargetAtTime(0.11 * (1 + 0.12 * n), now, 0.08);
      while (S.crack < now + 0.1) {
        const t = Math.max(now, S.crack);
        play("crackle", { amb: true, db: rnd(-30, -24), delay: (t - now) * 1000 });
        if (S.onCrackle) { const ms = (t - now) * 1000; setTimeout(() => { try { S.onCrackle(); } catch (e) {} }, ms); }
        S.crack = t + Math.exp(rnd(Math.log(0.12), Math.log(1.4))); /* log-spaced gaps */
      }
      if (S.next < now + 0.1) { play("clink", { amb: true, db: rnd(-36, -31) }); S.next = Math.max(now, S.next) + rnd(8, 20); }
    } catch (e) {}
  }
  function setOn(on) {
    S.on = on;
    if (on && !S.ctx) { let ok = false; try { ok = build(); } catch (e) { try { S.ctx.close(); } catch (x) {} S.ctx = null; } if (!ok) { S.on = false; return false; } }
    if (!S.ctx) return true;
    const c = S.ctx, g = S.master.gain, t = c.currentTime;
    clearTimeout(S.sus);
    try {
      if (on) c.resume();
      g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t);
      /* exponential approach: up in about 0.6 s, down in about 0.3 s */
      g.setTargetAtTime(on ? S.vol * 0.6 : 0, t, on ? 0.2 : 0.1);
      if (!on) S.sus = setTimeout(() => { try { if (!S.on) c.suspend(); } catch (e) {} }, 700);
    } catch (e) {}
    return true;
  }
  function setVol(v) { S.vol = v; try { if (S.on && S.ctx) S.master.gain.setTargetAtTime(v * 0.6, S.ctx.currentTime, 0.05); } catch (e) {} }
  /* a scene open muffles the room: the ambience low-pass sweeps to 2.5 kHz and the bed drops 6 dB; closing sweeps back */
  function setScene(on) {
    S.scene = on; const c = S.ctx; if (!c) return;
    try { S.lp.frequency.setTargetAtTime(on ? 2500 : 18000, c.currentTime, 0.32 / 3); S.amb.gain.setTargetAtTime(on ? 0.5 : 1, c.currentTime, 0.1); } catch (e) {}
  }
  /* a gesture: resume a context the browser left suspended (a touch's pointerdown is no activation; click and touchend are) */
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
    CUE_DB, LIMIT, DUCK_DB, DUCK_MS, TAKES,
    setOn, setVol, setScene, play, gesture, running, measure,
    setFlick: (f) => { S.flick = f; }, onCrackle: (f) => { S.onCrackle = f; },
    status: () => ({ on: S.on, state: S.ctx ? S.ctx.state : "none", live: S.live, plays: S.plays, takes: Object.fromEntries(Object.entries(S.takes).map(([k, v]) => [k, v.length])), master: S.master ? +S.master.gain.value.toFixed(3) : 0, ambience: S.amb ? +S.amb.gain.value.toFixed(3) : 0, lowpass: S.lp ? Math.round(S.lp.frequency.value) : 0, limiter: S.limiter ? { threshold: S.limiter.threshold.value, ratio: S.limiter.ratio.value } : null, volume: S.vol, lastCue: { ...S.lastCue } }),
  });
})();
