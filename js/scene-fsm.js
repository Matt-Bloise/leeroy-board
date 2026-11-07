/* Cinematic slice 3: the scene open/close state machine, a pure module (no DOM, no globals, timers injected) so every transition, interruption and watchdog can be unit tested.
   States: closed, opening, open, closing. The visual work (showing the layer, classes, focus, scroll) is done by the effects the board passes in; this module decides WHEN and guarantees an end:
   every move to opening or closing arms a hard watchdog at about 1.5 x the transition, so even if no animation event ever arrives the state converges to open or closed and the effects' settled() runs.
   An interruption (open while closing, close while opening) just changes the target state, bumps the generation (a stale timer does nothing) and starts the other transition. Reduced motion (instant()) settles at once.
   Effects: enter(state, ctx) when opening or closing begins, retarget(ctx) when open is asked for while already opening or open, settled(state, { forced, ctx }) when open or closed is reached.
   Loaded as a classic script (window.SceneFSM) and read by tests/unit/scene-fsm.test.mjs. */
(function (root, factory) { if (typeof module === "object" && module && module.exports) module.exports = factory(); else root.SceneFSM = factory(); })(typeof self !== "undefined" ? self : this, function () {
"use strict";
function create(opts) {
  const o = Object.assign({ openMs: 520, closeMs: 540, factor: 1.5, instant: () => false, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t), effects: {}, onError: null }, opts || {});
  let state = "closed", gen = 0, timer = null, ctx = null;
  const fx = (name, ...a) => { const f = o.effects && o.effects[name]; if (!f) return; try { f(...a); } catch (e) { if (o.onError) o.onError(name, e); } }; // an effect that throws never stops the state from converging
  const disarm = () => { if (timer !== null) { o.clearTimer(timer); timer = null; } };
  const arm = (ms) => { disarm(); const g = gen; timer = o.setTimer(() => { timer = null; if (g === gen) settle(true); }, Math.ceil(ms * o.factor)); };
  function settle(forced) {
    if (state === "opening") { state = "open"; disarm(); fx("settled", "open", { forced: !!forced, ctx }); }
    else if (state === "closing") { state = "closed"; disarm(); fx("settled", "closed", { forced: !!forced, ctx }); }
  }
  function open(c) {
    ctx = c;
    if (state === "opening" || state === "open") { fx("retarget", c); return state; }
    gen++; state = "opening"; fx("enter", "opening", c);
    if (o.instant()) settle(false); else arm(o.openMs);
    return state;
  }
  function close(c) {
    if (state === "closed" || state === "closing") return state;
    if (c !== undefined) ctx = Object.assign({}, ctx, c);
    gen++; state = "closing"; fx("enter", "closing", ctx);
    if (o.instant()) settle(false); else arm(o.closeMs);
    return state;
  }
  /* an animation or transition ended: settle early when it is for the current move */
  const transitionEnd = () => { settle(false); };
  const destroy = () => { disarm(); gen++; };
  /* the layer was closed directly (a glided close, browser back): back to closed without effects, any move in flight forgotten */
  const reset = () => { disarm(); gen++; state = "closed"; ctx = null; };
  return { open, close, transitionEnd, destroy, reset, get state() { return state; }, get generation() { return gen; }, get armed() { return timer !== null; } };
}
return { create, FACTOR: 1.5 };
});
