/* Haptics: one grammar, one switch, one pulse per gesture (mobile build, section 6, 2026-10-30). Full note: board/MOBILE-NOTES.md, file notes. */
(() => {
  if (typeof window === "undefined" || typeof navigator === "undefined" || typeof document === "undefined" || typeof addEventListener !== "function") return; /* a bare script host (a test harness) gets nothing */
  const freeze = (a) => Object.freeze(a);
  const CANON = freeze({
    select: freeze([8]),
    confirm: freeze([14, 40, 14]),
    boundary: freeze([5]),
    success: freeze([10, 50, 10, 50, 30]),
    refusal: freeze([40, 60, 40]),
    fanfare: freeze([20, 60, 20, 60, 20, 60, 80]),
  });
  const ALIAS = freeze({ tap: "select", tick: "select", tab: "select", open: "select", close: "select", rsvp: "confirm", error: "refusal" });
  const GRAMMAR = freeze([
    freeze({ name: "select", meaning: "a place, a tab, a chip, a coin, a card flip, a scene open or close, a sheet snap", pattern: CANON.select, aliases: freeze(["tap", "tick", "tab", "open", "close"]) }),
    freeze({ name: "confirm", meaning: "a sign-up answer, a sheet line saved, a journey picked, a launch state set", pattern: CANON.confirm, aliases: freeze(["rsvp"]) }),
    freeze({ name: "boundary", meaning: "the end of a swipe, a sheet pulled past full, a list end reached by a flick", pattern: CANON.boundary, aliases: freeze([]) }),
    freeze({ name: "success", meaning: "a Dispatch sent, haptics switched on", pattern: CANON.success, aliases: freeze([]) }),
    freeze({ name: "refusal", meaning: "a write refused, a control that needs a board link, a save that failed", pattern: CANON.refusal, aliases: freeze(["error"]) }),
    freeze({ name: "fanfare", meaning: "the launch moment, once", pattern: CANON.fanfare, aliases: freeze([]) }),
  ]);
  /* PAT: the six, every alias, and hover (silent). Frozen so no call site can change a pattern. */
  const PAT = {};
  for (const k of Object.keys(CANON)) PAT[k] = CANON[k];
  for (const a of Object.keys(ALIAS)) PAT[a] = CANON[ALIAS[a]];
  PAT.hover = freeze([]);
  Object.freeze(PAT);
  const WIN = 120, SPENT = 1000;
  const SPECULATIVE = freeze([
    "the iOS switch tick inside the Discord iOS app",
    "navigator.vibrate inside the Discord Android web view",
    "the 5 ms boundary pattern on Android (raise to 8 ms if the probe says it is not felt)",
    "the low-power heuristic (the web cannot read battery saver)",
  ]);
  const H = { on: false, explicit: false, fired: 0, last: "", via: "none", dropped: 0 };
  const G = { at: -1e9, down: false, dead: false, best: null, name: "", first: 0, sent: false, timer: 0 };
  let low = false;
  const reduce = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const strength = (p) => p.reduce((a, b, i) => a + (i % 2 ? 0 : b), 0);
  const disabled = (t) => { try { return !!(t && t.closest && t.closest('[aria-disabled="true"], :disabled')); } catch (e) { return false; } };
  const canon = (name) => (Object.prototype.hasOwnProperty.call(ALIAS, name) ? ALIAS[name] : name);
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
  /* low power: read at start and on every change; the web cannot see battery saver, so this is the level and charging state only */
  const readBattery = (b) => { low = !!b && typeof b.level === "number" && b.level <= 0.2 && !b.charging; };
  try {
    if (typeof navigator.getBattery === "function") navigator.getBattery().then((b) => {
      readBattery(b);
      for (const ev of ["levelchange", "chargingchange"]) { try { b.addEventListener(ev, () => readBattery(b)); } catch (e) {} }
    }, () => {});
  } catch (e) {}
  const cssSwitch = () => { try { return !!(window.CSS && typeof CSS.supports === "function" && CSS.supports("appearance", "switch")); } catch (e) { return false; } };
  const vibrateOK = () => typeof navigator.vibrate === "function";
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent || "") && !vibrateOK() && cssSwitch(); /* iOS 18 and later: the switch appearance exists; earlier iOS stays silent */
  const route = () => (vibrateOK() ? "vibrate" : ios ? "ios-switch" : "none");
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
    try { if (vibrateOK() && navigator.vibrate(p)) via = "vibrate"; } catch (e) {}
    if (via === "none" && ios) { try { let n = 0; for (let i = 0; i < p.length; i += 2) { const k = n++; if (k === 0) tickIOS(); else setTimeout(() => { try { tickIOS(); } catch (e) {} }, p.slice(0, i).reduce((a, b) => a + b, 0)); } via = "ios-switch"; } catch (e) {} }
    try {
      const ms = Math.min(250, strength(p));
      for (const g of pads.values()) { const a = g.vibrationActuator; if (a && a.playEffect) { a.playEffect("dual-rumble", { duration: ms, strongMagnitude: 0.35, weakMagnitude: 0.5 }); via = via === "none" ? "gamepad" : via + "+gamepad"; } }
    } catch (e) {}
    return via;
  }
  function flush() {
    G.timer = 0; if (G.sent || !G.best) return; G.sent = true;
    try { if (G.dead || !H.on || document.hidden || low) return; H.last = G.name; const via = pulse(G.best); if (via !== "none") { H.fired++; H.via = via; } } catch (e) {}
  }
  /* true when the call joined this gesture's pulse (or opened it); false when silent, off, low power or the gesture is spent */
  function fire(name) {
    try {
      if (!H.on || document.hidden || low || (reduce() && !H.explicit)) return false;
      const key = canon(String(name || "select"));
      const p = Object.prototype.hasOwnProperty.call(CANON, key) ? CANON[key] : (PAT[name] !== undefined ? PAT[name] : CANON.select);
      if (!p.length) return false; /* hover: silent */
      const t = now();
      if (t - G.at >= SPENT) begin(false); /* no input for a second: this call opens its own window */
      if (G.dead || G.sent || (G.best && t - G.first > WIN)) { H.dropped++; return false; }
      if (!G.best) { G.best = p; G.name = key; G.first = t; G.timer = setTimeout(flush, WIN); }
      else { H.dropped++; if (strength(p) > strength(G.best)) { G.best = p; G.name = key; } }
      return true;
    } catch (e) {}
    return false;
  }
  window.BoardHaptics = Object.freeze({
    PAT, GRAMMAR, fire,
    support: () => ({ vibrate: vibrateOK(), ios, gamepads: pads.size, any: vibrateOK() || ios || pads.size > 0 }),
    set: (on, explicit) => { H.on = !!on; if (explicit !== undefined) H.explicit = !!explicit; },
    status: () => ({ ...H, reduced: reduce(), grammar: true, lowPower: low, route: route(), speculative: SPECULATIVE.slice() }),
  });
})();
