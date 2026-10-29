/* Haptics (audio-sensory pass). Feature-detected, never throws, off until the visitor opts in (Sensory panel or a preset).
   Android and desktop Chrome: navigator.vibrate. iPhone Safari 18+: a hidden <input type=checkbox switch> toggled by a label click
   inside a user gesture gives a system tick (one tick per call, so patterns become a short run of ticks). Gamepads: the
   vibrationActuator of any connected controller. prefers-reduced-motion keeps haptics off unless the visitor switched them on. */
(() => {
  if (typeof window === "undefined" || typeof navigator === "undefined" || typeof document === "undefined" || typeof addEventListener !== "function") return; /* a bare script host (a test harness) gets nothing */
  const PAT = { tap: [8], hover: [3], tab: [12], open: [16, 30, 10], close: [10], rsvp: [14, 40, 14], success: [10, 50, 10, 50, 30], error: [40, 60, 40], tick: [4], fanfare: [20, 60, 20, 60, 20, 60, 80] };
  const H = { on: false, explicit: false, fired: 0, last: "", via: "none" };
  const reduce = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
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
  function fire(name) {
    try {
      if (!H.on || document.hidden || (reduce() && !H.explicit)) return false;
      const p = PAT[name] || PAT.tap; H.last = name; const via = pulse(p); if (via !== "none") { H.fired++; H.via = via; return true; }
    } catch (e) {}
    return false;
  }
  window.BoardHaptics = Object.freeze({
    PAT, fire, support: () => ({ vibrate: typeof navigator.vibrate === "function", ios, gamepads: pads.size, any: typeof navigator.vibrate === "function" || ios || pads.size > 0 }),
    set: (on, explicit) => { H.on = !!on; if (explicit !== undefined) H.explicit = !!explicit; }, status: () => ({ ...H, reduced: reduce() }),
  });
})();
