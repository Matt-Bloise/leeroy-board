/* Haptics (audio-sensory pass). Feature-detected, never throws, off until the visitor opts in (Sensory panel or a preset).
   Android and desktop Chrome: navigator.vibrate. iPhone Safari 18+: a hidden <input type=checkbox switch> toggled by a label click
   inside a user gesture gives a system tick (one tick per call, so patterns become a short run of ticks). Gamepads: the
   vibrationActuator of any connected controller. prefers-reduced-motion keeps haptics off unless the visitor switched them on.
   One buzz per gesture (2026-10-30): a gesture starts at a trusted pointerdown or keydown (or a click with neither before it);
   every fire() in the 120 ms after the first one joins a single pulse, the strongest pattern by vibrating time wins, and it is
   sent when that window closes. Then the gesture is spent: later calls (the five's card flips, a cue that lands after the click)
   are dropped until the next gesture, or until 1 s has passed with no input. A gesture on a disabled control (disabled, or
   aria-disabled="true" on it or an ancestor) never vibrates, and a pointercancel (the touch became a scroll) drops a pulse still
   waiting. A call with no gesture around it (the launch fanfare) opens its own window. WebKit carries a gesture through timers
   under 1 s, so the iPhone tick still lands in it. */
(() => {
  if (typeof window === "undefined" || typeof navigator === "undefined" || typeof document === "undefined" || typeof addEventListener !== "function") return; /* a bare script host (a test harness) gets nothing */
  const PAT = { tap: [8], hover: [3], tab: [12], open: [16, 30, 10], close: [10], rsvp: [14, 40, 14], success: [10, 50, 10, 50, 30], error: [40, 60, 40], tick: [4], fanfare: [20, 60, 20, 60, 20, 60, 80] };
  const WIN = 120, SPENT = 1000;
  const H = { on: false, explicit: false, fired: 0, last: "", via: "none", dropped: 0 };
  const G = { at: -1e9, down: false, dead: false, best: null, name: "", first: 0, sent: false, timer: 0 };
  const reduce = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const strength = (p) => p.reduce((a, b, i) => a + (i % 2 ? 0 : b), 0);
  const disabled = (t) => { try { return !!(t && t.closest && t.closest('[aria-disabled="true"], :disabled')); } catch (e) { return false; } };
  function begin(dead) { clearTimeout(G.timer); G.timer = 0; G.at = now(); G.dead = !!dead; G.best = null; G.name = ""; G.sent = false; }
  try {
    addEventListener("pointerdown", (e) => { if (e.isTrusted) { begin(disabled(e.target)); G.down = true; } }, { capture: true, passive: true });
    addEventListener("keydown", (e) => { if (e.isTrusted) begin(disabled(e.target)); }, { capture: true, passive: true });
    /* a press held past 1 s is still one gesture: its release restarts the clock, so the click after it stays in */
    addEventListener("pointerup", (e) => { if (e.isTrusted && G.down) { G.down = false; G.at = now(); } }, { capture: true, passive: true });
    addEventListener("pointercancel", (e) => { if (!e.isTrusted) return; G.down = false; if (!G.sent) G.dead = true; }, { capture: true, passive: true });
    /* the click that ends a tap or a key press stays in its gesture; a click with no input before it starts one */
    addEventListener("click", (e) => { if (!e.isTrusted) return; if (now() - G.at < SPENT) { G.at = now(); if (disabled(e.target)) G.dead = true; } else begin(disabled(e.target)); }, { capture: true, passive: true });
  } catch (e) {}
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent || "") && typeof navigator.vibrate !== "function";
  let sw = null, pads = new Map();
  try {
    addEventListener("gamepadconnected", (e) => { if (e.gamepad && e.gamepad.vibrationActuator) pads.set(e.gamepad.index, e.gamepad); });
    addEventListener("gamepaddisconnected", (e) => { pads.delete(e.gamepad.index); });
  } catch (e) {}
  function tickIOS() {
    if (!sw) {
      const l = document.createElement("label"); l.setAttribute("aria-hidden", "true"); l.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      const i = document.createElement("input"); i.type = "checkbox"; i.setAttribute("switch", ""); i.tabIndex = -1; l.appendChild(i); document.body.appendChild(l); sw = l;
    }
    sw.click();
  }
  function pulse(p) {
    let via = "none";
    try { if (typeof navigator.vibrate === "function" && navigator.vibrate(p)) via = "vibrate"; } catch (e) {}
    if (via === "none" && ios) { try { let n = 0; for (let i = 0; i < p.length; i += 2) { const k = n++; if (k === 0) tickIOS(); else setTimeout(() => { try { tickIOS(); } catch (e) {} }, p.slice(0, i).reduce((a, b) => a + b, 0)); } via = "ios-switch"; } catch (e) {} }
    try {
      const ms = Math.min(250, p.reduce((a, b, i) => a + (i % 2 ? 0 : b), 0));
      for (const g of pads.values()) { const a = g.vibrationActuator; if (a && a.playEffect) { a.playEffect("dual-rumble", { duration: ms, strongMagnitude: 0.35, weakMagnitude: 0.5 }); via = via === "none" ? "gamepad" : via + "+gamepad"; } }
    } catch (e) {}
    return via;
  }
  function flush() {
    G.timer = 0; if (G.sent || !G.best) return; G.sent = true;
    try { if (G.dead || !H.on || document.hidden) return; H.last = G.name; const via = pulse(G.best); if (via !== "none") { H.fired++; H.via = via; } } catch (e) {}
  }
  /* true when the call joined this gesture's pulse (or opened it); false when haptics are off or the gesture is spent */
  function fire(name) {
    try {
      if (!H.on || document.hidden || (reduce() && !H.explicit)) return false;
      const t = now(), p = PAT[name] || PAT.tap;
      if (t - G.at >= SPENT) begin(false); /* no input for a second: this call opens its own window */
      if (G.dead || G.sent || (G.best && t - G.first > WIN)) { H.dropped++; return false; }
      if (!G.best) { G.best = p; G.name = name; G.first = t; G.timer = setTimeout(flush, WIN); }
      else { H.dropped++; if (strength(p) > strength(G.best)) { G.best = p; G.name = name; } }
      return true;
    } catch (e) {}
    return false;
  }
  window.BoardHaptics = Object.freeze({
    PAT, fire, support: () => ({ vibrate: typeof navigator.vibrate === "function", ios, gamepads: pads.size, any: typeof navigator.vibrate === "function" || ios || pads.size > 0 }),
    set: (on, explicit) => { H.on = !!on; if (explicit !== undefined) H.explicit = !!explicit; }, status: () => ({ ...H, reduced: reduce() }),
  });
})();
