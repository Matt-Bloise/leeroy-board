/* Play mode and Lounge mode (companion contract 4, node N4). html.play is Play: text only, nothing moves, no sound unless the
   friend turns it back on. No class is Lounge: the board as it always was. Kept on this device only (localStorage board-mode =
   "play", absent = Lounge; a browser cannot tell that the game is running), read when this script runs, before boot, so the
   first paint is already Play. Entering Play holds the sound (board-mode-sound = "1" when it was on) and asks room/tier.js to
   choose again: its pref() reads "off" while html.play, and the menu's remembered choice is never touched. Leaving gives both
   back. A switch never changes the scene, the scroll or the journey.
     window.__mode = { play(), set(on), toggle(), status() }   K.on("mode", (m) => ...), m = "play" | "lounge"   event "board-mode" */
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
  /* Play holds the sound it found on; the Sensory panel and M still turn it on inside Play */
  const hold = () => { if (sound()) { put(HELD, "1"); sound(false); } };
  const give = () => { if (get(HELD) === "1") { put(HELD, null); sound(true); } };

  /* the lantern: lit in Lounge, snuffed in Play; the word names the mode you are in (on the wall it is read, not shown:
     css/mode.css keeps the hero's height) */
  /* integrator pass 3: the button is named for what it switches (Play mode), aria-pressed says whether it is on, and the tip names
     what a press does (the word had flipped between Lounge and Play mode, naming the state, not the action) */
  const TIP = { off: "Turn on Play mode: text only, nothing moves, for while the game runs.", on: "Play mode is on. Press to light the tavern room again." }; /* fix C20 */
  const TITLE = TIP.off;
  /* the painted lantern pair (img/companion, contract 13 sheet 1) once it has loaded */
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
    /* polish (2026-10-30): on a phone the wall's lantern carries a short word under its icon ("Play") and no tip: a tip there stood
       over two tiles for as long as it showed. The sentence is still read (aria-description) */
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
  /* the node after n, also where a DOM has no nextSibling */
  const nextOf = (n) => { const p = n.parentNode; if (!p) return null; if (n.nextSibling !== undefined) return n.nextSibling; const c = p.childNodes; return c[Array.prototype.indexOf.call(c, n) + 1] || null; };
  /* the wall: in the presence row after Sound; the scene head: after Look at the room */
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
    html.classList.add("snuff"); setTimeout(() => html.classList.remove("snuff"), 160); /* Snuff: the light cross-fades, nothing moves */
    html.classList.toggle("play", on); put(KEY, on ? "play" : null);
    sync();
    /* tier.js chooses again; the wall's light, sheen and wisps re-check their live() on */
    fire("board-mode"); fire("board-room");
    if (on) hold(); else give();
    if (K) K.emit("mode", on ? "play" : "lounge");
    hap();
    return on;
  }
  const toggle = () => set(!isPlay());

  /* a room still starting when Play came on can finish after tier.js chose off (its first frame fires board-room): while Play
     is on, a room left standing is asked off once more */
  let asking = false;
  addEventListener("board-room", () => {
    if (!isPlay() || asking) return;
    let r = null; try { const b = B(); r = b && b.room ? b.room() : null; } catch (e) {}
    if (!r || (r.tier === "off" && !r.room)) return;
    asking = true; try { fire("board-mode"); } finally { asking = false; }
  });
  /* P, the same guard as board.js's keys: never while typing in a field */
  const typing = (t) => !(!t || !t.closest || !t.closest("input, textarea, select")) || !!(t && t.isContentEditable);
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.key !== "p" && e.key !== "P") || typing(e.target)) return;
    e.preventDefault(); toggle();
  });

  if (isPlay()) hold(); /* a page that opens in Play opens quiet */
  /* both paintings decoded before the first swap, so a switch never shows a half-loaded */
  if (typeof Image === "function") { let n = 0; for (const u of [ART.lit, ART.snuffed]) { const im = new Image(); im.onload = () => { if (++n === 2) { art = true; sync(); } }; im.src = u; } }
  place();
  if (K) K.on("booted", place);
  window.__mode = Object.freeze({
    play: isPlay, set, toggle,
    status: () => { let tier = null; try { const b = B(); tier = b && b.room ? b.room().tier : null; } catch (e) {} return { play: isPlay(), soundHeld: get(HELD) === "1", tier }; },
  });
})();
