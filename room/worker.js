// The room's Web Worker (2026-10-30): room.js's own loop on an OffscreenCanvas, off the page's thread, so the room's first
// frame, its shader compile and its canvas textures never block the wall. tier.js owns it: it transfers the canvas in,
// forwards every change on the page (a resize, a scene opening or closing, the tab hiding, the pointer's aim, reduced
// motion, a tier change, a refresh, the fire's pops) as a message, and takes the room's light position, slow verdicts,
// start cost, context loss and status back the same way. Nothing here touches the DOM.
//   new Worker("./worker.js", { type: "module" })   then   { t: "init", canvas, tier, env, motion, launchEpoch, newSignup, timeOrigin }
import { startRoom } from "./room.js?v=30df1642a8";

/* the shared flicker (js/board.js flickBase): the same three octaves on the page's own clock, so the hearth and the card
   highlights flicker together; a crackle's pop comes over as a message with the page's time stamp */
const flickHash = (i) => { const v = Math.sin(i * 127.1 + 311.7 * 7.31) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
const flickOct = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return flickHash(i) * (1 - u) + flickHash(i + 1) * u; };
const flickBase = (s) => 1.25 * (0.55 * flickOct(s * 1.9) + 0.3 * flickOct(s * 4.3 + 17) + 0.15 * flickOct(s * 9.7 + 41));
const POP = { at: -1, amp: 0, ms: 75 };
const flickPop = (s) => { if (POP.at < 0) return 0; const d = s * 1000 - POP.at; return d < 0 || d > POP.ms ? 0 : POP.amp * (1 - d / POP.ms); };
let skew = 0; /* seconds from this worker's clock to the page's (their time origins differ by the worker's start) */
const signal = (s) => { const p = s + skew; return Math.max(-1, Math.min(1, flickBase(p) + flickPop(p))); };

let room = null, frames = 0, told = 0;
const A = { tx: null, ty: null }; /* the aim the page forwards: viewport pixels, or null when nobody points */
const post = (m) => postMessage(m);
onmessage = async (e) => {
  const m = e.data;
  if (m.t === "init") {
    skew = (m.timeOrigin - performance.timeOrigin) / 1000;
    try {
      room = await startRoom({ tier: m.tier, canvas: m.canvas, env: m.env, motion: m.motion, launchEpoch: m.launchEpoch, newSignup: m.newSignup, aim: () => A, signal,
        yieldTask: () => new Promise((r) => setTimeout(r, 0)), /* a worker has no frame to yield to: a plain task break between the start-up steps */
        onLight: (x, y, n) => post({ t: "light", x, y, n }), onSlow: (why) => post({ t: "slow", why }), onStartCost: (ms) => post({ t: "startCost", ms }), onLost: () => post({ t: "lost" }),
        onFrame: () => { if (!frames++) post({ t: "frame", frames: 1 }); } });
      post({ t: "started", info: room.info, status: room.status() });
    } catch (err) { post({ t: "fail", message: String((err && err.message) || err) }); }
    return;
  }
  if (!room) return;
  switch (m.t) {
    case "resize": room.resize(m.env); break;
    case "scene": room.scene(m.open); break;
    case "visible": room.visible(m.on); break;
    case "aim": A.tx = m.x; A.ty = m.y; break;
    case "motion": room.motion(m.reduce); break;
    case "tier": room.setTier(m.tier); break;
    case "refresh": room.refresh(m.next || {}); break;
    case "pop": POP.at = m.at; POP.amp = m.amp; POP.ms = m.ms || 75; break;
    case "status": post({ t: "status", status: room.status() }); break;
    case "stop": room.stop(); room = null; close(); break;
  }
};
/* the page's status mirror: a fresh snapshot once a second while the room draws, so window.__board.room() stays current */
setInterval(() => { if (room && frames !== told) { told = frames; post({ t: "status", status: room.status() }); } }, 1000);
post({ t: "up" });
