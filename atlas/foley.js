// The Atlas's sounds (contract 3.6), synthesized on BoardSound's buses. Nothing is built before the visitor turns sound on
// (internals() is null until then); every call is guarded. wind and surf are slow noise beds that fade out within 2 s of
// the Atlas closing; horn is two low brass notes on a crossing; quill is the board's own cue on a drawn course.
const DB = (d) => Math.pow(10, d / 20);
export function createFoley(o) {
  const F = { on: false, built: false, nodes: null, destroyed: false, active: false, listening: false, stopT: 0, played: [] };
  const sound = o.sound || null;
  const reduced = () => !!(o.reduced && o.reduced());
  const I = () => { try { return sound && sound.internals ? sound.internals() : null; } catch (e) { return null; } };
  F.state = () => ({ on: F.on, built: F.built, active: F.active });

  function build() {
    if (F.built || F.destroyed) return F.built;
    const bus = I(); if (!bus || !bus.ctx) return false;
    try {
      const c = bus.ctx, R = c.sampleRate || 48000, buf = c.createBuffer(1, R * 2, R), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = () => { const s = c.createBufferSource(); s.buffer = buf; s.loop = true; s.start(c.currentTime); return s; };
      const filt = (type, f, q) => { const x = c.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
      const gain = (v, to) => { const g = c.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
      const wind = gain(0, bus.amb), surf = gain(0, bus.amb);
      const w = noise(), wf = filt("bandpass", 420, 0.7); w.connect(wf); wf.connect(wind);
      const s = noise(), sf = filt("lowpass", 900, 0.6); s.connect(sf); sf.connect(surf);
      F.nodes = { c, bus, wind, surf, srcs: [w, s] };
      F.built = true;
    } catch (e) { F.built = false; }
    return F.built;
  }
  const ramp = (g, v, t) => { try { g.gain.setTargetAtTime(v, F.nodes.c.currentTime, t); } catch (e) { /* ignore */ } };

  // vars: { wind: 0..1 (louder over The Barrens and Durotar, 0 over sea), surf: 0..1 (near the coast ring) }
  F.update = (v) => {
    if (!F.active || !F.on || reduced() || !F.built) return;
    ramp(F.nodes.wind, DB(-44) * Math.max(0, Math.min(1, v.wind)), 0.8);
    ramp(F.nodes.surf, DB(-46) * Math.max(0, Math.min(1, v.surf)), 0.8);
  };
  F.start = () => {
    F.active = true; clearTimeout(F.stopT);
    if (F.on && !reduced()) build();
  };
  F.stop = () => {
    F.active = false;
    if (!F.built) return;
    ramp(F.nodes.wind, 0, 0.4); ramp(F.nodes.surf, 0, 0.4);
    clearTimeout(F.stopT);
    F.stopT = setTimeout(() => { if (!F.active && F.nodes) for (const s of F.nodes.srcs) { try { s.stop(); } catch (e) { /* ignore */ } } if (!F.active) { F.nodes = null; F.built = false; } }, 2000);
  };
  F.cue = (type) => {
    if (F.destroyed || !F.on) return false;
    if (type === "quill") { try { sound.play("quill", { noHook: true }); F.played.push("quill"); return true; } catch (e) { return false; } }
    if (type !== "horn" || reduced()) return false;
    const bus = I(); if (!bus || !bus.ctx) return false;
    try {
      const c = bus.ctx, t0 = c.currentTime, lp = c.createBiquadFilter(), g = c.createGain();
      lp.type = "lowpass"; lp.frequency.value = 260; g.gain.value = 0; lp.connect(g); g.connect(bus.ui || bus.master);
      const peak = DB(-30);
      [[98, 0, 0.9], [73.4, 0.85, 1.6]].forEach(([f, at, len]) => {
        const osc = c.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = f; osc.connect(lp);
        g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(peak, t0 + at + 0.12); g.gain.linearRampToValueAtTime(0, t0 + at + len);
        osc.start(t0 + at); osc.stop(t0 + at + len + 0.05);
      });
      F.played.push("horn"); return true;
    } catch (e) { return false; }
  };
  F.destroy = () => { F.destroyed = true; F.active = false; clearTimeout(F.stopT); if (F.nodes) for (const s of F.nodes.srcs) { try { s.stop(); } catch (e) { /* ignore */ } } F.nodes = null; F.built = false; };

  // follow the board's sound switch; the listener cannot be removed, so it checks the destroyed flag
  try { F.on = !!(o.soundOn && o.soundOn()); } catch (e) { F.on = false; }
  if (sound && sound.onState && !F.listening) { F.listening = true; sound.onState((on) => { if (F.destroyed) return; F.on = !!on; if (on && F.active && !reduced()) build(); if (!on && F.built) F.stop(); }); }
  return F;
}
