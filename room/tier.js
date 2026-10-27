// The quality ladder (V7-SPEC 3.2): off / low / medium / high / ultra. Picks a tier from the device, runs a 2 s probe,
// remembers the result, takes the menu's override, and demotes on slow frames, a long start-up task or a lost context.
// off: no room, the 2D light and the wisps pause. low: the V6 page as it was (painted room, 2D light). medium: the 3D room,
// still lights, 30 fps. high: flickering lights, GPU wisps, bloom, 60 fps. ultra: high at full pixel ratio with more wisps;
// its soft shadows and reflections need a renderer library and stay off. auto never picks ultra.
//   import("./room/tier.js").then((m) => m.startTier(host))
//   host: { state, motion, launchEpoch, newSignup, select, moreButton }   state is the object window.__board.room() reads
export const ORDER = ["off", "low", "medium", "high", "ultra"];
export const BUDGET = { medium: 33.3, high: 16.7, ultra: 16.7 };
const KEY = "board-room", AUTO_KEY = "board-room-streak";
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
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return { tier: "off", why: ["reduced motion"] };
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
  if (coarse) { tier = "medium"; why.push("touch device"); }
  if (cores < 4) { tier = "medium"; why.push(`${cores} cores`); }
  if (tier === "high" && navigator.gpu) why.push("WebGPU present");
  return { tier, why: why.length ? why : ["capable GPU"], gpu, software };
}

export async function startTier(host) {
  const S = host.state;
  S.backend = "webgl2 (hand-written; a renderer library can replace room/gl2.js)";
  S.demotions = S.demotions || [];
  let room = null, canvas = null, probeT = 0;
  /* Default (2026-10-27, main session): the room ships OFF until a critic scores craft with it on at least equal to off
     (V7 round 2 and an independent round 3 both scored 3 against 4). A viewer turns it on from the menu; a stored
     "auto" is kept as a real choice so it stays reachable. Flip DEFAULT_CHOICE to "auto" when the gate passes. */
  const DEFAULT_CHOICE = "off";
  const pref = () => get(KEY) || DEFAULT_CHOICE;
  const setClasses = (t) => {
    html().classList.toggle("room-off", t === "off");
    html().classList.toggle("room-on", t === "medium" || t === "high" || t === "ultra");
    html().classList.toggle("room-wisps", t === "high" || t === "ultra");
    dispatchEvent(new Event("board-room"));
  };
  /* low keeps V6's 2D light and wisps; on a machine that cannot hold them (a software GPU) the same rule demotes to off */
  let lowRaf = 0;
  const watchLow = () => {
    cancelAnimationFrame(lowRaf);
    let last = 0, slow = []; const t0 = performance.now();
    const f = (now) => {
      if (S.tier !== "low") return;
      if (document.hidden) { last = 0; slow = []; lowRaf = requestAnimationFrame(f); return; } /* a background tab is throttled, not slow */
      if (last && now - t0 > 2000 && now - last > 50) slow.push(now);
      slow = slow.filter((x) => now - x < 5000); last = now;
      if (slow.length >= 3) { demote("three frames over 50 ms in 5 s"); return; }
      lowRaf = requestAnimationFrame(f);
    };
    lowRaf = requestAnimationFrame(f);
  };
  const stopRoom = () => { if (room) { room.stop(); room = null; } if (canvas) { canvas.remove(); canvas = null; } };
  const demote = (why) => {
    if (document.hidden) return; /* background throttling is never a reason to demote */
    const i = ORDER.indexOf(S.tier); if (i <= 0) return;
    const next = ORDER[i - 1];
    S.demotions.push({ from: S.tier, to: next, why, at: Math.round(performance.now()) });
    apply(next, `demoted: ${why}`); /* per session: never stored here */
  };
  async function apply(t, why) {
    S.tier = t; S.why = why;
    if (t === "off" || t === "low") { stopRoom(); setClasses(t); if (t === "low") watchLow(); return; }
    if (room) { room.setTier(t); setClasses(t); return; }
    canvas = document.createElement("canvas");
    canvas.id = "room"; canvas.setAttribute("aria-hidden", "true"); canvas.tabIndex = -1;
    const anchor = document.querySelector(".hero-art"); /* above the painting, under the candle glow and vignette */
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(canvas, anchor.nextSibling); else document.body.prepend(canvas);
    try {
      const { startRoom } = await import("./room.js");
      room = await startRoom({ tier: t, canvas, motion: host.motion, launchEpoch: host.launchEpoch, newSignup: host.newSignup, onSlow: () => demote("three frames over 50 ms in 5 s"), onStartCost: (ms) => { S.startCost = ms; /* recorded, never a demotion: the tier is judged on steady-state frames */ }, onLost: () => { stopRoom(); S.tier = "off"; S.why = "lost the WebGL context"; setClasses("off"); } });
      setClasses(S.tier);
      S.renderer = room.info.renderer; S.software = room.info.software;
    } catch (e) { stopRoom(); S.tier = "low"; S.why = `room did not start: ${e.message}`; setClasses("low"); }
  }
  /* the 2 s probe: frame intervals while the room runs; p95 over the tier's budget demotes one tier. It runs only while the
     page is visible: a hidden start waits for the first visible moment, and a probe that sees the page hidden is thrown away */
  const visible = () => (document.hidden ? new Promise((r) => { const h = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", h); r(); } }; document.addEventListener("visibilitychange", h); }) : Promise.resolve());
  const probe = () => new Promise((res) => {
    const d = []; let last = 0; const t0 = performance.now();
    const f = (now) => { if (document.hidden) { res({ d, aborted: true }); return; } if (last) d.push(now - last); last = now; if (now - t0 < 2000) probeT = requestAnimationFrame(f); else res({ d, aborted: false }); };
    probeT = requestAnimationFrame(f);
  });
  const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.95)] : 0; };
  /* the probe waits for the page to be idle after first paint: the DOM's own start-up is not the room's */
  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 600)));
  async function choose() {
    cancelAnimationFrame(probeT);
    const d = detect(); S.gpu = d.gpu || ""; S.detected = d.tier; S.detectWhy = d.why;
    const p = pref(); S.choice = p;
    if (d.tier === "off") { await apply("off", d.why.join(", ")); return; }
    if (p !== "auto") { await apply(p, "chosen in the menu"); return; }
    let record = null; try { record = JSON.parse(get(AUTO_KEY) || "null"); } catch (e) {}
    const start = startFrom(d.tier, S.gpu, record);
    await apply(start.tier, start.why || d.why.join(", "));
    let judged = !BUDGET[S.tier];
    if (BUDGET[S.tier]) {
      for (let tries = 0; tries < 6 && !judged; tries++) {
        if (document.hidden) S.probeWaiting = "the page is hidden; the probe waits for it to show";
        await visible(); await idle(); S.probeWaiting = null;
        const r = await probe();
        if (r.aborted) { S.probeAborted = (S.probeAborted || 0) + 1; continue; }
        const p95v = p95(r.d); S.probe = { tier: S.tier, p95: +p95v.toFixed(1), budget: BUDGET[S.tier] };
        if (p95v > BUDGET[S.tier]) demote(`probe p95 ${p95v.toFixed(1)} ms over ${BUDGET[S.tier]} ms`);
        judged = true;
      }
    }
    if (!judged) return; /* no visible verdict: the streak record is left as it was */
    const next = recordAfter(record, S.gpu, d.tier, S.tier);
    put(AUTO_KEY, next ? JSON.stringify(next) : null); S.record = next;
  }
  /* the menu: a select beside Sound on a desktop, a cycling button in More on a phone */
  const label = () => `Room: ${pref()}`;
  const sync = () => { if (host.select) host.select.value = pref(); if (host.moreButton) host.moreButton.textContent = label(); };
  const setPref = (v) => { put(KEY, v === DEFAULT_CHOICE ? null : v); sync(); choose(); };
  if (host.select) host.select.addEventListener("change", () => setPref(host.select.value));
  if (host.moreButton) host.moreButton.addEventListener("click", () => { const opts = ["auto", "off", "low", "medium", "high", "ultra"]; setPref(opts[(opts.indexOf(pref()) + 1) % opts.length]); });
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => choose());
  put("board-room-auto", null); /* the first build's ratcheting record, if a browser still has it */
  sync();
  S.status = () => (room ? room.status() : null);
  await choose();
  return { choose, demote, status: () => ({ ...S, room: room ? room.status() : null }) };
}
