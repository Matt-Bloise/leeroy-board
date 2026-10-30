/* Bottom sheets (mobile contract section 3). Full note: board/MOBILE-NOTES.md, file notes. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h } = K;
const doc = document;
const SPR = () => window.BoardSpring || null;
const reduced = () => !!(K.reduceMQ && K.reduceMQ.matches);
const buzz = (n) => { try { if (window.BoardHaptics) window.BoardHaptics.fire(n); } catch (e) {} };
const B = { cur: null, snap: null, y: 0, dragging: false, fullH: 0, peekH: 0, spring: null, track: null, token: 0 };
let veil = null, sec = null, grip = null, titleEl = null, bodyEl = null, built = false;

function build() {
  if (built) return;
  veil = h("div", { class: "bsheet-veil", id: "bsheet-veil", hidden: true });
  grip = h("button", { class: "bsheet-grip", type: "button", "aria-label": "Resize the sheet: Enter opens it full or back to the peek, Escape closes it" });
  titleEl = h("h3", { class: "bsheet-h", id: "bsheet-h" });
  bodyEl = h("div", { class: "bsheet-body", id: "bsheet-body", tabindex: "-1" });
  sec = h("section", { class: "bsheet", id: "bsheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "bsheet-h", "data-snap": "peek", hidden: true },
    h("div", { class: "bsheet-handle" }, grip), titleEl, bodyEl);
  veil.addEventListener("click", () => close());
  grip.addEventListener("click", () => { if (B.cur) snapTo(B.snap === "full" ? "peek" : "full"); });
  sec.addEventListener("keydown", onKey);
  /* a translated sheet sits partly outside the scene frame, which scrolls programmatically when focus lands there: put it back */
  sec.addEventListener("focusin", () => { const p = sec.parentNode; if (p && p !== doc.body && p.scrollTop) p.scrollTop = 0; });
  built = true;
}
function onKey(e) {
  if (!B.cur) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== "Tab") return;
  const list = [...sec.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")].filter((el) => !el.disabled && el.getAttribute("tabindex") !== "-1" && !el.hidden);
  if (!list.length) { e.preventDefault(); return; }
  const at = doc.activeElement, first = list[0], last = list[list.length - 1];
  if (!list.includes(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
}

/* where the sheet lives: inside the open scene's frame (so its focus trap sees it), else the page */
function host() { const sc = K.SC && K.SC.open !== null ? $("#scene .sheet") : null; return sc || doc.body; }
function place() {
  const p = host();
  if (veil.parentNode !== p) p.append(veil);
  if (sec.parentNode !== p) p.append(sec);
}
function measure(peek) {
  const vh = window.innerHeight || 800;
  let base = vh;
  try { const p = sec.parentNode; if (p && p !== doc.body) { const r = p.getBoundingClientRect(); if (r && r.height > 0 && r.height < vh) base = r.height; } } catch (e) {}
  sec.style.height = Math.max(240, Math.round(base - 24)) + "px";
  let full = Math.round(base - 24);
  try { const r = sec.getBoundingClientRect(); if (r && r.height > 0) full = Math.round(r.height); } catch (e) {}
  B.fullH = Math.max(240, full);
  B.peekH = Math.min(B.fullH, Math.max(240, Math.round(peek * vh)));
}
const yFor = (snap) => (snap === "full" ? 0 : B.fullH - B.peekH);
const setY = (y) => { B.y = y; sec.style.transform = "translateY(" + (Math.round(y * 100) / 100) + "px)"; };
function stopSpring() { if (B.spring) { B.spring.stop(); B.spring = null; } }
function glide(preset, to, done) {
  stopSpring();
  const S = SPR();
  const tok = ++B.token;
  if (!S || reduced()) { setY(to); if (done) done(); return Promise.resolve(); }
  return new Promise((res) => {
    B.spring = S.spring({ preset, x: B.y, target: to, onFrame: (x) => { if (tok === B.token) setY(x); },
      onRest: () => { if (tok !== B.token) { res(); return; } setY(to); B.spring = null; if (done) done(); res(); } });
  });
}
function setSnap(n) { B.snap = n; sec.setAttribute("data-snap", n); }
function snapTo(n) {
  if (!B.cur || !B.cur.snaps.includes(n)) return Promise.resolve();
  const changed = n !== B.snap; setSnap(n);
  if (changed) buzz("select");
  return glide("firm", yFor(n));
}

function open(o) {
  if (!o || !o.id) return Promise.resolve();
  build();
  const prevFocus = doc.activeElement;
  if (B.closing) finish(false, B.closing);
  if (B.cur) finish(true);
  const snaps = Array.isArray(o.snaps) && o.snaps.length ? o.snaps.filter((s) => s === "peek" || s === "full") : ["peek", "full"];
  const want = o.start === "full" || !snaps.includes("peek") ? "full" : "peek";
  B.cur = { id: o.id, snaps, onClose: o.onClose || null, returnTo: o.returnTo || prevFocus || null };
  titleEl.textContent = o.title || "";
  bodyEl.replaceChildren(); bodyEl.scrollTop = 0;
  if (typeof o.build === "function") o.build(bodyEl);
  else if (o.content && typeof o.content !== "string") bodyEl.append(o.content);
  else if (typeof o.content === "string") bodyEl.append(doc.createTextNode(o.content));
  place();
  measure(typeof o.peek === "number" ? o.peek : 0.42);
  const start = snaps.includes(want) ? want : snaps[0];
  setSnap(start);
  sec.hidden = false; veil.hidden = false; B.dragging = false;
  attachTrack();
  const rm = reduced();
  sec.classList.toggle("fade", rm); sec.classList.remove("out");
  veil.classList.add("on");
  if (rm) setY(yFor(start)); else setY(B.fullH + 40);
  try { bodyEl.focus({ preventScroll: true }); } catch (e) { try { bodyEl.focus(); } catch (e2) {} }
  return glide("firm", yFor(start));
}

function attachTrack() {
  detachTrack();
  const S = SPR(); if (!S || !S.track || reduced()) return;
  let ignore = false, boundaryFired = false, base = 0;
  B.track = S.track(sec, {
    axis: "y", slop: 10, lockRatio: 1.5, mouse: false, capture: true,
    canStart(e) {
      if (!B.cur) return false;
      const t = e && e.target;
      if (t && t.closest && t.closest("input, select, textarea")) return false;
      if (t && t.closest && t.closest(".bsheet-handle, .bsheet-h")) return true;
      return bodyEl.scrollTop <= 0;
    },
    onStart(s) {
      const t = s.target, onHandle = t && t.closest && t.closest(".bsheet-handle, .bsheet-h");
      ignore = !onHandle && (bodyEl.scrollTop > 0 || s.dy < 0);
      if (ignore) return;
      stopSpring(); B.token++; B.dragging = true; boundaryFired = false; base = B.y;
    },
    onMove(s) {
      if (ignore || !B.dragging) return;
      let y = base + s.dy;
      if (y < 0) {
        const over = -y, r = SPR() ? SPR().resist(over, 120) : over * 0.3;
        if (!boundaryFired && over > 4) { boundaryFired = true; buzz("boundary"); }
        y = -r;
      }
      setY(y);
    },
    onEnd(s) {
      if (ignore || !B.dragging) { ignore = false; return; }
      B.dragging = false;
      const vy = s.vy, y = B.y, peekY = yFor("peek"), canFull = B.cur.snaps.includes("full"), canPeek = B.cur.snaps.includes("peek");
      if (vy > 0.6 || (y > peekY + B.peekH * 0.5 && Math.abs(vy) < 0.3)) { dismiss(); return; }
      let to;
      if (vy < -0.6 && canFull) to = "full";
      else if (Math.abs(vy) >= 0.3) to = vy > 0 && canPeek ? "peek" : canFull ? "full" : "peek";
      else to = !canFull ? "peek" : !canPeek ? "full" : Math.abs(y) < Math.abs(y - peekY) ? "full" : "peek";
      if (to === B.snap) glide("firm", yFor(to)); else snapTo(to);
    },
    onCancel() { if (!B.dragging) return; B.dragging = false; if (B.cur) glide("firm", yFor(B.snap)); },
  });
}
function detachTrack() { if (B.track) { try { B.track.stop(); } catch (e) {} B.track = null; } }

function dismiss() {
  if (!B.cur) return Promise.resolve();
  if (reduced()) return close();
  const tok = B.cur;
  return glide("oak", B.fullH + 40).then(() => { if (B.cur === tok) finish(false); });
}
/* finish: hide the sheet and run the close side (instant = a second open replacing this one, no onClose) */
function finish(instant, c0) {
  const c = c0 || B.cur; if (!c) return;
  if (B.cur === c) B.cur = null;
  if (B.closing === c) B.closing = null;
  B.dragging = false; B.token++; stopSpring(); detachTrack();
  veil.classList.remove("on");
  const hide = () => { if (B.cur) return; sec.hidden = true; veil.hidden = true; sec.classList.remove("out", "fade"); };
  if (instant) { sec.hidden = true; veil.hidden = true; sec.classList.remove("out", "fade"); }
  else if (reduced()) { sec.classList.add("fade", "out"); setTimeout(hide, 130); }
  else hide();
  try { if (!c.focused && c.returnTo && c.returnTo.focus && c.returnTo.isConnected !== false) c.returnTo.focus(); } catch (e) {}
  if (c.onClose && !instant) { try { c.onClose(); } catch (e) { console.error("bsheet onClose", e); } }
}
function close(id) {
  if (!B.cur || (id && id !== B.cur.id)) return Promise.resolve();
  /* integrator (2026-10-30): the sheet counts as closed the moment a close starts (status().open is null), so a More row ... Full note: board/MOBILE-NOTES.md, file notes. */
  if (!reduced()) {
    const tok = B.cur; B.cur = null; B.closing = tok; B.dragging = false; detachTrack(); veil.classList.remove("on"); buzz("select");
    try { if (tok.returnTo && tok.returnTo.focus && tok.returnTo.isConnected !== false) { tok.returnTo.focus(); tok.focused = true; } } catch (e) {}
    return glide("firm", B.fullH + 40).then(() => { if (B.closing === tok) finish(false, tok); });
  }
  finish(false); return Promise.resolve();
}

K.on("closed", () => { if (B.closing) finish(false, B.closing); if (B.cur) finish(false); });

window.BoardSheets = Object.freeze({
  open, close, snap: (id, n) => (B.cur && B.cur.id === id ? snapTo(n) : Promise.resolve()),
  status: () => ({ open: B.cur ? B.cur.id : null, snap: B.cur ? B.snap : null, dragging: B.dragging, height: B.cur ? Math.round(B.fullH - B.y) : 0, reduced: reduced(), translateY: B.y, fullH: B.fullH, peekH: B.peekH }),
});
})();
