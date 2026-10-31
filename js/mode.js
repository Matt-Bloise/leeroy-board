(() => {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const KEY = "board-mode", HELD = "board-mode-sound", html = document.documentElement;
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
  const isPlay = () => html.classList.contains("play");
  html.classList.toggle("play", get(KEY) === "play");
  const K = window.__boardKit || null, B = () => window.__board || null;
  const sound = (on) => { try { const b = B(); return b && b.sound ? b.sound(on) : false; } catch (e) { return false; } };
  const fire = (n) => { try { if (typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(n)); } catch (e) {} };
  const hap = () => { try { if (window.BoardHaptics) window.BoardHaptics.fire("select"); } catch (e) {} };
  const hold = () => { if (sound()) { put(HELD, "1"); sound(false); } };
  const give = () => { if (get(HELD) === "1") { put(HELD, null); sound(true); } };

  const TIP = { off: "Turn on Play mode: text only, nothing moves, for while the game runs.", on: "Play mode is on. Press to light the tavern room again." };
  const TITLE = TIP.off;
  const ART = { lit: "img/companion/lantern-lit.webp", snuffed: "img/companion/lantern-snuffed.webp" };
  let art = false;
  const lantern = (on) => {
    if (art) { const im = document.createElement("img"); im.setAttribute("class", "emblem mode-art"); im.setAttribute("src", on ? ART.snuffed : ART.lit); im.setAttribute("alt", ""); im.setAttribute("width", "20"); im.setAttribute("height", "20"); return im; }
    try { return K && K.emb ? K.emb("candle", "emblem") : null; } catch (e) { return null; }
  };
  const paint = (b) => {
    const on = isPlay(), e = lantern(on), w = document.createElement("span");
    w.setAttribute("class", "mode-word"); w.textContent = on ? "Play mode: on" : "Play mode";
    b.setAttribute("aria-pressed", String(on));
    const bare = b.id === "mode-btn" && narrow();
    if (bare) { b.removeAttribute("title"); b.removeAttribute("data-tip"); } else b.setAttribute(b.hasAttribute("data-tip") ? "data-tip" : "title", on ? TIP.on : TIP.off);
    b.setAttribute("aria-description", on ? TIP.on : TIP.off);
    b.classList.toggle("mode-lit", !on); b.classList.toggle("mode-snuffed", on);
    const short = document.createElement("span"); short.setAttribute("class", "mode-short"); short.setAttribute("aria-hidden", "true"); short.textContent = "Play";
    b.replaceChildren(...(e ? [e] : []), w, short);
  };
  const narrow = () => { try { return matchMedia("(max-width: 599px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)").matches; } catch (e) { return false; } };
  const sync = () => { for (const id of ["mode-btn", "mode-btn-scene"]) { const b = document.getElementById(id); if (b) paint(b); } };
  let wasNarrow = narrow(); if (typeof addEventListener === "function") addEventListener("resize", () => { const n = narrow(); if (n !== wasNarrow) { wasNarrow = n; sync(); } });
  const make = (id, cls) => {
    const b = document.createElement("button");
    b.setAttribute("type", "button"); b.setAttribute("id", id); b.setAttribute("class", cls); b.setAttribute("title", TITLE);
    b.addEventListener("click", () => toggle());
    return b;
  };
  const nextOf = (n) => { const p = n.parentNode; if (!p) return null; if (n.nextSibling !== undefined) return n.nextSibling; const c = p.childNodes; return c[Array.prototype.indexOf.call(c, n) + 1] || null; };
  const place = () => {
    const pres = document.getElementById("presence"), box = document.getElementById("sound-box");
    if (pres && !document.getElementById("mode-btn")) pres.insertBefore(make("mode-btn", "tilt"), box && box.parentNode === pres ? nextOf(box) : null);
    const peek = document.getElementById("scene-peek");
    if (peek && peek.parentNode && !document.getElementById("mode-btn-scene")) peek.parentNode.insertBefore(make("mode-btn-scene", "peek-btn"), nextOf(peek));
    sync();
  };

  function set(on) {
    on = !!on;
    if (on === isPlay()) { sync(); return on; }
    html.classList.add("snuff"); setTimeout(() => html.classList.remove("snuff"), 160);
    html.classList.toggle("play", on); put(KEY, on ? "play" : null);
    sync();
    fire("board-mode"); fire("board-room");
    if (on) hold(); else give();
    if (K) K.emit("mode", on ? "play" : "lounge");
    hap();
    return on;
  }
  const toggle = () => set(!isPlay());

  let asking = false;
  addEventListener("board-room", () => {
    if (!isPlay() || asking) return;
    let r = null; try { const b = B(); r = b && b.room ? b.room() : null; } catch (e) {}
    if (!r || (r.tier === "off" && !r.room)) return;
    asking = true; try { fire("board-mode"); } finally { asking = false; }
  });
  const typing = (t) => !(!t || !t.closest || !t.closest("input, textarea, select")) || !!(t && t.isContentEditable);
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.key !== "p" && e.key !== "P") || typing(e.target)) return;
    e.preventDefault(); toggle();
  });

  if (isPlay()) hold();
  if (typeof Image === "function") { let n = 0; for (const u of [ART.lit, ART.snuffed]) { const im = new Image(); im.onload = () => { if (++n === 2) { art = true; sync(); } }; im.src = u; } }
  place();
  if (K) K.on("booted", place);
  window.__mode = Object.freeze({
    play: isPlay, set, toggle,
    status: () => { let tier = null; try { const b = B(); tier = b && b.room ? b.room().tier : null; } catch (e) {} return { play: isPlay(), soundHeld: get(HELD) === "1", tier }; },
  });
})();
