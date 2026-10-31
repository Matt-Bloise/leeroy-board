export const ORDER = ["off", "low", "medium", "high", "ultra"];
export const BUDGET = { medium: 33.3, high: 16.7, ultra: 16.7 };
export const QUIET = 1500, INPUT_QUIET = 1000;
export const LOW_GAP = 6000, LOW_CLEAN = 4;
export const WORKER_UP_MS = 15000;
export function p95(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0; }
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

export const STREAK = 3, DECAY_DAYS = 7;
export function startFrom(detected, gpu, record, now = Date.now()) {
  const live = record && record.gpu === gpu && record.streak >= STREAK && ORDER.includes(record.low) && now - (record.at || 0) < DECAY_DAYS * 864e5;
  if (live && ORDER.indexOf(record.low) < ORDER.indexOf(detected)) return { tier: record.low, why: `${record.streak} slow loads in a row on this GPU` };
  return { tier: detected, why: null };
}
export function recordAfter(record, gpu, detected, ended, now = Date.now()) {
  if (ORDER.indexOf(ended) >= ORDER.indexOf(detected)) return null;
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

export function pageEnv() {
  const a = document.querySelector("#main") || document.body, r = a.getBoundingClientRect();
  const wide = { off: /[?&]hdr=0(?:&|#|$)/.test(location.search || "") || html().classList.contains("hdr-off"), p3: matchMedia("(color-gamut: p3)").matches };
  return { W: innerWidth, H: innerHeight, dpr: window.devicePixelRatio || 1, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, reduce: matchMedia(RM).matches, hidden: document.hidden, sceneOpen: html().classList.contains("scene-open"), wide };
}
export const canWorker = () => typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function" && !/[?&]room-worker=off\b/.test(location.search);

export async function startTier(host) {
  const S = host.state;
  S.backend = "three.js 0.170.0 (vendor/three.module.min.js), modelled in room/tavern.js";
  S.demotions = S.demotions || [];
  let room = null, canvas = null, probeT = 0;
  const DEFAULT_CHOICE = "auto";
  const pref = () => (html().classList.contains("play") ? "off" : get(KEY) || DEFAULT_CHOICE);
  const setClasses = (t) => {
    html().classList.toggle("room-off", t === "off");
    html().classList.toggle("room-on", t === "medium" || t === "high" || t === "ultra");
    html().classList.toggle("room-wisps", t === "medium" || t === "high" || t === "ultra");
    dispatchEvent(new Event("board-room"));
  };
  let quietUntil = performance.now() + QUIET;
  const hush = (ms = QUIET) => { quietUntil = Math.max(quietUntil, performance.now() + ms); };
  const quiet = () => performance.now() < quietUntil;
  let sceneWas = html().classList.contains("scene-open");
  const coarse = matchMedia("(pointer: coarse)").matches;
  new MutationObserver(() => { const o = html().classList.contains("scene-open"); if (o !== sceneWas) { sceneWas = o; hush(coarse ? QUIET * 2 : QUIET); if (room) room.scene(o); } }).observe(html(), { attributes: true, attributeFilter: ["class"] });
  for (const t of ["keydown", "pointerdown", "wheel", "touchstart", "resize"]) addEventListener(t, () => hush(INPUT_QUIET), { passive: true, capture: true });
  addEventListener("scroll", () => hush(INPUT_QUIET), { passive: true, capture: true });
  let rsz = 0; addEventListener("resize", () => { if (!rsz) rsz = requestAnimationFrame(() => { rsz = 0; if (room) room.resize(pageEnv()); }); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (room) room.visible(!document.hidden); });
  const A = host.aim ? host.aim() : null; let aimT = 0;
  const sendAim = () => { if (!aimT) aimT = requestAnimationFrame(() => { aimT = 0; if (room && room.aim && A) room.aim(A.tx == null ? null : A.tx, A.ty == null ? null : A.ty); }); };
  if (A) { const prev = A.wake; A.wake = () => { if (prev) prev(); sendAim(); }; html().addEventListener("pointerleave", sendAim); }
  S.pop = (at, amp, ms) => { if (room && room.pop) room.pop(at, amp, ms); };
  let lowRaf = 0, lowTimer = 0;
  const watchLow = () => {
    cancelAnimationFrame(lowRaf); clearTimeout(lowTimer);
    let last = 0, d = [], w0 = 0, slowWins = 0, clean = 0; const t0 = performance.now();
    const later = () => { cancelAnimationFrame(lowRaf); lowRaf = 0; last = 0; d = []; w0 = 0; lowTimer = setTimeout(() => { lowRaf = requestAnimationFrame(f); }, LOW_GAP); };
    const f = (now) => {
      if (S.tier !== "low") return;
      if (document.hidden || quiet() || now - t0 < 2000 || html().classList.contains("scene-open")) { later(); return; }
      if (last) d.push(now - last);
      last = now; if (!w0) w0 = now;
      if (now - w0 >= 2000) {
        const v = p95(d); S.lowP95 = +v.toFixed(1); S.lowWindows = (S.lowWindows || 0) + 1;
        slowWins = v > 50 ? slowWins + 1 : 0; clean = v > 50 ? 0 : clean + 1;
        if (slowWins >= (coarse ? 3 : 2) && !(host.tiltOn && host.tiltOn())) { slowWins = 0; slow(`frame p95 ${v.toFixed(1)} ms over 50 ms in ${coarse ? "three" : "two"} quiet 2 s windows`); if (S.tier !== "low") return; }
        if (clean >= LOW_CLEAN) return;
        if (!slowWins) { later(); return; }
        d = []; w0 = now;
      }
      lowRaf = requestAnimationFrame(f);
    };
    lowRaf = requestAnimationFrame(f);
  };
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
  const slow = (why) => {
    if (get(KEY)) { S.slowKept = (S.slowKept || 0) + 1; S.slowWhy = `kept ${S.tier} (chosen in the menu): ${why}`; return; }
    demote(why);
  };
  const stopRoom = () => { if (room) { room.stop(); room = null; } if (canvas) { canvas.remove(); canvas = null; } };
  const demote = (why) => {
    if (document.hidden) return;
    const i = ORDER.indexOf(S.tier); if (i <= 0) return;
    const next = ORDER[i - 1];
    S.demotions.push({ from: S.tier, to: next, why, at: Math.round(performance.now()) });
    apply(next, `demoted: ${why}`);
  };
  const lost = () => { stopRoom(); S.tier = "off"; S.why = "lost the WebGL context"; setClasses("off"); };
  const mount = () => {
    const c = document.createElement("canvas");
    c.id = "room"; c.setAttribute("aria-hidden", "true"); c.tabIndex = -1; S.transferred = false;
    const anchor = document.querySelector(".hero-art");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(c, anchor); else document.body.prepend(c);
    return c;
  };
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
        clearTimeout(timer); return;
      }
      if (m.t === "fail") { fail(`room did not start in the worker: ${m.message}`); return; }
      if (m.t === "started") { if (settled) return; settled = true; info = m.info; mirror = m.status; res(proxy); return; }
      if (dead || room !== proxy) return;
      if (m.t === "frame" && !drawn) { drawn = true; mirror = mirror ? { ...mirror, frames: m.frames } : mirror; setClasses(S.tier); return; }
      if (m.t === "status") { mirror = m.status; return; }
      if (m.t === "light") { if (host.onLight) host.onLight(m.x, m.y, m.n); return; }
      if (m.t === "slow") { slow(m.why || "slow frames"); return; }
      if (m.t === "startCost") { S.startCost = m.ms; return; }
      if (m.t === "lost") lost();
    };
  });
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
        if (S.transferred) { canvas.remove(); canvas = mount(); S.transferred = false; }
        r = await viaPage(canvas, t);
      }
      room = r; S.via = r.via;
      S.renderer = r.info.renderer; S.software = r.info.software; S.colorSpace = r.info.colorSpace; S.wideWhy = r.info.wideWhy;
      if (r.via === "page") setClasses(S.tier);
      watchLong();
    } catch (e) { stopRoom(); S.tier = "low"; S.why = `room did not start: ${e.message}`; setClasses("low"); }
  }
  const visible = () => (document.hidden ? new Promise((r) => { const h = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", h); r(); } }; document.addEventListener("visibilitychange", h); }) : Promise.resolve());
  const probe = () => new Promise((res) => {
    const d = []; let last = 0; const t0 = performance.now();
    const f = (now) => { if (document.hidden || quiet()) { res({ d, aborted: true }); return; } if (last) d.push(now - last); last = now; if (now - t0 < 2000) probeT = requestAnimationFrame(f); else res({ d, aborted: false }); };
    probeT = requestAnimationFrame(f);
  });
  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 600)));
  const calm = async () => { while (quiet()) await new Promise((r) => setTimeout(r, Math.max(50, quietUntil - performance.now()))); };
  async function choose() {
    cancelAnimationFrame(probeT);
    if (html().classList.contains("play")) { S.choice = "off"; await apply("off", "Play mode"); return; }
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
    if (!judged || pref() !== p) return;
    const next = recordAfter(record, S.gpu, d.tier, S.tier);
    put(AUTO_KEY, next ? JSON.stringify(next) : null); S.record = next;
  }
  const label = () => `Room: ${pref()}`;
  const sync = () => { if (host.select) host.select.value = pref(); if (host.moreButton) host.moreButton.textContent = label(); };
  const setPref = (v) => { put(KEY, v === DEFAULT_CHOICE ? null : v); sync(); choose(); };
  if (host.select) host.select.addEventListener("change", () => setPref(host.select.value));
  if (host.moreButton) host.moreButton.addEventListener("click", () => { const opts = ["auto", "off", "low", "medium", "high", "ultra"]; setPref(opts[(opts.indexOf(pref()) + 1) % opts.length]); });
  matchMedia(RM).addEventListener("change", (e) => { if (room) room.motion(e.matches); choose(); });
  addEventListener("board-mode", () => choose());
  put("board-room-auto", null);
  sync();
  S.status = () => (room ? room.status() : null);
  await choose();
  return { choose, demote, status: () => ({ ...S, room: room ? room.status() : null }) };
}
