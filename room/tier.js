// The quality ladder (V7-SPEC 3.2): off / low / medium / high / ultra. Picks a tier from the device, runs a 2 s probe,
// remembers the result, takes the menu's override, and demotes on slow frames, a long start-up task or a lost context.
// off: no room, the 2D light and the wisps pause. low: the V6 page as it was (painted room, 2D light). medium: the 3D room,
// still lights, 30 fps. high: flickering lights, GPU dust and embers, every display refresh (V13a). ultra: high at full pixel ratio with more dust;
// on three.js (V10) every 3D tier has soft shadows drawn once; ultra gets the sharper shadow maps. auto never picks ultra.
// 2026-10-30: the room draws in a Web Worker on an OffscreenCanvas where the browser has them, so its first frame, its
// shader compile and its textures never block the page; the page's own thread runs the same room.js when they are missing
// or the worker fails. This file is the page side of both: one set of listeners feeds whichever room runs, and the room's
// light position, slow verdicts and status come back the same way. The worker is never a change in the ladder's rules.
//   import("./room/tier.js").then((m) => m.startTier(host))
//   host: { state, motion, launchEpoch, newSignup, select, moreButton, aim, signal, onLight, tiltOn }   state is the object window.__board.room() reads
export const ORDER = ["off", "low", "medium", "high", "ultra"];
export const BUDGET = { medium: 33.3, high: 16.7, ultra: 16.7 };
/* V13a: how long a scene change or a resize (QUIET) and an input (INPUT_QUIET) keep the judges from counting frames */
export const QUIET = 1500, INPUT_QUIET = 1000;
/* the low tier's watch: one 2 s window every LOW_GAP ms, done after LOW_CLEAN clean windows */
export const LOW_GAP = 6000, LOW_CLEAN = 4;
/* the worker handshake: how long the page waits for the worker module to say it is up before it draws the room itself */
export const WORKER_UP_MS = 15000;
export function p95(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0; }
/* fix E7 (2026-10-30): the long-frame rule. renderer.render() alone missed the owner's 27 fps tavern room (worst frame 429 ms): the cost
   was GPU and compositor time, which the page's own frame intervals carry. Over the last LONG_WIN ms of intervals (quiet moments
   left out, and only once the watch has run that long), more than LONG_SHARE of them over twice the tier's budget, or two over
   HUGE_MS, is slow; a slow window asks for one step at most every LONG_GAP ms. stepFor() takes the step: one rung, never below low,
   never over a menu choice. Pure, so check.mjs and fix-e.mjs feed them synthetic frames. */
export const LONG_WIN = 3000, LONG_SHARE = 0.25, HUGE_MS = 250, LONG_GAP = 10000;
export function longJudge() {
  const q = []; let t0 = 0, long = 0, huge = 0, lastStep = -1e9;
  const J = {
    win: null,
    push(now, dt, tier) {
      const b = BUDGET[tier]; if (!b || !(dt > 0)) return null;
      if (!t0) t0 = now - dt;
      const L = dt > 2 * b ? 1 : 0, H = dt > HUGE_MS ? 1 : 0; q.push([now, L, H]); long += L; huge += H;
      while (q.length && now - q[0][0] > LONG_WIN) { const o = q.shift(); long -= o[1]; huge -= o[2]; }
      const n = q.length, slow = now - t0 >= LONG_WIN && (long / n > LONG_SHARE || huge >= 2);
      J.win = { tier, n, long, huge, share: +(long / n).toFixed(3), over: +(2 * b).toFixed(1), slow, at: Math.round(now) };
      if (!slow || now - lastStep < LONG_GAP) return null;
      lastStep = now; const v = J.win; J.reset(now); return v;
    },
    reset(now) { q.length = 0; long = huge = 0; t0 = now || 0; },
  };
  return J;
}
export const stepFor = (tier, verdict, chosen) => (verdict && verdict.slow && !chosen && ORDER.indexOf(tier) > ORDER.indexOf("low") ? ORDER[ORDER.indexOf(tier) - 1] : tier);
const KEY = "board-room", AUTO_KEY = "board-room-streak", RM = "(prefers-reduced-motion: reduce)";
const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const put = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
const html = () => document.documentElement;

/* Memory (fixed 2026-10-27): only a menu choice is remembered as is. An auto load always starts from the detected tier;
   a demotion is per session. Only STREAK loads in a row that each ended below the detected tier persist a lower start,
   and that record expires after DECAY_DAYS, so a one-off slow start (cold cache, a background tab, a reload storm) never
   ratchets a capable GPU down. Pure functions, so check.mjs can test them in node. */
export const STREAK = 3, DECAY_DAYS = 7;
export function startFrom(detected, gpu, record, now = Date.now()) {
  const live = record && record.gpu === gpu && record.streak >= STREAK && ORDER.includes(record.low) && now - (record.at || 0) < DECAY_DAYS * 864e5;
  if (live && ORDER.indexOf(record.low) < ORDER.indexOf(detected)) return { tier: record.low, why: `${record.streak} slow loads in a row on this GPU` };
  return { tier: detected, why: null };
}
export function recordAfter(record, gpu, detected, ended, now = Date.now()) {
  if (ORDER.indexOf(ended) >= ORDER.indexOf(detected)) return null; /* a clean load clears the streak */
  const same = record && record.gpu === gpu;
  const low = same && ORDER.includes(record.low) && ORDER.indexOf(record.low) < ORDER.indexOf(ended) ? record.low : ended;
  return { gpu, streak: (same ? record.streak || 0 : 0) + 1, low, at: now };
}

export function detect() {
  const why = [];
  if (matchMedia(RM).matches) return { tier: "off", why: ["reduced motion"] };
  if (navigator.connection && navigator.connection.saveData) return { tier: "off", why: ["data saver"] };
  let gpu = "", software = false, gl2 = false;
  try {
    const c = document.createElement("canvas"), gl = c.getContext("webgl2");
    if (gl) { gl2 = true; const d = gl.getExtension("WEBGL_debug_renderer_info"); gpu = String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); }
  } catch (e) {}
  software = /swiftshader|llvmpipe|software|basic render|warp/i.test(gpu);
  if (!gl2) return { tier: "low", why: ["no WebGL2"], gpu };
  if (software) return { tier: "low", why: ["software GPU"], gpu, software };
  let tier = "high";
  const mem = navigator.deviceMemory || 8, coarse = matchMedia("(pointer: coarse)").matches, cores = navigator.hardwareConcurrency || 4;
  if (mem < 4) { tier = "medium"; why.push(`device memory ${mem} GB`); }
  if (coarse) return { tier: "low", why: ["touch device: a phone shows almost none of the room"], gpu, software };
  if (cores < 4) { tier = "medium"; why.push(`${cores} cores`); }
  if (tier === "high" && navigator.gpu) why.push("WebGPU present");
  return { tier, why: why.length ? why : ["capable GPU"], gpu, software };
}

/* the page as the room sees it (room.js ctx.env): its size, the board's rectangle for the gutters, and the states a worker
   cannot read for itself */
export function pageEnv() {
  const a = document.querySelector("#main") || document.body, r = a.getBoundingClientRect();
  /* wide: the 2026-10-29 wide-gamut switch (?hdr=0 or html.hdr-off from js/hdr.js) and the display's gamut, read here because tavern.js has no page in the worker */
  const wide = { off: /[?&]hdr=0(?:&|#|$)/.test(location.search || "") || html().classList.contains("hdr-off"), p3: matchMedia("(color-gamut: p3)").matches };
  return { W: innerWidth, H: innerHeight, dpr: window.devicePixelRatio || 1, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, reduce: matchMedia(RM).matches, hidden: document.hidden, sceneOpen: html().classList.contains("scene-open"), wide };
}
/* the worker needs a module Worker, an OffscreenCanvas and a canvas that can hand itself over; ?room-worker=off (a preview
   switch for the harness) forces the page's own thread */
export const canWorker = () => typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function" && !/[?&]room-worker=off\b/.test(location.search);

export async function startTier(host) {
  const S = host.state;
  S.backend = "three.js 0.170.0 (vendor/three.module.min.js), modelled in room/tavern.js";
  S.demotions = S.demotions || [];
  let room = null, canvas = null, probeT = 0;
  /* Default: "auto" since V10 (2026-10-27). The V7 room shipped off after four critics scored its craft 3 against 4. The
     three.js room passed a fresh blind panel (four critics, room on 87 against off 85; board/V10-NOTES.md). A viewer can
     still pick "off" in the menu, and that choice is remembered. On a phone auto means low: the painted page. */
  const DEFAULT_CHOICE = "auto";
  const pref = () => (html().classList.contains("play") ? "off" : get(KEY) || DEFAULT_CHOICE);
  const setClasses = (t) => {
    html().classList.toggle("room-off", t === "off");
    html().classList.toggle("room-on", t === "medium" || t === "high" || t === "ultra");
    html().classList.toggle("room-wisps", t === "medium" || t === "high" || t === "ultra"); /* the 2D wisps never float over the 3D room */
    dispatchEvent(new Event("board-room"));
  };
  /* V13a: the page's own work is never the room's fault. A scene opening or closing, a resize and any input (a key, a tap,
     a wheel, a scroll) quiet the judges for QUIET ms; the startup probe waits for a quiet moment and starts over when one ends */
  let quietUntil = performance.now() + QUIET;
  const hush = (ms = QUIET) => { quietUntil = Math.max(quietUntil, performance.now() + ms); };
  const quiet = () => performance.now() < quietUntil;
  let sceneWas = html().classList.contains("scene-open");
  /* V13b (phone-deep T1): a phone's first scene opening and closing are the slowest frames it draws; they never count, and
     the quiet after a phone's scene change is twice as long */
  const coarse = matchMedia("(pointer: coarse)").matches;
  new MutationObserver(() => { const o = html().classList.contains("scene-open"); if (o !== sceneWas) { sceneWas = o; hush(coarse ? QUIET * 2 : QUIET); if (room) room.scene(o); } }).observe(html(), { attributes: true, attributeFilter: ["class"] });
  for (const t of ["keydown", "pointerdown", "wheel", "touchstart", "resize"]) addEventListener(t, () => hush(INPUT_QUIET), { passive: true, capture: true });
  addEventListener("scroll", () => hush(INPUT_QUIET), { passive: true, capture: true });
  /* the page side of the room (2026-10-30): a resize (one per frame), the tab hiding or showing, reduced motion, and for the
     worker the aim, which the page's shared light position wakes on every move (js/board.js aimAt), sent once a frame */
  let rsz = 0; addEventListener("resize", () => { if (!rsz) rsz = requestAnimationFrame(() => { rsz = 0; if (room) room.resize(pageEnv()); }); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (room) room.visible(!document.hidden); });
  const A = host.aim ? host.aim() : null; let aimT = 0;
  const sendAim = () => { if (!aimT) aimT = requestAnimationFrame(() => { aimT = 0; if (room && room.aim && A) room.aim(A.tx == null ? null : A.tx, A.ty == null ? null : A.ty); }); };
  if (A) { const prev = A.wake; A.wake = () => { if (prev) prev(); sendAim(); }; html().addEventListener("pointerleave", sendAim); }
  S.pop = (at, amp, ms) => { if (room && room.pop) room.pop(at, amp, ms); }; /* a fire crackle's pop on the shared flicker (js/board.js) */
  /* low keeps V6's 2D light and wisps; on a machine that cannot hold them (a software GPU) the same judge demotes to off:
     the p95 frame interval of two quiet 2 s windows in a row over 50 ms. A frame in a window that was not quiet throws
     the window away. V13a: the watch samples one 2 s window every LOW_GAP ms while the wall shows (the light and wisps run
     only there), and stops after LOW_CLEAN clean windows, so a phone is not kept awake by a loop that measures nothing. */
  let lowRaf = 0, lowTimer = 0;
  const watchLow = () => {
    cancelAnimationFrame(lowRaf); clearTimeout(lowTimer);
    let last = 0, d = [], w0 = 0, slowWins = 0, clean = 0; const t0 = performance.now();
    const later = () => { cancelAnimationFrame(lowRaf); lowRaf = 0; last = 0; d = []; w0 = 0; lowTimer = setTimeout(() => { lowRaf = requestAnimationFrame(f); }, LOW_GAP); };
    const f = (now) => {
      if (S.tier !== "low") return;
      if (document.hidden || quiet() || now - t0 < 2000 || html().classList.contains("scene-open")) { later(); return; } /* a background tab is throttled, not slow */
      if (last) d.push(now - last);
      last = now; if (!w0) w0 = now;
      if (now - w0 >= 2000) {
        const v = p95(d); S.lowP95 = +v.toFixed(1); S.lowWindows = (S.lowWindows || 0) + 1;
        slowWins = v > 50 ? slowWins + 1 : 0; clean = v > 50 ? 0 : clean + 1;
        /* V13b: a phone needs three slow quiet windows in a row, and a viewer who switched the tilt on keeps the light */
        if (slowWins >= (coarse ? 3 : 2) && !(host.tiltOn && host.tiltOn())) { slowWins = 0; slow(`frame p95 ${v.toFixed(1)} ms over 50 ms in ${coarse ? "three" : "two"} quiet 2 s windows`); if (S.tier !== "low") return; }
        if (clean >= LOW_CLEAN) return; /* this machine holds the low tier: the watch ends */
        if (!slowWins) { later(); return; }
        d = []; w0 = now;
      }
      lowRaf = requestAnimationFrame(f);
    };
    lowRaf = requestAnimationFrame(f);
  };
  /* fix E7: the long-frame watch, while a 3D tier shows (a menu choice runs it too, so its window reaches the status; slow() keeps the choice) */
  let longRaf = 0;
  const watchLong = () => {
    cancelAnimationFrame(longRaf);
    const J = longJudge(); let last = 0;
    const f = (now) => {
      longRaf = 0; if (!BUDGET[S.tier] || !room) return;
      if (document.hidden || quiet()) last = 0;
      else { const v = last ? J.push(now, now - last, S.tier) : null; last = now; S.longWin = J.win;
        if (v && stepFor(S.tier, v, false) !== S.tier) { S.longSteps = (S.longSteps || 0) + 1; slow(`${v.long} of ${v.n} frames over ${v.over} ms${v.huge ? `, ${v.huge} over ${HUGE_MS} ms` : ""} in ${LONG_WIN / 1000} s`); } }
      longRaf = requestAnimationFrame(f);
    };
    longRaf = requestAnimationFrame(f);
  };
  /* a tier the viewer picked in the menu is never demoted: the slow verdict is recorded and nothing changes */
  const slow = (why) => {
    if (get(KEY)) { S.slowKept = (S.slowKept || 0) + 1; S.slowWhy = `kept ${S.tier} (chosen in the menu): ${why}`; return; }
    demote(why);
  };
  const stopRoom = () => { if (room) { room.stop(); room = null; } if (canvas) { canvas.remove(); canvas = null; } };
  const demote = (why) => {
    if (document.hidden) return; /* background throttling is never a reason to demote */
    const i = ORDER.indexOf(S.tier); if (i <= 0) return;
    const next = ORDER[i - 1];
    S.demotions.push({ from: S.tier, to: next, why, at: Math.round(performance.now()) });
    apply(next, `demoted: ${why}`); /* per session: never stored here */
  };
  const lost = () => { stopRoom(); S.tier = "off"; S.why = "lost the WebGL context"; setClasses("off"); };
  /* the canvas under the hero's shade (its painting hides while the room is on), the candle glow and the vignette: the room
     gets the same scrim the painting had, so the heading reads the same over either */
  const mount = () => {
    const c = document.createElement("canvas");
    c.id = "room"; c.setAttribute("aria-hidden", "true"); c.tabIndex = -1; S.transferred = false;
    const anchor = document.querySelector(".hero-art");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(c, anchor); else document.body.prepend(c);
    return c;
  };
  /* the room in its worker: the handshake (up, then the canvas goes over, then started or fail), the messages back, and a
     room-shaped proxy for the ladder. Resolves null when the worker cannot run it, and the page draws the room itself. */
  const viaWorker = (cv, t) => new Promise((res) => {
    let w = null, timer = 0, settled = false, dead = false, mirror = null, info = null, drawn = false;
    const fail = (why) => { S.workerWhy = why; if (settled) return; settled = true; clearTimeout(timer); dead = true; try { if (w) w.terminate(); } catch (e) {} res(null); };
    try { w = new Worker(new URL("./worker.js?v=6c902d45f5", import.meta.url), { type: "module" }); } catch (e) { fail(`no module worker: ${e && e.message}`); return; }
    timer = setTimeout(() => fail(`the worker did not answer in ${WORKER_UP_MS / 1000} s`), WORKER_UP_MS);
    w.onerror = (e) => { if (!settled) fail(`worker error: ${(e && e.message) || "unknown"}`); else if (room === proxy) lost(); };
    const send = (m) => { if (!dead) w.postMessage(m); };
    const proxy = {
      via: "worker", get info() { return info; },
      setTier: (next) => send({ t: "tier", tier: next }), refresh: (next) => send({ t: "refresh", next }), status: () => mirror,
      resize: (env) => send({ t: "resize", env }), scene: (o) => send({ t: "scene", open: !!o }), visible: (on) => send({ t: "visible", on: !!on }), motion: (r) => send({ t: "motion", reduce: !!r }),
      aim: (x, y) => send({ t: "aim", x, y }), pop: (at, amp, ms) => send({ t: "pop", at, amp, ms }),
      stop: () => { send({ t: "stop" }); dead = true; setTimeout(() => { try { w.terminate(); } catch (e) {} }, 500); },
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.t === "up") {
        let off; try { off = cv.transferControlToOffscreen(); } catch (x) { fail(`the canvas would not transfer: ${x && x.message}`); return; }
        S.transferred = true;
        try { w.postMessage({ t: "init", canvas: off, tier: t, env: pageEnv(), motion: host.motion, launchEpoch: host.launchEpoch, newSignup: host.newSignup, timeOrigin: performance.timeOrigin }, [off]); }
        catch (x) { fail(`the canvas would not go over: ${x && x.message}`); return; }
        /* the worker is up: from here the only failure is the room itself, which has no time limit on a slow start */
        clearTimeout(timer); return;
      }
      if (m.t === "fail") { fail(`room did not start in the worker: ${m.message}`); return; }
      if (m.t === "started") { if (settled) return; settled = true; info = m.info; mirror = m.status; res(proxy); return; }
      if (dead || room !== proxy) return;
      if (m.t === "frame" && !drawn) { drawn = true; mirror = mirror ? { ...mirror, frames: m.frames } : mirror; setClasses(S.tier); return; } /* the photograph gives way only once the room has drawn */
      if (m.t === "status") { mirror = m.status; return; }
      if (m.t === "light") { if (host.onLight) host.onLight(m.x, m.y, m.n); return; }
      if (m.t === "slow") { slow(m.why || "slow frames"); return; }
      if (m.t === "startCost") { S.startCost = m.ms; return; } /* recorded, never a demotion: the tier is judged on steady-state frames */
      if (m.t === "lost") lost();
    };
  });
  /* the room on the page's own thread: the path every browser took before 2026-10-30, and the fallback */
  const viaPage = async (cv, t) => {
    const { startRoom } = await import("./room.js?v=30df1642a8");
    const r = await startRoom({ tier: t, canvas: cv, env: pageEnv(), motion: host.motion, launchEpoch: host.launchEpoch, newSignup: host.newSignup, aim: host.aim, signal: host.signal, onLight: host.onLight, onSlow: (why) => slow(why || "slow frames"), onStartCost: (ms) => { S.startCost = ms; }, onLost: lost });
    r.via = "page"; return r;
  };
  async function apply(t, why) {
    S.tier = t; S.why = why;
    if (t === "off" || t === "low") { stopRoom(); setClasses(t); if (t === "low") watchLow(); return; }
    if (room) { room.setTier(t); setClasses(t); watchLong(); return; }
    canvas = mount();
    try {
      let r = canWorker() ? await viaWorker(canvas, t) : null;
      if (!r) {
        if (S.transferred) { canvas.remove(); canvas = mount(); S.transferred = false; } /* a canvas handed to a worker cannot draw on the page again */
        r = await viaPage(canvas, t);
      }
      room = r; S.via = r.via;
      S.renderer = r.info.renderer; S.software = r.info.software; S.colorSpace = r.info.colorSpace; S.wideWhy = r.info.wideWhy;
      if (r.via === "page") setClasses(S.tier); /* same frame as the page room's first draw; the worker's first frame sets the classes itself */
      watchLong();
    } catch (e) { stopRoom(); S.tier = "low"; S.why = `room did not start: ${e.message}`; setClasses("low"); }
  }
  /* the 2 s probe: frame intervals while the room runs; p95 over the tier's budget demotes one tier. It runs only while the
     page is visible: a hidden start waits for the first visible moment, and a probe that sees the page hidden is thrown away */
  const visible = () => (document.hidden ? new Promise((r) => { const h = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", h); r(); } }; document.addEventListener("visibilitychange", h); }) : Promise.resolve());
  const probe = () => new Promise((res) => {
    const d = []; let last = 0; const t0 = performance.now();
    const f = (now) => { if (document.hidden || quiet()) { res({ d, aborted: true }); return; } if (last) d.push(now - last); last = now; if (now - t0 < 2000) probeT = requestAnimationFrame(f); else res({ d, aborted: false }); };
    probeT = requestAnimationFrame(f);
  });
  /* the probe waits for the page to be idle after first paint and for a quiet moment: the DOM's own start-up and a scene
     opening are not the room's */
  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 600)));
  const calm = async () => { while (quiet()) await new Promise((r) => setTimeout(r, Math.max(50, quietUntil - performance.now()))); };
  async function choose() {
    cancelAnimationFrame(probeT);
    if (html().classList.contains("play")) { S.choice = "off"; await apply("off", "Play mode"); return; } /* no GPU probe in Play: no WebGL context at all */
    const d = detect(); S.gpu = d.gpu || ""; S.detected = d.tier; S.detectWhy = d.why;
    const p = pref(); S.choice = p;
    if (d.tier === "off") { await apply("off", d.why.join(", ")); return; }
    if (p !== "auto") { await apply(p, get(KEY) ? "chosen in the menu" : `${p} by default`); return; }
    let record = null; try { record = JSON.parse(get(AUTO_KEY) || "null"); } catch (e) {}
    const start = startFrom(d.tier, S.gpu, record);
    await apply(start.tier, start.why || d.why.join(", "));
    let judged = !BUDGET[S.tier];
    if (BUDGET[S.tier]) {
      for (let tries = 0; tries < 6 && !judged; tries++) {
        if (document.hidden) S.probeWaiting = "the page is hidden; the probe waits for it to show";
        await visible(); await idle(); await calm(); S.probeWaiting = null;
        const r = await probe();
        if (r.aborted) { S.probeAborted = (S.probeAborted || 0) + 1; continue; }
        const p95v = p95(r.d); S.probe = { tier: S.tier, p95: +p95v.toFixed(1), budget: BUDGET[S.tier] };
        if (p95v > BUDGET[S.tier]) demote(`probe p95 ${p95v.toFixed(1)} ms over ${BUDGET[S.tier]} ms`);
        judged = true;
      }
    }
    if (!judged || pref() !== p) return; /* no visible verdict, or Play mode or a menu choice came in during the probe: the streak record is left as it was */
    const next = recordAfter(record, S.gpu, d.tier, S.tier);
    put(AUTO_KEY, next ? JSON.stringify(next) : null); S.record = next;
  }
  /* the menu: a select beside Sound on a desktop, a cycling button in More on a phone */
  const label = () => `Room: ${pref()}`;
  const sync = () => { if (host.select) host.select.value = pref(); if (host.moreButton) host.moreButton.textContent = label(); };
  const setPref = (v) => { put(KEY, v === DEFAULT_CHOICE ? null : v); sync(); choose(); };
  if (host.select) host.select.addEventListener("change", () => setPref(host.select.value));
  if (host.moreButton) host.moreButton.addEventListener("click", () => { const opts = ["auto", "off", "low", "medium", "high", "ultra"]; setPref(opts[(opts.indexOf(pref()) + 1) % opts.length]); });
  matchMedia(RM).addEventListener("change", (e) => { if (room) room.motion(e.matches); choose(); });
  addEventListener("board-mode", () => choose()); /* js/mode.js: html.play on or off, pref() reads it */
  put("board-room-auto", null); /* the first build's ratcheting record, if a browser still has it */
  sync();
  S.status = () => (room ? room.status() : null);
  await choose();
  return { choose, demote, status: () => ({ ...S, room: room ? room.status() : null }) };
}
