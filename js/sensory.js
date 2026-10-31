(() => {
  if (typeof window === "undefined" || typeof navigator === "undefined" || typeof document === "undefined" || typeof addEventListener !== "function") return;
  const BS = window.BoardSound, HP = window.BoardHaptics;
  if (!BS) return;
  const $ = (q) => document.querySelector(q);
  const rnd = (a, b) => a + Math.random() * (b - a), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dbG = (db) => Math.pow(10, db / 20);
  const mq = (q) => { try { return matchMedia(q).matches; } catch (e) { return false; } };
  const reduced = () => mq("(prefers-reduced-motion: reduce)");
  const saveData = () => { try { return !!(navigator.connection && navigator.connection.saveData); } catch (e) { return false; } };
  const PRESETS = { quiet: { music: 0, amb: 0.55, fx: 0.7, spatial: false, haptics: false }, tavern: { music: 0.5, amb: 1, fx: 1, spatial: true, haptics: true }, everything: { music: 0.7, amb: 1, fx: 1, spatial: true, haptics: true } };
  const KEY = "board-sense";
  const cfg = { preset: "tavern", music: 0.5, amb: 1, fx: 1, spatial: true, haptics: false, awake: false };
  try { const j = JSON.parse(localStorage.getItem(KEY) || "null"); if (j && typeof j === "object") for (const k of Object.keys(cfg)) if (j[k] !== undefined && typeof j[k] === typeof cfg[k]) cfg[k] = j[k]; } catch (e) {}
  if (saveData() && !localStorage.getItem(KEY)) cfg.music = 0;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} };
  const E = { run: false, I: null, scene: null, next: {}, timer: 0, t0: 0, plays: 0, notes: 0, live: 0, bars: 0, mode: "", rainLvl: 0, weather: 0, fanfared: false, voices: 0 };

  const STREAMS = {
    babble: { cue: "babble", gap: [4, 11], db: [-43, -38], base: 1, crowd: 1 }, laugh: { cue: "laugh", gap: [28, 75], db: [-41, -35], base: 1, crowd: 1 },
    creak: { cue: "creak", gap: [45, 130], db: [-39, -34], base: 1 }, door: { cue: "door", gap: [100, 260], db: [-32, -27], base: 1, crowd: 1 },
    thunk: { cue: "thunk", gap: [40, 100], db: [-34, -28], base: 1 }, pour: { cue: "pour", gap: [70, 160], db: [-40, -35], base: 1 },
    purr: { cue: "purr", gap: [220, 520], db: [-50, -46], base: 1, calm: 1 }, thunder: { cue: "thunder", gap: [30, 85], db: [-32, -26], base: 1, storm: 0.64 },
    drip: { cue: "drip", gap: [1.4, 4.5], db: [-54, -48], base: 1, storm: 0.45 },
    gull: { cue: "gull", gap: [18, 45], db: [-46, -41] }, hoof: { cue: "hoof", gap: [9, 20], db: [-38, -32] }, coin: { cue: "coin", gap: [5, 13], db: [-40, -34] },
    shimmer: { cue: "shimmer", gap: [4, 10], db: [-40, -34] }, page: { cue: "page", gap: [9, 22], db: [-42, -37] }, clinkx: { cue: "clink", gap: [5, 11], db: [-36, -31] },
    toast: { cue: "toast", gap: [110, 280], db: [-34, -30] },
  };
  const PROF = {
    library: { babble: 2.5, laugh: 3, door: 3, thunk: 2, page: 1, purr: 0.7, clock: 1 }, roads: { babble: 3, laugh: 4, creak: 3, door: 4, thunk: 3, gull: 1, hoof: 1, zep: 1 },
    signups: { babble: 0.5, laugh: 0.5, thunk: 0.6, clinkx: 1, toast: 1 }, legacy: { coin: 1, babble: 2 }, ledger: { coin: 1, babble: 2 }, buffs: { shimmer: 1, babble: 3, laugh: 3 },
    five: { babble: 1.5 }, racials: { babble: 1.5, laugh: 1.5 }, librarian: { babble: 2.5, page: 1 }, tonight: {}, timeline: { clock: 1, babble: 2 },
  };
  function scale(id) {
    const st = STREAMS[id], p = PROF[E.scene] || {};
    let sc = p[id] !== undefined ? p[id] : st.base ? 1 : 0;
    if (!sc) return 0;
    if (st.crowd) { const h = new Date().getHours(); sc /= h >= 17 || h < 2 ? 1 : h < 11 ? 0.55 : 0.8; }
    if (st.storm && E.weather < st.storm) return 0;
    if (st.calm && E.weather > 0.5) return 0;
    return sc;
  }
  const WP = [rnd(0, 6.28), rnd(0, 6.28), rnd(0, 6.28)];
  const weatherAt = (s) => clamp(0.5 + 0.34 * Math.sin(6.283 * s / 600 + WP[0]) + 0.2 * Math.sin(6.283 * s / 230 + WP[1]), 0, 1);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  function buildBeds(I) {
    const c = I.ctx, R = c.sampleRate, nb = c.createBuffer(1, R * 4, R), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = (to) => { const s = c.createBufferSource(); s.buffer = nb; s.loop = true; s.loopStart = 0; s.start(c.currentTime, rnd(0, 3)); return s; };
    const F = (type, f, q) => { const x = c.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
    const G = (v, to) => { const g = c.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    E.rain = G(0, I.amb); { const hp = F("highpass", 1100, 0.5), lp = F("lowpass", 5200, 0.5); src().connect(hp); hp.connect(lp); lp.connect(E.rain); }
    E.wind = G(0, I.amb); { const bp = F("bandpass", 330, 0.8), s = src(); s.connect(bp); bp.connect(E.wind);
      const lfo = c.createOscillator(), lg = G(120, bp.frequency); lfo.frequency.value = 0.07; lfo.connect(lg); lfo.start();
      const l2 = c.createOscillator(), g2 = G(0.0012, E.wind.gain); l2.frequency.value = 0.13; l2.connect(g2); l2.start(); }
    E.zep = G(0, I.amb); { const lp = F("lowpass", 150, 0.7); lp.connect(E.zep); for (const f of [58, 58.7]) { const o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.connect(lp); o.start(); }
      const l = c.createOscillator(), g = G(0.0004, E.zep.gain); l.frequency.value = 0.2; l.connect(g); l.start(); }
  }

  const MODES = { dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10] };
  const PROG = { dorian: [[0, 6, 0, 3], [0, 3, 6, 0], [0, 4, 3, 0]], mixolydian: [[0, 6, 3, 0], [0, 3, 0, 4], [0, 6, 0, 3]], aeolian: [[0, 5, 6, 0], [0, 3, 6, 4], [0, 6, 5, 4]] };
  const EIGHTH = 0.42, BAR = 6 * EIGHTH;
  const M = { t: 0, bar: 0, key: 50, mode: "dorian", prog: PROG.dorian[0], md: 9, phrase: 0, voice: "fiddle", cache: new Map(), on: false };
  const note = (deg) => { const m = MODES[M.mode], i = ((deg % 7) + 7) % 7; return M.key + m[i] + 12 * Math.floor(deg / 7); };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function pluck(c, m) {
    let b = M.cache.get(m); if (b) return b;
    const R = c.sampleRate, f = hz(m), N = Math.max(2, Math.round(R / f)), len = Math.round(R * 1.9), buf = c.createBuffer(1, len, R), d = buf.getChannelData(0), ring = new Float32Array(N);
    for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    let lp = 0; for (let i = 0; i < N; i++) { lp += (ring[i] - lp) * 0.6; ring[i] = lp; }
    let p = 0; for (let i = 0; i < len; i++) { const a = ring[p], q = p + 1 === N ? 0 : p + 1, nx = ring[q]; d[i] = a; ring[p] = 0.5 * (a + nx) * 0.9965; p = q; }
    let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(d[i])); for (let i = 0; i < len; i++) d[i] /= pk || 1;
    M.cache.set(m, buf); if (M.cache.size > 40) M.cache.delete(M.cache.keys().next().value);
    return buf;
  }
  const out = (I, pan) => { const c = I.ctx; if (BS && cfg.spatial && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; p.connect(I.mus); return p; } return I.mus; };
  function voiceDone(nodes, t) { E.voices++; setTimeout(() => { E.voices--; for (const n of nodes) { try { n.disconnect(); } catch (e) {} } }, Math.max(0, (t - E.I.ctx.currentTime) * 1000) + 100); }
  function lute(I, m, t, vel) {
    if (E.voices > 30) return; const c = I.ctx, s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter(); s.buffer = pluck(c, m);
    f.type = "lowpass"; f.frequency.value = 2600 + vel * 2200; g.gain.setValueAtTime(vel, t); g.gain.setTargetAtTime(0.0001, t + 1.3, 0.2);
    const o = out(I, rnd(-0.35, 0.1)); s.connect(f); f.connect(g); g.connect(o); s.start(t); s.stop(t + 1.9); voiceDone([s, f, g, o], t + 2); E.notes++;
  }
  function fiddle(I, m, t, dur, vel) {
    if (E.voices > 30) return; const c = I.ctx, g = c.createGain(), f = c.createBiquadFilter(), lfo = c.createOscillator(), lg = c.createGain(), nodes = [g, f, lfo, lg], os = [];
    f.type = "lowpass"; f.frequency.value = Math.min(4200, hz(m) * 3 + 700); f.Q.value = 0.6;
    for (const dt of [-6, 6]) { const o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(m); o.detune.value = dt; o.connect(f); o.start(t); o.stop(t + dur + 0.4); os.push(o); }
    lfo.frequency.value = 5.2; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(7, t + 0.35); lfo.connect(lg); for (const o of os) lg.connect(o.detune); lfo.start(t); lfo.stop(t + dur + 0.4);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.5, t + 0.08); g.gain.setValueAtTime(vel * 0.5, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.25);
    const o = out(I, rnd(0.1, 0.4)); f.connect(g); g.connect(o); voiceDone([...nodes, ...os, o], t + dur + 0.5); E.notes++;
  }
  function pipe(I, m, t, dur, vel) {
    if (E.voices > 30) return; const c = I.ctx, g = c.createGain(), o1 = c.createOscillator(), o2 = c.createOscillator(), g2 = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    o1.frequency.value = hz(m + 12); o2.frequency.value = hz(m + 24); g2.gain.value = 0.18; lfo.frequency.value = 4.6; lg.gain.value = 5; lfo.connect(lg); lg.connect(o1.detune);
    o1.connect(g); o2.connect(g2); g2.connect(g); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.4, t + 0.1); g.gain.setValueAtTime(vel * 0.4, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.3);
    for (const x of [o1, o2, lfo]) { x.start(t); x.stop(t + dur + 0.5); } const o = out(I, rnd(0.15, 0.5)); g.connect(o); voiceDone([o1, o2, g, g2, lfo, lg, o], t + dur + 0.6); E.notes++;
  }
  function thump(I, t, vel) {
    if (E.voices > 30) return; const c = I.ctx, o = c.createOscillator(), g = c.createGain(); o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.18);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32); o.connect(g); g.connect(I.mus); o.start(t); o.stop(t + 0.35); voiceDone([o, g], t + 0.4);
  }
  function drone(I) {
    const c = I.ctx; E.drone = c.createGain(); E.drone.gain.value = 0; E.drone.connect(I.mus); E.droneO = [];
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420; lp.connect(E.drone);
    for (const [off, v] of [[-24, 0.5], [-17, 0.3], [-12, 0.2]]) { const o = c.createOscillator(), g = c.createGain(); o.type = "triangle"; o.frequency.value = hz(M.key + off); g.gain.value = v; o.connect(g); g.connect(lp); o.start(); E.droneO.push([o, off]); }
    const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = 0.06; lg.gain.value = 0.03; l.connect(lg); lg.connect(E.drone.gain); l.start();
  }
  function bar(I, t) {
    if (M.bar % 16 === 0 && M.bar) {
      const ms = Object.keys(MODES); M.mode = Math.random() < 0.55 ? M.mode : ms[(Math.random() * ms.length) | 0]; M.key = [50, 55, 48, 53, 52][(Math.random() * 5) | 0];
      for (const [o, off] of E.droneO) o.frequency.setTargetAtTime(hz(M.key + off), t, 0.8);
    }
    if (M.bar % 4 === 0) { const ps = PROG[M.mode]; M.prog = ps[(Math.random() * ps.length) | 0]; }
    const root = M.prog[M.bar % 4] - 7, chord = [root, root + 2, root + 4, root + 7], pat = [[0, 1, 2, 1, 2, 3], [0, 2, 1, 2, 3, 2], [0, 1, 2, 3, 2, 1]][(Math.random() * 3) | 0];
    pat.forEach((ci, i) => { if (Math.random() < 0.13 && i) return; lute(I, note(chord[ci]), t + i * EIGHTH + rnd(0, 0.012), (i % 3 ? 0.17 : 0.27) * rnd(0.85, 1.1)); });
    if (cfg.music > 0.7) { thump(I, t, 0.4); if (Math.random() < 0.7) thump(I, t + 3 * EIGHTH, 0.22); }
    if (M.bar % 4 === 0) { M.phrase = Math.random() < 0.62 ? 4 : 0; M.voice = Math.random() < 0.6 ? "fiddle" : "pipe"; }
    if (M.phrase > 0) {
      let p = 0; const ch = new Set([0, 2, 4].map((k) => ((root + k) % 7 + 7) % 7));
      while (p < 6) {
        const dur = [1, 2, 2, 3][(Math.random() * 4) | 0], d = Math.min(dur, 6 - p);
        const step = [-2, -1, -1, 0, 1, 1, 2][(Math.random() * 7) | 0]; M.md = clamp(M.md + step, 7, 14);
        if (p === 0 || (p % 3 === 0 && Math.random() < 0.6)) { let k = 0; while (!ch.has(((M.md % 7) + 7) % 7) && k++ < 3) M.md += M.md > 10 ? -1 : 1; }
        const nm = note(M.md), vel = rnd(0.6, 0.9), tt = t + p * EIGHTH;
        if (Math.random() < 0.9) (M.voice === "fiddle" ? fiddle : pipe)(I, nm, tt, d * EIGHTH * 0.92, vel);
        p += d;
      }
      M.phrase--;
    }
    M.bar++; E.bars++; E.mode = M.mode + " " + M.key;
  }

  function levels() {
    const I = E.I; if (!I) return; const c = I.ctx, t = c.currentTime;
    I.ambLvl.gain.setTargetAtTime(cfg.amb, t, 0.15); I.ui.gain.setTargetAtTime(cfg.fx, t, 0.1);
    I.mus.gain.setTargetAtTime(cfg.music * 0.38 * (E.scene ? 0.7 : 1), t, 0.4);
    if (E.drone) E.drone.gain.setTargetAtTime(cfg.music > 0 ? 0.05 : 0, t, 0.5);
    BS.setSpatial(cfg.spatial);
  }
  function fire(id, delayMs) {
    const st = STREAMS[id], db = rnd(st.db[0], st.db[1]), pan = rnd(-0.8, 0.8);
    if (id === "toast") { [0, 0.34, 0.62].forEach((d, k) => BS.play("clink", { amb: true, db: db - k, pan, delay: (delayMs || 0) + d * 1000, noHook: true })); E.plays += 3; return; }
    BS.play(st.cue, { amb: true, db, pan, delay: delayMs || 0, noHook: true }); E.plays++;
  }
  function tick() {
    const I = E.I; if (!I || !BS.running()) return; const c = I.ctx, now = c.currentTime, el = (performance.now() - E.t0) / 1000;
    E.weather = weatherAt(el); const w = E.weather, raining = smooth(0.4, 0.8, w);
    E.rain.gain.setTargetAtTime(0.0105 * raining, now, 3); E.wind.gain.setTargetAtTime(0.0038 * (0.35 + 0.65 * w) * (E.scene === "roads" ? 1.8 : 1), now, 3);
    E.zep.gain.setTargetAtTime(E.scene === "roads" ? 0.011 : 0, now, 2.5); E.rainLvl = raining;
    for (const id of Object.keys(STREAMS)) {
      const sc = scale(id); if (!sc) { delete E.next[id]; continue; }
      if (E.next[id] === undefined) { BS.ensure(STREAMS[id].cue); E.next[id] = now + rnd(0.4, 1.2) * Math.min(STREAMS[id].gap[0] * sc, 6); continue; }
      if (now >= E.next[id]) { fire(id); E.next[id] = now + rnd(STREAMS[id].gap[0], STREAMS[id].gap[1]) * sc; }
    }
    if ((PROF[E.scene] || {}).clock && now >= (E.nextClock || 0)) { E.nextClock = Math.max(now, E.nextClock || 0) + 1; BS.play(E.tk ^= 1 ? "tick" : "tock", { amb: true, db: -40, pan: -0.5, noHook: true }); }
    if (cfg.music > 0) {
      if (!M.on) { M.on = true; M.t = now + 0.4; levels(); }
      let guard = 0; while (M.t < now + 1.4 && guard++ < 1) { bar(I, M.t); M.t += BAR; }
    } else M.on = false;
  }

  const COMPANION = { open: [["whoosh", 0, -26], ["unfurl", 70, -30]], close: [["whoosh", 0, -32, 0.8]], flip: [["coin", 110, -30]], good: [], stamp: [["thunk", 0, -34]] };
  function cueHook(name) {
    if (!cfg.fx) return; const l = COMPANION[name]; if (!l) return;
    for (const [n, d, db, rate] of l) BS.play(n, { delay: d, db, rate, noHook: true });
    if (name === "open") hap("open"); else if (name === "close") hap("close");
  }
  const hap = (n) => { try { if (HP) HP.fire(n); } catch (e) {} };
  const ptr = { x: innerWidth / 2, t: 0 };
  for (const t of ["pointermove", "pointerdown", "touchstart"]) addEventListener(t, (e) => { const p = e.touches ? e.touches[0] : e; if (p) { ptr.x = p.clientX; ptr.t = performance.now(); } }, { passive: true, capture: true });
  BS.setPanSource(() => (performance.now() - ptr.t < 2500 ? clamp(ptr.x / Math.max(1, innerWidth) * 2 - 1, -1, 1) * 0.7 : 0));
  let lastHover = null, lastHoverT = 0;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || !E.run) return; const t = e.target.closest && e.target.closest("a.tile, [data-tab]");
    const now = performance.now(); if (t && t !== lastHover && now - lastHoverT > 90 && cfg.fx) { BS.play("hover", { noHook: true }); lastHoverT = now; } lastHover = t || null;
  }, true);
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button, a"); if (!b) return;
    if (b.disabled || b.closest('[aria-disabled="true"]')) return;
    let h = "tap";
    if (b.matches("a.tile")) h = "open"; else if (b.matches("[data-tab]")) h = "tab";
    const tx = (b.textContent || "").trim().toLowerCase();
    if (b.closest("#scene") && /^(i'm in|in|tentative|running late|out)$/.test(tx)) {
      h = "rsvp";
      if (E.run && cfg.fx) {
        if (/in$/.test(tx)) { BS.play("cork", { noHook: true }); BS.play("clink", { delay: 140, db: -26, noHook: true }); }
        else if (tx === "tentative") BS.play("thunk", { noHook: true }); else if (tx === "running late") BS.play("hoof", { db: -30, noHook: true }); else BS.play("door", { db: -30, noHook: true });
      }
    }
    if (b.id === "sense-btn" || b.closest("#sense-panel")) h = "tick";
    hap(h);
  }, true);

  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "text") n.textContent = v; else n.setAttribute(k, v); } for (const x of kids) if (x) n.append(x); return n; };
  const isOn = () => { try { return !!(window.__board && window.__board.sound() ); } catch (e) { return false; } };
  const setMaster = (v) => { const r = $("#vol"); if (r) { r.value = String(Math.round(v * 100)); r.dispatchEvent(new Event("input", { bubbles: true })); } };
  function applyPreset(name) {
    const p = PRESETS[name]; if (!p) return; Object.assign(cfg, p, { preset: name }); if (HP) HP.set(cfg.haptics, true); save(); levels(); sync(); wow();
  }
  function wow() { document.documentElement.classList.toggle("sense-wow", cfg.preset === "everything" && !reduced() && !saveData()); }
  function setCfg(k, v) {
    cfg[k] = v; cfg.preset = "custom"; if (k === "haptics" && HP) { HP.set(v, true); if (v) hap("success"); }
    if (k === "awake") wake(v); save(); levels(); sync();
  }
  let panel = null, btn = null;
  function slider(id, label, key) {
    const i = el("input", { type: "range", min: 0, max: 100, step: 5, id, "aria-label": label }); i.value = String(Math.round(cfg[key] * 100));
    i.addEventListener("input", () => setCfg(key, Number(i.value) / 100)); return el("label", { class: "sense-row" }, el("span", { text: label }), i);
  }
  function toggle(id, label, key) {
    const b = el("button", { type: "button", class: "sense-toggle", id, "aria-pressed": String(!!cfg[key]), text: label }); b.addEventListener("click", () => setCfg(key, !cfg[key])); return b;
  }
  function buildPanel() {
    btn = el("button", { type: "button", id: "sense-btn", class: "sense-fab", "aria-label": "Sensory settings", "aria-keyshortcuts": "S", "aria-expanded": "false", "aria-controls": "sense-panel", text: "Sensory" });
    panel = el("div", { id: "sense-panel", class: "sense-panel", role: "dialog", "aria-label": "Sensory settings", hidden: "" });
    const master = el("input", { type: "range", min: 0, max: 100, step: 5, id: "sense-master", "aria-label": "Master volume" }); master.value = String(Math.round(((window.__board && window.__board.audio().volume) || 0.7) * 100));
    master.addEventListener("input", () => setMaster(Number(master.value) / 100));
    const pre = el("div", { class: "sense-presets", role: "group", "aria-label": "Presets" });
    for (const [k, n] of [["quiet", "Quiet"], ["tavern", "Tavern"], ["everything", "Full"]] ) { const b = el("button", { type: "button", "data-preset": k, "aria-pressed": "false", text: n }); b.addEventListener("click", () => { applyPreset(k); if (!isOn() && window.__board) window.__board.sound(true); sync(); }); pre.append(b); }
    const onb = el("button", { type: "button", id: "sense-power", class: "sense-toggle", "aria-pressed": "false", text: "Sound: off" }); onb.addEventListener("click", () => { if (window.__board) window.__board.sound(!isOn()); setTimeout(sync, 80); });
    const hs = HP ? HP.support() : { any: false }, note = el("p", { class: "sense-note", id: "sense-note" });
    note.textContent = "Saved on this device only. " + (hs.any ? "Haptics: " + [hs.vibrate && "vibration", hs.ios && "iPhone tick", "controller rumble when one is connected"].filter(Boolean).join(", ") + "." : "Haptics need a phone or a controller; none found here.");
    panel.append(el("h2", { text: "Sensory" }), pre, el("label", { class: "sense-row" }, el("span", { text: "Master" }), master), slider("sense-music", "Music", "music"), slider("sense-amb", "Ambience", "amb"), slider("sense-fx", "Effects", "fx"),
      el("div", { class: "sense-toggles" }, onb, toggle("sense-haptics", "Haptics", "haptics"), toggle("sense-spatial", "Spatial", "spatial"), toggle("sense-awake", "Keep awake", "awake")), note);
    document.body.append(btn, panel);
    btn.addEventListener("click", () => openPanel(panel.hidden));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { openPanel(false); btn.focus(); } else if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || "")) && !e.target.isContentEditable) openPanel(panel.hidden); });
    document.addEventListener("pointerdown", (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) openPanel(false); }, true);
    sync();
  }
  function openPanel(open) { panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); if (open) { sync(); const f = panel.querySelector("button"); if (f) f.focus({ preventScroll: true }); } }
  function dock() {
    if (!btn) return;
    const foot = $("#footer"), head = E.scene && ($("#mode-btn-scene") || $("#scene-peek"));
    if (document.documentElement.classList.contains("phone-shell") || innerWidth < 700 || (E.scene && innerWidth < 1024)) {  if (btn.parentNode !== document.body) document.body.insertBefore(btn, panel); }
    else if (head) { if (btn.previousSibling !== head) head.parentNode.insertBefore(btn, head.nextSibling); }
    else if (foot && foot.firstChild !== btn) foot.insertBefore(btn, foot.firstChild);
  }
  function sync() {
    if (!panel) return; const on = isOn();
    const v = (id, x) => { const n = $("#" + id); if (n) n.value = String(Math.round(x * 100)); };
    v("sense-music", cfg.music); v("sense-amb", cfg.amb); v("sense-fx", cfg.fx);
    const m = $("#sense-master"), vol = $("#vol"); if (m && vol) m.value = vol.value;
    for (const [id, k] of [["sense-haptics", "haptics"], ["sense-spatial", "spatial"], ["sense-awake", "awake"]]) { const n = $("#" + id); if (n) n.setAttribute("aria-pressed", String(!!cfg[k])); }
    panel.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === cfg.preset)));
    const p = $("#sense-power"); if (p) { p.setAttribute("aria-pressed", String(on)); p.textContent = on ? "Sound: on" : "Sound: off"; }
  }

  let lock = null;
  async function wake(on) {
    try { if (!on) { if (lock) { await lock.release(); lock = null; } return; } if (navigator.wakeLock && !document.hidden) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { lock = null; }); } } catch (e) { lock = null; }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && cfg.awake && !lock) wake(true); });
  function media(on) {
    try {
      if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
      navigator.mediaSession.metadata = on ? new MediaMetadata({ title: "The tavern", artist: "Dungeons and Drinking", album: "Living Board" }) : null;
      navigator.mediaSession.playbackState = on ? "playing" : "paused";
      for (const [a, v] of [["play", true], ["pause", false]]) { try { navigator.mediaSession.setActionHandler(a, () => { if (window.__board) window.__board.sound(v); }); } catch (e) {} }
    } catch (e) {}
  }
  const LAUNCH = Date.parse("2026-11-04T23:00:00Z");
  function fanfare() { if (!E.run || !BS.running()) return false; BS.play("fanfare"); hap("fanfare"); return true; }
  function launchCheck() {
    const now = Date.now(); if (E.fanfared || now < LAUNCH || now > LAUNCH + 1800000) return;
    try { if (sessionStorage.getItem("board-fanfare")) { E.fanfared = true; return; } } catch (e) {}
    if (fanfare()) { E.fanfared = true; try { sessionStorage.setItem("board-fanfare", "1"); } catch (e) {} }
  }
  const INV = { el: null, life: 0, done: false, timer: 0, away: null, gone: null };
  try { INV.done = !!sessionStorage.getItem("board-invite"); } catch (e) {}
  function inviteEnd(used) {
    if (INV.away) removeEventListener("pointerdown", INV.away, true);
    if (INV.gone) { try { removeEventListener("scroll", INV.gone, true); } catch (e) {} }
    clearTimeout(INV.life); INV.life = 0; INV.away = INV.gone = null;
    const t = INV.el; INV.el = null;
    if (t) { t.classList.add("out"); setTimeout(() => t.remove(), 400); }
    if (used) { INV.done = true; try { sessionStorage.setItem("board-invite", "1"); } catch (e) {} }
  }
  function inviteTry() {
    if (INV.done || INV.el) return;
    const foot = $("#footer");
    if (isOn() || !btn || !foot || btn.parentNode !== foot || document.hidden || document.documentElement.classList.contains("play")) return;
    const t = el("div", { class: "sense-invite", role: "status" }), b = el("button", { type: "button", text: "Hear the tavern" }), x = el("button", { type: "button", class: "sense-x", "aria-label": "Dismiss", text: "×" });
    t.append(el("span", { text: "Sound is off." }), b, x); foot.insertBefore(t, btn.nextSibling); INV.el = t;
    INV.away = (e) => { if (!t.contains(e.target)) inviteEnd(true); };
    INV.gone = (e) => { if (!e || !e.target || e.target === document || e.target === document.documentElement || e.target === document.scrollingElement) inviteEnd(true); };
    b.addEventListener("click", () => { if (window.__board) window.__board.sound(true); inviteEnd(true); }); x.addEventListener("click", () => inviteEnd(true));
    INV.life = setTimeout(() => inviteEnd(true), 8000);
    addEventListener("pointerdown", INV.away, true); addEventListener("scroll", INV.gone, { capture: true, passive: true });
  }
  function invite() { if (!INV.done) setTimeout(inviteTry, 3500); }

  function start() {
    const I = BS.internals(); if (!I || E.run) return; E.run = true; E.I = I; E.t0 = performance.now();
    try { buildBeds(I); drone(I); } catch (e) { E.run = false; return; }
    BS.setCueHook(cueHook); levels(); clearInterval(E.timer); E.timer = setInterval(tick, 150);
    try { I.ctx.addEventListener("statechange", () => { if (I.ctx.state !== "running" && E.run && !document.hidden) { try { I.ctx.resume(); } catch (e) {} } }); } catch (e) {}
    media(true); sync(); setTimeout(() => { for (const n of ["coin", "good", "bad"]) BS.ensure(n); if (Math.abs(LAUNCH - Date.now()) < 864e5) BS.ensure("fanfare"); }, 6000); setTimeout(launchCheck, 2000); E.launchT = setInterval(launchCheck, 15000);
  }
  function stop() { M.on = false; media(false); sync(); }
  BS.onState((on) => { if (on) setTimeout(start, 0); else stop(); setTimeout(sync, 150); });
  function kit() {
    const K = window.__boardKit; if (!K) return false;
    K.on("scene", (key) => { E.scene = key; levels(); sync(); dock(); if (INV.el) inviteEnd(false); }); K.on("closed", () => { E.scene = null; levels(); dock(); if (!INV.done) setTimeout(inviteTry, 600); });
    K.on("rendered", dock); addEventListener("resize", dock); if (K.SC && K.SC.open) E.scene = K.SC.open; dock();
    return true;
  }
  function init() {
    if (HP) HP.set(cfg.haptics, cfg.haptics);
    buildPanel(); wow(); invite(); if (cfg.awake) wake(true);
    if (!kit()) { let n = 0; const iv = setInterval(() => { if (kit() || ++n > 40) clearInterval(iv); }, 250); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.BoardSensory = Object.freeze({
    PRESETS, STREAMS, PROF, fanfare, preset: applyPreset, set: setCfg, config: () => ({ ...cfg }), tick, scale,
    status: () => ({ run: E.run, scene: E.scene, plays: E.plays, notes: E.notes, voices: E.voices, bars: E.bars, mode: E.mode, weather: +E.weather.toFixed(2), rain: +E.rainLvl.toFixed(2), cfg: { ...cfg }, haptics: HP ? HP.status() : null, wake: !!lock, panel: !!panel }),
  });
})();
