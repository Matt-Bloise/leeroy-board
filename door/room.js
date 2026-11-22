// The tavern room, on entry only. Nothing of it loads before a person presses "Step inside": three.js (about 700 KB) and the room's four textures
// (about 800 KB) come with room/room.js, the board's own scene, drawn here at its "medium" tier: at most 30 frames a second, device pixel ratio 1,
// no shadows. The room pauses when the tab is hidden, rests after 30 s without input (the last frame stays, nothing is drawn), and is stopped with its
// WebGL context released when the dialog closes. Under reduced motion, with data saver on, without WebGL2 or on a software GPU the painting is shown
// instead and no WebGL starts (?room=gl lets a test start it on a software GPU).
const RM = matchMedia("(prefers-reduced-motion: reduce)");
const REST_MS = 30000, CLOSE_MS = 320;
const STILL = { srcset: "/img/door/door-hero-54.w768.webp 768w, /img/door/door-hero-54.w1200.webp 1200w, /img/tavern-hero.w1672.webp 1672w", src: "/img/door/door-hero-54.w768.webp" };

function webgl(force) {
  try {
    const c = document.createElement("canvas"), gl = c.getContext("webgl2");
    if (!gl) return "This browser has no WebGL2, so the room is shown as a painting.";
    const d = gl.getExtension("WEBGL_debug_renderer_info"), r = String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    if (!force && /swiftshader|llvmpipe|software|basic render|warp/i.test(r)) return "This device draws 3D without a graphics card, so the room is shown as a painting.";
    return "";
  } catch (e) { return "The room could not start here, so it is shown as a painting."; }
}

let session = null;
export async function openRoom({ dialog, opener }) {
  if (session || dialog.open) return;
  const say = dialog.querySelector("#room-d"), stage = dialog.querySelector("#room-stage"), still = dialog.querySelector("#room-still"), closeBtn = dialog.querySelector("#room-x");
  // a fresh canvas each time: closing releases the old one's WebGL context for good
  const old = stage.querySelector("canvas"), canvas = document.createElement("canvas");
  canvas.id = "room-canvas"; canvas.setAttribute("aria-hidden", "true"); old.replaceWith(canvas);
  const S = session = { room: null, closed: false, resting: false, restT: 0, offs: [] };
  const on = (t, ev, f, o) => { t.addEventListener(ev, f, o); S.offs.push(() => t.removeEventListener(ev, f, o)); };
  const showStill = (why) => {
    canvas.hidden = true; still.hidden = false;
    if (!still.getAttribute("src")) { still.sizes = "100vw"; still.srcset = STILL.srcset; still.src = STILL.src; }
    say.textContent = why;
  };
  const stopRoom = () => { if (S.room) { try { S.room.stop(); } catch (e) {} S.room = null; } };
  const close = () => {
    if (S.closed) return; S.closed = true;
    clearTimeout(S.restT); for (const off of S.offs) off(); S.offs.length = 0; stopRoom();
    const done = () => { dialog.classList.remove("closing"); if (dialog.open) dialog.close(); session = null; if (opener && opener.focus) opener.focus(); };
    if (RM.matches) { done(); return; }
    dialog.classList.add("closing"); setTimeout(done, CLOSE_MS);
  };
  on(closeBtn, "click", close);
  on(dialog, "cancel", (e) => { e.preventDefault(); close(); });
  still.hidden = true; canvas.hidden = false; say.textContent = "Lighting the candles.";
  dialog.showModal(); closeBtn.focus();

  if (RM.matches) { showStill("Motion is reduced on this device, so the room is shown as a painting."); return; }
  if (navigator.connection && navigator.connection.saveData) { showStill("Data saver is on, so the room is shown as a painting."); return; }
  const no = webgl(/[?&]room=gl(?:&|$)/.test(location.search));
  if (no) { showStill(no); return; }
  try {
    const { startRoom } = await import("../room/room.js?v=8f0fc29708");
    if (S.closed) return;
    const env = () => ({ W: canvas.clientWidth || innerWidth, H: canvas.clientHeight || innerHeight, dpr: 1, rect: null, reduce: false, hidden: document.hidden, sceneOpen: false, wide: { off: false, p3: matchMedia("(color-gamut: p3)").matches } });
    const aim = { tx: null, ty: null };
    S.room = await startRoom({ canvas, tier: "medium", env: env(), aim: () => aim, onLost: () => { stopRoom(); showStill("The graphics card stopped the room, so here is the painting."); } });
    if (S.closed) { stopRoom(); return; }
    say.textContent = "Candles, the hearth and the bar. Move the pointer to look around.";
    const rest = () => { if (!S.room || S.closed) return; S.resting = true; S.room.visible(false); say.textContent = "The room is resting to save power. Move the pointer or tap to wake it."; };
    const wake = (e) => {
      if (e && e.type === "pointermove") { const r = canvas.getBoundingClientRect(); aim.tx = e.clientX - r.left; aim.ty = e.clientY - r.top; }
      if (S.resting && S.room) { S.resting = false; S.room.visible(!document.hidden); say.textContent = "Candles, the hearth and the bar. Move the pointer to look around."; }
      clearTimeout(S.restT); S.restT = setTimeout(rest, REST_MS);
    };
    for (const t of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) on(dialog, t, wake, { passive: true });
    on(document, "visibilitychange", () => { if (S.room) S.room.visible(!document.hidden && !S.resting); });
    let rz = 0; on(window, "resize", () => { if (!rz) rz = requestAnimationFrame(() => { rz = 0; if (S.room) S.room.resize(env()); }); }, { passive: true });
    S.restT = setTimeout(rest, REST_MS);
  } catch (e) {
    stopRoom(); if (!S.closed) showStill("The room did not load, so here is the painting.");
  }
}
// read only, for the browser suite (tests/browser/door.mjs): whether a room is running and its draw count (room/room.js status().frames)
export const roomStatus = () => (session && session.room ? session.room.status() : null);
window.__doorRoom = Object.freeze({ status: roomStatus, open: () => !!session });
